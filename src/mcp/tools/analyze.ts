/**
 * DiscoveryLab Analyze Tools
 * MCP tools for video analysis, OCR, and frame extraction
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult, createJsonResult } from '../server.js';
import { getDatabase, projects, frames } from '../../db/index.js';
import {
  extractFrames,
  extractKeyFramesOnly,
  getVideoInfo,
  detectKeyFrames,
  generateThumbnail,
} from '../../core/analyze/frames.js';
import {
  recognizeText,
  recognizeTextBatch,
  analyzeText,
  getAvailableOCREngines,
} from '../../core/analyze/ocr.js';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

// ============================================================================
// dlab.analyze.video
// ============================================================================
export const analyzeVideoTool: MCPTool = {
  name: 'dlab.analyze.video',
  description: 'Analyze a video file: extract frames, perform OCR, and store results.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID'),
    videoPath: z.string().describe('Path to the video file'),
    keyFramesOnly: z.boolean().optional().describe('Only extract key frames (scene changes)'),
    fps: z.number().optional().describe('Frames per second to extract (default: 1)'),
    maxFrames: z.number().optional().describe('Maximum number of frames to extract'),
    performOCR: z.boolean().optional().describe('Perform OCR on extracted frames (default: true)'),
  }),
  handler: async (params) => {
    const { projectId, videoPath, keyFramesOnly, fps, maxFrames, performOCR = true } = params;

    if (!existsSync(videoPath)) {
      return createErrorResult(`Video file not found: ${videoPath}`);
    }

    // Get video info
    const videoInfo = getVideoInfo(videoPath);
    if (!videoInfo) {
      return createErrorResult('Failed to read video information');
    }

    // Extract frames
    let extractionResult;
    if (keyFramesOnly) {
      extractionResult = await extractKeyFramesOnly(projectId, videoPath);
    } else {
      extractionResult = await extractFrames({
        projectId,
        videoPath,
        fps: fps || 1,
        maxFrames,
      });
    }

    if (!extractionResult.success) {
      return createErrorResult(extractionResult.error || 'Frame extraction failed');
    }

    const db = getDatabase();

    // Update project with video path and duration
    await db
      .update(projects)
      .set({
        videoPath,
        duration: videoInfo.duration,
        frameCount: extractionResult.frameCount,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    // Perform OCR and store frames
    let ocrText = '';
    const frameRecords = [];

    if (extractionResult.frames) {
      for (const frame of extractionResult.frames) {
        let frameOCR = '';

        if (performOCR) {
          const ocrResult = await recognizeText(frame.path);
          if (ocrResult.success && ocrResult.text) {
            frameOCR = ocrResult.text;
            ocrText += `[Frame ${frame.frameNumber} @ ${frame.timestamp.toFixed(1)}s]\n${ocrResult.text}\n\n`;
          }
        }

        const frameId = randomUUID();
        frameRecords.push({
          id: frameId,
          projectId,
          frameNumber: frame.frameNumber,
          timestamp: frame.timestamp,
          imagePath: frame.path,
          ocrText: frameOCR || null,
          isKeyFrame: keyFramesOnly || false,
          createdAt: new Date(),
        });
      }

      // Insert frames into database
      if (frameRecords.length > 0) {
        await db.insert(frames).values(frameRecords);
      }

      // Update project OCR text
      if (ocrText) {
        await db
          .update(projects)
          .set({
            ocrText,
            status: 'analyzed',
            updatedAt: new Date(),
          })
          .where(eq(projects.id, projectId));
      }
    }

    return createJsonResult({
      message: 'Video analysis complete',
      videoInfo: {
        duration: `${videoInfo.duration.toFixed(1)} seconds`,
        resolution: `${videoInfo.width}x${videoInfo.height}`,
        fps: videoInfo.fps,
        codec: videoInfo.codec,
      },
      extraction: {
        framesExtracted: extractionResult.frameCount,
        framesDir: extractionResult.framesDir,
        keyFramesOnly,
      },
      ocr: performOCR
        ? {
            performed: true,
            totalCharacters: ocrText.length,
            preview: ocrText.slice(0, 500) + (ocrText.length > 500 ? '...' : ''),
          }
        : { performed: false },
    });
  },
};

// ============================================================================
// dlab.analyze.screenshot
// ============================================================================
export const analyzeScreenshotTool: MCPTool = {
  name: 'dlab.analyze.screenshot',
  description: 'Analyze a screenshot: perform OCR and text analysis.',
  inputSchema: z.object({
    imagePath: z.string().describe('Path to the image file'),
    languages: z.array(z.string()).optional().describe('Languages for OCR (e.g., ["en", "pt"])'),
  }),
  handler: async (params) => {
    const { imagePath, languages } = params;

    if (!existsSync(imagePath)) {
      return createErrorResult(`Image file not found: ${imagePath}`);
    }

    const ocrResult = await recognizeText(imagePath, { languages });

    if (!ocrResult.success) {
      return createErrorResult(ocrResult.error || 'OCR failed');
    }

    const textAnalysis = analyzeText(ocrResult.text || '');

    return createJsonResult({
      ocr: {
        engine: ocrResult.engine,
        text: ocrResult.text,
        confidence: ocrResult.confidence,
        blocks: ocrResult.blocks?.length || 0,
      },
      analysis: textAnalysis,
    });
  },
};

// ============================================================================
// dlab.analyze.frames
// ============================================================================
export const extractFramesTool: MCPTool = {
  name: 'dlab.analyze.frames',
  description: 'Extract frames from a video file without full analysis.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID'),
    videoPath: z.string().describe('Path to the video file'),
    fps: z.number().optional().describe('Frames per second (default: 1)'),
    maxFrames: z.number().optional().describe('Maximum frames to extract'),
    keyFramesOnly: z.boolean().optional().describe('Only extract scene changes'),
    startTime: z.number().optional().describe('Start time in seconds'),
    endTime: z.number().optional().describe('End time in seconds'),
  }),
  handler: async (params) => {
    if (!existsSync(params.videoPath)) {
      return createErrorResult(`Video file not found: ${params.videoPath}`);
    }

    let result;
    if (params.keyFramesOnly) {
      result = await extractKeyFramesOnly(params.projectId, params.videoPath);
    } else {
      result = await extractFrames({
        projectId: params.projectId,
        videoPath: params.videoPath,
        fps: params.fps,
        maxFrames: params.maxFrames,
        startTime: params.startTime,
        endTime: params.endTime,
      });
    }

    if (!result.success) {
      return createErrorResult(result.error || 'Frame extraction failed');
    }

    return createJsonResult({
      message: 'Frames extracted',
      count: result.frameCount,
      directory: result.framesDir,
      frames: result.frames?.slice(0, 10).map((f) => ({
        filename: f.filename,
        timestamp: `${f.timestamp.toFixed(1)}s`,
      })),
      note: result.frames && result.frames.length > 10 ? `... and ${result.frames.length - 10} more` : undefined,
    });
  },
};

// ============================================================================
// dlab.analyze.ocr.batch
// ============================================================================
export const ocrBatchTool: MCPTool = {
  name: 'dlab.analyze.ocr.batch',
  description: 'Perform OCR on multiple images.',
  inputSchema: z.object({
    imagePaths: z.array(z.string()).describe('Array of image file paths'),
    languages: z.array(z.string()).optional().describe('Languages for OCR'),
  }),
  handler: async (params) => {
    const validPaths = params.imagePaths.filter(existsSync);

    if (validPaths.length === 0) {
      return createErrorResult('No valid image files found');
    }

    const result = await recognizeTextBatch(validPaths, { languages: params.languages });

    const successCount = result.results.filter((r) => r.ocr.success).length;

    return createJsonResult({
      processed: validPaths.length,
      successful: successCount,
      failed: validPaths.length - successCount,
      combinedText: result.totalText.slice(0, 2000) + (result.totalText.length > 2000 ? '...' : ''),
      results: result.results.map((r) => ({
        file: basename(r.imagePath),
        success: r.ocr.success,
        engine: r.ocr.engine,
        textLength: r.ocr.text?.length || 0,
        error: r.ocr.error,
      })),
    });
  },
};

// ============================================================================
// dlab.analyze.video.info
// ============================================================================
export const videoInfoTool: MCPTool = {
  name: 'dlab.analyze.video.info',
  description: 'Get information about a video file without processing it.',
  inputSchema: z.object({
    videoPath: z.string().describe('Path to the video file'),
  }),
  handler: async (params) => {
    if (!existsSync(params.videoPath)) {
      return createErrorResult(`Video file not found: ${params.videoPath}`);
    }

    const info = getVideoInfo(params.videoPath);

    if (!info) {
      return createErrorResult('Failed to read video information');
    }

    return createJsonResult({
      file: basename(params.videoPath),
      duration: `${info.duration.toFixed(1)} seconds`,
      resolution: `${info.width}x${info.height}`,
      fps: info.fps.toFixed(2),
      codec: info.codec,
      estimatedFrames: info.frameCount,
    });
  },
};

// ============================================================================
// dlab.analyze.keyframes
// ============================================================================
export const detectKeyFramesTool: MCPTool = {
  name: 'dlab.analyze.keyframes',
  description: 'Detect key frames (scene changes) in a video without extracting them.',
  inputSchema: z.object({
    videoPath: z.string().describe('Path to the video file'),
    threshold: z.number().optional().describe('Scene change threshold 0-1 (default: 0.3)'),
  }),
  handler: async (params) => {
    if (!existsSync(params.videoPath)) {
      return createErrorResult(`Video file not found: ${params.videoPath}`);
    }

    const keyFrames = await detectKeyFrames(params.videoPath, params.threshold || 0.3);

    if (keyFrames.length === 0) {
      return createTextResult('No significant scene changes detected');
    }

    return createJsonResult({
      keyFrameCount: keyFrames.length,
      threshold: params.threshold || 0.3,
      keyFrames: keyFrames.slice(0, 20).map((kf) => ({
        frameNumber: kf.frameNumber,
        timestamp: `${kf.timestamp.toFixed(1)}s`,
        score: kf.score.toFixed(3),
      })),
      note: keyFrames.length > 20 ? `Showing first 20 of ${keyFrames.length} key frames` : undefined,
    });
  },
};

// ============================================================================
// dlab.analyze.thumbnail
// ============================================================================
export const generateThumbnailTool: MCPTool = {
  name: 'dlab.analyze.thumbnail',
  description: 'Generate a thumbnail image from a video.',
  inputSchema: z.object({
    videoPath: z.string().describe('Path to the video file'),
    outputPath: z.string().describe('Path for the output thumbnail'),
    timestamp: z.number().optional().describe('Time in seconds (default: 0)'),
    width: z.number().optional().describe('Thumbnail width in pixels (default: 320)'),
  }),
  handler: async (params) => {
    if (!existsSync(params.videoPath)) {
      return createErrorResult(`Video file not found: ${params.videoPath}`);
    }

    const success = await generateThumbnail(
      params.videoPath,
      params.outputPath,
      params.timestamp || 0,
      params.width || 320
    );

    if (success) {
      return createJsonResult({
        message: 'Thumbnail generated',
        outputPath: params.outputPath,
      });
    } else {
      return createErrorResult('Failed to generate thumbnail');
    }
  },
};

// ============================================================================
// dlab.analyze.ocr.engines
// ============================================================================
export const listOCREnginesTool: MCPTool = {
  name: 'dlab.analyze.ocr.engines',
  description: 'List available OCR engines on this system.',
  inputSchema: z.object({}),
  handler: async () => {
    const engines = getAvailableOCREngines();

    if (engines.length === 0) {
      return createTextResult('No OCR engines available. Install Tesseract or use macOS for Vision.');
    }

    return createJsonResult({
      available: engines,
      recommended: engines.includes('vision') ? 'vision' : 'tesseract',
      note: engines.includes('vision')
        ? 'Apple Vision provides best accuracy on macOS'
        : 'Consider using macOS for better OCR via Apple Vision',
    });
  },
};

// ============================================================================
// EXPORTS
// ============================================================================
export const analyzeTools: MCPTool[] = [
  analyzeVideoTool,
  analyzeScreenshotTool,
  extractFramesTool,
  ocrBatchTool,
  videoInfoTool,
  detectKeyFramesTool,
  generateThumbnailTool,
  listOCREnginesTool,
];
