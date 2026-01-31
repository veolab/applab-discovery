# DiscoveryLab

![Node.js](https://img.shields.io/badge/Node.js-20%2B-brightgreen?style=flat-square)
[![npm](https://img.shields.io/npm/v/@veolab/discoverylab.svg?style=flat-square)](https://www.npmjs.com/package/@veolab/discoverylab)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](https://opensource.org/licenses/MIT)

> AI-powered app testing & marketing asset generator. A Claude Code plugin.

![DiscoveryLab](assets/applab-discovery.jpeg)

## How It Works

```mermaid
flowchart LR
    subgraph Input
        A[Mobile App] --> R[Record]
        B[Web App] --> R
        C[Video File] --> U[Upload]
    end

    subgraph DiscoveryLab
        R --> P[Process]
        U --> P
        P --> AI[AI Analysis]
        AI --> O[OCR + Features]
    end

    subgraph Output
        O --> E1[Screenshots]
        O --> E2[GIF / MP4]
        O --> E3[Test Reports]
    end
```

## Quick Start

**Install:**
```bash
npm install -g @veolab/discoverylab
```

**Configure** `~/.claude.json`:
```json
{
  "mcpServers": {
    "discoverylab": {
      "command": "npx",
      "args": ["-y", "@veolab/discoverylab@latest", "mcp"]
    }
  }
}
```

**Run:**
```bash
discoverylab serve
```

## Features

| Feature | Description |
|---------|-------------|
| **Screen Capture** | Record iOS/Android emulators or web apps |
| **Maestro Testing** | Automated mobile app testing with screenshots |
| **Playwright Testing** | Web testing using your installed Chrome |
| **AI Analysis** | OCR, feature detection, smart summaries |
| **Export** | PNG, GIF, MP4 with professional quality |
| **Task Hub** | Jira, Notion, Figma, GitHub integration |

## Skills

After installing, use these in Claude Code:

```
/discoverylab:open-ui        → Open web interface
/discoverylab:quick-capture  → Capture emulator screen
/discoverylab:mobile-test    → Mobile testing with Maestro
/discoverylab:web-test       → Web testing with Playwright
```

## Requirements

- Node.js 20+
- FFmpeg (for video/GIF export)
- Maestro CLI (optional)
- Playwright (optional)

## Platform Support

| | macOS | Windows | Linux |
|---|:---:|:---:|:---:|
| Web UI | ✓ | ✓ | ✓ |
| iOS Capture | ✓ | — | — |
| Android Capture | ✓ | ✓ | ✓ |
| Web Recording | ✓ | ✓ | ✓ |
| Apple Vision OCR | ✓ | — | — |

## License

MIT
