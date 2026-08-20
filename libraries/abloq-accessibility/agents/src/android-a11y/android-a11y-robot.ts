import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";

import { AndroidRobot } from "../android";
import { ActionableError } from "../robot";
import { trace } from "../logger";

// Talks to the AbloqBridge receiver injected into the patched Developer Assistant companion
// app (see ../../../app/patch/). Full protocol/data-model rationale: ../../../app/recon/RECON.md.
export const COMPANION_PACKAGE = "com.appsisle.developerassistant";
const ACTION_DUMP = "com.abloq.bridge.ACTION_DUMP";
// USER-0 ASSUMPTION (single place it is written down): this whole flow targets a companion
// installed in user 0. `/sdcard` *is* user 0's external-storage view (secondary users live under
// /storage/emulated/<userId>), so these paths, the `pm list packages --user 0` probe in
// isCompanionAvailable(), and the `am broadcast --user 0` in dumpFullHierarchy() are deliberately
// kept consistent with each other. A companion installed *only* in a secondary user (Samsung
// Secure Folder, work profile) is therefore reported as "not installed" rather than half-working
// against another user's storage. Supporting that would mean resolving the user id first and
// deriving /storage/emulated/<userId>/... from it, not just widening the pm query.
const EXTERNAL_DUMP_PATH = `/sdcard/Android/data/${COMPANION_PACKAGE}/files/abloq_dump.json`;
const EXTERNAL_DONE_PATH = `/sdcard/Android/data/${COMPANION_PACKAGE}/files/abloq_dump.done`;
const DUMP_POLL_TIMEOUT_MS = 6000;
const DUMP_POLL_INTERVAL_MS = 200;

// Appended to the `.done` presence check as `... && echo <sentinel>`. AbloqBridge writes the
// sentinel as a *zero-byte* file (see RECON.md / bridge_src), so "did cat print anything" cannot
// tell present-but-empty from absent, and "did cat throw" relies on adb forwarding the device
// shell's exit status - a comparatively modern platform-tools/device guarantee. An old adb or an
// OEM shell that returns 0 regardless would make an absent file look ready on the first poll and
// hand back the previous screen's dump. Requiring this token in stdout makes the check
// positive-evidence-based: it can only appear if `cat` actually succeeded on the device.
export const COMPANION_FILE_PRESENT_SENTINEL = "__ABLOQ_PRESENT__";

// Same defaults AndroidRobot.adb() uses (src/android.ts) - kept in sync manually since that
// file is upstream and off-limits to edit/export from.
const DEFAULT_ADB_MAX_BUFFER = 1024 * 1024 * 8;
const DEFAULT_ADB_TIMEOUT = 30000;
// A dense/deep screen (long lists, WebViews) can plausibly produce a JSON dump over 8MB - both
// the plain and run-as `cat` attempts would hit the inherited ceiling identically, masquerading
// as a permissions failure. Only the dump-content read needs this; the tiny .done-file poll does not.
export const DUMP_CONTENT_MAX_BUFFER = 1024 * 1024 * 64;
// The .done-file poll documents a 6s total budget (DUMP_POLL_TIMEOUT_MS) but each attempt could
// otherwise inherit the 30s default, ballooning the real wait well past that - fail each attempt
// fast so the poll loop's own deadline check stays meaningful.
export const DONE_POLL_TIMEOUT_MS = 2000;

interface CompanionAdbOptions {
	maxBuffer?: number;
	timeout?: number;
}

interface CompanionReadFailure {
	ok: false;
	plainMessage: string;
	runAsMessage: string;
	// true when run-as itself refused the request (app not debuggable / unknown package) rather
	// than the read failing for a permission or IO reason - see describeReadFailure().
	runAsUnsupported: boolean;
}

type CompanionReadResult = { ok: true; content: string } | CompanionReadFailure;

