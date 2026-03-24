/**
 * Export Pipeline
 * Orchestrates: manifest → prepare assets → adapt for destination → upload
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { lookup } from 'mime-types';
import type {
  BatchExportManifest,
  PreparedProject,
  PreparedAsset,
  ExportDestinationAdapter,
  BatchExportResult,
  ProgressCallback,
  ExportAsset,
  ExportProgress,
} from './adapters/types.js';

// ============================================================================
// ADAPTER REGISTRY
// ============================================================================

const adapters = new Map<string, ExportDestinationAdapter>();

export function registerAdapter(adapter: ExportDestinationAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): ExportDestinationAdapter | undefined {
  return adapters.get(name);
}

export function getAvailableAdapters(): string[] {
  return Array.from(adapters.keys());
}

// ============================================================================
// ASSET PREPARATION
// ============================================================================

export interface AssetPreparationContext {
  projectId: string;
  videoPath?: string | null;
  framesDir?: string;
  platform?: string;
  aiSummary?: string;
}

/**
 * Prepare a single asset for export by resolving file paths and metadata.
 * Does NOT convert for destination - that's the adapter's job.
 */
async function prepareAsset(
  asset: ExportAsset,
  ctx: AssetPreparationContext,
): Promise<PreparedAsset | null> {
  switch (asset.type) {
    case 'video': {
      if (!ctx.videoPath) return null;
      const videoPath = resolveVideoFile(ctx.videoPath);
      if (!videoPath || !existsSync(videoPath)) return null;
      const ext = extname(videoPath).slice(1) || 'mp4';
      return {
        type: 'video',
        originalType: 'video',
        filePath: videoPath,
        mimeType: lookup(videoPath) || `video/${ext}`,
        fileName: basename(videoPath),
        metadata: { ...(asset.config || {}) },
      };
    }

    case 'frames': {
      if (!ctx.framesDir || !existsSync(ctx.framesDir)) return null;
      // Return the directory path - adapter will handle individual frames
      return {
        type: 'frames',
        originalType: 'frames',
        filePath: ctx.framesDir,
        mimeType: 'inode/directory',
        fileName: 'frames',
        metadata: { ...(asset.config || {}) },
      };
    }

    case 'grid':
    case 'infographic':
    case 'visualization': {
      // These are generated on-demand by their respective endpoints
      // The pipeline stores the config; the adapter calls the generation endpoints
      return {
        type: asset.type,
        originalType: asset.type,
        filePath: '', // Will be generated
        mimeType: 'image/png',
        fileName: `${asset.type}-${ctx.projectId}.png`,
        metadata: {
          projectId: ctx.projectId,
          needsGeneration: true,
          ...(asset.config || {}),
        },
      };
    }

    default:
      return null;
  }
}

/**
 * Resolve a video path that might be a directory (Maestro/Playwright pattern)
 */
function resolveVideoFile(videoPath: string): string | null {
  if (!existsSync(videoPath)) return null;

  const stat = statSync(videoPath);

  if (stat.isFile()) return videoPath;

  // Directory - look for video files
  const videoExts = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
  const searchDirs = [join(videoPath, 'video'), videoPath];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const dirStat = statSync(dir);
    if (!dirStat.isDirectory()) continue;
    const files = readdirSync(dir);
    for (const file of files) {
      if (videoExts.some(ext => file.toLowerCase().endsWith(ext))) {
        return join(dir, file);
      }
    }
  }

  return null;
}

// ============================================================================
// PIPELINE EXECUTION
// ============================================================================

export interface ProjectDataProvider {
  getProject(projectId: string): Promise<{
    id: string;
    name: string;
    videoPath?: string | null;
    platform?: string | null;
    aiSummary?: string | null;
    marketingTitle?: string | null;
    marketingDescription?: string | null;
  } | null>;
  getFramesDir(projectId: string): string;
}

/**
 * Execute the full export pipeline:
 * 1. Validate destination adapter
 * 2. Prepare assets for each project
 * 3. Convert assets via adapter
 * 4. Upload to destination
 */
export async function executeBatchExport(
  manifest: BatchExportManifest,
  dataProvider: ProjectDataProvider,
  onProgress?: ProgressCallback,
): Promise<BatchExportResult> {
  const { destination, projects: entries } = manifest;

  // 1. Get adapter
  const adapter = getAdapter(destination.type);
  if (!adapter) {
    return {
      success: false,
      results: [],
      errors: [`No adapter registered for destination: ${destination.type}`],
    };
  }

  // 2. Validate destination
  const validation = await adapter.validate(destination.config || {});
  if (!validation.valid) {
    return {
      success: false,
      results: [],
      errors: [`Destination validation failed: ${validation.error}`],
    };
  }

  const totalProjects = entries.length;
  const preparedProjects: PreparedProject[] = [];

  // 3. Prepare assets for each project
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const progress: ExportProgress = {
      phase: 'preparing',
      projectIndex: i,
      totalProjects,
      detail: `Preparing project ${i + 1}/${totalProjects}: ${entry.title}`,
      percent: Math.round((i / totalProjects) * 30), // 0-30% for preparation
    };
    onProgress?.(progress);

    const projectData = await dataProvider.getProject(entry.projectId);
    if (!projectData) {
      preparedProjects.push({
        projectId: entry.projectId,
        title: entry.title,
        description: entry.description,
        assets: [],
      });
      continue;
    }

    const ctx: AssetPreparationContext = {
      projectId: entry.projectId,
      videoPath: projectData.videoPath,
      framesDir: dataProvider.getFramesDir(entry.projectId),
      platform: projectData.platform || undefined,
      aiSummary: projectData.aiSummary || undefined,
    };

    const includedAssets = entry.assets.filter(a => a.include);
    const preparedAssets: PreparedAsset[] = [];

    for (const asset of includedAssets) {
      if (!adapter.supportsAssetType(asset.type)) continue;
      const prepared = await prepareAsset(asset, ctx);
      if (prepared) {
        // 4. Convert via adapter (e.g., MP4→GIF for Notion)
        const converted = await adapter.convertAsset(prepared);
        preparedAssets.push(converted);
      }
    }

    preparedProjects.push({
      projectId: entry.projectId,
      title: entry.title,
      description: entry.description,
      platform: projectData.platform || undefined,
      aiSummary: projectData.aiSummary || undefined,
      assets: preparedAssets,
    });
  }

  // 5. Upload to destination
  onProgress?.({
    phase: 'uploading',
    projectIndex: 0,
    totalProjects,
    detail: `Uploading ${preparedProjects.length} projects to ${destination.type}...`,
    percent: 30,
  });

  const result = await adapter.upload(
    preparedProjects,
    destination.config || {},
    (uploadProgress) => {
      // Remap upload progress to 30-100% range
      onProgress?.({
        ...uploadProgress,
        percent: 30 + Math.round(uploadProgress.percent * 0.7),
      });
    },
  );

  onProgress?.({
    phase: result.success ? 'done' : 'error',
    projectIndex: totalProjects - 1,
    totalProjects,
    detail: result.success
      ? `Exported ${result.results.filter(r => r.success).length} projects successfully`
      : `Export completed with ${result.errors.length} errors`,
    percent: 100,
  });

  return result;
}
