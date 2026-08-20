#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
BUILD_TOOLS="$ANDROID_SDK_ROOT/build-tools/36.0.0"
PLATFORM="$ANDROID_SDK_ROOT/platforms/android-37.0/android.jar"

if [ ! -f "$PLATFORM" ]; then
  PLATFORM="$(find "$ANDROID_SDK_ROOT/platforms" -name "android.jar" | head -n 1)"
fi

echo "==> Using Android SDK: $ANDROID_SDK_ROOT"
echo "==> Using Build Tools: $BUILD_TOOLS"
echo "==> Using Platform JAR: $PLATFORM"

rm -rf build whatsapp_blocker.apk
mkdir -p build/compiled build/gen build/obj build/dex

echo "==> 1. Compiling resources with aapt2..."
"$BUILD_TOOLS/aapt2" compile --dir res -o build/compiled/res.zip

echo "==> 2. Linking APK and generating R.java..."
"$BUILD_TOOLS/aapt2" link \
    -I "$PLATFORM" \
    --manifest AndroidManifest.xml \
    -o build/unaligned.apk \
    build/compiled/res.zip \
    --java build/gen \
    --auto-add-overlay

echo "==> 3. Compiling Java source files..."
javac --release 8 \
    -cp "$PLATFORM" \
    -d build/obj \
    build/gen/com/abloq/whatsappblocker/R.java \
    src/com/abloq/whatsappblocker/*.java

echo "==> 4. Converting bytecode to DEX..."
"$BUILD_TOOLS/d8" --lib "$PLATFORM" \
    --output build/dex/ \
    build/obj/com/abloq/whatsappblocker/*.class

echo "==> 5. Packaging DEX into APK..."
cd build/dex
jar uf "$SCRIPT_DIR/build/unaligned.apk" classes.dex
cd "$SCRIPT_DIR"

echo "==> 6. Aligning APK with zipalign..."
"$BUILD_TOOLS/zipalign" -p -f 4 build/unaligned.apk build/aligned.apk

echo "==> 7. Creating debug keystore if needed..."
KEYSTORE="$SCRIPT_DIR/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
    keytool -genkeypair \
        -keystore "$KEYSTORE" \
        -storepass android \
        -keypass android \
        -alias androiddebugkey \
        -dname "CN=Android Debug,O=Android,C=US" \
        -keyalg RSA \
        -keysize 2048 \
        -validity 10000
fi

echo "==> 8. Signing APK with apksigner..."
"$BUILD_TOOLS/apksigner" sign \
    --ks "$KEYSTORE" \
    --ks-pass pass:android \
    --key-pass pass:android \
    --out whatsapp_blocker.apk \
    build/aligned.apk

echo "==> BUILD SUCCESSFUL: $SCRIPT_DIR/whatsapp_blocker.apk"
