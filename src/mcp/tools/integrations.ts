/**
 * DiscoveryLab Integration Tools
 * MCP tools for Notion, Google Drive, and Jira exports
 */

import { z } from 'zod';
import * as fs from 'fs';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult } from '../server.js';
import {
  checkNotionAuth,
  loginToNotion,
  createNotionPage,
  quickExportToNotion,
  markdownToNotionBlocks,
} from '../../integrations/notion.js';
import {
  checkDriveAuth,
  loginToDrive,
  uploadToDrive,
  quickExportToDrive,
  createDriveFolder,
  generateShareableLink,
} from '../../integrations/drive.js';
import {
  checkJiraAuth,
  loginToJira,
  attachToJiraIssue,
  createJiraIssue,
  addJiraComment,
  quickExportToJira,
  getJiraIssueUrl,
  parseJiraIssueKey,
} from '../../integrations/jira.js';

// ============================================================================
// NOTION TOOLS
// ============================================================================
export const notionStatusTool: MCPTool = {
  name: 'dlab.notion.status',
  description: 'Check Notion authentication status.',
  inputSchema: z.object({}),
  handler: async () => {
    const auth = await checkNotionAuth();
    return createTextResult(JSON.stringify({
      authenticated: auth.authenticated,
      workspace: auth.workspace,
      sessionPath: auth.sessionPath,
      message: auth.authenticated
        ? 'Notion is authenticated and ready'
        : 'Not authenticated. Run dlab.notion.login to connect.',
    }, null, 2));
  },
};

export const notionLoginTool: MCPTool = {
  name: 'dlab.notion.login',
  description: 'Open browser to log in to Notion (saves session for future use).',
  inputSchema: z.object({}),
  handler: async () => {
    const result = await loginToNotion();

    if (!result.success) {
      return createErrorResult(result.error || 'Login failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      message: 'Successfully logged in to Notion. Session saved.',
    }, null, 2));
  },
};

export const notionExportTool: MCPTool = {
  name: 'dlab.notion.export',
  description: 'Export project evidence to a Notion page.',
  inputSchema: z.object({
    title: z.string().describe('Page title'),
    description: z.string().optional().describe('Page description'),
    screenshots: z.array(z.string()).optional().describe('Screenshot file paths'),
    videos: z.array(z.string()).optional().describe('Video file paths'),
    notes: z.string().optional().describe('Additional notes'),
    tags: z.array(z.string()).optional().describe('Tags for the page'),
    parentPageId: z.string().optional().describe('Parent page ID to create under'),
    template: z.enum(['evidence', 'testReport', 'gallery', 'custom']).optional().describe('Page template'),
  }),
  handler: async (params) => {
    const auth = await checkNotionAuth();
    if (!auth.authenticated) {
      return createErrorResult('Not authenticated. Run dlab.notion.login first.');
    }

    // Validate files exist
    const validScreenshots = (params.screenshots || []).filter(f => fs.existsSync(f));
    const validVideos = (params.videos || []).filter(f => fs.existsSync(f));

    const result = await createNotionPage({
      projectId: 'mcp-export',
      title: params.title,
      description: params.description,
      screenshots: validScreenshots,
      videos: validVideos,
      notes: params.notes,
      tags: params.tags,
      parentPageId: params.parentPageId,
      template: params.template || 'evidence',
    });

    if (!result.success) {
      return createErrorResult(result.error || 'Export failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      pageUrl: result.pageUrl,
      pageId: result.pageId,
    }, null, 2));
  },
};

export const notionQuickExportTool: MCPTool = {
  name: 'dlab.notion.quick',
  description: 'Quickly export files to a new Notion page.',
  inputSchema: z.object({
    title: z.string().describe('Page title'),
    files: z.array(z.string()).describe('Files to upload'),
    notes: z.string().optional().describe('Optional notes'),
  }),
  handler: async (params) => {
    const auth = await checkNotionAuth();
    if (!auth.authenticated) {
      return createErrorResult('Not authenticated. Run dlab.notion.login first.');
    }

    const validFiles = params.files.filter(f => fs.existsSync(f));
    if (validFiles.length === 0) {
      return createErrorResult('No valid files to upload');
    }

    const result = await quickExportToNotion(params.title, validFiles, params.notes);

    if (!result.success) {
      return createErrorResult(result.error || 'Export failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      pageUrl: result.pageUrl,
    }, null, 2));
  },
};

