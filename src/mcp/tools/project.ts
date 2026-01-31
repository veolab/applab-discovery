/**
 * DiscoveryLab Project Tools
 * MCP tools for project management
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult, createJsonResult } from '../server.js';
import { getDatabase, projects, projectExports, PROJECTS_DIR } from '../../db/index.js';
import type { Project, NewProject } from '../../db/schema.js';

// ============================================================================
// dlab.project.list
// ============================================================================
export const projectListTool: MCPTool = {
  name: 'dlab.project.list',
  description: 'List all saved projects. Returns project IDs, names, status, and timestamps.',
  inputSchema: z.object({
    status: z.enum(['draft', 'analyzed', 'exported', 'archived']).optional().describe('Filter by status'),
    platform: z.enum(['ios', 'android', 'web']).optional().describe('Filter by platform'),
    limit: z.number().optional().describe('Maximum number of projects to return (default: 20)'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();
      let query = db.select().from(projects).orderBy(desc(projects.updatedAt));

      // Apply filters using where clauses
      const conditions: any[] = [];
      if (params.status) {
        conditions.push(eq(projects.status, params.status));
      }
      if (params.platform) {
        conditions.push(eq(projects.platform, params.platform));
      }

      // Execute query
      const results = await query.limit(params.limit || 20);

      // Filter in memory for now (Drizzle dynamic where is complex)
      const filtered = results.filter((p) => {
        if (params.status && p.status !== params.status) return false;
        if (params.platform && p.platform !== params.platform) return false;
        return true;
      });

      if (filtered.length === 0) {
        return createTextResult('No projects found. Create one with dlab.project.create');
      }

      const summary = filtered.map((p) => ({
        id: p.id,
        name: p.name,
        platform: p.platform,
        status: p.status,
        linkedTicket: p.linkedTicket,
        createdAt: new Date(p.createdAt).toISOString(),
        updatedAt: new Date(p.updatedAt).toISOString(),
      }));

      return createJsonResult({
        count: filtered.length,
        projects: summary,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list projects';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// dlab.project.create
// ============================================================================
export const projectCreateTool: MCPTool = {
  name: 'dlab.project.create',
  description: 'Create a new project for capturing and analyzing app evidence.',
  inputSchema: z.object({
    name: z.string().describe('Project name'),
    platform: z.enum(['ios', 'android', 'web']).optional().describe('Target platform'),
    linkedTicket: z.string().optional().describe('Jira ticket ID (e.g., "ABC-123")'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();
      const now = new Date();
      const id = randomUUID();

      const newProject: NewProject = {
        id,
        name: params.name,
        platform: params.platform || null,
        linkedTicket: params.linkedTicket || null,
        tags: params.tags ? JSON.stringify(params.tags) : null,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      };

      await db.insert(projects).values(newProject);

      return createJsonResult({
        message: 'Project created successfully',
        project: {
          id,
          name: params.name,
          platform: params.platform,
          linkedTicket: params.linkedTicket,
          status: 'draft',
          projectDir: `${PROJECTS_DIR}/${id}`,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create project';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// dlab.project.get
// ============================================================================
export const projectGetTool: MCPTool = {
  name: 'dlab.project.get',
  description: 'Get detailed information about a specific project.',
  inputSchema: z.object({
    id: z.string().describe('Project ID'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();
      const result = await db.select().from(projects).where(eq(projects.id, params.id)).limit(1);

      if (result.length === 0) {
        return createErrorResult(`Project not found: ${params.id}`);
      }

      const project = result[0];

      // Get exports for this project
      const exports = await db
        .select()
        .from(projectExports)
        .where(eq(projectExports.projectId, params.id))
        .orderBy(desc(projectExports.createdAt));

      return createJsonResult({
        ...project,
        tags: project.tags ? JSON.parse(project.tags) : [],
        exports: exports.map((e) => ({
          id: e.id,
          destination: e.destination,
          status: e.status,
          destinationUrl: e.destinationUrl,
          exportedAt: e.exportedAt ? new Date(e.exportedAt).toISOString() : null,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get project';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// dlab.project.save
// ============================================================================
export const projectSaveTool: MCPTool = {
  name: 'dlab.project.save',
  description: 'Save/update project with notes, tags, and linked ticket.',
  inputSchema: z.object({
    id: z.string().describe('Project ID'),
    manualNotes: z.string().optional().describe('Manual notes and annotations'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
    linkedTicket: z.string().optional().describe('Jira ticket ID'),
    status: z.enum(['draft', 'analyzed', 'exported', 'archived']).optional().describe('Project status'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();

      // Check if project exists
      const existing = await db.select().from(projects).where(eq(projects.id, params.id)).limit(1);
      if (existing.length === 0) {
        return createErrorResult(`Project not found: ${params.id}`);
      }

      const updates: Partial<Project> = {
        updatedAt: new Date(),
      };

      if (params.manualNotes !== undefined) {
        updates.manualNotes = params.manualNotes;
      }
      if (params.tags !== undefined) {
        updates.tags = JSON.stringify(params.tags);
      }
      if (params.linkedTicket !== undefined) {
        updates.linkedTicket = params.linkedTicket;
      }
      if (params.status !== undefined) {
        updates.status = params.status;
      }

      await db.update(projects).set(updates).where(eq(projects.id, params.id));

      return createTextResult(`Project ${params.id} saved successfully`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save project';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// dlab.project.delete
// ============================================================================
export const projectDeleteTool: MCPTool = {
  name: 'dlab.project.delete',
  description: 'Delete a project and all its associated data.',
  inputSchema: z.object({
    id: z.string().describe('Project ID'),
  }),
  handler: async (params) => {
    try {
      const db = getDatabase();

      // Check if project exists
      const existing = await db.select().from(projects).where(eq(projects.id, params.id)).limit(1);
      if (existing.length === 0) {
        return createErrorResult(`Project not found: ${params.id}`);
      }

      // Delete project (cascades to exports and frames)
      await db.delete(projects).where(eq(projects.id, params.id));

      return createTextResult(`Project ${params.id} deleted successfully`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete project';
      return createErrorResult(message);
    }
  },
};

// ============================================================================
// EXPORTS
// ============================================================================
export const projectTools: MCPTool[] = [
  projectListTool,
  projectCreateTool,
  projectGetTool,
  projectSaveTool,
  projectDeleteTool,
];
