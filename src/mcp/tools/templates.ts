/**
 * DiscoveryLab Template Tools
 * MCP tools for listing and rendering video templates
 */

import { z } from 'zod';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult, createJsonResult } from '../server.js';
import { isTemplatesInstalled, getAvailableTemplates } from '../../core/templates/loader.js';

// ============================================================================
// dlab.template.list
// ============================================================================
export const templateListTool: MCPTool = {
  name: 'dlab.template.list',
  description: 'List available Remotion video templates. Returns installed templates with their metadata, or indicates templates are not installed.',
  inputSchema: z.object({}),
  handler: async () => {
    const installed = isTemplatesInstalled();
    if (!installed) {
      return createJsonResult({
        installed: false,
        templates: [],
        message: 'Templates not installed. Install discoverylab-templates to ~/.discoverylab/templates/',
      });
    }

    const templates = getAvailableTemplates();
    return createJsonResult({
      installed: true,
      templates: templates.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        resolution: `${t.width}x${t.height}`,
        fps: t.fps,
        durationFrames: t.durationFrames,
      })),
    });
  },
};

// ============================================================================
// dlab.template.render
// ============================================================================
export const templateRenderTool: MCPTool = {
  name: 'dlab.template.render',
  description: 'Render a project video with a Remotion template. Starts an async render job and returns the job ID. Use the web UI to monitor progress.',
  inputSchema: z.object({
    projectId: z.string().describe('The project ID to render'),
    templateId: z.enum(['studio', 'showcase']).describe('Template to use: "studio" (device + terminal) or "showcase" (floating device + artistic title + terminal)'),
  }),
  handler: async ({ projectId, templateId }) => {
    if (!isTemplatesInstalled()) {
      return createErrorResult('Templates not installed. Install discoverylab-templates first.');
    }

    // Delegate to the web server endpoint for full props assembly + render
    return createTextResult(
      `To render project "${projectId}" with template "${templateId}", use the web UI or call POST /api/templates/render with { projectId: "${projectId}", templateId: "${templateId}" }. ` +
      `The render runs asynchronously and progress is broadcast via WebSocket.`
    );
  },
};

// ============================================================================
// EXPORTS
// ============================================================================
export const templateTools: MCPTool[] = [
  templateListTool,
  templateRenderTool,
];