// `run-as` on a stock "user" build refuses any package that isn't android:debuggable, which is
// every release-signed app - including the patched companion. Recognising that refusal keeps it
// from being reported as a permissions problem the user could act on.
export const isRunAsUnsupportedError = (message: string): boolean =>
	/not debuggable|unknown package|is not an application/i.test(message);

// Duplicated from src/android.ts's module-private getAdbPath() (not exported, so this is the
// only way to reuse the same cross-platform resolution without editing that upstream file) -
// needed because execCompanionAdb() below has to call execFileSync directly to override
// maxBuffer/timeout per call, which AndroidRobot.adb()'s fixed options don't allow.
export const resolveAdbPath = (): string => {
	const exeName = process.platform === "win32" ? "adb.exe" : "adb";
	if (process.env.ANDROID_HOME) {
		return path.join(process.env.ANDROID_HOME, "platform-tools", exeName);
	}

	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		const windowsAdbPath = path.join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe");
		if (existsSync(windowsAdbPath)) {
			return windowsAdbPath;
		}
	}

	if (process.platform === "darwin" && process.env.HOME) {
		const defaultAndroidSdk = path.join(process.env.HOME, "Library", "Android", "sdk", "platform-tools", "adb");
		if (existsSync(defaultAndroidSdk)) {
			return defaultAndroidSdk;
		}
	}

	// fallthrough, hope for the best
	return exeName;
};

// Validated at runtime against the companion app's actual output (see dumpFullHierarchy) -
// AbloqBridge.java is untrusted from this MCP server's point of view (a different codebase,
// see ../../../app/patch/), so a blind `as AbloqNode[]` cast isn't enough. AbloqNode is
// derived from the schema (not hand-written) so the two can't drift apart.
const AbloqBoundsSchema = z.object({
	left: z.number(),
	top: z.number(),
	right: z.number(),
	bottom: z.number(),
});

const AbloqNodeSchema = z.object({
	index: z.number(),
	parentIndex: z.number().nullable(),
	windowId: z.number().nullable(),
	className: z.string().nullable(),
	resourceId: z.string().nullable(),
	resourceNumericId: z.number().optional(),
	text: z.string().nullable(),
	contentDescription: z.string().nullable(),
	hintText: z.string().nullable(),
	checkable: z.boolean(),
	checked: z.boolean(),
	clickable: z.boolean(),
	longClickable: z.boolean(),
	focusable: z.boolean(),
	focused: z.boolean(),
	enabled: z.boolean(),
	selected: z.boolean(),
	visible: z.boolean(),
	boundsInScreen: AbloqBoundsSchema.nullable(),
});

export type AbloqNode = z.infer<typeof AbloqNodeSchema>;

export interface CurrentActivity {
	packageName: string;
	activityName: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// AndroidRobot already implements every upstream Robot method via plain adb - subclassing
// gets tap/swipe/screenshot/launchApp/etc "for free" for the companion-app-capable device
// path, so getRobotFromDevice can return this instead of AndroidRobot with zero loss of
// existing behavior, purely additive new methods below.
export class AndroidA11yRobot extends AndroidRobot {

	// AndroidRobot's own deviceId is private (not visible to subclasses), so it's kept a second
	// time here purely for execCompanionAdb() below.
	public constructor(private readonly a11yDeviceId: string) {
		super(a11yDeviceId);
	}

	// Same shape as AndroidRobot.adb(), but with overridable maxBuffer/timeout - see
	// DUMP_CONTENT_MAX_BUFFER/DONE_POLL_TIMEOUT_MS above for why. Public (not private) so it can
	// be mocked the same way test/android-a11y-robot.test.ts already mocks `robot.adb`.
	public execCompanionAdb(args: string[], options: CompanionAdbOptions = {}): Buffer {
		return execFileSync(resolveAdbPath(), ["-s", this.a11yDeviceId, ...args], {
			maxBuffer: options.maxBuffer ?? DEFAULT_ADB_MAX_BUFFER,
			timeout: options.timeout ?? DEFAULT_ADB_TIMEOUT,
		});
	}

