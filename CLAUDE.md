# AppLab Discovery - Claude Code Instructions

## Project Overview

AppLab Discovery is an AI-powered app testing and marketing asset generator. It's a localhost-first tool distributed as a Claude Code Plugin (MCP Server).

## Architecture

### Tech Stack
- **Runtime**: Node.js 20+ / Bun
- **Build**: tsup (ESM output)
- **Database**: SQLite via Drizzle ORM (better-sqlite3)
- **Server**: Hono.js
- **Frontend**: Single HTML file with vanilla JS (no framework)
- **LLM**: Multi-provider support (Anthropic API, OpenAI API, Ollama, Claude CLI fallback)

### Key Directories
```
src/
├── cli.ts              # CLI entry point
├── index.ts            # Main exports
├── db/
│   └── schema.ts       # Drizzle ORM schema definitions
├── mcp/
│   └── tools/          # MCP tools for Claude integration
│       ├── ui.ts       # UI management tools
│       ├── project.ts  # Project CRUD tools
│       ├── capture.ts  # Screen capture tools
│       ├── testing.ts  # Maestro/Playwright tools
│       ├── taskhub.ts  # Task Hub tools
│       └── ...
├── web/
│   ├── server.ts       # Hono.js API server (~5000 lines)
│   └── index.html      # Monolithic frontend (~9000 lines)
└── commands/           # CLI commands
```

### Data Storage
- **Database**: `~/.discoverylab/discoverylab.db`
- **Projects**: `~/.discoverylab/projects/`
- **Recordings**: `~/.discoverylab/projects/maestro-recordings/` and `web-recordings/`
- **LLM Settings**: `~/.discoverylab/llm-settings.json`

## Development Commands

```bash
# Build the project
npm run build

# Start the development server
npm run dev

# Run the CLI
npx applab-discovery serve
```

## Code Patterns

### Frontend (index.html)
- All state is managed via global variables (`currentProject`, `projects`, etc.)
- Functions are globally scoped for onclick handlers
- CSS is embedded in `<style>` tags
- Uses CSS variables for theming (dark mode default)

### Backend (server.ts)
- RESTful API with Hono.js
- All endpoints are defined in a single file
- Uses Drizzle ORM for database operations
- Cascade delete pattern for related data cleanup

### Database Schema
Key tables in `src/db/schema.ts`:
- `projects` - Main project entity with all metadata
- `frames` - Extracted video frames
- `projectExports` - Export history
- `settings` - App configuration

## Task Hub Feature

### Data Model
```typescript
// In projects table
taskHubLinks: text     // JSON array: [{ id, type, url, title, status, metadata }]
taskRequirements: text // JSON array: [{ id, text, source, priority }]
taskTestMap: text      // JSON array: [{ id, description, type, completed }]
```

### Link Types
- `jira` - Extracts ticket key (e.g., PROJ-123)
- `notion` - Extracts page ID and name
- `figma` - Extracts file key and node ID
- `github` - Extracts owner, repo, issue/PR number

### API Endpoints
```
PUT  /api/projects/:id/links     - Save all link data
POST /api/mcp/fetch              - Extract metadata from URL
POST /api/mcp/fetch-batch        - Batch metadata extraction
POST /api/ai/generate-task-info  - Generate requirements/tests
POST /api/projects/sync-orphans  - Sync orphan project directories from disk to database
```

## Mobile Chat Feature

### Overview
In-app chat during mobile testing sessions. Uses optimized LLM configuration for fast responses.

### Claude CLI Optimization
When falling back to Claude CLI, uses optimized parameters:
- `--model haiku` - Faster model for chat interactions
- `--tools ""` - Disable tools overhead
- `--no-session-persistence` - Eliminate I/O overhead
- 120-second timeout (extended from 30s)

### API Endpoints
```
POST /api/mobile-chat          - Send chat message during mobile testing
GET  /api/mobile-chat/providers - Get available LLM providers for chat
```

## LLM Provider Configuration

### Provider Priority Order
1. **Anthropic API** - If `ANTHROPIC_API_KEY` is set (fastest, most reliable)
2. **OpenAI API** - If `OPENAI_API_KEY` is set
3. **Ollama** - If local server running at configured URL (default: `http://localhost:11434`)
4. **Claude CLI** - Fallback with 120-second timeout (uses haiku model for speed)

### Settings Storage
LLM settings persisted in `~/.discoverylab/llm-settings.json`:
```json
{
  "anthropicApiKey": "sk-ant-...",
  "anthropicModel": "claude-sonnet-4-20250514",
  "openaiApiKey": "sk-...",
  "openaiModel": "gpt-5.2",
  "ollamaUrl": "http://localhost:11434",
  "ollamaModel": "llama3.2"
}
```

### API Endpoints
```
GET  /api/settings/llm     - Get LLM settings (keys masked)
POST /api/settings/llm     - Update LLM settings
GET  /api/ollama/status    - Check Ollama status and models
GET  /api/mobile-chat/providers - Get available chat providers
```

