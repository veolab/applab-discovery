/**
 * DiscoveryLab Image Export Module
 * PNG/JPEG export, batch processing, and image manipulation
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { EXPORTS_DIR, PROJECTS_DIR } from '../../db/index.js';
import {
  CanvasRenderer,
  FrameComposition,
  renderToBuffer,
  renderToFile,
  createDeviceMockupComposition,
  createComparisonComposition,
} from '../canvas/render.js';
import { listDevices, DeviceModel, getDevice } from '../canvas/mockup.js';

const execAsync = promisify(exec);

// ============================================================================
// TYPES
// ============================================================================
export interface ImageExportOptions {
  input: string; // Source image path
  output: string; // Output path
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number; // 1-100 for JPEG/WebP
  width?: number;
  height?: number;
  maintainAspect?: boolean;
}

export interface BatchExportOptions {
  inputs: string[]; // Source image paths
  outputDir: string;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  width?: number;
  height?: number;
  prefix?: string;
  suffix?: string;
}

export interface MockupExportOptions {
  screenshot: string; // Screenshot image path
  output: string;
  deviceId: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  title?: string;
  subtitle?: string;
}

export interface GalleryExportOptions {
  screenshots: Array<{
    path: string;
    deviceId: string;
    label?: string;
  }>;
  output: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  title?: string;
  columns?: number;
}

export interface ImageInfo {
  width: number;
  height: number;
  format: string;
  size: number;
  hasAlpha: boolean;
}

export interface ExportResult {
  success: boolean;
  error?: string;
  outputPath?: string;
  size?: number;
}

export interface BatchExportResult {
  success: boolean;
  error?: string;
  outputs: Array<{
    input: string;
    output: string;
    success: boolean;
    error?: string;
  }>;
  totalSize?: number;
}

// ============================================================================
// IMAGE INFO
// ============================================================================
export async function getImageInfo(imagePath: string): Promise<ImageInfo | null> {
  if (!fs.existsSync(imagePath)) {
    return null;
  }

  try {
    // Try using sips (macOS)
    const { stdout } = await execAsync(
      `sips -g pixelWidth -g pixelHeight -g format -g hasAlpha "${imagePath}"`
    );

    const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
    const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
    const formatMatch = stdout.match(/format:\s*(\w+)/);
    const alphaMatch = stdout.match(/hasAlpha:\s*(\w+)/);

    const stats = await fs.promises.stat(imagePath);

    return {
      width: widthMatch ? parseInt(widthMatch[1], 10) : 0,
      height: heightMatch ? parseInt(heightMatch[1], 10) : 0,
      format: formatMatch ? formatMatch[1] : path.extname(imagePath).slice(1),
      size: stats.size,
      hasAlpha: alphaMatch ? alphaMatch[1] === 'yes' : false,
    };
  } catch {
    // Fallback: just get basic info from file
    const stats = await fs.promises.stat(imagePath);
    return {
      width: 0,
      height: 0,
      format: path.extname(imagePath).slice(1),
      size: stats.size,
      hasAlpha: false,
    };
  }
}

// ============================================================================
// SINGLE IMAGE EXPORT
// ============================================================================
export async function exportImage(options: ImageExportOptions): Promise<ExportResult> {
  const {
    input,
    output,
    format = 'png',
    quality = 90,
    width,
    height,
    maintainAspect = true,
  } = options;

  if (!fs.existsSync(input)) {
    return { success: false, error: `Input file not found: ${input}` };
  }

  // Ensure output directory exists
  const outputDir = path.dirname(output);
  await fs.promises.mkdir(outputDir, { recursive: true });

  try {
    // Use sips for image conversion (macOS)
    let args: string[] = [];

    // Format conversion
    const sipsFormat = format === 'jpeg' ? 'jpeg' : format;
    args.push('-s', 'format', sipsFormat);

    // Quality (for JPEG)
    if (format === 'jpeg' && quality) {
      args.push('-s', 'formatOptions', quality.toString());
    }

    // Resize
    if (width && height) {
      if (maintainAspect) {
        args.push('-Z', Math.max(width, height).toString());
      } else {
        args.push('-z', height.toString(), width.toString());
      }
    } else if (width) {
      args.push('--resampleWidth', width.toString());
    } else if (height) {
      args.push('--resampleHeight', height.toString());
    }

    args.push('--out', output, input);

    await execAsync(`sips ${args.join(' ')}`);

    const stats = await fs.promises.stat(output);

    return {
      success: true,
      outputPath: output,
      size: stats.size,
    };
  } catch (error) {
    // Fallback: copy file directly
    try {
      await fs.promises.copyFile(input, output);
      const stats = await fs.promises.stat(output);
      return {
        success: true,
        outputPath: output,
        size: stats.size,
      };
    } catch (copyError) {
      return {
        success: false,
        error: copyError instanceof Error ? copyError.message : String(copyError),
      };
    }
  }
}

// ============================================================================
// BATCH IMAGE EXPORT
// ============================================================================
export async function exportBatch(options: BatchExportOptions): Promise<BatchExportResult> {
  const {
    inputs,
    outputDir,
    format = 'png',
    quality = 90,
    width,
    height,
    prefix = '',
    suffix = '',
  } = options;

  // Ensure output directory exists
  await fs.promises.mkdir(outputDir, { recursive: true });

  const outputs: BatchExportResult['outputs'] = [];
  let totalSize = 0;

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const baseName = path.basename(input, path.extname(input));
    const outputName = `${prefix}${baseName}${suffix}.${format}`;
    const output = path.join(outputDir, outputName);

    const result = await exportImage({
      input,
      output,
      format,
      quality,
      width,
      height,
    });

    outputs.push({
      input,
      output,
      success: result.success,
      error: result.error,
    });

    if (result.success && result.size) {
      totalSize += result.size;
    }
  }

  const allSuccess = outputs.every(o => o.success);

  return {
    success: allSuccess,
    error: allSuccess ? undefined : 'Some exports failed',
    outputs,
    totalSize,
  };
}

// ============================================================================
// MOCKUP EXPORT
// ============================================================================
export async function exportMockup(options: MockupExportOptions): Promise<ExportResult> {
  const {
    screenshot,
    output,
    deviceId,
    format = 'png',
    quality = 90,
    width = 1920,
    height = 1080,
    backgroundColor = '#f5f5f7',
    title,
    subtitle,
  } = options;

  if (!fs.existsSync(screenshot)) {
    return { success: false, error: `Screenshot not found: ${screenshot}` };
  }

  const device = getDevice(deviceId);
  if (!device) {
    return { success: false, error: `Device not found: ${deviceId}` };
  }

  try {
    const composition = createDeviceMockupComposition(deviceId, screenshot, {
      width,
      height,
      backgroundColor,
      title,
      subtitle,
    });

    const result = await renderToFile(composition, output, { format, quality });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    const stats = await fs.promises.stat(output);

    return {
      success: true,
      outputPath: output,
      size: stats.size,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// GALLERY EXPORT
// ============================================================================
export async function exportGallery(options: GalleryExportOptions): Promise<ExportResult> {
  const {
    screenshots,
    output,
    format = 'png',
    quality = 90,
    width = 1920,
    height = 1080,
    backgroundColor = '#f5f5f7',
    title,
    columns = 3,
  } = options;

  if (screenshots.length === 0) {
    return { success: false, error: 'No screenshots provided' };
  }

  try {
    // If all screenshots are for the same device comparison
    const devices = screenshots.map(s => ({
      deviceId: s.deviceId,
      screenshotPath: s.path,
      label: s.label,
    }));

    const composition = createComparisonComposition(devices, {
      width,
      height,
      backgroundColor,
      title,
    });

    const result = await renderToFile(composition, output, { format, quality });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    const stats = await fs.promises.stat(output);

    return {
      success: true,
      outputPath: output,
      size: stats.size,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// SCREENSHOT TO MOCKUP BATCH
// ============================================================================
export async function exportScreenshotsAsMockups(
  screenshots: string[],
  outputDir: string,
  deviceId: string,
  options: {
    format?: 'png' | 'jpeg';
    quality?: number;
    width?: number;
    height?: number;
    backgroundColor?: string;
  } = {}
): Promise<BatchExportResult> {
  await fs.promises.mkdir(outputDir, { recursive: true });

  const outputs: BatchExportResult['outputs'] = [];
  let totalSize = 0;

  for (let i = 0; i < screenshots.length; i++) {
    const screenshot = screenshots[i];
    const baseName = path.basename(screenshot, path.extname(screenshot));
    const output = path.join(outputDir, `${baseName}_mockup.${options.format || 'png'}`);

    const result = await exportMockup({
      screenshot,
      output,
      deviceId,
      ...options,
    });

    outputs.push({
      input: screenshot,
      output,
      success: result.success,
      error: result.error,
    });

    if (result.success && result.size) {
      totalSize += result.size;
    }
  }

  const allSuccess = outputs.every(o => o.success);

  return {
    success: allSuccess,
    error: allSuccess ? undefined : 'Some exports failed',
    outputs,
    totalSize,
  };
}

// ============================================================================
// COMPOSITE IMAGE
// ============================================================================
export async function createCompositeImage(
  images: Array<{
    path: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    opacity?: number;
  }>,
  output: string,
  options: {
    width: number;
    height: number;
    backgroundColor?: string;
    format?: 'png' | 'jpeg';
    quality?: number;
  }
): Promise<ExportResult> {
  const { width, height, backgroundColor = '#ffffff', format = 'png', quality = 90 } = options;

  try {
    const composition: FrameComposition = {
      width,
      height,
      backgroundColor,
      layers: images.map((img, i) => ({
        type: 'image' as const,
        zIndex: i,
        opacity: img.opacity,
        image: {
          src: img.path,
          x: img.x,
          y: img.y,
          width: img.width,
          height: img.height,
        },
      })),
    };

    const result = await renderToFile(composition, output, { format, quality });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    const stats = await fs.promises.stat(output);

    return {
      success: true,
      outputPath: output,
      size: stats.size,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// UTILITY
// ============================================================================
export function generateExportPath(
  projectId: string,
  format: 'png' | 'jpeg' | 'webp',
  suffix?: string
): string {
  const timestamp = Date.now();
  const filename = suffix
    ? `${projectId}_${suffix}_${timestamp}.${format}`
    : `${projectId}_${timestamp}.${format}`;
  return path.join(EXPORTS_DIR, filename);
}

export async function cleanupTempImages(directory: string, olderThanMs: number = 3600000): Promise<number> {
  let deletedCount = 0;
  const now = Date.now();

  try {
    const files = await fs.promises.readdir(directory);

    for (const file of files) {
      const filePath = path.join(directory, file);
      const stats = await fs.promises.stat(filePath);

      if (now - stats.mtimeMs > olderThanMs) {
        await fs.promises.unlink(filePath);
        deletedCount++;
      }
    }
  } catch {
    // Directory might not exist
  }

  return deletedCount;
}

export async function copyToClipboard(imagePath: string): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false; // Only supported on macOS
  }

  try {
    await execAsync(
      `osascript -e 'set the clipboard to (read (POSIX file "${imagePath}") as JPEG picture)'`
    );
    return true;
  } catch {
    try {
      // Try PNG
      await execAsync(
        `osascript -e 'set the clipboard to (read (POSIX file "${imagePath}") as PNG picture)'`
      );
      return true;
    } catch {
      return false;
    }
  }
}

export async function revealInFinder(filePath: string): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false;
  }

  try {
    await execAsync(`open -R "${filePath}"`);
    return true;
  } catch {
    return false;
  }
}
