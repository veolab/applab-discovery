---
name: mobile-test
description: Full mobile testing workflow with Maestro recording
context: fork
agent: general-purpose
---

# Mobile Test Workflow

Complete mobile app testing workflow using Maestro for iOS/Android automation and recording.

## Workflow

1. **Setup Check**: Use `dlab.setup.status` to verify dependencies (Maestro, emulators)
2. **Project Setup**: Create or select project with `dlab.project.create` or `dlab.project.list`
3. **Start Recording**: Begin recording with `dlab.capture.start`
4. **Guide Testing**: Help user through app interactions while recording
5. **Stop Recording**: End recording with `dlab.capture.stop`
6. **Process Results**: Frames are extracted and analyzed automatically
7. **Generate Tests**: Use `dlab.taskhub.generate` to create test cases from recording

## Prerequisites

- iOS Simulator or Android Emulator running
- Maestro CLI installed (`brew install maestro`)
- App under test launched on emulator

## Output

- Extracted frames with OCR analysis
- AI-generated test cases
- Requirements documentation
- Evidence for QA/stakeholders
