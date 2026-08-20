import path from "node:path";
import { test, expect } from "@playwright/test";
import { ActionableError } from "../src/robot";
import { AndroidA11yRobot, COMPANION_FILE_PRESENT_SENTINEL, COMPANION_PACKAGE, DUMP_CONTENT_MAX_BUFFER, DONE_POLL_TIMEOUT_MS, resolveAdbPath } from "../src/android-a11y/android-a11y-robot";

type AdbCall = { args: string[] };
type ExecCall = { args: string[]; options: { maxBuffer?: number; timeout?: number } };

function mockRobot(responder: (args: string[]) => Buffer | string): { robot: AndroidA11yRobot; calls: AdbCall[] } {
	const robot = new AndroidA11yRobot("mock-device");
	const calls: AdbCall[] = [];

	robot.adb = function(...args: string[]): Buffer {
		calls.push({ args });
		const result = responder(args);
		return Buffer.isBuffer(result) ? result : Buffer.from(result);
	};

	return { robot, calls };
}

const DONE_PATH = `/sdcard/Android/data/${COMPANION_PACKAGE}/files/abloq_dump.done`;
const DUMP_PATH = `/sdcard/Android/data/${COMPANION_PACKAGE}/files/abloq_dump.json`;

// What a device really prints for the `.done` presence check: the sentinel file is zero-byte
// (AbloqBridge just opens and closes it), so all the output comes from the appended
// `&& echo <sentinel>`.
const DONE_FILE_PRESENT = `${COMPANION_FILE_PRESENT_SENTINEL}\n`;

// Mocks both adb() (used for the plain rm/broadcast/pm/settings calls) and execCompanionAdb()
// (used for the maxBuffer/timeout-overridable cat/run-as-cat calls) so dumpFullHierarchy's full
// happy/fallback paths can be exercised without a real device.
function mockFullRobot(config: {
	adb?: (args: string[]) => Buffer | string;
	execCompanionAdb?: (args: string[], options: { maxBuffer?: number; timeout?: number }) => Buffer | string | null;
}): { robot: AndroidA11yRobot; adbCalls: AdbCall[]; execCalls: ExecCall[] } {
	const robot = new AndroidA11yRobot("mock-device");
	const adbCalls: AdbCall[] = [];
	const execCalls: ExecCall[] = [];

	robot.adb = function(...args: string[]): Buffer {
		adbCalls.push({ args });
		const result = config.adb ? config.adb(args) : "";
		return Buffer.isBuffer(result) ? result : Buffer.from(result ?? "");
	};

	robot.execCompanionAdb = function(args: string[], options: { maxBuffer?: number; timeout?: number } = {}): Buffer {
		execCalls.push({ args, options });
		const result = config.execCompanionAdb ? config.execCompanionAdb(args, options) : null;
		if (result === null || result === undefined) {
			throw new Error("mock: no response configured for " + args.join(" "));
		}
		return Buffer.isBuffer(result) ? result : Buffer.from(result);
	};

	return { robot, adbCalls, execCalls };
}

// companion-available responder shared by the dumpFullHierarchy tests below.
const companionAvailableAdb = (args: string[]): string => {
	if (args.includes("packages")) {
		return "package:com.appsisle.developerassistant\n";
	}
	if (args.includes("enabled_accessibility_services")) {
		return `${COMPANION_PACKAGE}/${COMPANION_PACKAGE}.AssistAccessibilityService`;
	}
	return "";
};

