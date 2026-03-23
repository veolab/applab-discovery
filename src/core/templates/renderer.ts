/**
 * Template Renderer
 * Uses @remotion/renderer to render videos with template compositions
 */

import { existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { DATA_DIR, EXPORTS_DIR } from '../../db/index.js';
import { getBundlePath, getTemplate } from './loader.js';
import type { TemplateProps, TemplateId, RenderJob, TerminalTab } from './types.js';

// In-memory render job tracking
const renderJobs = new Map<string, RenderJob>();

let jobCounter = 0;

function generateJobId(): string {
  return `render_${Date.now()}_${++jobCounter}`;
}

/**
 * Get the output directory for template renders
 */
function getOutputDir(projectId: string): string {
  const dir = join(EXPORTS_DIR, projectId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

type TemplateRenderOptimizationProfile = {
  maxTabs: number;
  maxCharsPerTab: number;
  maxLinesPerTab: number;
  maxJsonItemsPerTab: number;
  maxTotalChars: number;
};

function getLineCount(text: string): number {
  return String(text || '').replace(/\r\n/g, '\n').split('\n').length;
}

function shouldPreserveTerminalTabContent(
  tab: TerminalTab,
  profile: TemplateRenderOptimizationProfile
): boolean {
  return tab.content.length <= profile.maxCharsPerTab && getLineCount(tab.content) <= profile.maxLinesPerTab;
}

function clampTextForTerminalRender(text: string, profile: TemplateRenderOptimizationProfile): string {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\t/g, '  ');
  const rawLines = normalized.split('\n').map((line) => line.replace(/\s+$/g, ''));
  const truncatedByLines = rawLines.length > profile.maxLinesPerTab;
  const visibleLines = truncatedByLines
    ? rawLines.slice(0, profile.maxLinesPerTab - 1)
    : rawLines.slice(0, profile.maxLinesPerTab);
  if (truncatedByLines) {
    const hiddenLines = Math.max(1, rawLines.length - visibleLines.length);
    visibleLines.push(`... +${hiddenLines} more lines`);
  }

  let output = visibleLines.join('\n').trim();
  if (output.length > profile.maxCharsPerTab) {
    output = `${output.slice(0, Math.max(0, profile.maxCharsPerTab - 12)).trimEnd()}\n...`;
  }

  return output || '// no terminal content';
}

function formatCompactBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)}KB`;
  return `${Math.round(bytes)}B`;
}

function compactTerminalJsonContent(
  tab: TerminalTab,
  profile: TemplateRenderOptimizationProfile
): string | null {
  try {
    const parsed = JSON.parse(tab.content);
    if (!Array.isArray(parsed)) return null;

    const lines = parsed
      .slice(0, profile.maxJsonItemsPerTab)
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        const status = record.status ?? '...';
        const duration = Number.isFinite(Number(record.durationMs)) ? `${Math.round(Number(record.durationMs))}ms` : '';
        const size = formatCompactBytes(record.responseSize);
        const rawUrl = typeof record.url === 'string' ? record.url : '';
        let displayUrl = rawUrl || tab.route || tab.label;
        try {
          const parsedUrl = new URL(rawUrl);
          displayUrl = parsedUrl.pathname || `${parsedUrl.origin}${parsedUrl.pathname}`;
        } catch {}
        return [status, duration, size, displayUrl].filter(Boolean).join(' ');
      })
      .filter((line): line is string => !!line);

    if (parsed.length > lines.length) {
      lines.push(`... +${parsed.length - lines.length} more requests`);
    }

    return clampTextForTerminalRender(lines.join('\n'), profile);
  } catch {
    return null;
  }
}

function getTemplateRenderOptimizationProfile(
  templateId: TemplateId,
  props: TemplateProps,
  realVideoDuration: number | null
): TemplateRenderOptimizationProfile {
  const totalChars = Array.isArray(props.terminalTabs)
    ? props.terminalTabs.reduce((sum, tab) => sum + String(tab?.content || '').length, 0)
    : 0;
  const tabCount = Array.isArray(props.terminalTabs) ? props.terminalTabs.length : 0;
  const isLongVideo = (realVideoDuration || props.videoDuration || 0) >= 30;
  const isHeavyTerminal = totalChars >= 1600 || tabCount >= 6;
  const showcaseAggressive = templateId === 'showcase';

  if (isLongVideo || isHeavyTerminal || showcaseAggressive) {
    return {
      maxTabs: showcaseAggressive ? 4 : 5,
      maxCharsPerTab: showcaseAggressive ? 1_000 : isLongVideo ? 1_800 : 2_200,
      maxLinesPerTab: showcaseAggressive ? 22 : 40,
      maxJsonItemsPerTab: showcaseAggressive ? 6 : 12,
      maxTotalChars: showcaseAggressive ? 3_500 : 7_000,
    };
  }

  return {
    maxTabs: 6,
    maxCharsPerTab: 2_800,
    maxLinesPerTab: 60,
    maxJsonItemsPerTab: 16,
    maxTotalChars: 10_000,
  };
}

function optimizeTemplatePropsForRender(
  templateId: TemplateId,
  props: TemplateProps,
  realVideoDuration: number | null
): TemplateProps {
  if (!Array.isArray(props.terminalTabs) || props.terminalTabs.length === 0) {
    return { ...props };
  }

  const profile = getTemplateRenderOptimizationProfile(templateId, props, realVideoDuration);
  const terminalTabs = props.terminalTabs
    .slice(0, profile.maxTabs)
    .map((tab) => {
      if (shouldPreserveTerminalTabContent(tab, profile)) {
        return { ...tab };
      }
      const compactJson = compactTerminalJsonContent(tab, profile);
      return {
        ...tab,
        content: compactJson || clampTextForTerminalRender(tab.content, profile),
      };
    });

  let totalChars = terminalTabs.reduce((sum, tab) => sum + tab.content.length, 0);
  while (totalChars > profile.maxTotalChars && terminalTabs.length > 1) {
    terminalTabs.pop();
    totalChars = terminalTabs.reduce((sum, tab) => sum + tab.content.length, 0);
  }

  if (totalChars > profile.maxTotalChars && terminalTabs.length === 1) {
    const [tab] = terminalTabs;
    const compactJson = compactTerminalJsonContent(tab, profile);
    terminalTabs[0] = {
      ...tab,
      content: compactJson || clampTextForTerminalRender(tab.content, profile),
    };
  }

  return {
    ...props,
    terminalTabs,
    hasNetworkData: terminalTabs.length > 0,
  };
}

/**
 * Start an async render job
 */
export async function startRender(
  projectId: string,
  templateId: TemplateId,
  props: TemplateProps,
  onProgress?: (progress: number) => void,
): Promise<RenderJob> {
  const bundlePath = getBundlePath();
  if (!bundlePath) {
    throw new Error('Templates not installed. Bundle not found at ~/.discoverylab/templates/bundle/');
  }

  const template = getTemplate(templateId);
  if (!template) {
    throw new Error(`Template "${templateId}" not found in manifest`);
  }

  const jobId = generateJobId();
  const outputDir = getOutputDir(projectId);
  const outputPath = join(outputDir, `template-${templateId}.mp4`);

  const job: RenderJob = {
    id: jobId,
    projectId,
    templateId,
    status: 'queued',
    progress: 0,
    outputPath,
    startedAt: Date.now(),
  };

  renderJobs.set(jobId, job);

  // Start rendering asynchronously
  renderAsync(job, bundlePath, templateId, template.compositionId, props, onProgress).catch(err => {
    job.status = 'error';
    job.error = err.message;
    job.completedAt = Date.now();
  });

  return job;
}

async function renderAsync(
  job: RenderJob,
  bundlePath: string,
  templateId: TemplateId,
  compositionId: string,
  props: TemplateProps,
  onProgress?: (progress: number) => void,
): Promise<void> {
  job.status = 'rendering';

  // Temporarily change cwd so @remotion/renderer caches its Chrome download
  // in ~/.discoverylab/.remotion/ instead of polluting the user's project dir.
  const originalCwd = process.cwd();
  try {
    process.chdir(DATA_DIR);

    // Dynamic import to avoid failing if @remotion/renderer is not installed
    const { selectComposition, renderMedia } = await import('@remotion/renderer');

    // Get real video duration via ffprobe
    const realVideoDuration = getVideoDuration(props.videoUrl);
    const optimizedProps = optimizeTemplatePropsForRender(templateId, props, realVideoDuration);

    if (realVideoDuration && realVideoDuration > 0) {
      optimizedProps.videoDuration = realVideoDuration;
    }

    const composition = await selectComposition({
      serveUrl: bundlePath,
      id: compositionId,
      inputProps: optimizedProps as unknown as Record<string, unknown>,
    });

    // Match render length to the source video only. Terminal content is compacted
    // for render-time so long scripts do not inflate the full composition.
    const fps = composition.fps || 30;
    let durationOverride: number | undefined;
    if (realVideoDuration && realVideoDuration > 0) {
      const videoFrames = Math.ceil(realVideoDuration * fps);
      if (videoFrames > composition.durationInFrames) {
        durationOverride = videoFrames;
      }
    }

    await renderMedia({
      composition: durationOverride
        ? { ...composition, durationInFrames: durationOverride }
        : composition,
      serveUrl: bundlePath,
      codec: 'h264',
      outputLocation: job.outputPath!,
      inputProps: optimizedProps as unknown as Record<string, unknown>,
      onProgress: ({ progress }) => {
        job.progress = progress;
        onProgress?.(progress);
      },
    });

    job.status = 'done';
    job.progress = 1;
    job.completedAt = Date.now();
  } catch (err: any) {
    job.status = 'error';
    job.error = err.message;
    job.completedAt = Date.now();
    throw err;
  } finally {
    process.chdir(originalCwd);
  }
}

/**
 * Get video duration in seconds via ffprobe.
 * Handles both file paths and localhost URLs (extracts path from query param).
 */
function getVideoDuration(videoUrl: string): number | null {
  try {
    let filePath = videoUrl;
    // If it's a localhost URL like http://localhost:PORT/api/file?path=..., extract the path
    if (videoUrl.startsWith('http')) {
      const url = new URL(videoUrl);
      const pathParam = url.searchParams.get('path');
      if (pathParam) {
        filePath = decodeURIComponent(pathParam);
      } else {
        return null;
      }
    }
    if (!existsSync(filePath)) return null;

    const output = execSync(
      `ffprobe -v quiet -print_format json -show_format "${filePath}"`,
      { encoding: 'utf-8', timeout: 10_000 }
    );
    const data = JSON.parse(output);
    const duration = parseFloat(data.format?.duration || '0');
    return duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

/**
 * Get render job status
 */
export function getRenderJob(jobId: string): RenderJob | null {
  return renderJobs.get(jobId) ?? null;
}

/**
 * Get all render jobs for a project
 */
export function getProjectRenderJobs(projectId: string): RenderJob[] {
  return Array.from(renderJobs.values()).filter(j => j.projectId === projectId);
}

/**
 * Check if a rendered template file already exists (cached)
 */
export function getCachedRender(projectId: string, templateId: TemplateId): string | null {
  const outputPath = join(EXPORTS_DIR, projectId, `template-${templateId}.mp4`);
  if (existsSync(outputPath)) return outputPath;
  return null;
}

/**
 * Clean up old render jobs from memory
 */
export function cleanupRenderJobs(maxAge = 3600_000): void {
  const now = Date.now();
  for (const [id, job] of renderJobs) {
    if (job.completedAt && now - job.completedAt > maxAge) {
      renderJobs.delete(id);
    }
  }
}
