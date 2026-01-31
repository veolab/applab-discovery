# AppLab Discovery - Agent Integration Guide

> How to use AppLab Discovery with Claude Code and other MCP agents

## Overview

AppLab Discovery exposes MCP (Model Context Protocol) tools that any compatible AI agent can use for automated app testing, screen capture, and marketing asset generation.

## Quick Start with Claude Code

### Installation via Marketplace (Recommended)
```bash
# Add the marketplace
/plugin marketplace add veolab/applab-discovery

# Install the plugin
/plugin install discoverylab@veolab-applab-discovery
```

The MCP server is automatically configured when you install via the marketplace.

### Installation via npm (Manual)
```bash
# Install globally
npm install -g discoverylab

# Add to Claude Code config (~/.claude.json)
{
  "mcpServers": {
    "discoverylab": {
      "command": "npx",
      "args": ["-y", "discoverylab@latest", "mcp"]
    }
  }
}
```

### Available Skills (Slash Commands)

After installing, use these skills in Claude Code:

| Skill | Description |
|-------|-------------|
| `/discoverylab:open-ui` | Open the web interface |
| `/discoverylab:quick-capture` | Capture iOS/Android emulator screen |
| `/discoverylab:mobile-test` | Full mobile testing with Maestro |
| `/discoverylab:web-test` | Web testing with Playwright |
| `/discoverylab:generate-assets` | Generate marketing assets |
| `/discoverylab:task-hub` | Manage links and requirements |

### First Run
```
# In Claude Code, say:
Open DiscoveryLab UI

# Or use a skill:
/discoverylab:open-ui

# Or use the tool directly:
dlab.ui.open
```

## Available MCP Tools

### UI Management (`dlab.ui.*`)

| Tool | Description |
|------|-------------|
| `dlab.ui.open` | Open web UI in browser |
| `dlab.ui.status` | Check server status |

### Setup (`dlab.setup.*`)

| Tool | Description |
|------|-------------|
| `dlab.setup.status` | Check all dependencies (FFmpeg, Maestro, Playwright, etc.) |

### Projects (`dlab.project.*`)

| Tool | Description |
|------|-------------|
| `dlab.project.list` | List all projects |
| `dlab.project.create` | Create new project |
| `dlab.project.get` | Get project details by ID |
| `dlab.project.save` | Update project metadata |
| `dlab.project.delete` | Delete project and all related data |

### Task Hub (`dlab.taskhub.*`)

| Tool | Description |
|------|-------------|
| `dlab.taskhub.links.list` | List all external links for a project |
| `dlab.taskhub.links.add` | Add Jira/Notion/Figma/GitHub link |
| `dlab.taskhub.links.remove` | Remove a link by ID |
| `dlab.taskhub.metadata.fetch` | Fetch metadata from URL (ticket key, page title, etc.) |
| `dlab.taskhub.generate` | Generate requirements and test map from all links |
| `dlab.taskhub.requirements.get` | Get generated requirements list |
| `dlab.taskhub.testmap.get` | Get test checklist with progress |
| `dlab.taskhub.testmap.toggle` | Toggle test item completion |

### Capture (`dlab.capture.*`)

| Tool | Description |
|------|-------------|
| `dlab.capture.emulator` | Capture current emulator screen (iOS/Android) |
| `dlab.capture.start` | Start recording session |
| `dlab.capture.stop` | Stop recording and process |

### Testing (`dlab.maestro.*`, `dlab.playwright.*`)

| Tool | Description |
|------|-------------|
| `dlab.maestro.run` | Run Maestro test file on mobile app |
| `dlab.playwright.run` | Run Playwright test on web app |

### Integrations (`dlab.notion.*`, `dlab.drive.*`, `dlab.jira.*`)

| Tool | Description |
|------|-------------|
| `dlab.notion.export` | Export project to Notion page |
| `dlab.drive.upload` | Upload assets to Google Drive |
| `dlab.jira.attach` | Attach screenshots/videos to Jira issue |

## Agent Workflows

### 1. Mobile App Testing Workflow

```
# Natural language prompt to Claude:
"Record my iOS app login flow and generate test cases"

# Claude will:
1. dlab.setup.status - Check Maestro is installed
2. dlab.capture.start - Start recording
3. [User performs actions]
4. dlab.capture.stop - Stop and process recording
5. dlab.taskhub.generate - Generate test map from recording
```

