/**
 * DiscoveryLab Knowledge Tools
 * Semantic search across all projects - turns DiscoveryLab into a knowledge base.
 * Claude can query app flows, UI elements, and behaviors from captured projects.
 */

import { z } from 'zod';
import { desc } from 'drizzle-orm';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult, createJsonResult, mcpServer } from '../server.js';
import { getDatabase, projects, frames } from '../../db/index.js';

const KNOWLEDGE_VIEWER_RESOURCE_URI = 'ui://discoverylab/knowledge-viewer.html';
const KNOWLEDGE_VIEWER_MIME_TYPE = 'text/html;profile=mcp-app';

function buildViewerPlaceholderHtml(message: string): string {
  const safeMessage = JSON.stringify(message);
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DiscoveryLab Flow Viewer</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1117;
        --panel: rgba(255, 255, 255, 0.04);
        --border: rgba(255, 255, 255, 0.1);
        --text: #eff5fb;
        --muted: #9fb0c2;
        --accent: #2dd4bf;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(45, 212, 191, 0.18), transparent 28%),
          linear-gradient(180deg, #101826, var(--bg));
        color: var(--text);
        font: 14px/1.5 "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
      }

      .card {
        width: min(720px, 100%);
        border: 1px solid var(--border);
        border-radius: 24px;
        padding: 24px;
        background: var(--panel);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 6px 12px;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }

      h1 {
        margin: 16px 0 8px;
        font: 700 32px/1.02 "Space Grotesk", "Avenir Next", system-ui, sans-serif;
        letter-spacing: -0.03em;
      }

      p {
        margin: 0;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="eyebrow">DiscoveryLab Local Viewer</div>
      <h1>Open a flow in Claude Desktop</h1>
      <p id="message"></p>
    </main>
    <script>
      document.getElementById('message').textContent = ${safeMessage};
    </script>
  </body>
</html>`;
}

mcpServer.registerResource({
  uri: KNOWLEDGE_VIEWER_RESOURCE_URI,
  name: 'discoverylab-knowledge-viewer',
  title: 'DiscoveryLab Flow Viewer',
  description: 'Interactive local flow viewer for DiscoveryLab projects.',
  mimeType: KNOWLEDGE_VIEWER_MIME_TYPE,
  contents: [
    {
      uri: KNOWLEDGE_VIEWER_RESOURCE_URI,
      mimeType: KNOWLEDGE_VIEWER_MIME_TYPE,
      text: buildViewerPlaceholderHtml('Use dlab.knowledge.open to load a local project into the canvas.'),
    },
  ],
});

// ============================================================================
// dlab.knowledge.search
// ============================================================================
export const knowledgeSearchTool: MCPTool = {
  name: 'dlab.knowledge.search',
  description: `Search across all DiscoveryLab projects for app flows, UI elements, screens, and behaviors. Use this when the user asks about how an app works, what a specific screen looks like, or any question about captured app flows. Returns relevant projects with their analysis, OCR text, and context.`,
  inputSchema: z.object({
    query: z.string().describe('Search query - app name, screen name, UI element, flow description, or any keyword'),
    limit: z.number().optional().describe('Max results (default: 5)'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();
      const allProjects = await db.select().from(projects).orderBy(desc(projects.updatedAt));

      if (allProjects.length === 0) {
        return createTextResult('No projects in DiscoveryLab. The user needs to capture some app flows first.');
      }

      const query = params.query.toLowerCase();
      const queryTerms = query.split(/\s+/).filter(t => t.length > 1);
      const limit = params.limit || 5;

      // Score each project by relevance
      const scored = allProjects.map(p => {
        let score = 0;
        const searchFields = [
          { text: p.name || '', weight: 3 },
          { text: p.marketingTitle || '', weight: 3 },
          { text: p.marketingDescription || '', weight: 2 },
          { text: p.aiSummary || '', weight: 2 },
          { text: p.ocrText || '', weight: 1 },
          { text: p.tags || '', weight: 2 },
          { text: p.linkedTicket || '', weight: 2 },
          { text: p.taskHubLinks || '', weight: 1 },
          { text: p.platform || '', weight: 1 },
        ];

        for (const field of searchFields) {
          const text = field.text.toLowerCase();
          for (const term of queryTerms) {
            if (text.includes(term)) {
              score += field.weight;
            }
          }
          // Bonus for exact phrase match
          if (text.includes(query)) {
            score += field.weight * 2;
          }
        }

        return { project: p, score };
      })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length === 0) {
        // Return all project names so Claude knows what's available
        const names = allProjects.slice(0, 15).map(p =>
          `- ${p.marketingTitle || p.name} (${p.platform || 'unknown'}, ${p.status})`
        ).join('\n');
        return createTextResult(`No projects matched "${params.query}". Available projects:\n${names}\n\nTry searching with different keywords or ask about a specific app/flow.`);
      }

      // Build rich results
      const results = scored.map(({ project: p, score }) => {
        // Extract user flow from aiSummary if available
        let userFlow = '';
        if (p.aiSummary) {
          const flowMatch = p.aiSummary.match(/## (?:User Flow|Likely User Flow|App Flow)\n([\s\S]*?)(?=\n##|\n$|$)/);
          if (flowMatch) userFlow = flowMatch[1].trim().slice(0, 500);
        }

        // Extract key UI elements
        let uiElements = '';
        if (p.aiSummary) {
          const uiMatch = p.aiSummary.match(/## (?:UI Elements Found|Key UI Elements)\n([\s\S]*?)(?=\n##|\n$|$)/);
          if (uiMatch) uiElements = uiMatch[1].trim().slice(0, 400);
        }

        // Extract overview
        let overview = '';
        if (p.aiSummary) {
          const overviewMatch = p.aiSummary.match(/## (?:App Overview|Page \/ App Overview)\n([\s\S]*?)(?=\n##|\n$|$)/);
          if (overviewMatch) overview = overviewMatch[1].trim().slice(0, 300);
        }

        return {
          projectId: p.id,
          name: p.marketingTitle || p.name,
          platform: p.platform,
          status: p.status,
          overview: overview || p.marketingDescription || '',
          userFlow: userFlow || '',
          uiElements: uiElements || '',
          ocrSample: p.ocrText?.slice(0, 300) || '',
          frameCount: p.frameCount || 0,
          linkedTicket: p.linkedTicket || '',
          tags: p.tags || '',
          relevanceScore: score,
        };
      });

      // Format for Claude
      let response = `Found ${results.length} project(s) matching "${params.query}":\n\n`;

      for (const r of results) {
        response += `### ${r.name}\n`;
        response += `Platform: ${r.platform || 'unknown'} | Screens: ${r.frameCount} | Status: ${r.status}\n`;
        if (r.linkedTicket) response += `Ticket: ${r.linkedTicket}\n`;
        if (r.overview) response += `\n**Overview:** ${r.overview}\n`;
        if (r.userFlow) response += `\n**User Flow:**\n${r.userFlow}\n`;
        if (r.uiElements) response += `\n**UI Elements:**\n${r.uiElements}\n`;
        if (r.ocrSample) response += `\n**Screen Text (OCR):** ${r.ocrSample}\n`;
        response += `\nProject ID: ${r.projectId} (use dlab.project.get for full details)\n`;
        response += `---\n`;
      }

      return createTextResult(response);
    } catch (error) {
      return createErrorResult(`Knowledge search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

// ============================================================================
// dlab.knowledge.summary
// ============================================================================
export const knowledgeSummaryTool: MCPTool = {
  name: 'dlab.knowledge.summary',
  description: 'Get a high-level summary of all captured app knowledge in DiscoveryLab. Lists all projects grouped by app/platform with key stats.',
  inputSchema: z.object({}),
  handler: async () => {
    try {
      const db = getDatabase();
      const allProjects = await db.select().from(projects).orderBy(desc(projects.updatedAt));

      if (allProjects.length === 0) {
        return createTextResult('No projects in DiscoveryLab yet.');
      }

      // Group by app name (first word of name, or marketing title)
      const appGroups = new Map<string, typeof allProjects>();
      for (const p of allProjects) {
        const appName = (p.marketingTitle || p.name || 'Unknown').split(/\s+/)[0];
        if (!appGroups.has(appName)) appGroups.set(appName, []);
        appGroups.get(appName)!.push(p);
      }

      let response = `# DiscoveryLab Knowledge Base\n`;
      response += `**${allProjects.length} projects** across **${appGroups.size} app(s)**\n\n`;

      for (const [app, projs] of appGroups) {
        const platforms = [...new Set(projs.map(p => p.platform).filter(Boolean))];
        const analyzed = projs.filter(p => p.status === 'analyzed').length;
        const totalFrames = projs.reduce((sum, p) => sum + (p.frameCount || 0), 0);

        response += `## ${app} (${platforms.join(', ')})\n`;
        response += `${projs.length} flows captured | ${analyzed} analyzed | ${totalFrames} screens\n`;

        for (const p of projs.slice(0, 5)) {
          const title = p.marketingTitle || p.name;
          response += `- **${title}** (${p.frameCount || 0} screens, ${p.status})`;
          if (p.linkedTicket) response += ` [${p.linkedTicket}]`;
          response += '\n';
        }
        if (projs.length > 5) response += `  ... and ${projs.length - 5} more\n`;
        response += '\n';
      }

      response += `\nUse \`dlab.knowledge.search\` with a query to find specific flows or screens.`;

      return createTextResult(response);
    } catch (error) {
      return createErrorResult(`Summary failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

// ============================================================================
// dlab.knowledge.open
// ============================================================================
export const knowledgeOpenTool: MCPTool = {
  name: 'dlab.knowledge.open',
  description: `Open an interactive visual infographic of an app flow. Returns self-contained HTML that Claude Desktop renders as a canvas/artifact. Use this when the user wants to SEE a flow visually, not just read about it. The HTML includes animated frame player, annotations, and navigation.`,
  inputSchema: z.object({
    query: z.string().optional().describe('Search query to find the project (e.g. "login flow", "onboarding")'),
    projectId: z.string().optional().describe('Direct project ID if known'),
  }),
  _meta: {
    ui: {
      resourceUri: KNOWLEDGE_VIEWER_RESOURCE_URI,
    },
  },
  handler: async (params) => {
    try {
      const db = getDatabase();

      let project: any = null;

      // Find project by ID or search
      if (params.projectId) {
        const { eq } = await import('drizzle-orm');
        const [p] = await db.select().from(projects).where(eq(projects.id, params.projectId)).limit(1);
        project = p;
      } else if (params.query) {
        // Reuse search logic
        const allProjects = await db.select().from(projects).orderBy(desc(projects.updatedAt));
        const query = params.query.toLowerCase();
        const queryTerms = query.split(/\s+/).filter(t => t.length > 1);

        let bestScore = 0;
        for (const p of allProjects) {
          let score = 0;
          const fields = [p.name, p.marketingTitle, p.aiSummary, p.ocrText, p.tags, p.linkedTicket].filter(Boolean);
          for (const field of fields) {
            const text = (field as string).toLowerCase();
            for (const term of queryTerms) {
              if (text.includes(term)) score += 1;
            }
            if (text.includes(query)) score += 3;
          }
          if (score > bestScore) { bestScore = score; project = p; }
        }
      }

      if (!project) {
        return createErrorResult(`No project found${params.query ? ` for "${params.query}"` : ''}. Use dlab.knowledge.summary to see available projects.`);
      }

      // Get frames
      const { eq } = await import('drizzle-orm');
      const { FRAMES_DIR, PROJECTS_DIR } = await import('../../db/index.js');
      const { join } = await import('node:path');
      const dbFrames = await db.select().from(frames)
        .where(eq(frames.projectId, project.id))
        .orderBy(frames.frameNumber)
        .limit(15);

      const { resolveInfographicFrameInputs, buildInfographicData, generateInfographicHtmlString } = await import('../../core/export/infographic.js');
      const resolvedFrames = resolveInfographicFrameInputs(
        dbFrames,
        join(FRAMES_DIR, project.id),
        project.videoPath,
        PROJECTS_DIR,
        project.id,
      );

      if (resolvedFrames.frameFiles.length === 0) {
        return createTextResult(`Project "${project.marketingTitle || project.name}" has no readable frames. Run the analyzer again, then try again.`);
      }

      // Build and generate HTML inline
      const data = buildInfographicData(project, resolvedFrames.frameFiles, resolvedFrames.frameOcr);
      if (data.frames.length === 0) {
        return createErrorResult(`Project "${project.marketingTitle || project.name}" did not produce embeddable infographic frames.`);
      }
      const html = generateInfographicHtmlString(data);

      if (!html) {
        return createErrorResult('Failed to generate infographic HTML (template not found)');
      }

      mcpServer.upsertResourceContents(KNOWLEDGE_VIEWER_RESOURCE_URI, {
        name: 'discoverylab-knowledge-viewer',
        title: `DiscoveryLab Flow Viewer · ${project.marketingTitle || project.name}`,
        description: 'Interactive local flow viewer for DiscoveryLab projects.',
        mimeType: KNOWLEDGE_VIEWER_MIME_TYPE,
        contents: [
          {
            uri: KNOWLEDGE_VIEWER_RESOURCE_URI,
            mimeType: KNOWLEDGE_VIEWER_MIME_TYPE,
            text: html,
          },
        ],
      });

      return {
        content: [
          {
            type: 'text',
            text: `Opened the local DiscoveryLab flow viewer for ${project.marketingTitle || project.name}.`,
          },
        ],
        structuredContent: {
          projectId: project.id,
          name: project.marketingTitle || project.name,
          frameCount: resolvedFrames.frameFiles.length,
          platform: project.platform || 'unknown',
        },
        _meta: {
          ui: {
            resourceUri: KNOWLEDGE_VIEWER_RESOURCE_URI,
          },
        },
      };
    } catch (error) {
      return createErrorResult(`Failed to open flow: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

// ============================================================================
// Export
// ============================================================================
export const knowledgeTools: MCPTool[] = [
  knowledgeSearchTool,
  knowledgeSummaryTool,
  knowledgeOpenTool,
];
