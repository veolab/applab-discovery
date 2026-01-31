/**
 * DiscoveryLab UI Tools
 * MCP tools for UI operations
 */

import { z } from 'zod';
import open from 'open';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult } from '../server.js';

const DEFAULT_PORT = 3847;

// ============================================================================
// dlab.ui.open
// ============================================================================
export const uiOpenTool: MCPTool = {
  name: 'dlab.ui.open',
  description: 'Open DiscoveryLab web UI in the default browser. The UI provides a visual interface for managing projects, capturing screens, and exporting evidence.',
  inputSchema: z.object({
    port: z.number().optional().describe('Port number (default: 3847)'),
  }),
  handler: async (params) => {
    const port = params.port || DEFAULT_PORT;
    const url = `http://localhost:${port}`;

    try {
      await open(url);
      return createTextResult(`Opened DiscoveryLab UI at ${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open browser';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// dlab.ui.status
// ============================================================================
export const uiStatusTool: MCPTool = {
  name: 'dlab.ui.status',
  description: 'Check if DiscoveryLab web UI server is running.',
  inputSchema: z.object({}),
  handler: async () => {
    const port = DEFAULT_PORT;
    const url = `http://localhost:${port}/api/health`;

    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return createTextResult(`DiscoveryLab UI is running at http://localhost:${port}`);
      } else {
        return createTextResult(`DiscoveryLab UI returned status ${response.status}`);
      }
    } catch {
      return createTextResult(`DiscoveryLab UI is not running. Start it with: discoverylab serve`);
    }
  },
};

// ============================================================================
// EXPORTS
// ============================================================================
export const uiTools: MCPTool[] = [uiOpenTool, uiStatusTool];