## Recording Features

### Mobile Recording (Maestro)
- Uses Maestro CLI for automation
- Captures screenshots during recording
- Processes with OCR and AI analysis
- Stores in `maestro-recordings/` directory
- IDB (iOS Development Bridge) optional - not required for basic functionality

### Web Recording (Playwright)
- Uses user's installed Chrome browser (not bundled Chromium)
- Records user interactions via Playwright
- Video capture with configurable viewport
- Stores in `web-recordings/` directory

## Best Practices

### When Adding Features
1. Add schema changes to `src/db/schema.ts`
2. Add API endpoints to `src/web/server.ts`
3. Add UI to `src/web/index.html`
4. Run `npm run build` to verify TypeScript compiles

### When Modifying UI
- The index.html is monolithic - search for function names
- CSS is at the top, JS at the bottom
- Use existing CSS variables for consistency
- Follow existing naming patterns (camelCase for functions)

### When Deleting Data
- Always implement cascade delete
- Clean up: database records, filesystem, in-memory state
- Update UI after deletion

## MCP Tools Reference

The plugin exposes tools that any MCP-compatible CLI can use:

### UI & Setup
- `dlab.ui.open` - Open the web UI
- `dlab.ui.status` - Check server status
- `dlab.setup.status` - Check dependencies

### Projects
- `dlab.project.list` - List all projects
- `dlab.project.create` - Create new project
- `dlab.project.get` - Get project details
- `dlab.project.save` - Update project
- `dlab.project.delete` - Delete project

### Task Hub (NEW)
- `dlab.taskhub.links.list` - List external links
- `dlab.taskhub.links.add` - Add Jira/Notion/Figma/GitHub link
- `dlab.taskhub.links.remove` - Remove a link
- `dlab.taskhub.metadata.fetch` - Fetch URL metadata
- `dlab.taskhub.generate` - Generate requirements & test map
- `dlab.taskhub.requirements.get` - Get requirements list
- `dlab.taskhub.testmap.get` - Get test checklist
- `dlab.taskhub.testmap.toggle` - Toggle test completion

### Recording
- `dlab.capture.emulator` - Capture emulator screen
- `dlab.capture.start` - Start recording
- `dlab.capture.stop` - Stop recording

### Testing
- `dlab.maestro.run` - Run Maestro tests
- `dlab.playwright.run` - Run Playwright tests

### Integrations
- `dlab.notion.export` - Export to Notion
- `dlab.drive.upload` - Upload to Google Drive
- `dlab.jira.attach` - Attach to Jira issue

## Example MCP Usage

```bash
# Add a Jira link to a project
dlab.taskhub.links.add {
  "projectId": "abc123",
  "type": "jira",
  "url": "https://company.atlassian.net/browse/PROJ-456"
}

# Generate requirements from all links
dlab.taskhub.generate {
  "projectId": "abc123"
}

# Get test map progress
dlab.taskhub.testmap.get {
  "projectId": "abc123"
}
```

## Common Issues

### Build Errors
- TypeScript errors in DTS generation are common
- Check for undefined variables and proper typing
- The ESM build usually succeeds even if DTS fails

### Database Migrations
- Drizzle doesn't auto-migrate
- New columns need manual ALTER TABLE or DB recreation
- Schema changes are additive (existing data preserved)

### Shell Environment
- Some commands may fail due to PATH issues
- The `(eval):1: no such file or directory` error is a zsh config issue, not a code bug

## UI Modal Design Pattern

All dynamically-created modals MUST follow the same minimalist landscape style. Use `openJiraSettingsModal()` in `src/web/index.html` as the reference implementation.

### Reference Files
- **Reference modal**: `openJiraSettingsModal()` in `src/web/index.html`
- **Second example**: `openAddLinkModal()` in `src/web/index.html`

### Style Rules
- Landscape layout: `max-width: 600px`, use CSS grid (`grid-template-columns: 1fr 1fr`) for multi-field forms
- Scoped CSS via `#modalId .class` inside inline `<style>` in innerHTML
- Compact status badge: inline-flex, pill shape (`border-radius: 20px`), small dot + text
- Labels: `font-size: 11px`, `font-weight: 500`, `color: var(--text-secondary)`, text-only (no icons)
- Inputs: `padding: 7px 10px`, `font-size: 12px`, `background: var(--bg-primary)`, `border-radius: 6px`
- Hints: `font-size: 10px`, `color: var(--text-muted)`, minimal margin-top
- Modal body: compact padding (`12px 16px`)
- Button row: `justify-content: flex-end`, Cancel (btn-secondary) + Action (btn-primary)
- Full-width fields use `grid-column: 1 / -1`
- Close button: use `class="icon-btn"` with 18x18 SVG X icon (same as Settings modal). Never use `modal-close` class for dynamic modals
