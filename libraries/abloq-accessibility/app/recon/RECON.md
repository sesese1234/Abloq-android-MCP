# Recon: com.appsisle.developerassistant (Developer Assistant) v1.4.2 (versionCode 2002001042)

Pulled via `apk-pull-gplay` (real Google Play). Decompiled with `jadx` (readable source, `recon/jadx_out/`) and `apktool` (smali, `apktool_mcp_server_workspace/devassistant_decode/` under the apktool-mcp server's workspace). minSdk 26, targetSdk 36, compileSdk 36.

## Headline finding: the app's own code is NOT obfuscated

R8/ProGuard only obfuscates class/method *names* in a subset of internal packages (`o7`, `q7`, `da`, `e8`, `y7`, `g0`, etc. — single/double-letter packages). The app's own well-known packages (`com.jw.devassist.*`, `com.jw.base.*`) keep full real names — Activities/Services/Receivers must anyway (manifest resolution requires it). Field names inside the obfuscated packages are mangled (`f9043e`, `f9058t`, ...) but all the methods/fields we need are `public`, so they're directly callable/referencable by exact name from injected code compiled separately — no reflection needed anywhere in the patch.

## 1. AccessibilityService — confirmed

`com.jw.devassist.ui.services.accessibility.AssistAccessibilityService` (manifest: `exported=true`, `permission=BIND_ACCESSIBILITY_SERVICE`, config `@xml/accessibility_service`). Implements `q7.d.a` (single-method callback interface: `da.b a()`).

`onServiceConnected()`:
```java
this.f8038a.e(this);   // f8038a is a q7.d instance — registers itself as the live data provider
if ((getServiceInfo().flags & 256) != 0) d();  // sets up the a11y-button callback
```

`onAccessibilityEvent()` is currently a no-op (just logs + recycles).

## 2. The exact "dump everything" call — already exists, no synthesis needed

```java
// AssistAccessibilityService.a()  (implements q7.d.a)
AccessibilityNodeInfo root = getRootInActiveWindow();
da.b result = new da.b(this, List.of(root));   // g0.g.a(...) just wraps varargs into a List
return result;
```

`da.b` (constructor walks the tree recursively via `AccessibilityNodeInfo.getChild(i)`, calling `.recycle()` on each node after reading it — standard correct lifecycle):
- `List d()` → **flat list of every node in the tree** (all descendants, root included) — exactly the "full hierarchy dump" the mission needs, already built.
- `List c()` → just the root(s).
- `b()` → `!isEmpty()`.

**Global access, no need to go through the AccessibilityService instance at all:** `o7.a.e().g()` (static singleton, initialized in `DevAssistApplication.onCreate()`) returns the live `q7.d` bridge. Its `.d()` method calls back into whichever `q7.d.a` most recently registered (i.e. `AssistAccessibilityService`, via the `f8038a.e(this)` call above) and returns the same `da.b`. **So any class running in the app process can call `o7.a.e().g().d()` to get a fresh live dump, with zero dependency on knowing it's talking to an AccessibilityService under the hood.** This is the injection point.

## 3. Per-node data model — already captures everything the mission asked for

`da.a extends e8.a implements e8.j` (`e8.j extends e8.h`), built in `da.b.f()` per `AccessibilityNodeInfo`:

| Data | Accessor | Source |
|---|---|---|
| window id | `v()` | `getWindowId()` |
| resource id (resolved, human-readable) | `u()` → `y7.a` struct (`.h()` pkg, `.i()` type, `.k()` entry, `.f()` numeric id) | `y7.a.l(viewIdResourceName, packageName, resources)` |
| class name | `o()` | `getClassName()` |
| text | `l()` | `getText()` |
| content description | `s()` | `getContentDescription()` |
| hint text | `y()` | `getHintText()` |
| bounds in screen | `C()` → `e8.d` struct, public field `c` (RectF, already mapped to screen coords) — baksmali ground truth is `.field public final c:Landroid/graphics/RectF;`; jadx displays this as `f9090c`, see 5a | `getBoundsInScreen()` |
| checkable / **checked (switch state)** | `isCheckable()` / `isChecked()` | confirmed present — this was flagged as an open risk pre-recon, now resolved |
| clickable / long-clickable | `e()` / `h()` | |
| focusable / focused | `f()` / `w()` | |
| enabled | `isEnabled()` | |
| selected | `n()` | |
| visible | `z()` (0=visible, 8=gone, reusing `View` constants) | `isVisibleToUser()` |
| parent | `a()` → `e8.j` (null at root) | tree-walk sets this during construction |
| children | `b()` → `List` | not needed for our dump — `parentIndex` per node is enough |

No `AccessibilityAction` list is captured in this per-node dump (their UI fetches actions separately per-element when the user drills in — `ui/properties/actions/*`). Not needed for the mission's "full hierarchy" ask; flagged as a real gap only if a future `get_node_detail`-style tool needs it — would require a small additional hook, not a blocker for the core dump.

## 4. Trigger path — real UI flow is permission-gated; the injection bypasses it correctly

- `AssistService` (`VoiceInteractionService`, manifest `permission=BIND_VOICE_INTERACTION`) and `AssistAccessibilityService` (`permission=BIND_ACCESSIBILITY_SERVICE`) are both **system-signature-permission gated** — `adb shell am start-service`/`am broadcast` from the `shell` UID cannot start or bind either directly. This confirms the plan's assumption that a direct adb-to-exported-component trigger wasn't going to work.
- The real flow: Assistant-button/gesture → `AssistAccessibilityService`'s `AccessibilityButtonCallback.onClicked()` → `startService(AssistService...)` → `VoiceInteractionService.showSession()` → `AssistSessionService.onNewSession()` → session UI calls `o7.a.e().g().d()` to get the dump and render it.
- **The injection point is different and doesn't touch any of the gated components**: once `AssistAccessibilityService` is running (user turned it on once in Settings, same as using the app normally), it is a live, long-running process. A `BroadcastReceiver` **dynamically registered from inside that already-running process** (`Context.registerReceiver(...)`, called from our own new code, not declared in the manifest at all) is reachable by adb (`registerReceiver` with `RECEIVER_EXPORTED` on API 33+, plain/unprotected pre-33) without needing any signature permission — it's just an ordinary broadcast the app's own process chooses to listen for.

## 5. Chosen patch (one hook call-site + one new package, no manifest edit)

**New code** (compiled separately as plain Java, dexed with `d8`, disassembled with `baksmali`, dropped into a new `smali_classes2/com/abloq/bridge/` — never touching the app's existing smali):

`com.abloq.bridge.AbloqBridge` (`extends BroadcastReceiver`):
- `static void install(Context)` — registers itself for `ACTION_DUMP` (`RECEIVER_EXPORTED` on API 33+, guarded by `Build.VERSION.SDK_INT`, since minSdk is 26 and that overload doesn't exist below 33).
- `onReceive()` → calls `o7.a.e().g().d()`, walks the flat node list, serializes every field in the table above (via `org.json`, already on the platform — zero new dependencies) to a JSON array, writes it atomically (`.tmp` → rename) to `getExternalFilesDir(null)`, plus a `.done` sentinel file — `adb pull`-able without root.

**Single edit to existing code**: `AssistAccessibilityService.smali`, `onServiceConnected()` — one added line after the existing `this.f8038a.e(this);` call:
```smali
invoke-static {p0}, Lcom/abloq/bridge/AbloqBridge;->install(Landroid/content/Context;)V
```

This is the entire footprint. It reuses 100% of the app's real inspection engine (their tree walk, their data model, their resource-id resolution) — the only new logic is the trigger receiver and the JSON serialization/file-write, exactly the "thin bridge" scoped in the approved plan.

## 5a. FIXED BUG — `e8.d.f9090c` is not a real field name; it's jadx's cosmetic rename

> **Status: FIXED** (2026-08-20). `stub_src/e8/d.java` now declares `public final RectF c` and
> `AbloqBridge.java` references `bounds.c` (the null check plus `.left`/`.top`/`.right`/`.bottom`,
> 5 references total) instead of `bounds.f9090c`. Verified against baksmali ground truth
> (`.field public final c:Landroid/graphics/RectF;`) and recompiled clean with the exact
> `apply_patch.sh` javac invocation. The rest of this section is preserved as the record of the
> bug and, more importantly, the jadx-rename lesson below — do not delete it.

**Symptom** (live device, `logcat`): `AbloqBridge.dumpToFile()` throws
`java.lang.NoSuchFieldError: No field f9090c of type Landroid/graphics/RectF; in class Le8/d;` at
`AbloqBridge.java:113`, every time — the receiver is alive and the broadcast is delivered
correctly (confirmed via `logcat`), but the dump always crashes before writing any file. This
made every en-route symptom look like a permissions/Doze problem (no `.done` file ever appears)
when the real cause is this field reference.

**Root cause**: `recon/jadx_out/sources/e8/d.java` decompiles the field as
`public final RectF f9090c;`, with jadx's own inline comment above it: `/* JADX INFO: renamed
from: c, reason: collision with root package name */`. That comment is jadx admitting it invented
`f9090c` for *display* purposes only — the real compiled field, confirmed directly from
`baksmali`-disassembled smali (ground truth, not jadx's pretty-printer), is:
```
.field public final c:Landroid/graphics/RectF;
```
Point 2's table row above ("bounds in screen ... public field `f9090c`") and `stub_src/e8/d.java`
(`public final RectF f9090c = null;`) both copied jadx's renamed display name instead of the real
`c`. `AbloqBridge.java` compiled cleanly against the wrong-but-plausible stub name, produced valid
bytecode referencing a field that doesn't exist in the real app, and only fails at runtime once
merged into the actual APK — this is invisible at build time, which is why `apply_patch.sh`
succeeding and installing cleanly gave false confidence.

**Fix** (applied 2026-08-20): in `patch/stub_src/e8/d.java`, the field `f9090c` was renamed to `c`.
In `patch/bridge_src/com/abloq/bridge/AbloqBridge.java`, the references to `bounds.f9090c` (the
null check plus `.left`/`.top`/`.right`/`.bottom`) became `bounds.c`. This is the *only* field
access by name anywhere in `AbloqBridge.java` — every other cross-class access in that file is a
method call (`node.a()`, `node.v()`, `resId.h()`, etc.), which resolves by signature and so was not
affected. During this fix, every symbol `AbloqBridge.java` touches was re-audited against
baksmali ground truth (not jadx): `o7.a.e()/.g()`, `q7.d.d()`, `da.b.d()`, all `e8.j`/`e8.a`
method calls, `y7.a.h()/i()/k()/f()`, and this `e8.d.c` field — the field was the sole mismatch.
The patch now compiles clean and is expected to run; re-run `apply_patch.sh`, reinstall, and
confirm a live dump writes `abloq_dump.json` + `.done` without a `NoSuchFieldError`.

**Broader risk this exposes**: jadx applies this same `fNNNNN<letter>`-style rename to *any*
short/obfuscated field name it judges collision-prone (the whole `e8.d` class got this treatment —
`a`→`f9088a`, `b`→`f9089b`, `c`→`f9090c`, `d`→`f9091d`, `e`→`f9092e`, `f`→`f9093f`, `g`→`f9094g` —
and this doc's own headline claim in section 0, "`f9043e`, `f9058t`", may itself describe jadx's
renamed display names rather than ground truth). **Method names were not affected** by this bug —
`AbloqBridge.java` makes zero other field accesses, only method calls, and Java method dispatch
resolves by signature, not by a name that jadx can silently swap — so the existing patch's method
calls (`o7.a.e()`, `.g()`, `.d()`, `node.a()`, `node.u()`, etc.) are not suspected of the same
failure mode. But if any *future* patch needs to reference a field by name again, verify it against
`baksmali`-disassembled smali (`baksmali disassemble classes.dex -o <out>`, extracted from
`recon/apk/com.appsisle.developerassistant.apk`), never jadx's decompiled Java source alone.

## 6. Update-resilience note

The R8 map ID embedded as a comment in every decompiled file (`r8-map-id-73e67ccf05762b9dc0b62fb84f43135dfe88b5832a58c1748fdadc2608944e08`) is stable across all files in *this* build — confirms one consistent obfuscation mapping per version, but that mapping (and the single-letter package names) **will change on every upstream release**. The patch script must re-locate `onServiceConnected` in `AssistAccessibilityService.smali` by method signature / call-site pattern (`iget-object` + `invoke-virtual` on the `f8038a`-equivalent field, or the `d()` void method literally named `onServiceConnected` — that name IS stable since it overrides a framework method) rather than by line number. `AssistAccessibilityService`'s own class/method names are stable (framework overrides), so the hook's *target* is easy to relocate even when the obfuscated internals it calls into shift names — the one line we insert only ever needs `p0` (the receiver's own `this`), not any of the obfuscated symbols.
