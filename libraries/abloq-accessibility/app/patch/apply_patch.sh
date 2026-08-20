#!/usr/bin/env bash
# Rebuilds the AbloqBridge-patched Developer Assistant APK from a freshly pulled
# com.appsisle.developerassistant.apk. Re-run this whenever the upstream app updates -
# see ../recon/RECON.md for what the hook assumes still holds (onServiceConnected still
# calls Lq7/d;->e(Lq7/d$a;)V, AssistAccessibilityService's smali path is unchanged).
#
# Does NOT touch resources.arsc/res/ at all - apktool's aapt1/aapt2 resource rebuild fails
# on this app's `$avd_*`-prefixed generated AnimatedVectorDrawable resource names (a known
# apktool limitation, unrelated to this patch). Instead: decode with apktool for smali only,
# patch + reassemble smali with `smali`/`baksmali` directly, and splice the resulting
# classes.dex/classes2.dex into a byte-identical copy of the original (unmodified) APK zip.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$HERE")"
RECON_APK_DIR="$APP_DIR/recon/apk"
BUILD_DIR="$HERE/build"
DECODE_DIR="$BUILD_DIR/decode"
KEYSTORE="$HERE/abloq-local-debug.keystore"
KEYSTORE_PASS="abloqlocal"
PKG="com.appsisle.developerassistant"

# Pinned identity of the input APK this patch was recon'd against (RECON.md v1.4.2).
# The whole patch (hook anchor Lq7/d;->e(Lq7/d$a;)V, the o7.a.e().g().d() engine, the e8/d field
# names) is tied to THIS exact bytecode. If upstream changes, every recon claim must be re-verified
# before the patch can be trusted, so a drift must fail loudly rather than silently swap the input.
EXPECTED_SHA="9b73c7d22e68de61fee1975dfc9ff109c82ef09e993521d457dc45744008434d"
EXPECTED_VC="2002001042"

ANDROID_SDK="${ANDROID_SDK:-$HOME/Android/Sdk}"
BUILD_TOOLS="$(find "$ANDROID_SDK/build-tools" -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)"
D8="$BUILD_TOOLS/d8"
ZIPALIGN="$BUILD_TOOLS/zipalign"
APKSIGNER="$BUILD_TOOLS/apksigner"
ANDROID_JAR="$(find "$ANDROID_SDK/platforms" -maxdepth 1 -type d -name "android-*" | sort -V | tail -1)/android.jar"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

echo "== 1. Obtain the input APK (reuse cached by default; pull only when asked) =="
mkdir -p "$RECON_APK_DIR"
SRC_APK="$RECON_APK_DIR/$PKG.apk"
# Default: reuse the cached, recon'd APK so rebuilds work offline and the input can't silently
# change out from under RECON.md. Set PULL=1 to deliberately re-pull from Google Play when
# intentionally bumping to a new upstream (then update EXPECTED_SHA/EXPECTED_VC + RECON.md together).
if [ "${PULL:-0}" = 1 ] || [ ! -f "$SRC_APK" ]; then
  echo "   pulling $PKG from Google Play (PULL=${PULL:-0}, cached present=$([ -f "$SRC_APK" ] && echo yes || echo no))"
  apkeep -a "$PKG" -d google-play -o split_apk=true "$RECON_APK_DIR"
else
  echo "   reusing cached $SRC_APK (set PULL=1 to re-pull)"
fi
[ -f "$SRC_APK" ] || { echo "FATAL: input APK not found at $SRC_APK (apkeep may have emitted a split bundle instead of a single base .apk)." >&2; exit 1; }

# Verify the input's identity against the pinned recon baseline. A mismatch means the bytecode this
# patch was built against has drifted; refuse to build rather than ship a clean-compiling but
# runtime-broken APK. Override deliberately (after re-running recon) by updating EXPECTED_* above.
GOT_SHA="$(sha256sum "$SRC_APK" | cut -d' ' -f1)"
if [ "$GOT_SHA" != "$EXPECTED_SHA" ]; then
  echo "FATAL: input APK sha256 $GOT_SHA != pinned $EXPECTED_SHA." >&2
  echo "Upstream changed - re-run recon (see ../recon/RECON.md), re-verify every symbol against baksmali," >&2
  echo "then update EXPECTED_SHA/EXPECTED_VC before trusting the patch." >&2
  exit 1
fi

echo "== 2. Decode with apktool (smali only, resources left encoded) =="
# -r/--no-res: do NOT decode resources.arsc/res/. Step 7 splices dex into a byte-identical copy of
# the original APK and never rebuilds resources, so decoding them is wasted work AND extra failure
# surface on this app's known `$avd_*` AnimatedVectorDrawable aapt bug (see RECON.md / header).
apktool d -r -f -o "$DECODE_DIR" "$SRC_APK"

