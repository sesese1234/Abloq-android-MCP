# abloq-accessibility

Precision Android UI-hierarchy MCP. Two components:

- **`app/`** — patch pipeline for `com.appsisle.developerassistant` (Developer Assistant). Adds a
  minimal `AbloqBridge` receiver that reuses the app's own AccessibilityService hierarchy-dump
  engine and exposes it over adb. See `app/recon/RECON.md` for how the app works internally and
  why this patch shape was chosen, and `app/patch/apply_patch.sh` to (re)build it.
  **Status: patch built, signed, and verified structurally sound (apksigner verify passes).
  On-device install/trigger/pull verification is still pending — needs a connected device.**
- **`agents/`** — the MCP server (fork of `mobile-next/mobile-mcp`) that drives navigation via the
  existing upstream tools and adds Android-only tools that talk to the patched app for full
  hierarchy dumps, current-activity tracking, and install-attempt observation.
  **Status: not started yet.**

See `/home/hacker/.claude/plans/your-mission-is-moonlit-phoenix.md` for the full approved plan
(scope, milestones, explicit non-goals — no enforcement/DPM logic lives here).

## Quick start (once a device is connected)

```bash
adb install -r app/patch/devassistant_patched_signed.apk
# enable Accessibility for "Developer Assistant" in Settings once, manually
adb shell am broadcast -a com.abloq.bridge.ACTION_DUMP
adb shell run-as com.appsisle.developerassistant cat files/abloq_dump.json  # or adb pull, if externally readable
```
