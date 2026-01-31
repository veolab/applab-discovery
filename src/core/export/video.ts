/**
 * DiscoveryLab Video Export Module
 * MP4 encoding and GIF generation via FFmpeg
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EXPORTS_DIR } from '../../db/index.js';

const execAsync = promisify(exec);

// ============================================================================
// TYPES
// ============================================================================
export interface VideoExportOptions {
  input: string; // Source video or image sequence
  output: string; // Output path
  format: 'mp4' | 'gif' | 'webm';
  quality?: 'high' | 'medium' | 'low';
  width?: number;
  height?: number;
  fps?: number;
  startTime?: number; // In seconds
  duration?: number; // In seconds
  loop?: number; // For GIF: 0 = infinite loop
  overlay?: VideoOverlay;
}

export interface VideoOverlay {
  type: 'text' | 'image' | 'watermark';
  text?: string;
  imagePath?: string;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
  fontSize?: number;
  fontColor?: string;
  opacity?: number;
  padding?: number;
}

export interface ImageSequenceOptions {
  inputPattern: string; // e.g., "frame_%04d.png"
  inputDir: string;
  output: string;
  format: 'mp4' | 'gif' | 'webm';
  fps: number;
  quality?: 'high' | 'medium' | 'low';
  width?: number;
  height?: number;
}

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrate: number;
  format: string;
}

export interface ExportResult {
  success: boolean;
  error?: string;
  outputPath?: string;
  size?: number;
  duration?: number;
}

export interface ExportProgress {
  percent: number;
  frame: number;
  fps: number;
  time: number;
  speed: string;
}

// ============================================================================
// FFMPEG HELPERS
// ============================================================================
async function checkFFmpeg(): Promise<boolean> {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch {
    return false;
  }
}

function getQualitySettings(quality: 'high' | 'medium' | 'low', format: string): string[] {
  const settings: Record<string, Record<string, string[]>> = {
    mp4: {
      high: ['-crf', '18', '-preset', 'slow'],
      medium: ['-crf', '23', '-preset', 'medium'],
      low: ['-crf', '28', '-preset', 'fast'],
    },
    webm: {
      high: ['-crf', '15', '-b:v', '0'],
      medium: ['-crf', '30', '-b:v', '0'],
      low: ['-crf', '40', '-b:v', '0'],
    },
    gif: {
      high: [],
      medium: [],
      low: [],
    },
  };

  return settings[format]?.[quality] || [];
}

// ============================================================================
// VIDEO EXPORT
// ============================================================================
export async function exportVideo(
  options: VideoExportOptions,
  onProgress?: (progress: ExportProgress) => void
): Promise<ExportResult> {
  const hasFFmpeg = await checkFFmpeg();
  if (!hasFFmpeg) {
    return { success: false, error: 'FFmpeg not installed' };
  }

  const {
    input,
    output,
    format,
    quality = 'medium',
    width,
    height,
    fps,
    startTime,
    duration,
    loop = 0,
    overlay,
  } = options;

  // Ensure output directory exists
  const outputDir = path.dirname(output);
  await fs.promises.mkdir(outputDir, { recursive: true });

  // Build FFmpeg arguments
  const args: string[] = ['-y']; // Overwrite output

  // Input options
  if (startTime !== undefined) {
    args.push('-ss', startTime.toString());
  }
  args.push('-i', input);

  // Duration
  if (duration !== undefined) {
    args.push('-t', duration.toString());
  }

  // Filters
  const filters: string[] = [];

  // Scale filter
  if (width || height) {
    const w = width || -1;
    const h = height || -1;
    filters.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
  }

  // FPS filter
  if (fps) {
    filters.push(`fps=${fps}`);
  }

  // Overlay filter
  if (overlay) {
    const overlayFilter = buildOverlayFilter(overlay);
    if (overlayFilter) {
      filters.push(overlayFilter);
    }
  }

  // Format-specific encoding
  if (format === 'gif') {
    // GIF requires special handling with palette generation
    const palettePath = path.join(os.tmpdir(), `palette_${Date.now()}.png`);

    // First pass: generate palette
    const paletteArgs = [
      '-y', '-i', input,
      '-vf', filters.length ? `${filters.join(',')},palettegen` : 'palettegen',
      palettePath
    ];
    await execAsync(`ffmpeg ${paletteArgs.map(a => `"${a}"`).join(' ')}`);

    // Second pass: create GIF with palette
    const gifFilters = filters.length ? `${filters.join(',')},` : '';
    const gifArgs = [
      '-y', '-i', input, '-i', palettePath,
      '-lavfi', `${gifFilters}paletteuse`,
      '-loop', loop.toString(),
      output
    ];
    await execAsync(`ffmpeg ${gifArgs.map(a => `"${a}"`).join(' ')}`);

    // Clean up palette
    await fs.promises.unlink(palettePath).catch(() => {});
  } else {
    // Apply filters
    if (filters.length) {
      args.push('-vf', filters.join(','));
    }

    // Quality settings
    args.push(...getQualitySettings(quality, format));

    // Format-specific codec
    if (format === 'mp4') {
      args.push('-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p');
    } else if (format === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-c:a', 'libopus');
    }

    args.push(output);

    // Execute with progress tracking
    if (onProgress) {
      await runFFmpegWithProgress(args, onProgress);
    } else {
      await execAsync(`ffmpeg ${args.map(a => `"${a}"`).join(' ')}`);
    }
  }

  // Get output file info
  const stats = await fs.promises.stat(output);

  return {
    success: true,
    outputPath: output,
    size: stats.size,
  };
}

function buildOverlayFilter(overlay: VideoOverlay): string | null {
  const { type, text, imagePath, position = 'bottom-right', fontSize = 24, fontColor = 'white', opacity = 1, padding = 10 } = overlay;

  const positionMap: Record<string, string> = {
    'top-left': `${padding}:${padding}`,
    'top-right': `W-w-${padding}:${padding}`,
    'bottom-left': `${padding}:H-h-${padding}`,
    'bottom-right': `W-w-${padding}:H-h-${padding}`,
    'center': '(W-w)/2:(H-h)/2',
  };

  const pos = positionMap[position];

  if (type === 'text' && text) {
    return `drawtext=text='${text.replace(/'/g, "\\'")}':fontsize=${fontSize}:fontcolor=${fontColor}@${opacity}:x=${pos.split(':')[0]}:y=${pos.split(':')[1]}`;
  }

  if ((type === 'image' || type === 'watermark') && imagePath) {
    return `[0:v][1:v]overlay=${pos}`;
  }

  return null;
}

async function runFFmpegWithProgress(
  args: string[],
  onProgress: (progress: ExportProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    ffmpeg.stderr?.on('data', (data: Buffer) => {
      const output = data.toString();

      // Parse progress from FFmpeg output
      const frameMatch = output.match(/frame=\s*(\d+)/);
      const fpsMatch = output.match(/fps=\s*([\d.]+)/);
      const timeMatch = output.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      const speedMatch = output.match(/speed=\s*([\d.]+x)/);

      if (frameMatch) {
        const progress: ExportProgress = {
          percent: 0, // Would need total frames to calculate
          frame: parseInt(frameMatch[1], 10),
          fps: fpsMatch ? parseFloat(fpsMatch[1]) : 0,
          time: timeMatch ?
            parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]) : 0,
          speed: speedMatch ? speedMatch[1] : '0x',
        };
        onProgress(progress);
      }
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on('error', reject);
  });
}

// ============================================================================
// IMAGE SEQUENCE TO VIDEO
// ============================================================================
export async function exportImageSequence(
  options: ImageSequenceOptions,
  onProgress?: (progress: ExportProgress) => void
): Promise<ExportResult> {
  const hasFFmpeg = await checkFFmpeg();
  if (!hasFFmpeg) {
    return { success: false, error: 'FFmpeg not installed' };
  }

  const { inputPattern, inputDir, output, format, fps, quality = 'medium', width, height } = options;

  // Ensure output directory exists
  const outputDir = path.dirname(output);
  await fs.promises.mkdir(outputDir, { recursive: true });

  const inputPath = path.join(inputDir, inputPattern);
  const args: string[] = [
    '-y',
    '-framerate', fps.toString(),
    '-i', inputPath,
  ];

  // Filters
  const filters: string[] = [];
  if (width || height) {
    const w = width || -1;
    const h = height || -1;
    filters.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
  }

  if (format === 'gif') {
    // Generate palette for better GIF quality
    const palettePath = path.join(os.tmpdir(), `palette_${Date.now()}.png`);

    const paletteArgs = [
      '-y',
      '-framerate', fps.toString(),
      '-i', inputPath,
      '-vf', filters.length ? `${filters.join(',')},palettegen` : 'palettegen',
      palettePath
    ];
    await execAsync(`ffmpeg ${paletteArgs.map(a => `"${a}"`).join(' ')}`);

    const gifFilters = filters.length ? `${filters.join(',')},` : '';
    const gifArgs = [
      '-y',
      '-framerate', fps.toString(),
      '-i', inputPath,
      '-i', palettePath,
      '-lavfi', `${gifFilters}paletteuse`,
      '-loop', '0',
      output
    ];
    await execAsync(`ffmpeg ${gifArgs.map(a => `"${a}"`).join(' ')}`);

    await fs.promises.unlink(palettePath).catch(() => {});
  } else {
    if (filters.length) {
      args.push('-vf', filters.join(','));
    }

    args.push(...getQualitySettings(quality, format));

    if (format === 'mp4') {
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    } else if (format === 'webm') {
      args.push('-c:v', 'libvpx-vp9');
    }

    args.push(output);

    if (onProgress) {
      await runFFmpegWithProgress(args, onProgress);
    } else {
      await execAsync(`ffmpeg ${args.map(a => `"${a}"`).join(' ')}`);
    }
  }

  const stats = await fs.promises.stat(output);

  return {
    success: true,
    outputPath: output,
    size: stats.size,
  };
}

// ============================================================================
// VIDEO INFO
// ============================================================================
export async function getVideoInfo(videoPath: string): Promise<VideoInfo | null> {
  const hasFFmpeg = await checkFFmpeg();
  if (!hasFFmpeg) return null;

  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${videoPath}"`
    );

    const data = JSON.parse(stdout);
    const videoStream = data.streams?.find((s: any) => s.codec_type === 'video');

    if (!videoStream) return null;

    const fpsMatch = videoStream.r_frame_rate?.match(/(\d+)\/(\d+)/);
    const fps = fpsMatch ? parseInt(fpsMatch[1]) / parseInt(fpsMatch[2]) : 30;

    return {
      duration: parseFloat(data.format?.duration || '0'),
      width: videoStream.width || 0,
      height: videoStream.height || 0,
      fps: Math.round(fps),
      codec: videoStream.codec_name || 'unknown',
      bitrate: parseInt(data.format?.bit_rate || '0'),
      format: data.format?.format_name || 'unknown',
    };
  } catch {
    return null;
  }
}

// ============================================================================
// VIDEO TRIMMING
// ============================================================================
export async function trimVideo(
  inputPath: string,
  outputPath: string,
  startTime: number,
  endTime: number
): Promise<ExportResult> {
  const hasFFmpeg = await checkFFmpeg();
  if (!hasFFmpeg) {
    return { success: false, error: 'FFmpeg not installed' };
  }

  const duration = endTime - startTime;
  const outputDir = path.dirname(outputPath);
  await fs.promises.mkdir(outputDir, { recursive: true });

  try {
    await execAsync(
      `ffmpeg -y -i "${inputPath}" -ss ${startTime} -t ${duration} -c copy "${outputPath}"`
    );

    const stats = await fs.promises.stat(outputPath);

    return {
      success: true,
      outputPath,
      size: stats.size,
      duration,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// VIDEO CONCATENATION
// ============================================================================
export async function concatenateVideos(
  inputPaths: string[],
  outputPath: string
): Promise<ExportResult> {
  const hasFFmpeg = await checkFFmpeg();
  if (!hasFFmpeg) {
    return { success: false, error: 'FFmpeg not installed' };
  }

  if (inputPaths.length === 0) {
    return { success: false, error: 'No input videos provided' };
  }

  // Create concat file
  const concatFile = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
  const concatContent = inputPaths.map(p => `file '${p}'`).join('\n');
  await fs.promises.writeFile(concatFile, concatContent);

  const outputDir = path.dirname(outputPath);
  await fs.promises.mkdir(outputDir, { recursive: true });

  try {
    await execAsync(
      `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}"`
    );

    await fs.promises.unlink(concatFile).catch(() => {});

    const stats = await fs.promises.stat(outputPath);
    const info = await getVideoInfo(outputPath);

    return {
      success: true,
      outputPath,
      size: stats.size,
      duration: info?.duration,
    };
  } catch (error) {
    await fs.promises.unlink(concatFile).catch(() => {});
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// THUMBNAIL GENERATION
// ============================================================================
export async function generateThumbnail(
  videoPath: string,
  outputPath: string,
  timestamp: number = 0
): Promise<ExportResult> {
  const hasFFmpeg = await checkFFmpeg();
  if (!hasFFmpeg) {
    return { success: false, error: 'FFmpeg not installed' };
  }

  const outputDir = path.dirname(outputPath);
  await fs.promises.mkdir(outputDir, { recursive: true });

  try {
    await execAsync(
      `ffmpeg -y -i "${videoPath}" -ss ${timestamp} -vframes 1 "${outputPath}"`
    );

    const stats = await fs.promises.stat(outputPath);

    return {
      success: true,
      outputPath,
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
// GIF CREATION
// ============================================================================
export async function createGIF(
  inputPath: string,
  outputPath: string,
  options: {
    width?: number;
    fps?: number;
    startTime?: number;
    duration?: number;
    loop?: number;
  } = {}
): Promise<ExportResult> {
  return exportVideo({
    input: inputPath,
    output: outputPath,
    format: 'gif',
    width: options.width,
    fps: options.fps || 15,
    startTime: options.startTime,
    duration: options.duration,
    loop: options.loop ?? 0,
  });
}

// ============================================================================
// UTILITY
// ============================================================================
export function generateExportPath(
  projectId: string,
  format: 'mp4' | 'gif' | 'webm',
  suffix?: string
): string {
  const timestamp = Date.now();
  const filename = suffix
    ? `${projectId}_${suffix}_${timestamp}.${format}`
    : `${projectId}_${timestamp}.${format}`;
  return path.join(EXPORTS_DIR, filename);
}
