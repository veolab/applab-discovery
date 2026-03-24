/**
 * Export Pipeline - Destination Adapter Types
 * Decoupled architecture: adapters implement this interface to support any destination
 */

// ============================================================================
// ASSET TYPES
// ============================================================================

export type ExportAssetType = 'video' | 'grid' | 'infographic' | 'frames' | 'visualization';

export interface ExportAsset {
  type: ExportAssetType;
  include: boolean;
  config?: Record<string, unknown>;
}

export interface VideoAsset extends ExportAsset {
  type: 'video';
  config?: {
    format?: 'mp4' | 'gif';
    maxDuration?: number; // seconds, for GIF conversion
    quality?: 'high' | 'medium' | 'low';
  };
}

export interface GridAsset extends ExportAsset {
  type: 'grid';
  config?: {
    layout?: string;
    aspectRatio?: string;
    background?: Record<string, unknown>;
  };
}

export interface InfographicAsset extends ExportAsset {
  type: 'infographic';
  config?: {
    layout?: 'flow-horizontal' | 'flow-vertical' | 'infographic';
    includeAnnotations?: boolean;
    includeStepNumbers?: boolean;
  };
}

export interface FramesAsset extends ExportAsset {
  type: 'frames';
  config?: {
    frameIds?: string[];
    maxFrames?: number;
  };
}

export interface VisualizationAsset extends ExportAsset {
  type: 'visualization';
  config?: {
    templateId?: 'flow-diagram' | 'device-showcase' | 'metrics-dashboard';
    exportFormat?: 'png' | 'gif';
  };
}

// ============================================================================
// MANIFEST
// ============================================================================

export interface ProjectExportEntry {
  projectId: string;
  title: string;             // User-editable marketing title
  description: string;       // User-editable marketing description
  assets: ExportAsset[];
}

export interface BatchExportManifest {
  projects: ProjectExportEntry[];
  destination: DestinationConfig;
}

export interface DestinationConfig {
  type: string; // 'notion' | 'drive' | 'slack' | 'local' | ...
  config?: Record<string, unknown>;
}

// ============================================================================
// PREPARED ASSETS (after preparation step)
// ============================================================================

export interface PreparedAsset {
  type: ExportAssetType;
  originalType: ExportAssetType;
  filePath: string;
  mimeType: string;
  fileName: string;
  metadata?: Record<string, unknown>;
}

export interface PreparedProject {
  projectId: string;
  title: string;
  description: string;
  platform?: string;
  aiSummary?: string;
  assets: PreparedAsset[];
}

// ============================================================================
// DESTINATION ADAPTER INTERFACE
// ============================================================================

export interface ExportProgress {
  phase: 'preparing' | 'converting' | 'uploading' | 'done' | 'error';
  projectIndex: number;
  totalProjects: number;
  detail: string;
  percent: number; // 0-100
}

export type ProgressCallback = (progress: ExportProgress) => void;

export interface ExportResult {
  success: boolean;
  projectId: string;
  destinationUrl?: string;
  error?: string;
}

export interface BatchExportResult {
  success: boolean;
  results: ExportResult[];
  errors: string[];
}

/**
 * Destination Adapter Interface
 * Implement this to add support for a new export destination.
 */
export interface ExportDestinationAdapter {
  /** Unique adapter name */
  name: string;

  /** Check if destination is configured and reachable */
  validate(config: Record<string, unknown>): Promise<{ valid: boolean; error?: string }>;

  /** Check if this adapter supports a given asset type */
  supportsAssetType(type: ExportAssetType): boolean;

  /**
   * Convert an asset to a format the destination supports.
   * e.g., MP4 → GIF for Notion, or resize images for Slack.
   * Returns the asset unchanged if no conversion needed.
   */
  convertAsset(asset: PreparedAsset): Promise<PreparedAsset>;

  /**
   * Upload a batch of prepared projects to the destination.
   * Reports progress via the callback.
   */
  upload(
    projects: PreparedProject[],
    config: Record<string, unknown>,
    onProgress?: ProgressCallback,
  ): Promise<BatchExportResult>;
}
