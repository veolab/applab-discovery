---
name: ui
description: "Web UI management and server status"
emoji: "🖥️"
version: "1.0.0"
category: ui
always: true
tools:
  - dlab.ui.open
  - dlab.ui.status
tags: [ui, web, server, browser]
---

# UI Skill

Manage the DiscoveryLab web interface.

## Tools

### dlab.ui.open

Open DiscoveryLab web UI in the default browser:
- `port`: Server port (default: 3847)

### dlab.ui.status

Check if the web UI server is running:
- Returns server status and URL
- Shows start command if not running

## Usage

```bash
# Open the UI
dlab.ui.open {}

# Check server status
dlab.ui.status {}
```

## Web UI Features

The web UI provides:

- **Project Management**: Create and manage testing projects
- **Screen Capture**: Capture emulator/simulator screens
- **Recording**: Record user interactions
- **Evidence Grid**: View and organize screenshots
- **Export**: Export to various formats
- **Task Hub**: Link Jira, Notion, Figma, GitHub resources

## Server

The web server runs on `http://localhost:3847` by default.

Start the server with:
```bash
npx applab-discovery serve
```

Or programmatically:
```typescript
import { startServer } from 'applab-discovery';
await startServer(3847);
```
