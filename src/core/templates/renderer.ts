/**
 * Template Renderer
 * Uses @remotion/renderer to render videos with template compositions
 */

import { existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { EXPORTS_DIR } from '../../db/index.js';
import { getBundlePath, getTemplate } from './loader.js';
import type { TemplateProps, TemplateId, RenderJob } from './types.js';

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
  renderAsync(job, bundlePath, template.compositionId, props, onProgress).catch(err => {
    job.status = 'error';
    job.error = err.message;
    job.completedAt = Date.now();
  });

  return job;
}

async function renderAsync(
  job: RenderJob,
  bundlePath: string,
  compositionId: string,
  props: TemplateProps,
  onProgress?: (progress: number) => void,
): Promise<void> {
  job.status = 'rendering';

  try {
    // Dynamic import to avoid failing if @remotion/renderer is not installed
    const { selectComposition, renderMedia } = await import('@remotion/renderer');

    const composition = await selectComposition({
      serveUrl: bundlePath,
      id: compositionId,
      inputProps: props as unknown as Record<string, unknown>,
    });

    // Calculate dynamic duration to fit the full source video
    const fps = composition.fps || 30;
    let durationOverride: number | undefined;

    // Get real video duration via ffprobe
    const realVideoDuration = getVideoDuration(props.videoUrl);
    if (realVideoDuration && realVideoDuration > 0) {
      // Update props so templates know the real duration
      props.videoDuration = realVideoDuration;
      const videoFrames = Math.ceil(realVideoDuration * fps);
      // Ensure composition is long enough for the full video
      if (videoFrames > composition.durationInFrames) {
        durationOverride = videoFrames;
      }
    }

    // Also account for terminal tabs typewriter animation
    if (props.terminalTabs && props.terminalTabs.length > 0) {
      const charFrames = 2;
      const transitionFrames = 30;
      const animationDelay = 190; // terminalAppearFrame(170) + 20 delay
      const totalTypewriterFrames = props.terminalTabs.reduce(
        (sum, tab) => sum + tab.content.length * charFrames + transitionFrames,
        0
      );
      const tabMinFrames = totalTypewriterFrames + animationDelay;
      const currentTarget = durationOverride || composition.durationInFrames;
      if (tabMinFrames > currentTarget) {
        durationOverride = tabMinFrames;
      }
    }

    await renderMedia({
      composition: durationOverride
        ? { ...composition, durationInFrames: durationOverride }
        : composition,
      serveUrl: bundlePath,
      codec: 'h264',
      outputLocation: job.outputPath!,
      inputProps: props as unknown as Record<string, unknown>,
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
