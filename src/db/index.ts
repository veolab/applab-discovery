/**
 * DiscoveryLab Database Initialization
 * Auto-creates ~/.discoverylab/ directory and initializes SQLite database
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as schema from './schema.js';

// ============================================================================
// PATHS
// ============================================================================
export const DATA_DIR = join(homedir(), '.discoverylab');
export const DB_PATH = join(DATA_DIR, 'data.db');
export const PROJECTS_DIR = join(DATA_DIR, 'projects');
export const EXPORTS_DIR = join(DATA_DIR, 'exports');
export const FRAMES_DIR = join(DATA_DIR, 'frames');

// ============================================================================
// INITIALIZATION
// ============================================================================
function ensureDirectories(): void {
  const dirs = [DATA_DIR, PROJECTS_DIR, EXPORTS_DIR, FRAMES_DIR];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

function createTables(sqlite: Database.Database): void {
  // Projects table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      video_path TEXT,
      thumbnail_path TEXT,
      platform TEXT,
      ai_summary TEXT,
      ocr_text TEXT,
      ocr_engine TEXT,
      ocr_confidence REAL,
      frame_count INTEGER DEFAULT 0,
      duration REAL,
      manual_notes TEXT,
      tags TEXT,
      linked_ticket TEXT,
      linked_jira_url TEXT,
      linked_notion_url TEXT,
      linked_figma_url TEXT,
      task_hub_links TEXT,
      task_requirements TEXT,
      task_test_map TEXT,
      status TEXT DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Migration: Add missing columns for existing databases
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN thumbnail_path TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN linked_jira_url TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN linked_notion_url TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN linked_figma_url TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN task_hub_links TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN task_requirements TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN task_test_map TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN ocr_engine TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN ocr_confidence REAL`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Project exports table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_exports (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      destination TEXT NOT NULL,
      destination_url TEXT,
      destination_path TEXT,
      content_included TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      exported_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  // Frames table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS frames (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      frame_number INTEGER NOT NULL,
      timestamp REAL NOT NULL,
      image_path TEXT NOT NULL,
      ocr_text TEXT,
      is_key_frame INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  // Settings table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Export destinations table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS export_destinations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT,
      is_active INTEGER DEFAULT 1,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Export rules table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS export_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      conditions TEXT,
      content_included TEXT,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (destination_id) REFERENCES export_destinations(id) ON DELETE CASCADE
    )
  `);

  // Indexes for performance
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_projects_platform ON projects(platform);
    CREATE INDEX IF NOT EXISTS idx_project_exports_project_id ON project_exports(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_exports_destination ON project_exports(destination);
    CREATE INDEX IF NOT EXISTS idx_frames_project_id ON frames(project_id);
    CREATE INDEX IF NOT EXISTS idx_frames_is_key_frame ON frames(is_key_frame);
  `);
}

// ============================================================================
// DATABASE INSTANCE
// ============================================================================
let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database.Database | null = null;

export function getDatabase() {
  if (!_db) {
    ensureDirectories();
    _sqlite = new Database(DB_PATH);
    _sqlite.pragma('journal_mode = WAL');
    _sqlite.pragma('foreign_keys = ON');
    createTables(_sqlite);
    _db = drizzle(_sqlite, { schema });
  }
  return _db;
}

export function getSqlite(): Database.Database {
  if (!_sqlite) {
    getDatabase(); // Initialize
  }
  return _sqlite!;
}

export function closeDatabase(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

// ============================================================================
// RE-EXPORT SCHEMA
// ============================================================================
export * from './schema.js';