	public isCompanionAvailable(): boolean {
		try {
			// `--user 0` is load-bearing, not cosmetic: an *unscoped* `pm list packages` throws
			// java.lang.SecurityException ("Shell does not have permission to access user <id>")
			// on any device that has a secondary user - confirmed live on a Samsung SM-A366B with
			// a Secure Folder (user 150), and equally applicable to work profiles. That throw is
			// swallowed by the catch below and would permanently report "no companion" even
			// though the app is installed and enabled in user 0. Single-user devices accept
			// `--user 0` happily, so scoping it is a universal fix (see the USER-0 ASSUMPTION
			// note at the top of this file).
			const packages = this.adb("shell", "pm", "list", "packages", "--user", "0", COMPANION_PACKAGE).toString();
			const packageLines = packages.split("\n").map(line => line.trim());
			if (!packageLines.includes(`package:${COMPANION_PACKAGE}`)) {
				return false;
			}

			// package installed isn't enough - AbloqBridge.install() only ran (and registered
			// the receiver) if the Accessibility Service was actually turned on in Settings.
			const enabledServices = this.adb("shell", "settings", "get", "secure", "enabled_accessibility_services").toString().trim();
			// An *unset* secure setting prints the literal four-character string "null" (observed
			// on a real device), not an empty line. Both mean "no accessibility service is
			// enabled" - handled explicitly here rather than relying on the coincidence that
			// "null".split(":") happens to contain no entry starting with the package name.
			if (enabledServices === "" || enabledServices === "null") {
				return false;
			}
			return enabledServices.split(":").some(service => service.startsWith(`${COMPANION_PACKAGE}/`));
		} catch (error) {
			return false;
		}
	}

	private requireCompanion(): void {
		if (!this.isCompanionAvailable()) {
			throw new ActionableError(
				`The patched Developer Assistant companion app is not installed, or its Accessibility Service is not enabled, on this device. ` +
				`Install libraries/abloq-accessibility/app/patch/devassistant_patched_signed.apk (adb install -r ...) and turn on ` +
				`"Developer Assistant" once under Settings > Accessibility, then retry.`
			);
		}
	}

	// Try a plain read first - on Android 11+ the adb shell user can normally read
	// /sdcard/Android/data/<pkg>/files, so this is the path that actually works in practice.
	// The run-as fallback below only helps on userdebug/eng builds (emulators), because run-as on
	// a stock "user" build refuses any app whose manifest isn't android:debuggable - and the
	// patched companion is a release APK that apply_patch.sh re-signs *without* setting that flag.
	// So on a retail phone the fallback is expected to be refused; that refusal is classified
	// (runAsUnsupported) instead of being reported as if run-as might have helped.
	private readCompanionFileResult(path: string, options: CompanionAdbOptions, suffixArgs: string[] = []): CompanionReadResult {
		try {
			return { ok: true, content: this.execCompanionAdb(["shell", "cat", path, ...suffixArgs], options).toString() };
		} catch (plainError: any) {
			try {
				// run-as chdirs into the app's *internal* data dir before exec'ing, but the dump
				// lives in *external* storage - an absolute path ignores cwd and resolves
				// correctly either way, so pass `path` through unmodified (never make it relative).
				return { ok: true, content: this.execCompanionAdb(["shell", "run-as", COMPANION_PACKAGE, "cat", path, ...suffixArgs], options).toString() };
			} catch (runAsError: any) {
				const plainMessage = String(plainError?.message ?? plainError);
				const runAsMessage = String(runAsError?.message ?? runAsError);
				trace(`readCompanionFileResult("${path}"): plain cat failed (${plainMessage}); run-as cat also failed (${runAsMessage})`);
				return {
					ok: false,
					plainMessage,
					runAsMessage,
					runAsUnsupported: isRunAsUnsupportedError(runAsMessage),
				};
			}
		}
	}

