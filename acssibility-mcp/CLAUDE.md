# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository root vs. working directories

The git repository root is `/home/hacker/projects/android/abloq` — one level up from here.
`acssibility-mcp/` (this directory) is empty and unused; it was superseded by
`../libraries/abloq-accessibility/` and should be ignored (do not populate it). `../Agents/` is
also an empty, unused placeholder. All real work lives under `../libraries/abloq-accessibility/`.

No commits have been made to this repo yet — everything is uncommitted working-tree state. Do not
commit unless explicitly asked.

## What this project is

A precision Android UI-hierarchy MCP server: drive any app via adb and pull its *complete*,
unfiltered accessibility node tree (resource-id, class, text, bounds, checkable/checked state,
clickable/focusable/enabled/selected flags, tree structure) plus exact foreground
package/Activity — not the filtered view existing Android automation MCPs provide. See
`../.claude/plans/your-mission-is-moonlit-phoenix.md` for the full approved plan and rationale.

Two components under `../libraries/abloq-accessibility/`:

### `app/` — patched Developer Assistant APK (the data source)

Rather than reimplementing hierarchy-walking, this patches the real `com.appsisle.developerassistant`
("Developer Assistant") Play Store app — decompiled, found to be **unobfuscated in its own code**
(only third-party library packages are R8-obfuscated) with a ready-made full-hierarchy dump engine
(`o7.a.e().g().d()`) already capturing everything needed, including switch/checked state. A small
injected class (`AbloqBridge`) adds a headless adb-triggerable `BroadcastReceiver` that calls that
existing engine and serializes the result to JSON — reusing the app's own inspection logic rather
than rewriting it. Only one line of the app's own code is touched (a call added in
`AssistAccessibilityService.onServiceConnected()`).

- **Read `app/recon/RECON.md` first** before touching anything in `app/patch/` — it documents the
  app's internal classes/methods/data model this patch depends on, and *why* this exact patch shape
  (dynamically-registered receiver, not a manifest-declared component) was chosen: both of the app's
  real entry points (`AssistService`, `AssistAccessibilityService`) are gated by system-signature
  permissions adb can't hold, so the injection point is a receiver registered from *inside* the
  already-running accessibility service process instead.
- `app/patch/apply_patch.sh` is the full reproducible pipeline: pull latest APK → decode with apktool
  (smali only) → compile+dex+baksmali the new `AbloqBridge` class against compile-only stubs of the
  app's internal API (`app/patch/stub_src/`) → splice the resulting smali in as `smali_classes2/` →
  patch the one hook call-site → reassemble dex directly with `smali`/`baksmali` CLI tools → splice
  the dex into an **unmodified copy of the original APK zip** → zipalign → sign with a local
  throwaway keystore (auto-generated on first run). Re-run this whenever the upstream app updates.
- **Deliberately bypasses apktool's resource rebuild entirely** (`res/`, `resources.arsc` are copied
  byte-identical from the original APK, never decoded/recompiled) — apktool/aapt reproducibly fails
  on this app's generated `$avd_*`-prefixed AnimatedVectorDrawable resource names, a known
  apktool limitation unrelated to this patch. If a future patch genuinely needs a manifest/resource
  change, that bug will need solving first; don't assume `apktool b` alone will just work here.
- Output: `app/patch/devassistant_patched_signed.apk`. Regenerable build artifacts
  (`app/patch/build/`, `app/recon/apk/`, `app/recon/jadx_out/`) are gitignored; only recon findings
  and patch source are meant to be committed.
- **Explicit non-goal**: no DeviceAdminReceiver/DevicePolicyManager/enforcement logic lives here or
  anywhere in this repo. This project is observation-only; app-install blocking/enforcement is a
  separate, already-existing system outside this project's scope.

### `agents/` — the MCP server (fork of `mobile-next/mobile-mcp`)

A wholesale copy (not a git submodule/subtree) of `mobile-next/mobile-mcp` at the commit recorded in
`agents/UPSTREAM.md`, Apache-2.0, kept as-is. New Android-only code lives entirely in
`agents/src/android-a11y/` and is additive — no existing upstream file is modified except
`src/server.ts`, which gets exactly two small splices (see below); all upstream tools/tests/behavior
are otherwise untouched.

- `src/android-a11y/android-a11y-robot.ts` — `AndroidA11yRobot extends AndroidRobot` (the upstream
  legacy direct-adb robot from `src/android.ts`), so every existing capability (tap, swipe,
  screenshot, app lifecycle, etc.) is inherited for free. Adds `isCompanionAvailable()`,
  `dumpFullHierarchy()` (talks to the patched app in `../app/patch/` via adb broadcast + file
  read, with a `run-as` fallback for devices where the shell user can't read another app's
  external-files-dir), and `getCurrentActivity()` (plain `dumpsys activity activities`, independent
  of the companion app).
- `src/server.ts`: `getRobotFromDevice()` tries `AndroidA11yRobot` **before** upstream's own
  `ensureMobilecliAvailable()` check, and falls through silently to unmodified upstream behavior
  (mobilecli, or `MOBILEMCP_LEGACY_ROBOT=1`) if the device isn't Android or the companion app isn't
  present. This means the new `mobile_android_*` tools work without requiring users to install the
  separate `mobilecli` binary that upstream's default path now needs.
- New tools registered: `mobile_android_companion_status`, `mobile_android_dump_full_hierarchy`,
  `mobile_android_get_current_activity`. Not yet implemented: install-attempt observation (would need
  a second bridge subsystem watching accessibility events for installer-window packages) — a known
  gap, not silently dropped.
- Node ids in `dumpFullHierarchy()`'s output are plain array indices with a `parentIndex` field per
  node (index into the same array, `null` at the root) — there is no persistent/stable node-id
  scheme or write/click tools yet (read-only dump + current-activity only, so far).

## Commands

All from `../libraries/abloq-accessibility/agents/`:
```
npm install
npm run build      # tsc && chmod +x lib/index.js
npm run lint       # eslint .
npm run fixlint    # eslint . --fix
npm run test       # c8 playwright test  (run a single file: npx playwright test test/<file>.test.ts)
```

Rebuilding the patched APK, from `../libraries/abloq-accessibility/app/patch/`:
```
./apply_patch.sh   # pulls latest APK, patches, signs -> devassistant_patched_signed.apk
```

## Testing on a real/emulated device

No physical device is assumed to be attached. An x86_64 API 34 (`google_apis`) AVD named
`abloq_test` was set up for this via `avdmanager`/`sdkmanager` (`~/Android/Sdk`) — `/dev/kvm` is
accessible to the `hacker` user (confirmed via ACL) so hardware acceleration works. Boot it headless
with `~/Android/Sdk/emulator/emulator -avd abloq_test -no-window -no-audio -no-boot-anim
-gpu host -accel on`, then poll `adb shell getprop sys.boot_completed` until it returns `1`.
The emulator process does not survive a session boundary (background processes are not preserved
across Claude Code sessions) — it must be relaunched at the start of any session that needs one.

Manual end-to-end check once a device is up:
```
adb install -r ../libraries/abloq-accessibility/app/patch/devassistant_patched_signed.apk
# enable Accessibility for "Developer Assistant" once under Settings, manually
adb shell am broadcast -a com.abloq.bridge.ACTION_DUMP
adb shell cat /sdcard/Android/data/com.appsisle.developerassistant/files/abloq_dump.json
```