# Guard the hard-coded two-dex-partition layout (step 6 only assembles smali + smali_classes2, and
# step 7 splices classes.dex + classes2.dex). The recon baseline is single-dex; a multidex upstream
# would leave smali_classes3+/ never reassembled and ship a silently inconsistent mix.
DEX_COUNT="$(unzip -l "$SRC_APK" | grep -cE 'classes[0-9]*\.dex$' || true)"
if [ "$DEX_COUNT" -ne 1 ]; then
  echo "FATAL: input APK is $DEX_COUNT-dex; steps 6/7 only handle classes.dex + classes2.dex." >&2
  echo "A multidex upstream needs the assemble/splice steps extended before this patch is safe." >&2
  exit 1
fi

echo "== 3. Compile the bridge (new code only, against compile-only stubs) =="
mkdir -p "$BUILD_DIR/classes"
javac --release 17 -cp "$ANDROID_JAR" -d "$BUILD_DIR/classes" \
  -sourcepath "$HERE/stub_src:$HERE/bridge_src" \
  "$HERE/bridge_src/com/abloq/bridge/AbloqBridge.java" \
  "$HERE/stub_src/o7/a.java" "$HERE/stub_src/q7/d.java" "$HERE/stub_src/da/b.java" \
  "$HERE/stub_src/e8/j.java" "$HERE/stub_src/e8/d.java" "$HERE/stub_src/y7/a.java"

mkdir -p "$BUILD_DIR/dex"
"$D8" --release --min-api 26 --lib "$ANDROID_JAR" --output "$BUILD_DIR/dex" \
  "$BUILD_DIR/classes/com/abloq/bridge/AbloqBridge.class"

mkdir -p "$BUILD_DIR/smali_out"
baksmali disassemble "$BUILD_DIR/dex/classes.dex" -o "$BUILD_DIR/smali_out"

echo "== 4. Splice bridge smali in as a second dex partition =="
mkdir -p "$DECODE_DIR/smali_classes2/com/abloq/bridge"
cp "$BUILD_DIR/smali_out/com/abloq/bridge/AbloqBridge.smali" \
   "$DECODE_DIR/smali_classes2/com/abloq/bridge/"

echo "== 5. Patch the hook call-site =="
HOOK_FILE="$DECODE_DIR/smali/com/jw/devassist/ui/services/accessibility/AssistAccessibilityService.smali"
if ! grep -q "Lcom/abloq/bridge/AbloqBridge;->install" "$HOOK_FILE"; then
  ANCHOR='invoke-virtual {v0, p0}, Lq7/d;->e(Lq7/d$a;)V'
  if ! grep -qF "$ANCHOR" "$HOOK_FILE"; then
    echo "FATAL: hook anchor not found - AssistAccessibilityService.smali has changed shape." >&2
    echo "Re-run recon (see ../recon/RECON.md) and update the anchor before re-patching." >&2
    exit 1
  fi
  python3 - "$HOOK_FILE" "$ANCHOR" <<'PYEOF'
import sys
path, anchor = sys.argv[1], sys.argv[2]
text = open(path).read()
hook = anchor + "\n\n    .line 38\n    invoke-static {p0}, Lcom/abloq/bridge/AbloqBridge;->install(Landroid/content/Context;)V\n"
assert text.count(anchor) == 1, f"expected exactly one anchor match, found {text.count(anchor)}"
open(path, "w").write(text.replace(anchor, hook, 1))
PYEOF
fi

echo "== 6. Reassemble only the two dex partitions (smali handles this internally via apktool build's dexer, invoked here directly) =="
# --api 26 matches the manifest minSdk and the d8 --min-api 26 used for the bridge, so the dex
# version (038) and opcode-permission validation are intentional, not smali's implicit auto-bump.
smali assemble --api 26 -o "$BUILD_DIR/classes.dex" "$DECODE_DIR/smali"
smali assemble --api 26 -o "$BUILD_DIR/classes2.dex" "$DECODE_DIR/smali_classes2"

echo "== 7. Splice dex into an unmodified copy of the original APK zip (resources untouched) =="
cp "$SRC_APK" "$BUILD_DIR/patched.apk"
zip -j "$BUILD_DIR/patched.apk" "$BUILD_DIR/classes.dex"
zip -j "$BUILD_DIR/patched.apk" "$BUILD_DIR/classes2.dex"

echo "== 8. zipalign + sign (local test-only keystore, generated on first run) =="
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -v -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" \
    -alias abloqlocal -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Abloq Local Patch, OU=local-only, O=abloq, L=NA, ST=NA, C=US"
fi
"$ZIPALIGN" -p -f 4 "$BUILD_DIR/patched.apk" "$BUILD_DIR/patched_aligned.apk"
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" --key-pass "pass:$KEYSTORE_PASS" \
  --out "$HERE/devassistant_patched_signed.apk" "$BUILD_DIR/patched_aligned.apk"
"$APKSIGNER" verify "$HERE/devassistant_patched_signed.apk"

echo "== Done: $HERE/devassistant_patched_signed.apk =="
echo "Install with: adb install -r '$HERE/devassistant_patched_signed.apk'"
echo "(the Play Store original, if installed, must be uninstalled first - this is re-signed with a different key)"