	// Presence check for the zero-byte `.done` sentinel - see COMPANION_FILE_PRESENT_SENTINEL for
	// why this cannot just be "did cat throw?".
	private companionFileExists(path: string, options: CompanionAdbOptions = {}): boolean {
		const result = this.readCompanionFileResult(path, options, ["&&", "echo", COMPANION_FILE_PRESENT_SENTINEL]);
		return result.ok && result.content.includes(COMPANION_FILE_PRESENT_SENTINEL);
	}

	private readCompanionFile(path: string, options: CompanionAdbOptions = {}): string {
		const result = this.readCompanionFileResult(path, options);
		if (!result.ok) {
			throw new ActionableError(this.describeReadFailure(path, result));
		}
		return result.content;
	}

	// Keeps the two genuinely different failures apart: "run-as refused this app because it isn't
	// debuggable" (expected on every retail device, so run-as was never going to help and saying
	// "tried run-as too" only misdirects) versus a real permission/IO error from both attempts.
	private describeReadFailure(path: string, failure: CompanionReadFailure): string {
		if (failure.runAsUnsupported) {
			return `Could not read "${path}" from the device: the plain "adb shell cat" read failed (${failure.plainMessage}). ` +
				`The run-as fallback is not usable for this app - the patched companion APK is release-signed and not marked ` +
				`android:debuggable, so run-as refuses it on any stock "user" build (${failure.runAsMessage}). ` +
				`adb shell can normally read /sdcard/Android/data/${COMPANION_PACKAGE}/files directly on Android 11+, so this ` +
				`usually means the companion app never wrote the dump (its Accessibility Service was killed or reconnected), ` +
				`not that permissions are missing. See app/recon/RECON.md.`;
		}

		return `Could not read "${path}" from the device (plain adb: ${failure.plainMessage}; run-as: ${failure.runAsMessage}). ` +
			`Neither the shell user nor run-as could see the companion app's external-files-dir. ` +
			`See app/recon/RECON.md for the tradeoffs here.`;
	}

	// Mirrors readCompanionFileResult's plain-then-run-as pattern for cleanup (with the same
	// caveat: run-as is refused for this non-debuggable app on stock builds). Without this,
	// deletion silently fails the same way reads did on a run-as-only device, and because
	// AbloqBridge.java deletes the old .done file only right before finishing the new write
	// (see RECON.md), a failed cleanup here means the poll below can observe the *previous*
	// dump's stale .done/.json as if it were fresh - silently stale data, not an error.
	// Returns whether either delete attempt actually succeeded, so callers can tell "cleaned"
	// apart from "nothing more we can do" instead of treating both the same.
	private tryDeleteCompanionFiles(...paths: string[]): boolean {
		try {
			this.adb("shell", "rm", "-f", ...paths);
			return true;
		} catch (plainError) {
			try {
				this.adb("shell", "run-as", COMPANION_PACKAGE, "rm", "-f", ...paths);
				return true;
			} catch (runAsError) {
				// stale files may not exist yet on first run, or this device can't grant access
				// at all (same gap as readCompanionFileResult) - either way, nothing more we can do.
				return false;
			}
		}
	}