### 2. Web Testing Workflow

```
# Natural language prompt:
"Test my web app checkout flow at localhost:3000"

# Claude will:
1. dlab.ui.open - Open DiscoveryLab
2. Start web recording (uses user's Chrome browser)
3. Navigate and record interactions
4. Generate screenshots and test cases
```

### 3. Task Management Workflow

```
# Natural language prompt:
"Add this Jira ticket to my project and generate requirements:
https://mycompany.atlassian.net/browse/PROJ-123"

# Claude will:
1. dlab.taskhub.links.add - Add the Jira link
2. dlab.taskhub.metadata.fetch - Extract ticket metadata
3. dlab.taskhub.generate - Generate requirements and test map
4. dlab.taskhub.testmap.get - Show the generated test checklist
```

### 4. Marketing Asset Generation

```
# Natural language prompt:
"Create marketing assets from my latest recording for the App Store"

# Claude will:
1. dlab.project.list - Find latest project
2. Use Grid Composer to create screenshot compositions
3. Export with App Store dimensions
```

## LLM Provider Configuration

DiscoveryLab supports multiple LLM providers for AI features (chat, analysis, etc.).

### Priority Order
1. **Anthropic API** - Set `ANTHROPIC_API_KEY` in Settings
2. **OpenAI API** - Set `OPENAI_API_KEY` in Settings
3. **Ollama** - Local server at `http://localhost:11434`
4. **Claude CLI** - Fallback with haiku model (optimized for speed)

### Configure via Settings UI
Open DiscoveryLab UI → Settings → LLM Configuration

### Configure via API
```bash
# Get current settings
curl http://localhost:3847/api/settings/llm

# Update settings
curl -X POST http://localhost:3847/api/settings/llm \
  -H "Content-Type: application/json" \
  -d '{"anthropicApiKey": "sk-ant-...", "anthropicModel": "claude-sonnet-4-20250514"}'
```

## Mobile Chat Integration

During mobile testing sessions, agents can use the chat feature for real-time interaction:

```
POST /api/mobile-chat
{
  "message": "What screen am I looking at?",
  "sessionId": "current-session-id"
}
```

The chat uses optimized LLM settings for fast responses:
- Haiku model when using Claude CLI
- Disabled tools overhead
- No session persistence

## Best Practices for Agents

### 1. Check Dependencies First
Always run `dlab.setup.status` before starting workflows to ensure all required tools are installed.

### 2. Use Project Context
When working on a project, always get the project ID first with `dlab.project.list` or `dlab.project.get`.

### 3. Handle Async Operations
Recording operations (`capture.start`, `capture.stop`) may take time. Wait for completion before proceeding.

### 4. Clean Up Resources
Delete test projects and recordings when done to avoid storage bloat.

### 5. Sync Orphan Projects
If projects are missing from the database but exist on disk, use:
```bash
curl -X POST http://localhost:3847/api/projects/sync-orphans
```

## Error Handling

Common errors and solutions:

| Error | Solution |
|-------|----------|
| `No LLM provider configured` | Configure API keys in Settings or run Ollama locally |
| `Maestro not installed` | Run `brew install maestro` or follow Maestro docs |
| `No emulator detected` | Start iOS Simulator or Android Emulator first |
| `Project not found` | Run sync-orphans endpoint to recover disk projects |

## Example Claude Code Sessions

### Session 1: Quick Capture
```
User: Capture my iOS app and analyze it
Claude: I'll capture your iOS Simulator screen and analyze it.

[Uses dlab.capture.emulator]
[Uses AI analysis]

Here's what I found in your app:
- Login screen with email/password fields
- "Sign In" button
- "Forgot Password" link
...
```

### Session 2: Full Testing Workflow
```
User: I need to test my checkout flow and attach results to JIRA-456

Claude: I'll help you test the checkout flow and attach everything to Jira.

1. First, let me start a recording session...
[dlab.capture.start]

2. Please perform the checkout flow. Let me know when done.

User: Done

3. Stopping recording and processing...
[dlab.capture.stop]

4. Generating test cases...
[dlab.taskhub.generate]

5. Attaching to Jira...
[dlab.jira.attach projectId="..." issueKey="JIRA-456"]

Done! I've attached 12 screenshots and a test report to JIRA-456.
```

## Contributing

See [CLAUDE.md](./CLAUDE.md) for development instructions and code patterns.
