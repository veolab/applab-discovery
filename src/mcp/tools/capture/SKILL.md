---
name: capture
description: "Screen capture and recording for mobile devices and emulators"
emoji: "📸"
version: "1.0.0"
category: capture
requires:
  bins: [adb]
os: [darwin, linux, win32]
install:
  brew: android-platform-tools
  apt: android-tools-adb
  manual: "Install Android SDK Platform Tools or Xcode Command Line Tools"
tools:
  - dlab.capture.screen
  - dlab.capture.emulator
  - dlab.capture.start
  - dlab.capture.stop
  - dlab.emulators.list
tags: [capture, screenshot, recording, mobile, emulator, ios, android]
---

# Capture Skill

Screen capture and recording capabilities for mobile devices and emulators.

## Tools

### dlab.capture.screen

Capture a screenshot from a running emulator or device:
- Supports iOS Simulator and Android Emulator
- Returns base64-encoded image

### dlab.capture.emulator

Capture emulator screen with device frame:
- Adds device mockup frame around screenshot
- Useful for marketing materials

### dlab.capture.start

Start recording the screen:
- Creates video or screenshot sequence
- Useful for demo recordings

### dlab.capture.stop

Stop active recording and save the result.

### dlab.emulators.list

List available emulators and simulators:
- iOS Simulators (via xcrun simctl)
- Android Emulators (via adb)

## Requirements

- **iOS**: Xcode with Simulator
- **Android**: Android SDK with ADB

## Usage Examples

```bash
# List available devices
dlab.emulators.list {}

# Capture iOS Simulator screenshot
dlab.capture.screen {
  "platform": "ios",
  "deviceId": "booted"
}

# Capture Android with device frame
dlab.capture.emulator {
  "platform": "android",
  "frame": "pixel6"
}
```
