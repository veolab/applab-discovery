---
name: open-ui
description: Open the DiscoveryLab web interface
disable-model-invocation: true
allowed-tools: dlab.ui.open, dlab.ui.status
---

# Open DiscoveryLab UI

Opens the DiscoveryLab web interface in your default browser.

## Workflow

1. Check if server is running with `dlab.ui.status`
2. If not running, start server and open UI with `dlab.ui.open`
3. Return the URL to the user

## Usage

This skill provides quick access to the DiscoveryLab dashboard where you can:
- Manage projects
- View captured screenshots and recordings
- Configure settings
- Access the Task Hub
