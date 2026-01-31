/**
 * DiscoveryLab Export Tools
 * MCP tools for video and image export operations
 */

import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult } from '../server.js';
import { EXPORTS_DIR, getDatabase } from '../../db/index.js';
import {
  exportVideo,
  exportImageSequence,
  getVideoInfo,
  trimVideo,
  concatenateVideos,
  generateThumbnail,
  createGIF,
} from '../../core/export/video.js';
import {
  exportImage,
  exportBatch,
  exportMockup,
  exportGallery,
  exportScreenshotsAsMockups,
  getImageInfo,
  copyToClipboard,
  revealInFinder,
} from '../../core/export/image.js';

// ============================================================================
// dlab.export.video
// ============================================================================
export const exportVideoTool: MCPTool = {
  name: 'dlab.export.video',
  description: 'Export a video in different formats (MP4, WebM, GIF).',
  inputSchema: z.object({
    input: z.string().describe('Path to source video'),
    format: z.enum(['mp4', 'webm', 'gif']).describe('Output format'),
    quality: z.enum(['high', 'medium', 'low']).optional().describe('Quality preset (default: medium)'),
    width: z.number().optional().describe('Output width (maintains aspect ratio)'),
    height: z.number().optional().describe('Output height'),
    fps: z.number().optional().describe('Output frame rate'),
    startTime: z.number().optional().describe('Start time in seconds'),
    duration: z.number().optional().describe('Duration in seconds'),
    output: z.string().optional().describe('Output path (auto-generated if not specified)'),
  }),
  handler: async (params) => {
    const {
      input,
      format,
      quality = 'medium',
      width,
      height,
      fps,
      startTime,
      duration,
      output,
    } = params;

    if (!fs.existsSync(input)) {
      return createErrorResult(`Input video not found: ${input}`);
    }

    const outputPath = output || path.join(
      EXPORTS_DIR,
      `export_${Date.now()}.${format}`
    );

    const result = await exportVideo({
      input,
      output: outputPath,
      format,
      quality,
      width,
      height,
      fps,
      startTime,
      duration,
    });

    if (!result.success) {
      return createErrorResult(result.error || 'Export failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      output: result.outputPath,
      size: result.size,
      format,
    }, null, 2));
  },
};

// ============================================================================
// dlab.export.gif
// ============================================================================
export const exportGifTool: MCPTool = {
  name: 'dlab.export.gif',
  description: 'Create an animated GIF from a video.',
  inputSchema: z.object({
    input: z.string().describe('Path to source video'),
    width: z.number().optional().describe('Output width (default: preserves original)'),
    fps: z.number().optional().describe('Frame rate (default: 15)'),
    startTime: z.number().optional().describe('Start time in seconds'),
    duration: z.number().optional().describe('Duration in seconds'),
    loop: z.number().optional().describe('Loop count (0 = infinite, default: 0)'),
    output: z.string().optional().describe('Output path'),
  }),
  handler: async (params) => {
    const {
      input,
      width,
      fps = 15,
      startTime,
      duration,
      loop = 0,
      output,
    } = params;

    if (!fs.existsSync(input)) {
      return createErrorResult(`Input video not found: ${input}`);
    }

    const outputPath = output || path.join(
      EXPORTS_DIR,
      `gif_${Date.now()}.gif`
    );

    const result = await createGIF(input, outputPath, {
      width,
      fps,
      startTime,
      duration,
      loop,
    });

    if (!result.success) {
      return createErrorResult(result.error || 'GIF creation failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      output: result.outputPath,
      size: result.size,
    }, null, 2));
  },
};