	// Reuses the app's own AccessibilityService hierarchy dump (see RECON.md) rather than
	// reimplementing tree-walking - this only triggers it headlessly and reads the result.
	public async dumpFullHierarchy(): Promise<AbloqNode[]> {
		this.requireCompanion();

		const cleaned = this.tryDeleteCompanionFiles(EXTERNAL_DONE_PATH, EXTERNAL_DUMP_PATH);
		if (!cleaned && this.companionFileExists(EXTERNAL_DONE_PATH, { timeout: DONE_POLL_TIMEOUT_MS })) {
			// Cleanup failed on both plain and run-as AND a .done marker from a previous dump is
			// still there and still readable - proceeding would let the poll below observe it as
			// "fresh" on the very first iteration and silently return stale data from the last
			// screen instead of the current one. Bail out loudly instead.
			throw new ActionableError(
				`Could not clear the previous accessibility dump at "${EXTERNAL_DONE_PATH}" before requesting a new one, and a dump from ` +
				`a previous call is still present there. Reading it now would silently return stale data from the last screen instead of ` +
				`the current one. This can happen on stock "user"-build devices where neither the shell user nor run-as can delete another ` +
				`app's external-files-dir contents. See app/recon/RECON.md for the tradeoffs here.`
			);
		}

		// Unguarded, an adb failure here (device unplugged mid-call, `am` SecurityException,
		// transport error) escapes as a raw execFileSync Error carrying the full adb path, the
		// whole argv and captured stderr - every other failure in this method is an
		// ActionableError, so this one is converted too. `--user 0` matches the user-0 assumption
		// documented at the top of this file (the receiver lives in the user-0 service process).
		try {
			this.adb("shell", "am", "broadcast", "--user", "0", "-a", ACTION_DUMP);
		} catch (err: any) {
			throw new ActionableError(
				`Could not broadcast ${ACTION_DUMP} to the companion app on device "${this.a11yDeviceId}" (adb error: ${err.message}). ` +
				`Check the device is still connected ("adb devices") and retry.`
			);
		}

		const deadline = Date.now() + DUMP_POLL_TIMEOUT_MS;
		let ready = false;
		while (Date.now() < deadline) {
			if (this.companionFileExists(EXTERNAL_DONE_PATH, { timeout: DONE_POLL_TIMEOUT_MS })) {
				ready = true;
				break;
			}
			await sleep(DUMP_POLL_INTERVAL_MS);
		}

		if (!ready) {
			throw new ActionableError(
				`No hierarchy dump appeared within ${DUMP_POLL_TIMEOUT_MS}ms after broadcasting ${ACTION_DUMP}. ` +
				`The companion app's process was most likely killed or its Accessibility Service disconnected (Doze/battery ` +
				`optimization - reopen "Developer Assistant" once, retry, or exempt it from battery optimization). Less commonly, ` +
				`"adb shell cat ${EXTERNAL_DONE_PATH}" cannot read the companion app's external-files-dir on this device at all ` +
				`(see app/recon/RECON.md) - run that command by hand to tell the two apart.`
			);
		}

		const raw = this.readCompanionFile(EXTERNAL_DUMP_PATH, { maxBuffer: DUMP_CONTENT_MAX_BUFFER });
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error: any) {
			throw new ActionableError(`Companion app's dump output wasn't valid JSON: ${error.message}`);
		}

		const result = AbloqNodeSchema.array().safeParse(parsed);
		if (!result.success) {
			const issues = result.error.issues;
			const preview = issues.slice(0, 3).map(i => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
			const more = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
			throw new ActionableError(
				`Companion app's dump output didn't match the expected accessibility-node shape (${issues.length} issue(s)): ${preview}${more}. ` +
				`This likely means the companion app's AbloqBridge protocol has changed - see app/recon/RECON.md.`
			);
		}

		// Best-effort: the dump can contain sensitive on-screen text (password hints, PII,
		// banking content) and is written to external storage in plaintext. Not fatal if it
		// fails - the caller already has valid data, and the pre-broadcast check above covers
		// the next call.
		if (!this.tryDeleteCompanionFiles(EXTERNAL_DONE_PATH, EXTERNAL_DUMP_PATH)) {
			trace(`Could not delete companion dump files after a successful read (${EXTERNAL_DONE_PATH}, ${EXTERNAL_DUMP_PATH}) - they may remain on the device until the next dump overwrites them.`);
		}

		return result.data;
	}

