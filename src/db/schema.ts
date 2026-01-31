/**
 * DiscoveryLab Database Schema
 * Using Drizzle ORM with SQLite (better-sqlite3)
 */

import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// ============================================================================
// PROJECTS TABLE
// ============================================================================
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),

  // Source
  videoPath: text('video_path'),
  thumbnailPath: text('thumbnail_path'), // Best frame or image for project cover
  platform: text('platform'), // 'ios' | 'android' | 'web'

  // Analysis
  aiSummary: text('ai_summary'),
  ocrText: text('ocr_text'),
  ocrEngine: text('ocr_engine'),
  ocrConfidence: real('ocr_confidence'),
  frameCount: integer('frame_count').default(0),
  duration: real('duration'), // seconds

  // Annotations
  manualNotes: text('manual_notes'),
  tags: text('tags'), // JSON array
  linkedTicket: text('linked_ticket'), // e.g., "ABC-123"

  // External integrations (legacy single URLs - maintained for backwards compatibility)
  linkedJiraUrl: text('linked_jira_url'), // Full Jira issue URL
  linkedNotionUrl: text('linked_notion_url'), // Notion page URL
  linkedFigmaUrl: text('linked_figma_url'), // Figma design URL (auto-detected from Jira or manual)

  // Task Hub - Multiple links with metadata (JSON array)
  taskHubLinks: text('task_hub_links'), // JSON: [{ id, type, url, title, status, metadata }]
  taskRequirements: text('task_requirements'), // AI-generated requirements from linked content
  taskTestMap: text('task_test_map'), // AI-generated test map from linked content

  // Status
  status: text('status').default('draft'), // 'draft' | 'analyzed' | 'exported' | 'archived'

  // Timestamps
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================================
// PROJECT EXPORTS TABLE
// ============================================================================
export const projectExports = sqliteTable('project_exports', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),

  // Destination
  destination: text('destination').notNull(), // 'notion' | 'drive' | 'jira' | 'slack' | 'local'
  destinationUrl: text('destination_url'),
  destinationPath: text('destination_path'),

  // Content included
  contentIncluded: text('content_included'), // JSON: { video, keyFrames, aiSummary, manualNotes }

  // Status
  status: text('status').default('pending'), // 'pending' | 'in_progress' | 'completed' | 'failed'
  errorMessage: text('error_message'),

  // Timestamps
  exportedAt: integer('exported_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================================
// FRAMES TABLE (extracted key frames)
// ============================================================================
export const frames = sqliteTable('frames', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),

  // Frame data
  frameNumber: integer('frame_number').notNull(),
  timestamp: real('timestamp').notNull(), // seconds
  imagePath: text('image_path').notNull(),

  // Analysis
  ocrText: text('ocr_text'),
  isKeyFrame: integer('is_key_frame', { mode: 'boolean' }).default(false),

  // Timestamps
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================================
// SETTINGS TABLE
// ============================================================================
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================================
// EXPORT DESTINATIONS TABLE (configured destinations)
// ============================================================================
export const exportDestinations = sqliteTable('export_destinations', {
  id: text('id').primaryKey(),

  // Destination config
  type: text('type').notNull(), // 'notion' | 'drive' | 'jira' | 'slack'
  name: text('name').notNull(), // User-friendly name

  // Configuration (JSON)
  config: text('config'), // { workspaceUrl, folderId, projectKey, channelId, etc. }

  // Status
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),

  // Timestamps
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================================
// AUTO EXPORT RULES TABLE
// ============================================================================
export const exportRules = sqliteTable('export_rules', {
  id: text('id').primaryKey(),

  // Rule definition
  name: text('name').notNull(),
  destinationId: text('destination_id').notNull().references(() => exportDestinations.id, { onDelete: 'cascade' }),

  // Trigger conditions (JSON)
  conditions: text('conditions'), // { tags: ['feature'], status: 'analyzed', platform: 'ios' }

  // Content to include (JSON)
  contentIncluded: text('content_included'), // { video: true, keyFrames: true, aiSummary: true }

  // Status
  isActive: integer('is_active', { mode: 'boolean' }).default(true),

  // Timestamps
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type ProjectExport = typeof projectExports.$inferSelect;
export type NewProjectExport = typeof projectExports.$inferInsert;

export type Frame = typeof frames.$inferSelect;
export type NewFrame = typeof frames.$inferInsert;

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;

export type ExportDestination = typeof exportDestinations.$inferSelect;
export type NewExportDestination = typeof exportDestinations.$inferInsert;

export type ExportRule = typeof exportRules.$inferSelect;
export type NewExportRule = typeof exportRules.$inferInsert;
