#!/usr/bin/env node
/**
 * DiscoveryLab - MCP Server Entry Point
 * AI-powered app testing & evidence generator
 *
 * This file serves as the MCP server entry point when invoked by Claude Code.
 * Run `discoverylab mcp` or use this file directly as the MCP server.
 */

import { getDatabase } from './db/index.js';
import { mcpServer } from './mcp/server.js';
import { uiTools, projectTools, setupTools, captureTools, analyzeTools, canvasTools, exportTools, testingTools, integrationTools, taskHubTools } from './mcp/tools/index.js';

// ============================================================================
// MCP SERVER STARTUP
// ============================================================================
async function main() {
  try {
    // Initialize database
    getDatabase();

    // Register all tools
    mcpServer.registerTools([
      ...uiTools,
      ...projectTools,
      ...setupTools,
      ...captureTools,
      ...analyzeTools,
      ...canvasTools,
      ...exportTools,
      ...testingTools,
      ...integrationTools,
      ...taskHubTools,
    ]);

    // Start STDIO transport for MCP
    await mcpServer.runStdio();
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
}

main();

// ============================================================================
// EXPORTS (for programmatic use)
// ============================================================================
export { mcpServer } from './mcp/server.js';
export { getDatabase, closeDatabase } from './db/index.js';
export * from './db/schema.js';
export { startServer, stopServer } from './web/server.js';

// WebSocket Protocol (Clawdbot-inspired typed protocol)
export * from './core/protocol/index.js';

// Skills System (SKILL.md discovery and loading)
export * from './core/skills/index.js';
