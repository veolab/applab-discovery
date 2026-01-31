---
name: export
description: "Export screenshots, videos, GIFs, and mockups"
emoji: "📤"
version: "1.0.0"
category: export
requires:
  bins: [ffmpeg]
os: [darwin, linux, win32]
install:
  brew: ffmpeg
  apt: ffmpeg
  manual: "Download from https://ffmpeg.org/download.html"
tools:
  - dlab.export.video
  - dlab.export.gif
  - dlab.export.thumbnail
  - dlab.export.trim
  - dlab.export.concat
  - dlab.export.image
  - dlab.export.batch
  - dlab.export.mockups
  - dlab.export.info
  - dlab.export.clipboard
  - dlab.export.reveal
  - dlab.export.sequence
tags: [export, video, gif, image, ffmpeg, mockup]
---

# Export Skill

Export and process screenshots, videos, and mockups.

## Video Tools

### dlab.export.video

Export recording as video file:
- `projectId`: Project to export
- `format`: mp4, webm, mov
- `quality`: low, medium, high

### dlab.export.trim

Trim video to specific time range:
- `input`: Source video
- `start`: Start time (seconds)
- `end`: End time (seconds)

### dlab.export.concat

Concatenate multiple videos:
- `inputs`: Array of video paths
- `output`: Output file path

### dlab.export.info

Get video file information (duration, resolution, codec).

## Image Tools

### dlab.export.gif

Convert video or sequence to animated GIF:
- `input`: Source video or image folder
- `fps`: Frame rate (default: 10)
- `scale`: Width in pixels

### dlab.export.thumbnail

Generate thumbnail from video:
- `input`: Source video
- `time`: Timestamp to capture

### dlab.export.image

Export single frame as image:
- Supports PNG, JPEG, WebP

### dlab.export.batch

Batch export multiple screenshots.

### dlab.export.sequence

Export video as image sequence.

## Mockup Tools

### dlab.export.mockups

Generate device mockups:
- Adds device frames around screenshots
- Supports iPhone, iPad, Android devices

## Utility Tools

### dlab.export.clipboard

Copy image to clipboard.

### dlab.export.reveal

Open file in Finder/Explorer.

## Requirements

- **FFmpeg**: Required for video processing
- Installed via Homebrew, apt, or manual download

## Usage Examples

```bash
# Export as GIF
dlab.export.gif {
  "input": "./recording.mp4",
  "fps": 15,
  "scale": 480
}

# Create mockup
dlab.export.mockups {
  "input": "./screenshot.png",
  "device": "iphone14pro"
}

# Trim video
dlab.export.trim {
  "input": "./recording.mp4",
  "start": 5,
  "end": 30
}
```
