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

DiscoveryLab captures app recordings and analyzes them with OCR + AI, building a knowledge base of every flow, screen, and UI element. This skill lets you query that knowledge.

## When to Use

Use this whenever the user asks about:
- How a specific screen or flow works in their app
- What UI elements exist on a page (buttons, inputs, labels)
- The user journey through a feature (onboarding, checkout, settings)
- Comparing different captures of the same flow
- Any reference to app screens, recordings, or captured content
- Context about what was tested or recorded

Also use proactively when:
- The user is working on code related to a feature that was captured
- You need visual context about the app to give better answers
- The user mentions a Jira ticket that might be linked to a project

## Tools

### `dlab.knowledge.search`
Semantic search across all captured projects. Matches against: project names, AI analysis summaries, OCR text from every screen, tags, and linked tickets.

```
dlab.knowledge.search { query: "login" }
dlab.knowledge.search { query: "paywall" }
dlab.knowledge.search { query: "onboarding flow" }
dlab.knowledge.search { query: "PROJ-123" }
dlab.knowledge.search { query: "settings profile" }
```

Returns per match:
- App overview (what the screen/flow does)
- User flow steps (numbered sequence)
- UI elements found (buttons, inputs, navigation)
- OCR text sample (actual text visible on screens)
- Project ID for deeper lookup

### `dlab.knowledge.summary`
High-level overview of the entire knowledge base - all projects grouped by app with stats.

```
dlab.knowledge.summary {}
```

Use this when:
- The user asks "what do we have captured?"
- You need to orient yourself on what apps/flows exist
- Starting a new conversation and need context

### `dlab.project.get`
Full details on a specific project found via search. Use when the search result summary is not enough.

```
dlab.project.get { projectId: "<id from search results>" }
```

## How to Respond

1. **Search first** - never say "I don't have information about that" without searching
2. **No match?** - run `dlab.knowledge.summary` to show the user what's available
3. **Multiple results** - present the most recent first, note if there are different versions
4. **Cite the source** - mention which project/recording the information comes from
5. **Suggest captures** - if the user asks about a flow that doesn't exist, suggest they capture it with DiscoveryLab
6. **Be specific** - use the OCR text and UI elements from results to give precise answers, not generic ones