// ============================================================================
// GOOGLE DRIVE TOOLS
// ============================================================================
export const driveStatusTool: MCPTool = {
  name: 'dlab.drive.status',
  description: 'Check Google Drive authentication status.',
  inputSchema: z.object({}),
  handler: async () => {
    const auth = await checkDriveAuth();
    return createTextResult(JSON.stringify({
      authenticated: auth.authenticated,
      email: auth.email,
      sessionPath: auth.sessionPath,
      message: auth.authenticated
        ? 'Google Drive is authenticated and ready'
        : 'Not authenticated. Run dlab.drive.login to connect.',
    }, null, 2));
  },
};

export const driveLoginTool: MCPTool = {
  name: 'dlab.drive.login',
  description: 'Open browser to log in to Google Drive (saves session for future use).',
  inputSchema: z.object({}),
  handler: async () => {
    const result = await loginToDrive();

    if (!result.success) {
      return createErrorResult(result.error || 'Login failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      message: 'Successfully logged in to Google Drive. Session saved.',
    }, null, 2));
  },
};

export const driveUploadTool: MCPTool = {
  name: 'dlab.drive.upload',
  description: 'Upload files to Google Drive.',
  inputSchema: z.object({
    files: z.array(z.string()).describe('File paths to upload'),
    folderName: z.string().optional().describe('Create a new folder with this name'),
    parentFolderId: z.string().optional().describe('Upload to existing folder ID'),
  }),
  handler: async (params) => {
    const auth = await checkDriveAuth();
    if (!auth.authenticated) {
      return createErrorResult('Not authenticated. Run dlab.drive.login first.');
    }

    const validFiles = params.files.filter(f => fs.existsSync(f));
    if (validFiles.length === 0) {
      return createErrorResult('No valid files to upload');
    }

    const result = await uploadToDrive({
      files: validFiles,
      folderName: params.folderName,
      parentFolderId: params.parentFolderId,
    });

    if (!result.success) {
      return createErrorResult(result.error || 'Upload failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      folderUrl: result.folderUrl,
      folderId: result.folderId,
      uploadedFiles: result.uploadedFiles,
      shareableLink: result.folderId ? generateShareableLink(result.folderId) : null,
    }, null, 2));
  },
};

export const driveQuickExportTool: MCPTool = {
  name: 'dlab.drive.quick',
  description: 'Quickly export files to a new Google Drive folder.',
  inputSchema: z.object({
    files: z.array(z.string()).describe('Files to upload'),
    folderName: z.string().optional().describe('Folder name (auto-generated if not specified)'),
  }),
  handler: async (params) => {
    const auth = await checkDriveAuth();
    if (!auth.authenticated) {
      return createErrorResult('Not authenticated. Run dlab.drive.login first.');
    }

    const validFiles = params.files.filter(f => fs.existsSync(f));
    if (validFiles.length === 0) {
      return createErrorResult('No valid files to upload');
    }

    const result = await quickExportToDrive(validFiles, params.folderName);

    if (!result.success) {
      return createErrorResult(result.error || 'Export failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      folderUrl: result.folderUrl,
      shareableLink: result.folderId ? generateShareableLink(result.folderId) : null,
    }, null, 2));
  },
};

export const driveFolderTool: MCPTool = {
  name: 'dlab.drive.folder',
  description: 'Create a new folder in Google Drive.',
  inputSchema: z.object({
    name: z.string().describe('Folder name'),
    parentFolderId: z.string().optional().describe('Parent folder ID'),
  }),
  handler: async (params) => {
    const auth = await checkDriveAuth();
    if (!auth.authenticated) {
      return createErrorResult('Not authenticated. Run dlab.drive.login first.');
    }

    const result = await createDriveFolder(params.name, params.parentFolderId);

    if (!result.success) {
      return createErrorResult(result.error || 'Failed to create folder');
    }

    return createTextResult(JSON.stringify({
      success: true,
      folderUrl: result.folderUrl,
      folderId: result.folderId,
      shareableLink: result.folderId ? generateShareableLink(result.folderId) : null,
    }, null, 2));
  },
};

