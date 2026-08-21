# Abloq Android MCP

Precision Android UI hierarchy inspection and accessibility tooling for AI agents and automation workflows.

---

## 📌 Overview

Standard mobile automation tools often provide filtered or incomplete views of an Android device's screen. **Abloq** solves this by providing:

1. **Precision UI-Hierarchy MCP Server (`libraries/abloq-accessibility/agents`)**  
   An MCP (Model Context Protocol) server extending standard mobile automation with deep Android accessibility inspection tools:
   - `mobile_android_dump_full_hierarchy`: Dumps the complete, raw accessibility node tree (resource IDs, class names, bounds, checked/checkable switch states, focusable/clickable flags, and parent-child hierarchy indices).
   - `mobile_android_get_current_activity`: Retrieves the exact foreground package and Activity component name via adb.
   - `mobile_android_companion_status`: Verifies companion accessibility service availability on the target device.

2. **Companion Service Patch Pipeline (`libraries/abloq-accessibility/app`)**  
   A reproducible patch pipeline that instruments the Developer Assistant engine to expose headless JSON accessibility dumps over adb broadcasts without requiring full framework rebuilds.

3. **Sample Implementations (`temp/whatsapp_blocker`)**  
   A lightweight, standalone Android Accessibility Service demonstration that intercepts and blocks unwanted UI tabs (e.g., WhatsApp Updates/Channels) and redirects navigation back to Chats in real-time.

---

## 🚀 Quick Start

### 1. Prerequisites
- Node.js (v20+)
- Android SDK (`platform-tools`, `build-tools`, and `platforms`)
- An Android device (physical or emulator) connected via USB with USB debugging enabled.

### 2. Building & Running the MCP Server

```bash
cd libraries/abloq-accessibility/agents
npm install
npm run build
npm test
```

### 3. Adding to your MCP Configuration (`mcp_config.json` or `claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "abloq-accessibility": {
      "command": "node",
      "args": [
        "/path/to/abloq/libraries/abloq-accessibility/agents/lib/index.js"
      ]
    }
  }
}
```

### 4. Deploying the Companion Service to a Device

```bash
# Install the patched companion APK
adb install -r libraries/abloq-accessibility/app/patch/devassistant_patched_signed.apk

# Enable accessibility service for Developer Assistant
adb shell settings put secure enabled_accessibility_services com.appsisle.developerassistant/com.jw.devassist.ui.services.accessibility.AssistAccessibilityService
adb shell settings put secure accessibility_enabled 1
```

---

## 📂 Project Structure

```
abloq/
├── libraries/
│   └── abloq-accessibility/
│       ├── agents/              # TypeScript MCP server (tools & test suites)
│       └── app/                 # APK patch pipeline, stubs & smali bridge
├── temp/
│   └── whatsapp_blocker/        # Sample Android accessibility blocker app
├── .gitignore
└── README.md
```

---

## 🛠️ Testing & Verification

Run the comprehensive Playwright test suite for the MCP server:

```bash
cd libraries/abloq-accessibility/agents
npx playwright test test/android-a11y-robot.test.ts
```

---

## 📄 License

Creative Commons Zero v1.0 Universal