test.describe("AndroidA11yRobot", () => {

	test.describe("isCompanionAvailable", () => {
		test("true when package is listed and its Accessibility Service is enabled", () => {
			const { robot } = mockRobot(args => {
				if (args.includes("packages")) {
					return "package:com.appsisle.developerassistant\n";
				}
				return "com.other.app/.Service:com.appsisle.developerassistant/com.jw.devassist.ui.services.accessibility.AssistAccessibilityService";
			});

			expect(robot.isCompanionAvailable()).toBe(true);
		});

		test("false when package is not installed", () => {
			const { robot } = mockRobot(args => args.includes("packages") ? "" : "");
			expect(robot.isCompanionAvailable()).toBe(false);
		});

		test("false when installed but Accessibility Service is not enabled", () => {
			const { robot } = mockRobot(args => {
				if (args.includes("packages")) {
					return "package:com.appsisle.developerassistant\n";
				}
				return "com.other.app/.Service";
			});

			expect(robot.isCompanionAvailable()).toBe(false);
		});

		test("false when adb throws (device unreachable, not android, etc)", () => {
			const robot = new AndroidA11yRobot("mock-device");
			robot.adb = () => { throw new Error("device offline"); };
			expect(robot.isCompanionAvailable()).toBe(false);
		});

		test("false when a colliding package name merely contains the companion's package as a substring", () => {
			const { robot } = mockRobot(args => {
				if (args.includes("packages")) {
					return "package:com.appsisle.developerassistant.evil\n";
				}
				return "com.appsisle.developerassistant.evil/.Service";
			});

			expect(robot.isCompanionAvailable()).toBe(false);
		});

		test("scopes `pm list packages` to user 0 so a device with a Secure Folder / work profile still detects the companion", () => {
			// Real failure on a Samsung SM-A366B with a Secure Folder (user 150): an unscoped
			// `pm list packages` throws inside ActivityManagerService.handleIncomingUser, which
			// isCompanionAvailable()'s catch turned into a permanent "companion not installed".
			const { robot, calls } = mockRobot(args => {
				if (args.includes("packages")) {
					if (!args.includes("--user")) {
						throw new Error("java.lang.SecurityException: Shell does not have permission to access user 150");
					}
					return "package:com.appsisle.developerassistant\n";
				}
				return `${COMPANION_PACKAGE}/${COMPANION_PACKAGE}.AssistAccessibilityService`;
			});

			expect(robot.isCompanionAvailable()).toBe(true);

			const pmCall = calls.find(c => c.args.includes("packages"))!;
			expect(pmCall.args).toContain("--user");
			expect(pmCall.args[pmCall.args.indexOf("--user") + 1]).toBe("0");
		});

		// Lock-in test (pins existing behavior rather than fixing a bug): an unset secure setting
		// prints the literal string "null", which used to be handled only by the coincidence that
		// "null" doesn't start with the package name - trivially inverted by a later "null fix".
		test("false when enabled_accessibility_services is unset and prints the literal string \"null\"", () => {
			const { robot } = mockRobot(args => {
				if (args.includes("packages")) {
					return "package:com.appsisle.developerassistant\n";
				}
				return "null\n";
			});

			expect(robot.isCompanionAvailable()).toBe(false);
		});

		test("false when a colliding service entry merely contains the companion's package as a substring", () => {
			const { robot } = mockRobot(args => {
				if (args.includes("packages")) {
					return "package:com.appsisle.developerassistant\n";
				}
				return "com.evil.com.appsisle.developerassistant/.Service";
			});

			expect(robot.isCompanionAvailable()).toBe(false);
		});
	});

	test.describe("getCurrentActivity", () => {
		test("parses package and activity name from dumpsys output", async () => {
			const { robot } = mockRobot(() =>
				"  mResumedActivity: ActivityRecord{a1b2c3 u0 com.example.app/com.example.app.MainActivity t42}\n"
			);

			const activity = await robot.getCurrentActivity();
			expect(activity).toEqual({ packageName: "com.example.app", activityName: "com.example.app.MainActivity" });
		});

		test("expands a relative activity name (leading dot) to fully-qualified", async () => {
			const { robot } = mockRobot(() =>
				"  mResumedActivity: ActivityRecord{a1b2c3 u0 com.example.app/.MainActivity t42}\n"
			);

			const activity = await robot.getCurrentActivity();
			expect(activity).toEqual({ packageName: "com.example.app", activityName: "com.example.app.MainActivity" });
		});

		test("parses the newer 'topResumedActivity=' form (no mResumedActivity present at all)", async () => {
			const { robot } = mockRobot(() =>
				"  topResumedActivity=ActivityRecord{a1b2c3 u0 com.example.app/com.example.app.MainActivity t42}\n" +
				"    ResumedActivity: ActivityRecord{a1b2c3 u0 com.example.app/com.example.app.MainActivity t42}\n"
			);

			const activity = await robot.getCurrentActivity();
			expect(activity).toEqual({ packageName: "com.example.app", activityName: "com.example.app.MainActivity" });
		});

		test("prefers display 0's resumed activity over one printed earlier for a secondary display", async () => {
			// Foldable outer screen / DeX / external display: dumpsys does not promise the
			// primary display comes first, so "first regex hit" reported the wrong app.
			const { robot } = mockRobot(() =>
				"Display #1 (activities from top to bottom):\n" +
				"  Stack #101:\n" +
				"    mResumedActivity: ActivityRecord{aaa u0 com.secondary.app/.SecondaryActivity t101}\n" +
				"Display #0 (activities from top to bottom):\n" +
				"  Stack #1:\n" +
				"    mResumedActivity: ActivityRecord{bbb u0 com.primary.app/.MainActivity t1}\n"
			);

			const activity = await robot.getCurrentActivity();
			expect(activity).toEqual({ packageName: "com.primary.app", activityName: "com.primary.app.MainActivity" });
		});

		test("prefers the user-0 resumed activity over a secondary user's (Secure Folder / work profile) listed first", async () => {
			const { robot } = mockRobot(() =>
				"Display #0 (activities from top to bottom):\n" +
				"  Task #200:\n" +
				"    mResumedActivity: ActivityRecord{ccc u150 com.samsung.securefolder/.VaultActivity t200}\n" +
				"  Task #1:\n" +
				"    mResumedActivity: ActivityRecord{ddd u0 com.primary.app/.MainActivity t1}\n"
			);

			const activity = await robot.getCurrentActivity();
			expect(activity).toEqual({ packageName: "com.primary.app", activityName: "com.primary.app.MainActivity" });
		});

		test("prefers the global topResumedActivity over an earlier split-screen ResumedActivity", async () => {
			const { robot } = mockRobot(() =>
				"Display #0 (activities from top to bottom):\n" +
				"  ResumedActivity: ActivityRecord{aaa u0 com.split.left/.LeftActivity t10}\n" +
				"  ResumedActivity: ActivityRecord{bbb u0 com.split.right/.RightActivity t11}\n" +
				"  topResumedActivity=ActivityRecord{bbb u0 com.split.right/.RightActivity t11}\n"
			);

			const activity = await robot.getCurrentActivity();
			expect(activity).toEqual({ packageName: "com.split.right", activityName: "com.split.right.RightActivity" });
		});

		test("ignores mLastResumedActivity (the previous activity), which also contains \"ResumedActivity\"", async () => {
			const { robot } = mockRobot(() =>
				"  mLastResumedActivity: ActivityRecord{aaa u0 com.previous.app/.OldActivity t9}\n" +
				"  mResumedActivity: ActivityRecord{bbb u0 com.current.app/.MainActivity t10}\n"
			);

			const activity = await robot.getCurrentActivity();
			expect(activity).toEqual({ packageName: "com.current.app", activityName: "com.current.app.MainActivity" });
		});

		test("throws ActionableError when dumpsys output has no mResumedActivity", async () => {
			const { robot } = mockRobot(() => "no match here\n");
			await expect(robot.getCurrentActivity()).rejects.toThrow(/current foreground activity/);
		});

		test("throws ActionableError (not a raw Error) when adb throws", async () => {
			const robot = new AndroidA11yRobot("mock-device");
			robot.adb = () => { throw new Error("error: device 'mock-device' not found"); };
			await expect(robot.getCurrentActivity()).rejects.toThrow(/Could not query the current foreground activity/);
		});
	});

	test.describe("dumpFullHierarchy", () => {
		test("throws ActionableError immediately when companion is unavailable, without broadcasting", async () => {
			const { robot, calls } = mockRobot(() => "");
			await expect(robot.dumpFullHierarchy()).rejects.toThrow(/companion app is not installed/);
			expect(calls.some(c => c.args.includes("broadcast"))).toBe(false);
		});

		test("run-as fallback reads use the original absolute path, not a relative one", async () => {
			const { robot, execCalls } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => {
					// plain `cat` always fails; run-as `cat` succeeds - forces both the .done poll
					// and the dump-content read through the fallback branch.
					if (args.includes("run-as") && args.includes(DONE_PATH)) {
						return DONE_FILE_PRESENT;
					}
					if (args.includes("run-as") && args.includes(DUMP_PATH)) {
						return "[]";
					}
					return null;
				},
			});

			const result = await robot.dumpFullHierarchy();
			expect(result).toEqual([]);

			const runAsCalls = execCalls.filter(c => c.args.includes("run-as"));
			expect(runAsCalls.length).toBeGreaterThan(0);
			for (const call of runAsCalls) {
				// the bug this guards against: passing a path relative to run-as's internal-storage
				// cwd instead of the absolute external-storage path the dump is actually written to.
				expect(call.args.some(a => a === DONE_PATH || a === DUMP_PATH)).toBe(true);
				expect(call.args.some(a => a.startsWith("files/"))).toBe(false);
			}
		});

		test("cleanup falls back to run-as rm -f with absolute paths when plain rm -f throws", async () => {
			const { robot, adbCalls } = mockFullRobot({
				adb: args => {
					if (args.includes("rm") && !args.includes("run-as")) {
						throw new Error("Permission denied");
					}
					return companionAvailableAdb(args);
				},
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : args.includes(DUMP_PATH) ? "[]" : null),
			});

			await robot.dumpFullHierarchy();

			const runAsRm = adbCalls.find(c => c.args.includes("run-as") && c.args.includes("rm"));
			expect(runAsRm).toBeTruthy();
			expect(runAsRm!.args).toContain(DONE_PATH);
			expect(runAsRm!.args).toContain(DUMP_PATH);
		});

		test("the .done-file poll uses a short per-attempt timeout, not the inherited 30s default", async () => {
			const { robot, execCalls } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : args.includes(DUMP_PATH) ? "[]" : null),
			});

			await robot.dumpFullHierarchy();

			const donePollCalls = execCalls.filter(c => c.args.includes(DONE_PATH));
			expect(donePollCalls.length).toBeGreaterThan(0);
			for (const call of donePollCalls) {
				expect(call.options.timeout).toBe(DONE_POLL_TIMEOUT_MS);
			}
		});

		test("the dump-content read uses an enlarged maxBuffer, not the inherited 8MB default", async () => {
			const { robot, execCalls } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : args.includes(DUMP_PATH) ? "[]" : null),
			});

			await robot.dumpFullHierarchy();

			const dumpReadCalls = execCalls.filter(c => c.args.includes(DUMP_PATH));
			expect(dumpReadCalls.length).toBeGreaterThan(0);
			for (const call of dumpReadCalls) {
				expect(call.options.maxBuffer).toBe(DUMP_CONTENT_MAX_BUFFER);
			}
		});

		test("throws before broadcasting when cleanup fails and a stale .done file is still readable", async () => {
			const { robot, adbCalls } = mockFullRobot({
				adb: args => {
					if (args.includes("rm")) {
						throw new Error("Permission denied");
					}
					return companionAvailableAdb(args);
				},
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : null),
			});

			await expect(robot.dumpFullHierarchy()).rejects.toThrow(/previous accessibility dump.*still present/s);
			expect(adbCalls.some(c => c.args.includes("broadcast"))).toBe(false);
		});

		test("does not throw when cleanup fails but no stale file exists yet (first run)", async () => {
			let doneCatCalls = 0;
			const { robot, adbCalls } = mockFullRobot({
				adb: args => {
					if (args.includes("rm")) {
						throw new Error("Permission denied");
					}
					return companionAvailableAdb(args);
				},
				execCompanionAdb: args => {
					if (args.includes(DONE_PATH)) {
						doneCatCalls++;
						// first two attempts (plain + run-as, pre-broadcast existence check) fail;
						// later attempts (during the post-broadcast poll) succeed.
						return doneCatCalls <= 2 ? null : DONE_FILE_PRESENT;
					}
					if (args.includes(DUMP_PATH)) {
						return "[]";
					}
					return null;
				},
			});

			const result = await robot.dumpFullHierarchy();
			expect(result).toEqual([]);
			expect(adbCalls.some(c => c.args.includes("broadcast"))).toBe(true);
		});

		test("throws ActionableError when the dump content is malformed JSON", async () => {
			const { robot } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : args.includes(DUMP_PATH) ? "{not json" : null),
			});

			await expect(robot.dumpFullHierarchy()).rejects.toThrow(/wasn't valid JSON/);
		});

		test("throws ActionableError when the dump is valid JSON but the wrong node shape", async () => {
			const { robot } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : args.includes(DUMP_PATH) ? "[{\"index\":\"not-a-number\"}]" : null),
			});

			await expect(robot.dumpFullHierarchy()).rejects.toThrow(/expected accessibility-node shape/);
		});

		test("throws ActionableError when the dump is valid JSON but not an array", async () => {
			const { robot } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : args.includes(DUMP_PATH) ? "{\"foo\":\"bar\"}" : null),
			});

			await expect(robot.dumpFullHierarchy()).rejects.toThrow(/expected accessibility-node shape/);
		});

		test("deletes the dump files again after a successful read", async () => {
			const { robot, adbCalls } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : args.includes(DUMP_PATH) ? "[]" : null),
			});

			await robot.dumpFullHierarchy();

			const rmDoneCalls = adbCalls.filter(c => c.args.includes("rm") && c.args.includes(DONE_PATH));
			expect(rmDoneCalls.length).toBe(2); // once pre-broadcast, once post-read
		});

		test("still returns the parsed result even if post-read cleanup fails", async () => {
			let rmCallCount = 0;
			const { robot } = mockFullRobot({
				adb: args => {
					if (args.includes("rm")) {
						rmCallCount++;
						if (rmCallCount === 1) {
							return ""; // pre-broadcast cleanup succeeds
						}
						throw new Error("Permission denied"); // post-read cleanup fails (plain + run-as)
					}
					return companionAvailableAdb(args);
				},
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : args.includes(DUMP_PATH) ? "[]" : null),
			});

			const result = await robot.dumpFullHierarchy();
			expect(result).toEqual([]);
		});

		test("scopes the dump broadcast to user 0, matching the user-0 companion install", async () => {
			const { robot, adbCalls } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : args.includes(DUMP_PATH) ? "[]" : null),
			});

			await robot.dumpFullHierarchy();

			const broadcast = adbCalls.find(c => c.args.includes("broadcast"))!;
			expect(broadcast.args).toContain("--user");
			expect(broadcast.args[broadcast.args.indexOf("--user") + 1]).toBe("0");
		});

		test("throws ActionableError (not a raw execFileSync Error) when the broadcast itself fails", async () => {
			const { robot } = mockFullRobot({
				adb: args => {
					if (args.includes("broadcast")) {
						// what execFileSync really throws: full adb path + argv + stderr
						throw new Error("Command failed: /home/user/Android/Sdk/platform-tools/adb -s mock-device shell am broadcast --user 0 -a com.abloq.bridge.ACTION_DUMP\nerror: device 'mock-device' not found\n");
					}
					return companionAvailableAdb(args);
				},
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : args.includes(DUMP_PATH) ? "[]" : null),
			});

			const error = await robot.dumpFullHierarchy().then(() => null, (err: unknown) => err);
			expect(error).toBeInstanceOf(ActionableError);
			expect(String((error as Error).message)).toMatch(/Could not broadcast com\.abloq\.bridge\.ACTION_DUMP .*mock-device/s);
		});

		test("does not accept a missing .done file as 'dump ready' when adb fails to propagate cat's exit code", async () => {
			// Old adb server / OEM shell: `cat` of a nonexistent file yields empty stdout and
			// exit 0, so nothing throws. Without positive evidence (the `&& echo <sentinel>`
			// token) that looks "ready" on the first poll and returns the previous screen's dump.
			const staleDump = JSON.stringify([{
				index: 0, parentIndex: null, windowId: 1, className: "android.widget.TextView",
				resourceId: null, text: "stale", contentDescription: null, hintText: null,
				checkable: false, checked: false, clickable: false, longClickable: false,
				focusable: false, focused: false, enabled: true, selected: false, visible: true,
				boundsInScreen: null,
			}]);
			const { robot, execCalls } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => {
					if (args.includes(DONE_PATH)) {
						return "";
					}
					if (args.includes(DUMP_PATH)) {
						return staleDump;
					}
					return null;
				},
			});

			await expect(robot.dumpFullHierarchy()).rejects.toThrow(/No hierarchy dump appeared/);
			expect(execCalls.some(c => c.args.includes(DUMP_PATH))).toBe(false);
		});

		test("the .done presence check asks for positive evidence, not just a non-failing cat", async () => {
			const { robot, execCalls } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : args.includes(DUMP_PATH) ? "[]" : null),
			});

			await robot.dumpFullHierarchy();

			const doneChecks = execCalls.filter(c => c.args.includes(DONE_PATH));
			expect(doneChecks.length).toBeGreaterThan(0);
			for (const call of doneChecks) {
				expect(call.args).toContain("&&");
				expect(call.args).toContain(COMPANION_FILE_PRESENT_SENTINEL);
			}
			// the dump content itself must stay byte-exact - no sentinel appended there, or the
			// JSON would not parse.
			for (const call of execCalls.filter(c => c.args.includes(DUMP_PATH))) {
				expect(call.args).not.toContain(COMPANION_FILE_PRESENT_SENTINEL);
			}
		});

		test("says run-as is inapplicable (app not debuggable) instead of blaming permissions generically", async () => {
			const { robot } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => {
					if (args.includes(DONE_PATH)) {
						return DONE_FILE_PRESENT;
					}
					if (args.includes("run-as")) {
						throw new Error("run-as: Package 'com.appsisle.developerassistant' is not debuggable.");
					}
					throw new Error("cat: /sdcard/Android/data/com.appsisle.developerassistant/files/abloq_dump.json: No such file or directory");
				},
			});

			const error = await robot.dumpFullHierarchy().then(() => null, (err: unknown) => err);
			expect(error).toBeInstanceOf(ActionableError);
			const message = String((error as Error).message);
			// names the real cause (the plain read) and why run-as was never going to help
			expect(message).toMatch(/not marked\s+android:debuggable/);
			expect(message).toMatch(/No such file or directory/);
			// and does not tell the user this is a shell-permission problem they can fix
			expect(message).not.toMatch(/Neither the shell user nor run-as/);
		});

		test("keeps the generic both-attempts-failed message when run-as failed for a real permission reason", async () => {
			const { robot } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => {
					if (args.includes(DONE_PATH)) {
						return DONE_FILE_PRESENT;
					}
					throw new Error("cat: /sdcard/Android/data/com.appsisle.developerassistant/files/abloq_dump.json: Permission denied");
				},
			});

			await expect(robot.dumpFullHierarchy()).rejects.toThrow(/Neither the shell user nor run-as/);
		});

		test("logs both plain and run-as failure details before returning null on the final content read", async () => {
			const { robot } = mockFullRobot({
				adb: companionAvailableAdb,
				execCompanionAdb: args => (args.includes(DONE_PATH) ? DONE_FILE_PRESENT : null),
			});

			const captured: string[] = [];
			const originalConsoleError = console.error;
			console.error = (msg: string) => { captured.push(String(msg)); };
			try {
				await expect(robot.dumpFullHierarchy()).rejects.toThrow(/Could not read/);
			} finally {
				console.error = originalConsoleError;
			}

			expect(captured.some(line => line.includes(DUMP_PATH))).toBe(true);
		});
	});

	test.describe("resolveAdbPath", () => {
		const originalPlatform = process.platform;
		const originalAndroidHome = process.env.ANDROID_HOME;
		const originalLocalAppData = process.env.LOCALAPPDATA;

		test.afterEach(() => {
			Object.defineProperty(process, "platform", { value: originalPlatform });
			if (originalAndroidHome === undefined) {
				delete process.env.ANDROID_HOME;
			} else {
				process.env.ANDROID_HOME = originalAndroidHome;
			}
			if (originalLocalAppData === undefined) {
				delete process.env.LOCALAPPDATA;
			} else {
				process.env.LOCALAPPDATA = originalLocalAppData;
			}
		});

		test("falls back to adb.exe on win32 without ANDROID_HOME or a detected SDK path", () => {
			Object.defineProperty(process, "platform", { value: "win32" });
			delete process.env.ANDROID_HOME;
			process.env.LOCALAPPDATA = "/definitely/not/a/real/path";
			expect(resolveAdbPath()).toBe("adb.exe");
		});

		test("falls back to plain adb on non-win32 without ANDROID_HOME", () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			delete process.env.ANDROID_HOME;
			expect(resolveAdbPath()).toBe("adb");
		});

		test("prefers ANDROID_HOME's platform-tools/adb.exe on win32", () => {
			Object.defineProperty(process, "platform", { value: "win32" });
			process.env.ANDROID_HOME = "/fake/sdk";
			expect(resolveAdbPath()).toBe(path.join("/fake/sdk", "platform-tools", "adb.exe"));
		});
	});
});
