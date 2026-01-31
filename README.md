# AppLab Discovery

> AI-Powered App Testing & Marketing Asset Generator

A localhost-first tool for developers that combines automated testing, AI analysis, and marketing asset generation. Distributed as a Claude Code Plugin (MCP Server).

![AppLab Discovery](assets/applab-discovery.jpeg)

## Features

### Core Features
- **Video Analysis** - Extract frames, OCR text, detect features using Apple Intelligence
- **3D Mockups** - Professional device mockups (iPhone, Android, Browser)
- **Text Effects** - Behind-object, title, subtitle overlays
- **Screen Capture** - Record emulators, windows, or web apps
- **Maestro Integration** - Automated mobile app testing
- **Playwright Integration** - Automated web app testing with recording (uses user's Chrome)
- **Export** - PNG, MP4, GIF with professional quality

### Task Hub
Centralized task management with external tool integration:
- **Multiple Links** - Add multiple Jira, Notion, Figma, and GitHub links per project
- **MCP Metadata Fetch** - Automatically extract ticket keys, page IDs, file info from URLs
- **AI-Generated Requirements** - Auto-generate requirements from linked sources
- **Test Map** - AI-generated test checklist with progress tracking
- **Status Tracking** - Visual indicators for task progress

### LLM Provider Configuration
Flexible AI backend with multiple provider support:
- **Anthropic API** - Use your own API key for Claude models
- **OpenAI API** - GPT-4/5 models support
- **Ollama** - Local LLM support (llama3, mistral, etc.)
- **Claude CLI** - Automatic fallback with optimized settings
- **Model Selection** - Configure specific models per provider in Settings UI

## Installation

### Via Claude Code Plugin Marketplace (Recommended)

```bash
# Add the marketplace
/plugin marketplace add veolab/applab-discovery

# Install the plugin
/plugin install discoverylab@veolab-applab-discovery
```

The MCP server is automatically configured when you install via the marketplace.

### Via npm (Manual)

```bash
npm install -g @veolab/discoverylab
```

Then add to your `~/.claude.json`:
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

### Via Bun (Faster)

```bash
bun add -g @veolab/discoverylab
```

Then add to your `~/.claude.json`:
```json
{
  "mcpServers": {
    "discoverylab": {
      "command": "bunx",
      "args": ["@veolab/discoverylab", "mcp"]
    }
  }
}
```

## Usage

### Skills (Slash Commands)

After installing the plugin, use these skills in Claude Code:

| Skill | Description |
|-------|-------------|
| `/discoverylab:open-ui` | Open the DiscoveryLab web interface |
| `/discoverylab:quick-capture` | Quickly capture iOS/Android emulator screen |
| `/discoverylab:mobile-test` | Full mobile testing workflow with Maestro |
| `/discoverylab:web-test` | Web testing workflow with Playwright |
| `/discoverylab:generate-assets` | Generate marketing assets from screenshots |
| `/discoverylab:task-hub` | Manage links, requirements and test maps |

### CLI Usage

```bash
# Start localhost UI
discoverylab serve

# Analyze a video
discoverylab analyze video.mp4

# Capture emulator
discoverylab capture --emulator ios
```

### Natural Language with Claude

```
# Basic usage
Use applab to analyze my app recording and generate marketing screenshots

# Task Hub integration
Add this Jira ticket to my project: https://company.atlassian.net/browse/PROJ-123
Generate requirements and test map from all my project links
Show me my test progress for the current project

# Recording
Start recording my iOS simulator
Run Maestro tests on my app
```

### Available MCP Tools
- **Projects**: `dlab.project.*` - Create, list, manage projects
- **Task Hub**: `dlab.taskhub.*` - Links, requirements, test maps
- **Recording**: `dlab.capture.*`, `dlab.maestro.*`, `dlab.playwright.*`
- **Export**: `dlab.notion.*`, `dlab.drive.*`, `dlab.jira.*`

## Requirements

- **Node.js 20+**
- **FFmpeg** (for video export)
- **Maestro CLI** (optional, for mobile testing)
- **Playwright** (optional, for web testing)

## Platform Compatibility

| Feature | macOS | Windows | Linux |
|---------|-------|---------|-------|
| Web UI | Full | Full | Full |
| Video Upload & Analysis | Full | Full | Full |
| Grid Composer | Full | Full | Full |
| PNG/Image Export | Full | Full | Full |
| Vision OCR (Apple Intelligence) | Full | Fallback* | Fallback* |
| iOS Simulator Capture | Full | N/A | N/A |
| Android Emulator Capture | Full | Full | Full |
| Playwright Web Testing | Full | Full | Full |
| Maestro Mobile Testing | Full | Full | Full |

*Fallback: Uses Tesseract.js for OCR when Apple Vision is unavailable.

### macOS (Recommended)
Full functionality including iOS Simulator capture and Apple Intelligence Vision OCR.

### Windows / Linux
Most features work with some limitations:
- iOS Simulator capture requires macOS
- Vision OCR falls back to Tesseract.js
- Android Emulator and Playwright work normally

## API Endpoints

### Task Hub Endpoints

```
PUT  /api/projects/:id/links     - Update project links (legacy + taskHubLinks)
POST /api/mcp/fetch              - Fetch metadata from a single URL
POST /api/mcp/fetch-batch        - Fetch metadata from multiple URLs
POST /api/ai/generate-task-info  - Generate requirements and test map from links
POST /api/projects/sync-orphans  - Sync orphan directories from disk to database
```

### Recording Endpoints

```
POST   /api/mobile/record/start  - Start Maestro mobile recording
POST   /api/mobile/record/stop   - Stop and process mobile recording
POST   /api/web/record/start     - Start Playwright web recording (uses user's Chrome)
POST   /api/web/record/stop      - Stop and process web recording
DELETE /api/recordings/:id       - Delete a recording with cascade cleanup
```

### LLM Settings Endpoints

```
GET  /api/settings/llm           - Get LLM provider settings (API keys masked)
POST /api/settings/llm           - Update LLM provider settings
GET  /api/ollama/status          - Check Ollama server status and available models
GET  /api/mobile-chat/providers  - Get available chat providers for mobile testing
POST /api/mobile-chat            - Send chat message during mobile testing session
```

## Documentation

See [CLAUDE.md](./CLAUDE.md) for Claude Code specific instructions.

## License

MIT - See LICENSE file

## Credits

Built with:
- Three.js (3D mockups)
- Remotion (video rendering)
- Apple Vision & NaturalLanguage frameworks
- Claude MCP SDK