// ============================================================================
// JIRA TOOLS
// ============================================================================
export const jiraStatusTool: MCPTool = {
  name: 'dlab.jira.status',
  description: 'Check Jira authentication status.',
  inputSchema: z.object({}),
  handler: async () => {
    const auth = await checkJiraAuth();
    return createTextResult(JSON.stringify({
      authenticated: auth.authenticated,
      baseUrl: auth.baseUrl,
      sessionPath: auth.sessionPath,
      message: auth.authenticated
        ? 'Jira is authenticated and ready'
        : 'Not authenticated. Run dlab.jira.login to connect.',
    }, null, 2));
  },
};

export const jiraLoginTool: MCPTool = {
  name: 'dlab.jira.login',
  description: 'Open browser to log in to Jira (saves session for future use).',
  inputSchema: z.object({
    baseUrl: z.string().describe('Jira instance URL (e.g., https://mycompany.atlassian.net)'),
  }),
  handler: async (params) => {
    const result = await loginToJira(params.baseUrl);

    if (!result.success) {
      return createErrorResult(result.error || 'Login failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      message: 'Successfully logged in to Jira. Session saved.',
      baseUrl: params.baseUrl,
    }, null, 2));
  },
};

export const jiraAttachTool: MCPTool = {
  name: 'dlab.jira.attach',
  description: 'Attach files to an existing Jira issue.',
  inputSchema: z.object({
    issueKey: z.string().describe('Issue key (e.g., PROJ-123)'),
    files: z.array(z.string()).describe('File paths to attach'),
    comment: z.string().optional().describe('Optional comment to add'),
  }),
  handler: async (params) => {
    const auth = await checkJiraAuth();
    if (!auth.authenticated) {
      return createErrorResult('Not authenticated. Run dlab.jira.login first.');
    }

    const issueKey = parseJiraIssueKey(params.issueKey);
    if (!issueKey) {
      return createErrorResult('Invalid issue key format');
    }

    const validFiles = params.files.filter(f => fs.existsSync(f));

    const result = await attachToJiraIssue({
      issueKey,
      files: validFiles,
      comment: params.comment,
    });

    if (!result.success) {
      return createErrorResult(result.error || 'Attachment failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      issueKey: result.issueKey,
      issueUrl: result.issueUrl,
    }, null, 2));
  },
};

export const jiraCreateTool: MCPTool = {
  name: 'dlab.jira.create',
  description: 'Create a new Jira issue with optional attachments.',
  inputSchema: z.object({
    projectKey: z.string().describe('Project key (e.g., PROJ)'),
    summary: z.string().describe('Issue summary/title'),
    description: z.string().optional().describe('Issue description'),
    issueType: z.enum(['Bug', 'Story', 'Task', 'Epic']).optional().describe('Issue type'),
    priority: z.enum(['Highest', 'High', 'Medium', 'Low', 'Lowest']).optional().describe('Priority'),
    labels: z.array(z.string()).optional().describe('Labels to add'),
    attachments: z.array(z.string()).optional().describe('Files to attach'),
  }),
  handler: async (params) => {
    const auth = await checkJiraAuth();
    if (!auth.authenticated) {
      return createErrorResult('Not authenticated. Run dlab.jira.login first.');
    }

    const validAttachments = (params.attachments || []).filter(f => fs.existsSync(f));

    const result = await createJiraIssue({
      projectKey: params.projectKey,
      summary: params.summary,
      description: params.description,
      issueType: params.issueType,
      priority: params.priority,
      labels: params.labels,
      attachments: validAttachments,
    });

    if (!result.success) {
      return createErrorResult(result.error || 'Issue creation failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      issueKey: result.issueKey,
      issueUrl: result.issueUrl,
    }, null, 2));
  },
};

export const jiraCommentTool: MCPTool = {
  name: 'dlab.jira.comment',
  description: 'Add a comment to a Jira issue with optional attachments.',
  inputSchema: z.object({
    issueKey: z.string().describe('Issue key (e.g., PROJ-123)'),
    comment: z.string().describe('Comment text'),
    attachments: z.array(z.string()).optional().describe('Files to attach with comment'),
  }),
  handler: async (params) => {
    const auth = await checkJiraAuth();
    if (!auth.authenticated) {
      return createErrorResult('Not authenticated. Run dlab.jira.login first.');
    }

    const issueKey = parseJiraIssueKey(params.issueKey);
    if (!issueKey) {
      return createErrorResult('Invalid issue key format');
    }

    const validAttachments = (params.attachments || []).filter(f => fs.existsSync(f));

    const result = await addJiraComment({
      issueKey,
      comment: params.comment,
      attachments: validAttachments,
    });

    if (!result.success) {
      return createErrorResult(result.error || 'Comment failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      issueKey: result.issueKey,
      issueUrl: result.issueUrl,
    }, null, 2));
  },
};

