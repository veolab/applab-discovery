---
name: analyze
description: "AI-powered screenshot and video analysis with OCR"
emoji: "🔍"
version: "1.0.0"
category: analyze
requires:
  env: [ANTHROPIC_API_KEY]
always: true
install:
  manual: "Set ANTHROPIC_API_KEY environment variable"
tools:
  - dlab.analyze.video
  - dlab.analyze.screenshot
  - dlab.analyze.frames
  - dlab.analyze.info
tags: [analyze, ai, ocr, vision, screenshot, video]
---

# Analyze Skill

AI-powered analysis of screenshots and videos using Claude Vision.

## Tools

### dlab.analyze.screenshot

Analyze a single screenshot:
- Detects UI elements and text (OCR)
- Identifies actions and interactions
- Returns structured analysis

### dlab.analyze.video

Analyze a video recording:
- Extracts key frames
- Identifies user flow and actions
- Generates step-by-step breakdown

### dlab.analyze.frames

Extract and analyze frames from video:
- `input`: Video file path
- `interval`: Seconds between frames
- Returns array of analyzed frames

### dlab.analyze.info

Get metadata about media file:
- Resolution, duration, format
- Detected elements summary

## AI Capabilities

The analysis uses Claude Vision to:

- **OCR**: Extract text from UI elements
- **Element Detection**: Identify buttons, inputs, lists
- **Action Recognition**: Detect taps, swipes, scrolls
- **Flow Analysis**: Understand user journey
- **Bug Detection**: Spot UI issues and anomalies

## Requirements

- **ANTHROPIC_API_KEY**: Required for AI analysis
- Get your key at https://console.anthropic.com

## Usage Examples

```bash
# Analyze screenshot
dlab.analyze.screenshot {
  "input": "./screenshot.png",
  "detailed": true
}

# Analyze video
dlab.analyze.video {
  "input": "./recording.mp4",
  "extractFrames": true
}

# Extract frames
dlab.analyze.frames {
  "input": "./recording.mp4",
  "interval": 2
}
```

## Output Format

Analysis results include:

```json
{
  "elements": [
    {"type": "button", "text": "Login", "bounds": {...}},
    {"type": "input", "placeholder": "Email", "bounds": {...}}
  ],
  "actions": [
    {"type": "tap", "target": "Login button", "timestamp": 1.5}
  ],
  "flow": "User enters credentials and taps login",
  "issues": []
}
```
