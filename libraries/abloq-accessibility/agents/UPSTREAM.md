# Upstream

Forked from https://github.com/mobile-next/mobile-mcp
Commit: 409e0a203f0cc843d02403f242f558b6b87d3bff (2026-08-18)
License: Apache-2.0 (see LICENSE - unchanged, this fork stays Apache-2.0)

Copied in wholesale (not a git subtree/submodule) to keep this a single-repo monorepo
checkout, per the approved plan. Full upstream commit history was intentionally not
imported to avoid creating a git commit without being asked to - ask before doing a
history-preserving `git subtree add` if that's wanted later.

## What's added on top (all in src/android-a11y/, non-invasive to upstream files)

See ../../../.claude/plans/your-mission-is-moonlit-phoenix.md for the full plan.
- New Android-only tools that talk to the patched Developer Assistant companion app
  (../app/patch/) over adb broadcast + file pull for precise full-hierarchy dumps,
  current-activity tracking, and install-attempt observation.
- Splices into src/server.ts's getRobotFromDevice() *before* the upstream mobilecli
  check, so these tools work without requiring the mobilecli binary - they wrap the
  legacy AndroidRobot (src/android.ts) directly via plain adb.
- All existing upstream tools/behavior are unmodified.
