/**
 * DiscoveryLab Knowledge Tools
 * Semantic search across all projects - turns DiscoveryLab into a knowledge base.
 * Claude can query app flows, UI elements, and behaviors from captured projects.
 */

import { z } from 'zod';
import { desc } from 'drizzle-orm';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult, createJsonResult } from '../server.js';
import { getDatabase, projects, frames } from '../../db/index.js';

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
// Export
// ============================================================================
export const knowledgeTools: MCPTool[] = [
  knowledgeSearchTool,
  knowledgeSummaryTool,
];
