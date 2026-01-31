---
name: web-test
description: Web testing workflow with Playwright recording
context: fork
agent: general-purpose
---

# Web Test Workflow

Complete web application testing workflow using Playwright for browser automation and recording.

## Workflow

1. **Setup Check**: Use `dlab.setup.status` to verify Playwright is installed
2. **Project Setup**: Create or select project with `dlab.project.create` or `dlab.project.list`
3. **Start Recording**: Launch browser and begin recording with web recording tools
4. **Guide Testing**: Help user navigate the web application while capturing interactions
5. **Stop Recording**: End recording and save video
6. **Process Results**: Extract frames and analyze with AI
7. **Generate Tests**: Create Playwright test scripts from recorded interactions

## Prerequisites

- Node.js 20+
- Playwright installed (`npx playwright install`)
- Target URL accessible

## Features

- Uses user's installed Chrome (not bundled Chromium)
- Configurable viewport sizes
- Network request capture
- Console log capture
- Video recording with frame extraction

## Output

- Recorded video of session
- Extracted key frames
- Generated Playwright test scripts
- Requirements and test documentation