export const jiraQuickExportTool: MCPTool = {
  name: 'dlab.jira.quick',
  description: 'Quickly attach files to a Jira issue with auto-generated comment.',
  inputSchema: z.object({
    issueKey: z.string().describe('Issue key (e.g., PROJ-123)'),
    files: z.array(z.string()).describe('Files to attach'),
    comment: z.string().optional().describe('Optional custom comment'),
  }),
  handler: async (params) => {
    const auth = await checkJiraAuth();
    if (!auth.authenticated) {
      return createErrorResult('Not authenticated. Run dlab.jira.login first.');
    }

    const issueKey = parseJiraIssueKey(params.issueKey);
    if (!issueKey) {
      return createErrorResult('Invalid issue key format');
    }

    const validFiles = params.files.filter(f => fs.existsSync(f));
    if (validFiles.length === 0) {
      return createErrorResult('No valid files to attach');
    }

    const result = await quickExportToJira(issueKey, validFiles, params.comment);

    if (!result.success) {
      return createErrorResult(result.error || 'Export failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      issueKey: result.issueKey,
      issueUrl: result.issueUrl,
    }, null, 2));
  },
};

// ============================================================================
// UNIFIED EXPORT TOOL
// ============================================================================
export const exportToTool: MCPTool = {
  name: 'dlab.export.to',
  description: 'Export files to multiple destinations (Notion, Drive, Jira) in one operation.',
  inputSchema: z.object({
    files: z.array(z.string()).describe('Files to export'),
    destinations: z.array(z.enum(['notion', 'drive', 'jira'])).describe('Export destinations'),
    title: z.string().optional().describe('Title for Notion page or Drive folder'),
    notes: z.string().optional().describe('Notes/description'),
    jiraIssueKey: z.string().optional().describe('Jira issue key (required if jira is a destination)'),
  }),
  handler: async (params) => {
    const validFiles = params.files.filter(f => fs.existsSync(f));
    if (validFiles.length === 0) {
      return createErrorResult('No valid files to export');
    }

    const results: Record<string, any> = {};

    // Export to Notion
    if (params.destinations.includes('notion')) {
      const auth = await checkNotionAuth();
      if (auth.authenticated) {
        const result = await quickExportToNotion(
          params.title || 'DiscoveryLab Export',
          validFiles,
          params.notes
        );
        results.notion = result;
      } else {
        results.notion = { success: false, error: 'Not authenticated' };
      }
    }

    // Export to Drive
    if (params.destinations.includes('drive')) {
      const auth = await checkDriveAuth();
      if (auth.authenticated) {
        const result = await quickExportToDrive(validFiles, params.title);
        results.drive = {
          ...result,
          shareableLink: result.folderId ? generateShareableLink(result.folderId) : null,
        };
      } else {
        results.drive = { success: false, error: 'Not authenticated' };
      }
    }

    // Export to Jira
    if (params.destinations.includes('jira')) {
      if (!params.jiraIssueKey) {
        results.jira = { success: false, error: 'Jira issue key is required' };
      } else {
        const auth = await checkJiraAuth();
        if (auth.authenticated) {
          const issueKey = parseJiraIssueKey(params.jiraIssueKey);
          if (issueKey) {
            const result = await quickExportToJira(issueKey, validFiles, params.notes);
            results.jira = result;
          } else {
            results.jira = { success: false, error: 'Invalid issue key' };
          }
        } else {
          results.jira = { success: false, error: 'Not authenticated' };
        }
      }
    }

    const allSuccess = Object.values(results).every((r: any) => r.success);

    return createTextResult(JSON.stringify({
      success: allSuccess,
      results,
    }, null, 2));
  },
};

// ============================================================================
// EXPORTS
// ============================================================================
export const integrationTools: MCPTool[] = [
  // Notion
  notionStatusTool,
  notionLoginTool,
  notionExportTool,
  notionQuickExportTool,

  // Google Drive
  driveStatusTool,
  driveLoginTool,
  driveUploadTool,
  driveQuickExportTool,
  driveFolderTool,

  // Jira
  jiraStatusTool,
  jiraLoginTool,
  jiraAttachTool,
  jiraCreateTool,
  jiraCommentTool,
  jiraQuickExportTool,

  // Unified
  exportToTool,
];