// ============================================================================
// dlab.export.thumbnail
// ============================================================================
export const exportThumbnailTool: MCPTool = {
  name: 'dlab.export.thumbnail',
  description: 'Generate a thumbnail image from a video.',
  inputSchema: z.object({
    input: z.string().describe('Path to source video'),
    timestamp: z.number().optional().describe('Timestamp in seconds (default: 0)'),
    output: z.string().optional().describe('Output path'),
  }),
  handler: async (params) => {
    const { input, timestamp = 0, output } = params;

    if (!fs.existsSync(input)) {
      return createErrorResult(`Input video not found: ${input}`);
    }

    const outputPath = output || path.join(
      EXPORTS_DIR,
      `thumbnail_${Date.now()}.png`
    );

    const result = await generateThumbnail(input, outputPath, timestamp);

    if (!result.success) {
      return createErrorResult(result.error || 'Thumbnail generation failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      output: result.outputPath,
      size: result.size,
    }, null, 2));
  },
};

// ============================================================================
// dlab.export.trim
// ============================================================================
export const exportTrimTool: MCPTool = {
  name: 'dlab.export.trim',
  description: 'Trim a video to a specific time range.',
  inputSchema: z.object({
    input: z.string().describe('Path to source video'),
    startTime: z.number().describe('Start time in seconds'),
    endTime: z.number().describe('End time in seconds'),
    output: z.string().optional().describe('Output path'),
  }),
  handler: async (params) => {
    const { input, startTime, endTime, output } = params;

    if (!fs.existsSync(input)) {
      return createErrorResult(`Input video not found: ${input}`);
    }

    if (startTime >= endTime) {
      return createErrorResult('Start time must be less than end time');
    }

    const ext = path.extname(input);
    const outputPath = output || path.join(
      EXPORTS_DIR,
      `trimmed_${Date.now()}${ext}`
    );

    const result = await trimVideo(input, outputPath, startTime, endTime);

    if (!result.success) {
      return createErrorResult(result.error || 'Trim failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      output: result.outputPath,
      size: result.size,
      duration: result.duration,
    }, null, 2));
  },
};

// ============================================================================
// dlab.export.concat
// ============================================================================
export const exportConcatTool: MCPTool = {
  name: 'dlab.export.concat',
  description: 'Concatenate multiple videos into one.',
  inputSchema: z.object({
    inputs: z.array(z.string()).describe('Array of video paths to concatenate'),
    output: z.string().optional().describe('Output path'),
  }),
  handler: async (params) => {
    const { inputs, output } = params;

    if (inputs.length === 0) {
      return createErrorResult('At least one input video is required');
    }

    // Validate all inputs exist
    for (const input of inputs) {
      if (!fs.existsSync(input)) {
        return createErrorResult(`Input video not found: ${input}`);
      }
    }

    const ext = path.extname(inputs[0]);
    const outputPath = output || path.join(
      EXPORTS_DIR,
      `concat_${Date.now()}${ext}`
    );

    const result = await concatenateVideos(inputs, outputPath);

    if (!result.success) {
      return createErrorResult(result.error || 'Concatenation failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      output: result.outputPath,
      size: result.size,
      duration: result.duration,
    }, null, 2));
  },
};

// ============================================================================
// dlab.export.image
// ============================================================================
export const exportImageTool: MCPTool = {
  name: 'dlab.export.image',
  description: 'Export an image with optional resizing and format conversion.',
  inputSchema: z.object({
    input: z.string().describe('Path to source image'),
    format: z.enum(['png', 'jpeg', 'webp']).optional().describe('Output format'),
    quality: z.number().optional().describe('Quality 1-100 for JPEG/WebP'),
    width: z.number().optional().describe('Output width'),
    height: z.number().optional().describe('Output height'),
    output: z.string().optional().describe('Output path'),
  }),
  handler: async (params) => {
    const { input, format = 'png', quality = 90, width, height, output } = params;

    if (!fs.existsSync(input)) {
      return createErrorResult(`Input image not found: ${input}`);
    }

    const outputPath = output || path.join(
      EXPORTS_DIR,
      `image_${Date.now()}.${format}`
    );

    const result = await exportImage({
      input,
      output: outputPath,
      format,
      quality,
      width,
      height,
    });

    if (!result.success) {
      return createErrorResult(result.error || 'Export failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      output: result.outputPath,
      size: result.size,
    }, null, 2));
  },
};

