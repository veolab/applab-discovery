/**
 * Notion Export Adapter
 * Implements ExportDestinationAdapter for Notion page creation
 * Wraps existing notion.ts integration with the pipeline interface
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ExportDestinationAdapter,
  ExportAssetType,
  PreparedAsset,
  PreparedProject,
  BatchExportResult,
  ExportResult,
  ProgressCallback,
} from './types.js';
import {
  checkNotionAuth,
  createNotionPage,
  type NotionBlock,
  type NotionExportOptions,
} from '../../../integrations/notion.js';

// Asset types that Notion supports natively
const SUPPORTED_TYPES: ExportAssetType[] = [
  'frames',     // Images upload directly
  'grid',       // PNG image
  'infographic', // PNG image
  'visualization', // PNG or GIF
  'video',      // Will be converted to GIF
];

export const notionAdapter: ExportDestinationAdapter = {
  name: 'notion',

  async validate(config: Record<string, unknown>) {
    try {
      const auth = await checkNotionAuth();
      if (!auth.authenticated) {
        return { valid: false, error: 'Not authenticated with Notion. Run dlab.notion.login first.' };
      }
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Failed to check Notion auth',
      };
    }
  },

  supportsAssetType(type: ExportAssetType): boolean {
    return SUPPORTED_TYPES.includes(type);
  },

  async convertAsset(asset: PreparedAsset): Promise<PreparedAsset> {
    // Video → GIF conversion for Notion (Notion displays inline GIFs but not MP4)
    if (asset.type === 'video' && asset.mimeType.startsWith('video/')) {
      const format = (asset.metadata?.format as string) || 'gif';
      if (format === 'gif') {
        // Mark for GIF conversion - actual conversion happens in upload step
        // where we have access to the video export module
        return {
          ...asset,
          metadata: {
            ...asset.metadata,
            needsGifConversion: true,
            maxDuration: (asset.metadata?.maxDuration as number) || 15,
          },
        };
      }
    }
    return asset;
  },

  async upload(
    projects: PreparedProject[],
    config: Record<string, unknown>,
    onProgress?: ProgressCallback,
  ): Promise<BatchExportResult> {
    const results: ExportResult[] = [];
    const errors: string[] = [];
    const parentPageId = config.parentPageId as string | undefined;
    const template = (config.template as string) || 'marketing';

    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];

      onProgress?.({
        phase: 'uploading',
        projectIndex: i,
        totalProjects: projects.length,
        detail: `Uploading to Notion: ${project.title} (${i + 1}/${projects.length})`,
        percent: Math.round((i / projects.length) * 100),
      });

      try {
        // Collect file paths from prepared assets
        const screenshots: string[] = [];
        const videos: string[] = [];

        for (const asset of project.assets) {
          if (!asset.filePath) continue;

          switch (asset.type) {
            case 'frames': {
              // Frames directory - collect image files
              try {
                const files = readdirSync(asset.filePath) as string[];
                const imageFiles = files
                  .filter((f: string) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
                  .sort()
                  .map((f: string) => join(asset.filePath, f));
                const maxFrames = (asset.metadata?.maxFrames as number) || 20;
                screenshots.push(...imageFiles.slice(0, maxFrames));
              } catch { /* empty dir */ }
              break;
            }
            case 'grid':
            case 'infographic':
              screenshots.push(asset.filePath);
              break;
            case 'visualization':
              // GIFs and PNGs go as screenshots (Notion renders GIFs inline)
              screenshots.push(asset.filePath);
              break;
            case 'video':
              if (asset.metadata?.needsGifConversion) {
                // TODO: Convert to GIF using video.ts and add as screenshot
                // For now, add as video file
                videos.push(asset.filePath);
              } else {
                videos.push(asset.filePath);
              }
              break;
          }
        }

        // Build the Notion page using marketing template
        const options: NotionExportOptions = {
          projectId: project.projectId,
          title: project.title,
          description: project.description,
          screenshots,
          videos: videos.length > 0 ? videos : undefined,
          notes: project.aiSummary || undefined,
          tags: [],
          parentPageId,
          template: template as 'evidence' | 'testReport' | 'gallery' | 'marketing' | 'custom',
        };

        const result = await createNotionPage(options);

        results.push({
          success: result.success,
          projectId: project.projectId,
          destinationUrl: result.pageUrl,
          error: result.error,
        });

        if (!result.success && result.error) {
          errors.push(`${project.title}: ${result.error}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${project.title}: ${msg}`);
        results.push({
          success: false,
          projectId: project.projectId,
          error: msg,
        });
      }
    }

    return {
      success: errors.length === 0,
      results,
      errors,
    };
  },
};
