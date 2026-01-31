---
name: testing
description: "Mobile and web test automation with Maestro and Playwright"
emoji: "🧪"
version: "1.0.0"
category: testing
requires:
  bins: [maestro, npx]
os: [darwin, linux]
install:
  manual: "Maestro: curl -Ls 'https://get.maestro.mobile.dev' | bash\nPlaywright: npm install -D playwright"
tools:
  - dlab.maestro.status
  - dlab.maestro.run
  - dlab.maestro.studio
  - dlab.maestro.generate
  - dlab.playwright.status
  - dlab.playwright.run
  - dlab.playwright.codegen
  - dlab.playwright.generate
  - dlab.playwright.report
  - dlab.playwright.install
  - dlab.playwright.devices
  - dlab.test.devices
tags: [testing, automation, mobile, web, maestro, playwright]
---

# Testing Skill

Automated testing capabilities for mobile apps (via Maestro) and web applications (via Playwright).

## Maestro Tools

Maestro is a mobile UI testing framework that runs on iOS and Android.

### dlab.maestro.status

Check Maestro installation and connected devices:
- Returns installed status, version, and device list
- Shows install hint if not installed

### dlab.maestro.run

Run a Maestro test flow:
- `flowPath`: Path to YAML flow file
- `device`: Target device ID
- `appId`: App bundle/package ID
- `captureVideo`: Record test execution

### dlab.maestro.studio

Start Maestro Studio for interactive flow building.

### dlab.maestro.generate

Generate flows from templates: login, onboarding, navigation.

## Playwright Tools

Playwright enables reliable end-to-end testing for web apps.

### dlab.playwright.status

Check Playwright installation status.

### dlab.playwright.run

Run Playwright tests:
- `testPath`: Test file or directory
- `browser`: chromium, firefox, or webkit
- `headed`: Run with visible browser

### dlab.playwright.codegen

Start Playwright codegen for recording tests.

### dlab.playwright.devices

List available device presets for mobile emulation.

## Usage Examples

```bash
# Check Maestro status
dlab.maestro.status {}

# Run a mobile test
dlab.maestro.run {
  "flowPath": "./tests/login.yaml",
  "appId": "com.example.app"
}

# Run web tests
dlab.playwright.run {
  "testPath": "./tests/e2e",
  "browser": "chromium"
}
```
