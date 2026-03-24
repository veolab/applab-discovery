---
name: knowledge-brain
description: Search app knowledge from captured flows - UI, screens, behaviors
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
---

# DiscoveryLab Knowledge Brain

When the user asks about app flows, screens, UI elements, or how something works in an app they've captured, use DiscoveryLab's knowledge base to find answers.

## When to Use

Use `dlab.knowledge.search` when the user:
- Asks about a specific app screen ("how does the login work?")
- Asks about UI elements ("what buttons are on the paywall?")
- Asks about user flows ("what's the onboarding flow?")
- References an app by name ("in StyliApp, what does the closet screen show?")
- Needs context about captured recordings
- Compares flows or screens

## Tools

### `dlab.knowledge.search`
Search across all captured projects. Matches against project names, AI analysis, OCR text, tags, and linked tickets.

```
dlab.knowledge.search { query: "login StyliApp" }
dlab.knowledge.search { query: "paywall premium" }
dlab.knowledge.search { query: "onboarding flow" }
```

Returns: project overview, user flow steps, UI elements found, OCR text sample, and project ID for deeper lookup.

### `dlab.knowledge.summary`
Get a high-level overview of all captured app knowledge.

```
dlab.knowledge.summary {}
```

Returns: all projects grouped by app, with stats (flows count, screens, analysis status).

### `dlab.project.get`
For full details on a specific project found via search.

```
dlab.project.get { projectId: "abc123" }
```

## Behavior

1. Always search first before saying you don't know about an app flow
2. If no match, show available projects so the user knows what's captured
3. Use `dlab.project.get` for full details when the search result needs more depth
4. Multiple projects may cover the same flow (different versions) - present the most recent first
