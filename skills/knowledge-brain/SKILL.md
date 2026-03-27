---
name: knowledge-brain
description: Search and visualize app knowledge from captured flows
context: fork
agent: general-purpose
always: true
tags:
  - knowledge
  - search
  - context
  - app-flow
  - ui
  - screens
  - brain
---

# DiscoveryLab Knowledge Brain

DiscoveryLab captures app recordings and analyzes them with AI, building a knowledge base of every flow, screen, and UI element. This skill lets you query and visualize that knowledge.

## Default behavior: Visual first

When the user asks about an app flow, **show it visually by default** using `dlab.knowledge.open`. The returned HTML renders as an interactive canvas with animated frame player, annotations, and navigation. Only fall back to text if the user explicitly asks for text or if no frames are available.

## Tools

### `dlab.knowledge.open` (primary - visual)
Opens an interactive infographic of an app flow. Returns self-contained HTML.

```
dlab.knowledge.open { query: "login" }
dlab.knowledge.open { query: "onboarding flow" }
dlab.knowledge.open { projectId: "abc123" }
```

Use when:
- User asks "how does the login work?"
- User asks "show me the onboarding"
- User says "what does the settings screen look like?"
- Any question about a captured flow where visual context helps

### `dlab.knowledge.search` (text answers)
Search across all projects. Returns text with overview, flow steps, UI elements.

```
dlab.knowledge.search { query: "checkout" }
dlab.knowledge.search { query: "PROJ-123" }
```

Use when:
- User asks a specific factual question ("what buttons are on the paywall?")
- User references a Jira ticket
- You need quick context without opening a visual

### `dlab.knowledge.summary` (overview)
Lists all captured knowledge grouped by app.

```
dlab.knowledge.summary {}
```

Use when:
- User asks "what do we have captured?"
- Starting a new conversation
- Need to orient on available projects

### `dlab.project.import` (sharing)
Import a shared .applab project file.

```
dlab.project.import { filePath: "/path/to/project.applab" }
```

Use when someone shares a .applab file.

## How to respond

1. **Visual first** - use `dlab.knowledge.open` by default for flow questions
2. **Search first** - never say "I don't know" without searching
3. **No match?** - run `dlab.knowledge.summary` to show what's available
4. **Cite the source** - mention which project the information comes from
5. **Suggest captures** - if a flow doesn't exist, suggest capturing it
