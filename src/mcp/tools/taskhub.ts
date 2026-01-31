/**
 * DiscoveryLab Task Hub Tools
 * MCP tools for managing task links, metadata, requirements, and test maps
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult, createJsonResult } from '../server.js';
import { getDatabase, projects } from '../../db/index.js';

// ============================================================================
// HELPER: Extract metadata from URL
// ============================================================================
function extractLinkMetadata(url: string, type: string): { success: boolean; metadata: any; error?: string } {
  try {
    const parsedUrl = new URL(url);

    switch (type) {
      case 'jira': {
        const ticketMatch = url.match(/([A-Z]+-\d+)/);
        const ticketKey = ticketMatch ? ticketMatch[1] : null;
        return {
          success: true,
          metadata: {
            ticketKey,
            domain: parsedUrl.hostname,
            type: 'jira',
            title: ticketKey ? `Jira Issue ${ticketKey}` : 'Jira Issue',
            status: null,
            fetchedAt: new Date().toISOString()
          }
        };
      }

      case 'notion': {
        const pageIdMatch = url.match(/([a-f0-9]{32}|[a-f0-9-]{36})/i);
        const pageId = pageIdMatch ? pageIdMatch[1] : null;
        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const pageName = pathParts[pathParts.length - 1]?.replace(/-[a-f0-9]{32}$/i, '').replace(/-/g, ' ');
        return {
          success: true,
          metadata: {
            pageId,
            domain: parsedUrl.hostname,
            type: 'notion',
            title: pageName || 'Notion Page',
            workspace: pathParts[0] || null,
            fetchedAt: new Date().toISOString()
          }
        };
      }

      case 'figma': {
        const fileMatch = url.match(/file\/([a-zA-Z0-9]+)/);
        const nodeMatch = url.match(/node-id=([^&]+)/);
        const fileKey = fileMatch ? fileMatch[1] : null;
        const nodeId = nodeMatch ? decodeURIComponent(nodeMatch[1]) : null;
        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const fileName = pathParts[2]?.replace(/-/g, ' ') || 'Figma Design';
        return {
          success: true,
          metadata: {
            fileKey,
            nodeId,
            domain: parsedUrl.hostname,
            type: 'figma',
            title: fileName,
            fetchedAt: new Date().toISOString()
          }
        };
      }

      case 'github': {
        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const owner = pathParts[0];
        const repo = pathParts[1];
        const itemType = pathParts[2];
        const itemNumber = pathParts[3];
        return {
          success: true,
          metadata: {
            owner,
            repo,
            itemType: itemType === 'pull' ? 'pull_request' : itemType,
            itemNumber: itemNumber ? parseInt(itemNumber) : null,
            domain: parsedUrl.hostname,
            type: 'github',
            title: itemNumber ? `${owner}/${repo}#${itemNumber}` : `${owner}/${repo}`,
            fetchedAt: new Date().toISOString()
          }
        };
      }

      default:
        return { success: false, metadata: null, error: `Unsupported link type: ${type}` };
    }
  } catch (err) {
    return { success: false, metadata: null, error: err instanceof Error ? err.message : 'Invalid URL' };
  }
}

// ============================================================================
// dlab.taskhub.links.list
// ============================================================================
export const taskHubLinksListTool: MCPTool = {
  name: 'dlab.taskhub.links.list',
  description: 'List all external links (Jira, Notion, Figma, GitHub) for a project.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();
      const result = await db.select().from(projects).where(eq(projects.id, params.projectId)).limit(1);

      if (result.length === 0) {
        return createErrorResult(`Project not found: ${params.projectId}`);
      }

      const project = result[0];
      const links: any[] = [];

      // Parse taskHubLinks if exists
      if (project.taskHubLinks) {
        try {
          const parsed = JSON.parse(project.taskHubLinks);
          links.push(...parsed);
        } catch (e) {}
      }

      // Include legacy links for backwards compatibility
      if (project.linkedJiraUrl && !links.find(l => l.url === project.linkedJiraUrl)) {
        links.push({ id: 'legacy_jira', type: 'jira', url: project.linkedJiraUrl, title: 'Jira Issue' });
      }
      if (project.linkedNotionUrl && !links.find(l => l.url === project.linkedNotionUrl)) {
        links.push({ id: 'legacy_notion', type: 'notion', url: project.linkedNotionUrl, title: 'Notion Page' });
      }
      if (project.linkedFigmaUrl && !links.find(l => l.url === project.linkedFigmaUrl)) {
        links.push({ id: 'legacy_figma', type: 'figma', url: project.linkedFigmaUrl, title: 'Figma Design' });
      }

      return createJsonResult({
        projectId: params.projectId,
        count: links.length,
        links,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list links';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// dlab.taskhub.links.add
// ============================================================================
export const taskHubLinksAddTool: MCPTool = {
  name: 'dlab.taskhub.links.add',
  description: 'Add an external link (Jira, Notion, Figma, GitHub) to a project.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID'),
    type: z.enum(['jira', 'notion', 'figma', 'github']).describe('Link type'),
    url: z.string().describe('URL of the external resource'),
    title: z.string().optional().describe('Optional title (auto-extracted from URL if not provided)'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();
      const result = await db.select().from(projects).where(eq(projects.id, params.projectId)).limit(1);

      if (result.length === 0) {
        return createErrorResult(`Project not found: ${params.projectId}`);
      }

      const project = result[0];

      // Extract metadata from URL
      const metadataResult = extractLinkMetadata(params.url, params.type);
      if (!metadataResult.success) {
        return createErrorResult(metadataResult.error || 'Invalid URL');
      }

      // Parse existing links
      let links: any[] = [];
      if (project.taskHubLinks) {
        try {
          links = JSON.parse(project.taskHubLinks);
        } catch (e) {}
      }

      // Create new link
      const newLink = {
        id: `link_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: params.type,
        url: params.url,
        title: params.title || metadataResult.metadata.title,
        status: null,
        metadata: metadataResult.metadata,
        createdAt: new Date().toISOString(),
      };

      links.push(newLink);

      // Update database
      await db.update(projects).set({
        taskHubLinks: JSON.stringify(links),
        updatedAt: new Date(),
      }).where(eq(projects.id, params.projectId));

      return createJsonResult({
        message: 'Link added successfully',
        link: newLink,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to add link';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// dlab.taskhub.links.remove
// ============================================================================
export const taskHubLinksRemoveTool: MCPTool = {
  name: 'dlab.taskhub.links.remove',
  description: 'Remove an external link from a project.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID'),
    linkId: z.string().describe('Link ID to remove'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();
      const result = await db.select().from(projects).where(eq(projects.id, params.projectId)).limit(1);

      if (result.length === 0) {
        return createErrorResult(`Project not found: ${params.projectId}`);
      }

      const project = result[0];

      // Parse existing links
      let links: any[] = [];
      if (project.taskHubLinks) {
        try {
          links = JSON.parse(project.taskHubLinks);
        } catch (e) {}
      }

      // Remove the link
      const initialCount = links.length;
      links = links.filter(l => l.id !== params.linkId);

      if (links.length === initialCount) {
        return createErrorResult(`Link not found: ${params.linkId}`);
      }

      // Update database
      await db.update(projects).set({
        taskHubLinks: JSON.stringify(links),
        updatedAt: new Date(),
      }).where(eq(projects.id, params.projectId));

      return createTextResult(`Link ${params.linkId} removed successfully`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove link';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// dlab.taskhub.metadata.fetch
// ============================================================================
export const taskHubMetadataFetchTool: MCPTool = {
  name: 'dlab.taskhub.metadata.fetch',
  description: 'Fetch metadata from an external URL (Jira ticket key, Notion page ID, Figma file info, etc.).',
  inputSchema: z.object({
    url: z.string().describe('URL to fetch metadata from'),
    type: z.enum(['jira', 'notion', 'figma', 'github']).describe('Link type'),
  }),
  handler: async (params) => {
    const result = extractLinkMetadata(params.url, params.type);

    if (!result.success) {
      return createErrorResult(result.error || 'Failed to extract metadata');
    }

    return createJsonResult({
      success: true,
      metadata: result.metadata,
    });
  },
};

// ============================================================================
// dlab.taskhub.generate
// ============================================================================
export const taskHubGenerateTool: MCPTool = {
  name: 'dlab.taskhub.generate',
  description: 'Generate requirements and test map from project links using AI analysis.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();
      const result = await db.select().from(projects).where(eq(projects.id, params.projectId)).limit(1);

      if (result.length === 0) {
        return createErrorResult(`Project not found: ${params.projectId}`);
      }

      const project = result[0];

      // Gather all links
      const links: any[] = [];
      if (project.taskHubLinks) {
        try {
          links.push(...JSON.parse(project.taskHubLinks));
        } catch (e) {}
      }
      if (project.linkedJiraUrl) {
        links.push({ type: 'jira', url: project.linkedJiraUrl, title: 'Jira Issue' });
      }
      if (project.linkedNotionUrl) {
        links.push({ type: 'notion', url: project.linkedNotionUrl, title: 'Notion Page' });
      }
      if (project.linkedFigmaUrl) {
        links.push({ type: 'figma', url: project.linkedFigmaUrl, title: 'Figma Design' });
      }

      if (links.length === 0) {
        return createErrorResult('No links found. Add links first with dlab.taskhub.links.add');
      }

      // Generate requirements and test map
      const requirements: any[] = [];
      const testMap: any[] = [];

      for (const link of links) {
        const { type, title, metadata } = link;

        switch (type) {
          case 'jira': {
            const ticketKey = metadata?.ticketKey || title;
            requirements.push({
              id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
              text: `Implement functionality as specified in ${ticketKey}`,
              source: ticketKey,
              priority: 'medium'
            });
            testMap.push({
              id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
              description: `Verify ${ticketKey} acceptance criteria`,
              type: 'functional',
              completed: false
            });
            break;
          }
          case 'notion': {
            const pageName = metadata?.title || title;
            requirements.push({
              id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
              text: `Follow specifications from "${pageName}"`,
              source: pageName,
              priority: 'medium'
            });
            testMap.push({
              id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
              description: `Validate against "${pageName}" documentation`,
              type: 'documentation',
              completed: false
            });
            break;
          }
          case 'figma': {
            const designName = metadata?.title || title;
            requirements.push({
              id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
              text: `Match UI/UX specifications from "${designName}"`,
              source: designName,
              priority: 'high'
            });
            testMap.push({
              id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
              description: `Visual regression test against "${designName}"`,
              type: 'visual',
              completed: false
            });
            break;
          }
          case 'github': {
            const repoInfo = metadata?.title || title;
            requirements.push({
              id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
              text: `Address issue/PR: ${repoInfo}`,
              source: repoInfo,
              priority: 'medium'
            });
            testMap.push({
              id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
              description: `Verify fix for ${repoInfo}`,
              type: 'regression',
              completed: false
            });
            break;
          }
        }
      }

      // Add general test cases
      testMap.push({
        id: `test_${Date.now()}_compat`,
        description: 'Cross-browser compatibility check',
        type: 'compatibility',
        completed: false
      });

      // Update database
      await db.update(projects).set({
        taskRequirements: JSON.stringify(requirements),
        taskTestMap: JSON.stringify(testMap),
        updatedAt: new Date(),
      }).where(eq(projects.id, params.projectId));

      return createJsonResult({
        message: 'Task info generated successfully',
        requirements,
        testMap,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate task info';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// dlab.taskhub.requirements.get
// ============================================================================
export const taskHubRequirementsGetTool: MCPTool = {
  name: 'dlab.taskhub.requirements.get',
  description: 'Get the generated requirements for a project.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();
      const result = await db.select().from(projects).where(eq(projects.id, params.projectId)).limit(1);

      if (result.length === 0) {
        return createErrorResult(`Project not found: ${params.projectId}`);
      }

      const project = result[0];
      let requirements: any[] = [];

      if (project.taskRequirements) {
        try {
          requirements = JSON.parse(project.taskRequirements);
        } catch (e) {}
      }

      if (requirements.length === 0) {
        return createTextResult('No requirements generated yet. Run dlab.taskhub.generate first.');
      }

      return createJsonResult({
        projectId: params.projectId,
        count: requirements.length,
        requirements,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get requirements';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// dlab.taskhub.testmap.get
// ============================================================================
export const taskHubTestMapGetTool: MCPTool = {
  name: 'dlab.taskhub.testmap.get',
  description: 'Get the test map (checklist) for a project.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();
      const result = await db.select().from(projects).where(eq(projects.id, params.projectId)).limit(1);

      if (result.length === 0) {
        return createErrorResult(`Project not found: ${params.projectId}`);
      }

      const project = result[0];
      let testMap: any[] = [];

      if (project.taskTestMap) {
        try {
          testMap = JSON.parse(project.taskTestMap);
        } catch (e) {}
      }

      if (testMap.length === 0) {
        return createTextResult('No test map generated yet. Run dlab.taskhub.generate first.');
      }

      const completed = testMap.filter(t => t.completed).length;
      const total = testMap.length;

      return createJsonResult({
        projectId: params.projectId,
        progress: `${completed}/${total}`,
        percentage: Math.round((completed / total) * 100),
        testMap,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get test map';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// dlab.taskhub.testmap.toggle
// ============================================================================
export const taskHubTestMapToggleTool: MCPTool = {
  name: 'dlab.taskhub.testmap.toggle',
  description: 'Toggle the completion status of a test map item.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID'),
    testId: z.string().describe('Test item ID to toggle'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();
      const result = await db.select().from(projects).where(eq(projects.id, params.projectId)).limit(1);

      if (result.length === 0) {
        return createErrorResult(`Project not found: ${params.projectId}`);
      }

      const project = result[0];
      let testMap: any[] = [];

      if (project.taskTestMap) {
        try {
          testMap = JSON.parse(project.taskTestMap);
        } catch (e) {}
      }

      const testItem = testMap.find(t => t.id === params.testId);
      if (!testItem) {
        return createErrorResult(`Test item not found: ${params.testId}`);
      }

      testItem.completed = !testItem.completed;

      // Update database
      await db.update(projects).set({
        taskTestMap: JSON.stringify(testMap),
        updatedAt: new Date(),
      }).where(eq(projects.id, params.projectId));

      return createJsonResult({
        message: `Test "${testItem.description}" marked as ${testItem.completed ? 'completed' : 'incomplete'}`,
        testId: params.testId,
        completed: testItem.completed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to toggle test';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// EXPORTS
// ============================================================================
export const taskHubTools: MCPTool[] = [
  taskHubLinksListTool,
  taskHubLinksAddTool,
  taskHubLinksRemoveTool,
  taskHubMetadataFetchTool,
  taskHubGenerateTool,
  taskHubRequirementsGetTool,
  taskHubTestMapGetTool,
  taskHubTestMapToggleTool,
];
