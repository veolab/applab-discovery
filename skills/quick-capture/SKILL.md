---
name: quick-capture
description: Quickly capture iOS/Android emulator screen
disable-model-invocation: true
allowed-tools: dlab.capture.emulator, dlab.project.create, dlab.project.list
---

# Quick Capture

Quickly capture the current screen from an iOS Simulator or Android Emulator.

## Workflow

1. Use `dlab.capture.emulator` to capture current emulator screen
2. Optionally use `dlab.project.create` to create a new project with the capture
3. Return the captured image path to user

## Parameters

- **platform**: `ios` or `android` (auto-detected if only one is running)
- **projectId**: Optional - associate capture with existing project

## Usage

Perfect for:
- Quick bug documentation
- UI state capture during development
- Creating evidence for QA tickets
