/**
 * Remotion Video Templates - Shared Types
 * Used by both AppLab Discovery (MIT) and discoverylab-templates (private)
 */

export interface TerminalTab {
  /** Tab label, e.g. "GET /api/users" */
  label: string;
  /** HTTP method */
  method: string;
  /** Route pathname */
  route: string;
  /** JSON string for this route's entries */
  content: string;
}

export interface TemplateProps {
  /** Video URL served via /api/file?path=... */
  videoUrl: string;
  /** Video duration in seconds */
  videoDuration: number;
  /** Target platform for device frame */
  platform: 'ios' | 'android' | 'web';
  /** Title from aiSummary (first sentence) */
  title: string;
  /** For Showcase: each line gets different font */
  titleLines?: string[];
  /** Optional subtitle */
  subtitle?: string;
  /** Tabbed terminal data — empty array = no terminal shown */
  terminalTabs: TerminalTab[];
  /** Whether real network data is available */
  hasNetworkData: boolean;
  /** Showcase display mode: 'artistic' = staggered fonts, no terminal; 'terminal' = plain title + terminal */
  showcaseMode?: 'artistic' | 'terminal';
  /** Optional device frame asset override for Android renders */
  deviceMockup?: string;
}

export type TemplateId = 'studio' | 'showcase';

export interface TemplateInfo {
  id: TemplateId;
  name: string;
  description: string;
  compositionId: string;
  durationFrames: number;
  fps: number;
  width: number;
  height: number;
}

export interface TemplateManifest {
  version: string;
  templates: TemplateInfo[];
}

export interface RenderJob {
  id: string;
  projectId: string;
  templateId: TemplateId;
  status: 'queued' | 'rendering' | 'done' | 'error';
  progress: number;
  outputPath?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}
