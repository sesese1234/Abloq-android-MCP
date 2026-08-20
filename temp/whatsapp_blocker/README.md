# WhatsApp Updates Blocker (Abloq Accessibility)

An Android Accessibility Service application that blocks access to the **Updates** (Status & Channels) tab in WhatsApp (`com.whatsapp` and `com.whatsapp.w4b`) and automatically redirects the user back to the **Chats** tab.

---

## Features

- **Real-Time Tab Interception**: Listens for accessibility events (`TYPE_VIEW_CLICKED`, `TYPE_WINDOW_CONTENT_CHANGED`, `TYPE_WINDOW_STATE_CHANGED`).
- **Multilingual Support**: Detects the Updates tab across multiple languages (Hebrew `עדכונים`, English `Updates`/`Status`, Arabic `المסטג'דאת`, Spanish `Novedades`/`Actualizaciones`, French `Actus`/`Mises à jour`, German `Aktuelles`, etc.).
- **Automatic Fallback & Cooldown**: Safely redirects to the Chats tab via node click actions, with `GLOBAL_ACTION_BACK` fallback and debounce cooldown to prevent loop thrashing.
- **Standalone Build Pipeline**: Includes a zero-dependency CLI build script (`build.sh`) leveraging `aapt2`, `javac`, `d8`, `zipalign`, and `apksigner`.

---

## Directory Structure

```
temp/whatsapp_blocker/
├── AndroidManifest.xml
├── README.md
├── build.sh
├── res/
│   ├── layout/
│   │   └── activity_main.xml
│   ├── values/
│   │   ├── colors.xml
│   │   └── strings.xml
│   └── xml/
│       └── accessibility_service_config.xml
├── src/
│   └── com/
│       └── abloq/
│           └── whatsappblocker/
│               ├── MainActivity.java
│               └── WhatsAppBlockerAccessibilityService.java
└── whatsapp_blocker.apk
```

---

## How to Build & Install

1. **Build APK**:
   ```bash
   ./build.sh
   ```

2. **Install on Device**:
   ```bash
   adb install -r whatsapp_blocker.apk
   ```

3. **Enable Accessibility Service**:
   ```bash
   adb shell settings put secure enabled_accessibility_services com.abloq.whatsappblocker/.WhatsAppBlockerAccessibilityService
   adb shell settings put secure accessibility_enabled 1
   ```