	// Plain adb, independent of the companion app - dumpsys already exposes the resumed
	// activity's package/class reliably. Fragment/Compose-route identity is not retrievable
	// for third-party apps via any public API (see RECON.md) - activityName is the ceiling.
	//
	// Matches both AOSP's older "mResumedActivity:" field and the newer forms seen on a real
	// MIUI/HyperOS device (targetSdk 36): "topResumedActivity=ActivityRecord{...}" and the
	// display-section "  ResumedActivity: ActivityRecord{...}" (no leading "m"). Selection among
	// several such lines (multi-display, split-screen, multi-user) is pickForegroundActivity's job.
	public async getCurrentActivity(): Promise<CurrentActivity> {
		let output: string;
		try {
			output = this.adb("shell", "dumpsys", "activity", "activities").toString();
		} catch (err: any) {
			throw new ActionableError(`Could not query the current foreground activity on device "${this.a11yDeviceId}" (adb error: ${err.message}).`);
		}
		const best = pickForegroundActivity(output);
		if (!best) {
			throw new ActionableError("Could not determine the current foreground activity from dumpsys output.");
		}

		const { packageName, rawActivityName } = best;
		const activityName = rawActivityName.startsWith(".") ? `${packageName}${rawActivityName}` : rawActivityName;
		return { packageName, activityName };
	}
}

interface ResumedActivityCandidate {
	packageName: string;
	rawActivityName: string;
	// null when the ActivityRecord line carries no "u<id>" token / the dump has no display headers.
	userId: number | null;
	displayId: number | null;
	topResumed: boolean;
	offset: number;
}

// "mLastResumedActivity" also contains the substring "ResumedActivity" but names the *previous*
// activity - the lookbehind keeps it out. "(top)?" captures the newer global
// "topResumedActivity=" form; "u(\d+)" is optional because not every build prints it.
const RESUMED_ACTIVITY_RE = /(?<!Last)(top)?ResumedActivity[:=]\s*ActivityRecord\{[^}]*?(?:\bu(\d+)\s+)?([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/g;
// Section headers as printed across AOSP/OEM builds: "Display #0 (activities from top to
// bottom):", "ActivityDisplay #1", "* Display #0". Anchored to line starts so field assignments
// like "mDisplayId=0" don't count as headers.
const DISPLAY_HEADER_RE = /(?:^|\n)[^\S\n]*(?:\*[^\S\n]*)?(?:Activity)?Display[^\S\n]*#(\d+)/g;

// `dumpsys activity activities` prints a resumed activity per display (foldable inner/outer,
// external/DeX), per visible task in split-screen/multi-window, and per user (Secure Folder, work
// profile), so "first regex hit wins" can silently report a background or other-user activity as
// the foreground one - dumpsys does not promise the primary display comes first. Rank the
// candidates instead: Android's single global top-resumed activity is the strongest signal, then
// display 0, then user 0; ties keep dump order.
export const pickForegroundActivity = (dumpsysOutput: string): ResumedActivityCandidate | null => {
	const displayHeaders: { offset: number; displayId: number }[] = [];
	for (const header of dumpsysOutput.matchAll(DISPLAY_HEADER_RE)) {
		displayHeaders.push({ offset: header.index ?? 0, displayId: Number(header[1]) });
	}

	const displayIdAt = (offset: number): number | null => {
		let current: number | null = null;
		for (const header of displayHeaders) {
			if (header.offset > offset) {
				break;
			}
			current = header.displayId;
		}
		return current;
	};

	const candidates: ResumedActivityCandidate[] = [];
	for (const match of dumpsysOutput.matchAll(RESUMED_ACTIVITY_RE)) {
		const offset = match.index ?? 0;
		candidates.push({
			topResumed: match[1] === "top",
			userId: match[2] === undefined ? null : Number(match[2]),
			packageName: match[3],
			rawActivityName: match[4],
			displayId: displayIdAt(offset),
			offset,
		});
	}

	if (candidates.length === 0) {
		return null;
	}

	// Absent information is scored as "probably the primary one" so single-display, single-user
	// dumps (emulators, and every pre-existing test fixture) behave exactly as before.
	const score = (candidate: ResumedActivityCandidate): number =>
		(candidate.topResumed ? 4 : 0) +
		(candidate.displayId === null || candidate.displayId === 0 ? 2 : 0) +
		(candidate.userId === null || candidate.userId === 0 ? 1 : 0);

	return candidates.reduce((best, candidate) => (score(candidate) > score(best) ? candidate : best));
};