// ============================================================================
// dlab.export.batch
// ============================================================================
export const exportBatchTool: MCPTool = {
  name: 'dlab.export.batch',
  description: 'Export multiple images with consistent settings.',
  inputSchema: z.object({
    inputs: z.array(z.string()).describe('Array of image paths'),
    outputDir: z.string().optional().describe('Output directory (default: exports folder)'),
    format: z.enum(['png', 'jpeg', 'webp']).optional().describe('Output format'),
    quality: z.number().optional().describe('Quality 1-100'),
    width: z.number().optional().describe('Output width'),
    height: z.number().optional().describe('Output height'),
    prefix: z.string().optional().describe('Filename prefix'),
    suffix: z.string().optional().describe('Filename suffix'),
  }),
  handler: async (params) => {
    const {
      inputs,
      outputDir = EXPORTS_DIR,
      format = 'png',
      quality = 90,
      width,
      height,
      prefix = '',
      suffix = '',
    } = params;

    if (inputs.length === 0) {
      return createErrorResult('At least one input image is required');
    }

    // Validate all inputs exist
    for (const input of inputs) {
      if (!fs.existsSync(input)) {
        return createErrorResult(`Input image not found: ${input}`);
      }
    }

    const result = await exportBatch({
      inputs,
      outputDir,
      format,
      quality,
      width,
      height,
      prefix,
      suffix,
    });

    return createTextResult(JSON.stringify({
      success: result.success,
      error: result.error,
      totalFiles: result.outputs.length,
      successful: result.outputs.filter(o => o.success).length,
      failed: result.outputs.filter(o => !o.success).length,
      totalSize: result.totalSize,
      outputs: result.outputs,
    }, null, 2));
  },
};

// ============================================================================
// dlab.export.mockups
// ============================================================================
export const exportMockupsTool: MCPTool = {
  name: 'dlab.export.mockups',
  description: 'Export screenshots as device mockups in batch.',
  inputSchema: z.object({
    screenshots: z.array(z.string()).describe('Array of screenshot paths'),
    device: z.string().optional().describe('Device ID (default: iphone-15-pro)'),
    outputDir: z.string().optional().describe('Output directory'),
    format: z.enum(['png', 'jpeg']).optional().describe('Output format'),
    width: z.number().optional().describe('Output width'),
    height: z.number().optional().describe('Output height'),
    backgroundColor: z.string().optional().describe('Background color'),
  }),
  handler: async (params) => {
    const {
      screenshots,
      device = 'iphone-15-pro',
      outputDir = path.join(EXPORTS_DIR, 'mockups'),
      format = 'png',
      width = 1920,
      height = 1080,
      backgroundColor = '#f5f5f7',
    } = params;

    if (screenshots.length === 0) {
      return createErrorResult('At least one screenshot is required');
    }

    // Validate all screenshots exist
    for (const screenshot of screenshots) {
      if (!fs.existsSync(screenshot)) {
        return createErrorResult(`Screenshot not found: ${screenshot}`);
      }
    }

    const result = await exportScreenshotsAsMockups(screenshots, outputDir, device, {
      format,
      width,
      height,
      backgroundColor,
    });

    return createTextResult(JSON.stringify({
      success: result.success,
      error: result.error,
      device,
      totalFiles: result.outputs.length,
      successful: result.outputs.filter(o => o.success).length,
      failed: result.outputs.filter(o => !o.success).length,
      totalSize: result.totalSize,
      outputs: result.outputs,
    }, null, 2));
  },
};

// ============================================================================
// dlab.export.info
// ============================================================================
export const exportInfoTool: MCPTool = {
  name: 'dlab.export.info',
  description: 'Get information about a video or image file.',
  inputSchema: z.object({
    input: z.string().describe('Path to video or image file'),
  }),
  handler: async (params) => {
    const { input } = params;

    if (!fs.existsSync(input)) {
      return createErrorResult(`File not found: ${input}`);
    }

    const ext = path.extname(input).toLowerCase();
    const isVideo = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.gif'].includes(ext);

    if (isVideo) {
      const info = await getVideoInfo(input);
      if (!info) {
        return createErrorResult('Failed to get video info');
      }
      return createTextResult(JSON.stringify({
        type: 'video',
        ...info,
      }, null, 2));
    } else {
      const info = await getImageInfo(input);
      if (!info) {
        return createErrorResult('Failed to get image info');
      }
      return createTextResult(JSON.stringify({
        type: 'image',
        ...info,
      }, null, 2));
    }
  },
};

