---
name: integrations
description: "Export to Notion, Google Drive, and Jira"
emoji: "🔗"
version: "1.0.0"
category: integrations
requires:
  env: [NOTION_API_KEY]
always: true
install:
  manual: "Set NOTION_API_KEY, configure Google Drive OAuth, set JIRA_API_TOKEN"
tools:
  - dlab.notion.status
  - dlab.notion.login
  - dlab.notion.export
  - dlab.notion.quick
  - dlab.drive.status
  - dlab.drive.login
  - dlab.drive.upload
  - dlab.drive.quick
  - dlab.drive.folder
  - dlab.jira.status
  - dlab.jira.login
  - dlab.jira.attach
  - dlab.jira.create
  - dlab.jira.comment
  - dlab.jira.quick
  - dlab.export.to
tags: [integrations, notion, drive, jira, export, cloud]
---

# Integrations Skill

Export evidence and screenshots to external services: Notion, Google Drive, and Jira.

## Notion Tools

### dlab.notion.status

Check Notion API connection status.

### dlab.notion.export

Export project data to a Notion page:
- Creates formatted page with screenshots
- Includes test results and metadata

### dlab.notion.quick

Quick export single screenshot to Notion.

## Google Drive Tools

### dlab.drive.status

Check Google Drive connection status.

### dlab.drive.upload

Upload files to Google Drive:
- `fileOrFolder`: Path to upload
- `folderId`: Target Drive folder

### dlab.drive.folder

Create a folder in Google Drive.

## Jira Tools

### dlab.jira.status

Check Jira API connection.

### dlab.jira.attach

Attach screenshots to a Jira issue:
- `issueKey`: e.g., "PROJ-123"
- `files`: Paths to attach

### dlab.jira.create

Create a new Jira issue with evidence.

### dlab.jira.comment

Add comment with screenshots to issue.

## Setup

### Notion

1. Create Notion integration at https://developers.notion.com
2. Set `NOTION_API_KEY` environment variable
3. Share target pages with your integration

### Google Drive

1. Run `dlab.drive.login` for OAuth flow
2. Credentials stored securely in `~/.discoverylab/`

### Jira

1. Create API token at https://id.atlassian.com/manage-profile/security/api-tokens
2. Set `JIRA_API_TOKEN` and `JIRA_EMAIL` environment variables

## Usage Examples

```bash
# Export to Notion
dlab.notion.export {
  "projectId": "abc123",
  "pageId": "notion-page-id"
}

# Upload to Drive
dlab.drive.upload {
  "file": "./screenshots/",
  "folderId": "drive-folder-id"
}

# Attach to Jira
dlab.jira.attach {
  "issueKey": "PROJ-456",
  "files": ["./evidence/screenshot1.png"]
}
```
