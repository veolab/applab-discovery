/**
 * DiscoveryLab Frame Extraction Module
 * Extracts frames from videos using FFmpeg
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { FRAMES_DIR } from '../../db/index.js';

// ============================================================================
// TYPES
// ============================================================================
export interface VideoInfo {
  duration: number; // seconds
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
}

export interface FrameExtractionOptions {
  projectId: string;
  videoPath: string;
  fps?: number; // frames per second to extract (default: 1)
  keyFramesOnly?: boolean; // only extract keyframes
  maxFrames?: number; // limit number of frames
  startTime?: number; // start extraction at this time (seconds)
  endTime?: number; // end extraction at this time (seconds)
  outputFormat?: 'png' | 'jpg'; // output format (default: png)
  quality?: number; // quality for jpg (1-31, lower is better)
}

export interface FrameExtractionResult {
  success: boolean;
  framesDir?: string;
  frameCount?: number;
  frames?: FrameInfo[];
  error?: string;
}

export interface FrameInfo {
  path: string;
  frameNumber: number;
  timestamp: number; // seconds into video
  filename: string;
}

// ============================================================================
// VIDEO INFO
// ============================================================================
export function getVideoInfo(videoPath: string): VideoInfo | null {
  if (!existsSync(videoPath)) {
    return null;
  }

  try {
    // Use ffprobe to get video information
    const output = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${videoPath}"`,
      { encoding: 'utf-8' }
    );

    const data = JSON.parse(output);
    const videoStream = data.streams?.find((s: any) => s.codec_type === 'video');

    if (!videoStream) {
      return null;
    }

    // Parse frame rate (can be "30/1" or "29.97")
    let fps = 30;
    if (videoStream.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split('/');
      fps = den ? parseInt(num, 10) / parseInt(den, 10) : parseFloat(num);
    }

    const duration = parseFloat(data.format?.duration || videoStream.duration || '0');
    const frameCount = parseInt(videoStream.nb_frames, 10) || Math.round(duration * fps);

    return {
      duration,
      frameCount,
      fps,
      width: videoStream.width,
      height: videoStream.height,
      codec: videoStream.codec_name,
    };
  } catch (error) {
    console.error('Failed to get video info:', error);
    return null;
  }
}

// ============================================================================
// FRAME EXTRACTION
// ============================================================================
export async function extractFrames(options: FrameExtractionOptions): Promise<FrameExtractionResult> {
  const { projectId, videoPath, outputFormat = 'png' } = options;

  if (!existsSync(videoPath)) {
    return { success: false, error: `Video file not found: ${videoPath}` };
  }

  // Create frames directory for this project
  const framesDir = join(FRAMES_DIR, projectId);
  if (!existsSync(framesDir)) {
    mkdirSync(framesDir, { recursive: true });
  }

  const videoInfo = getVideoInfo(videoPath);
  if (!videoInfo) {
    return { success: false, error: 'Failed to read video information' };
  }

  // Build FFmpeg arguments
  const args = buildFFmpegArgs(options, framesDir, videoInfo, outputFormat);

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args);

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: `FFmpeg failed: ${stderr.slice(-500)}` });
        return;
      }

      // List extracted frames
      const frames = listExtractedFrames(framesDir, videoInfo.fps, options.fps || 1);

      resolve({
        success: true,
        framesDir,
        frameCount: frames.length,
        frames,
      });
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

function buildFFmpegArgs(
  options: FrameExtractionOptions,
  framesDir: string,
  videoInfo: VideoInfo,
  outputFormat: string
): string[] {
  const args: string[] = ['-y']; // Overwrite output files

  // Input file
  args.push('-i', options.videoPath);

  // Time range
  if (options.startTime !== undefined) {
    args.push('-ss', options.startTime.toString());
  }
  if (options.endTime !== undefined) {
    args.push('-to', options.endTime.toString());
  }

  // Frame selection
  if (options.keyFramesOnly) {
    // Extract only keyframes (I-frames)
    args.push('-vf', 'select=eq(pict_type\\,I)');
    args.push('-vsync', 'vfr');
  } else if (options.fps) {
    // Extract at specified FPS
    args.push('-vf', `fps=${options.fps}`);
  } else {
    // Default: 1 frame per second
    args.push('-vf', 'fps=1');
  }

  // Limit frame count
  if (options.maxFrames) {
    args.push('-frames:v', options.maxFrames.toString());
  }

  // Quality settings
  if (outputFormat === 'jpg' && options.quality) {
    args.push('-q:v', options.quality.toString());
  }

  // Output pattern
  const outputPattern = join(framesDir, `frame-%04d.${outputFormat}`);
  args.push(outputPattern);

  return args;
}

function listExtractedFrames(framesDir: string, videoFps: number, extractFps: number): FrameInfo[] {
  const files = readdirSync(framesDir)
    .filter((f) => f.startsWith('frame-') && (f.endsWith('.png') || f.endsWith('.jpg')))
    .sort();

  return files.map((filename, index) => {
    // Calculate timestamp based on extraction FPS
    const timestamp = index / extractFps;

    // Parse frame number from filename
    const match = filename.match(/frame-(\d+)/);
    const frameNumber = match ? parseInt(match[1], 10) : index + 1;

    return {
      path: join(framesDir, filename),
      frameNumber,
      timestamp,
      filename,
    };
  });
}

// ============================================================================
// KEY FRAME DETECTION
// ============================================================================
export interface KeyFrameInfo extends FrameInfo {
  score: number; // Scene change score (0-1)
  isSceneChange: boolean;
}

export async function detectKeyFrames(
  videoPath: string,
  threshold: number = 0.3
): Promise<KeyFrameInfo[]> {
  if (!existsSync(videoPath)) {
    return [];
  }

  try {
    // Use FFmpeg scene change detection
    const output = execSync(
      `ffmpeg -i "${videoPath}" -vf "select='gt(scene,${threshold})',showinfo" -f null - 2>&1`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );

    const keyFrames: KeyFrameInfo[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Parse showinfo output
      const match = line.match(/n:\s*(\d+).*pts_time:\s*([\d.]+)/);
      if (match) {
        const frameNumber = parseInt(match[1], 10);
        const timestamp = parseFloat(match[2]);

        // Extract scene change score if available
        const scoreMatch = line.match(/scene:\s*([\d.]+)/);
        const score = scoreMatch ? parseFloat(scoreMatch[1]) : threshold;

        keyFrames.push({
          path: '',
          frameNumber,
          timestamp,
          filename: `keyframe-${frameNumber}.png`,
          score,
          isSceneChange: score > threshold,
        });
      }
    }

    return keyFrames;
  } catch (error) {
    console.error('Failed to detect key frames:', error);
    return [];
  }
}

export async function extractKeyFramesOnly(
  projectId: string,
  videoPath: string,
  threshold: number = 0.3
): Promise<FrameExtractionResult> {
  // Detect key frames first
  const keyFrames = await detectKeyFrames(videoPath, threshold);

  if (keyFrames.length === 0) {
    // Fall back to regular extraction
    return extractFrames({
      projectId,
      videoPath,
      fps: 1,
      maxFrames: 30,
    });
  }

  // Create frames directory
  const framesDir = join(FRAMES_DIR, projectId);
  if (!existsSync(framesDir)) {
    mkdirSync(framesDir, { recursive: true });
  }

  // Extract only the key frames at specific timestamps
  const extractedFrames: FrameInfo[] = [];

  for (let i = 0; i < keyFrames.length; i++) {
    const kf = keyFrames[i];
    const outputPath = join(framesDir, `keyframe-${String(i + 1).padStart(4, '0')}.png`);

    try {
      execSync(
        `ffmpeg -y -ss ${kf.timestamp} -i "${videoPath}" -frames:v 1 "${outputPath}"`,
        { stdio: 'ignore' }
      );

      if (existsSync(outputPath)) {
        extractedFrames.push({
          path: outputPath,
          frameNumber: i + 1,
          timestamp: kf.timestamp,
          filename: basename(outputPath),
        });
      }
    } catch {
      // Skip failed extractions
    }
  }

  return {
    success: true,
    framesDir,
    frameCount: extractedFrames.length,
    frames: extractedFrames,
  };
}

// ============================================================================
// THUMBNAIL GENERATION
// ============================================================================
export async function generateThumbnail(
  videoPath: string,
  outputPath: string,
  timestamp: number = 0,
  width: number = 320
): Promise<boolean> {
  if (!existsSync(videoPath)) {
    return false;
  }

  try {
    execSync(
      `ffmpeg -y -ss ${timestamp} -i "${videoPath}" -vframes 1 -vf "scale=${width}:-1" "${outputPath}"`,
      { stdio: 'ignore' }
    );

    return existsSync(outputPath);
  } catch {
    return false;
  }
}

// ============================================================================
// FRAME COMPARISON
// ============================================================================
export function compareFrames(frame1: string, frame2: string): number | null {
  // Uses ImageMagick's compare if available
  try {
    const output = execSync(
      `compare -metric RMSE "${frame1}" "${frame2}" null: 2>&1 || true`,
      { encoding: 'utf-8' }
    );

    // Parse RMSE value
    const match = output.match(/^([\d.]+)/);
    if (match) {
      return parseFloat(match[1]);
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// UTILITY
// ============================================================================
export function cleanupFrames(projectId: string): void {
  const framesDir = join(FRAMES_DIR, projectId);

  if (existsSync(framesDir)) {
    const files = readdirSync(framesDir);
    for (const file of files) {
      try {
        const filePath = join(framesDir, file);
        const stat = statSync(filePath);
        if (stat.isFile()) {
          require('fs').unlinkSync(filePath);
        }
      } catch {
        // Ignore errors
      }
    }
  }
}