// ============================================================================
// dlab.export.clipboard
// ============================================================================
export const exportClipboardTool: MCPTool = {
  name: 'dlab.export.clipboard',
  description: 'Copy an image to the system clipboard (macOS only).',
  inputSchema: z.object({
    input: z.string().describe('Path to image file'),
  }),
  handler: async (params) => {
    const { input } = params;

    if (!fs.existsSync(input)) {
      return createErrorResult(`Image not found: ${input}`);
    }

    if (process.platform !== 'darwin') {
      return createErrorResult('Clipboard copy is only supported on macOS');
    }

    const success = await copyToClipboard(input);

    if (!success) {
      return createErrorResult('Failed to copy to clipboard');
    }

    return createTextResult(JSON.stringify({
      success: true,
      message: 'Image copied to clipboard',
      file: input,
    }, null, 2));
  },
};

// ============================================================================
// dlab.export.reveal
// ============================================================================
export const exportRevealTool: MCPTool = {
  name: 'dlab.export.reveal',
  description: 'Reveal a file in Finder (macOS only).',
  inputSchema: z.object({
    path: z.string().describe('Path to file or directory'),
  }),
  handler: async (params) => {
    const { path: filePath } = params;

    if (!fs.existsSync(filePath)) {
      return createErrorResult(`Path not found: ${filePath}`);
    }

    if (process.platform !== 'darwin') {
      return createErrorResult('Reveal in Finder is only supported on macOS');
    }

    const success = await revealInFinder(filePath);

    if (!success) {
      return createErrorResult('Failed to reveal in Finder');
    }

    return createTextResult(JSON.stringify({
      success: true,
      message: 'Revealed in Finder',
      path: filePath,
    }, null, 2));
  },
};

// ============================================================================
// dlab.export.sequence
// ============================================================================
export const exportSequenceTool: MCPTool = {
  name: 'dlab.export.sequence',
  description: 'Create a video from an image sequence.',
  inputSchema: z.object({
    inputDir: z.string().describe('Directory containing images'),
    inputPattern: z.string().describe('Filename pattern (e.g., "frame_%04d.png")'),
    format: z.enum(['mp4', 'webm', 'gif']).describe('Output format'),
    fps: z.number().describe('Frames per second'),
    quality: z.enum(['high', 'medium', 'low']).optional().describe('Quality preset'),
    width: z.number().optional().describe('Output width'),
    height: z.number().optional().describe('Output height'),
    output: z.string().optional().describe('Output path'),
  }),
  handler: async (params) => {
    const {
      inputDir,
      inputPattern,
      format,
      fps,
      quality = 'medium',
      width,
      height,
      output,
    } = params;

    if (!fs.existsSync(inputDir)) {
      return createErrorResult(`Input directory not found: ${inputDir}`);
    }

    const outputPath = output || path.join(
      EXPORTS_DIR,
      `sequence_${Date.now()}.${format}`
    );

    const result = await exportImageSequence({
      inputDir,
      inputPattern,
      output: outputPath,
      format,
      fps,
      quality,
      width,
      height,
    });

    if (!result.success) {
      return createErrorResult(result.error || 'Sequence export failed');
    }

    return createTextResult(JSON.stringify({
      success: true,
      output: result.outputPath,
      size: result.size,
      format,
      fps,
    }, null, 2));
  },
};

// ============================================================================
// EXPORTS
// ============================================================================
export const exportTools: MCPTool[] = [
  exportVideoTool,
  exportGifTool,
  exportThumbnailTool,
  exportTrimTool,
  exportConcatTool,
  exportImageTool,
  exportBatchTool,
  exportMockupsTool,
  exportInfoTool,
  exportClipboardTool,
  exportRevealTool,
  exportSequenceTool,
];
