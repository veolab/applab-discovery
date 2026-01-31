---
name: task-hub
description: Manage external links, requirements and test maps
context: fork
agent: general-purpose
---

# Task Hub Management

Manage external links (Jira, Notion, Figma, GitHub) and generate requirements and test maps.

## Workflow

1. **Select Project**: Use `dlab.project.list` to find or create project
2. **Add Links**: Use `dlab.taskhub.links.add` to connect external resources:
   - Jira tickets for requirements
   - Notion pages for documentation
   - Figma files for designs
   - GitHub issues/PRs for code context
3. **Fetch Metadata**: Use `dlab.taskhub.metadata.fetch` to extract info from links
4. **Generate Content**: Use `dlab.taskhub.generate` to create:
   - Requirements list from linked resources
   - Test map with acceptance criteria
5. **Track Progress**: Use `dlab.taskhub.testmap.toggle` to mark tests complete

## Link Types

| Type | Extracted Info |
|------|----------------|
| Jira | Ticket key, title, description, status |
| Notion | Page title, content summary |
| Figma | File name, frame names, comments |
| GitHub | Issue/PR title, description, labels |

## Tools

- `dlab.taskhub.links.list` - View all linked resources
- `dlab.taskhub.links.add` - Add new external link
- `dlab.taskhub.links.remove` - Remove a link
- `dlab.taskhub.metadata.fetch` - Fetch URL metadata
- `dlab.taskhub.generate` - Generate requirements & tests
- `dlab.taskhub.requirements.get` - Get requirements list
- `dlab.taskhub.testmap.get` - Get test checklist
- `dlab.taskhub.testmap.toggle` - Toggle test completion
