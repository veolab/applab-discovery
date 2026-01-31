/**
 * DiscoveryLab Capture Tools
 * MCP tools for screen capture and emulator recording
 */

import { z } from 'zod';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult, createJsonResult } from '../server.js';
import {
  captureScreenshot,
  startRecording,
  stopRecording,
  getActiveRecordings,
  checkFFmpeg,
  listDisplays,
  listWindows,
} from '../../core/capture/screen.js';
import {
  listAllEmulators,
  getBootedEmulator,
  captureEmulatorScreenshot,
  startEmulatorRecording,
  stopEmulatorRecording,
  checkADB,
  checkSimctl,
} from '../../core/capture/emulator.js';

// ============================================================================
// dlab.capture.screen
// ============================================================================
export const captureScreenTool: MCPTool = {
  name: 'dlab.capture.screen',
  description: 'Capture a screenshot of the screen, a specific display, or a window.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID to save the screenshot to'),
    displayId: z.number().optional().describe('Specific display ID (use dlab.capture.displays to list)'),
    windowId: z.number().optional().describe('Specific window ID (use dlab.capture.windows to list)'),
    region: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional()
      .describe('Capture specific region'),
  }),
  handler: async (params) => {
    const result = await captureScreenshot({
      projectId: params.projectId,
      type: 'screenshot',
      displayId: params.displayId,
      windowId: params.windowId,
      region: params.region,
    });

    if (result.success) {
      return createJsonResult({
        message: 'Screenshot captured successfully',
        filePath: result.filePath,
      });
    } else {
      return createErrorResult(result.error || 'Screenshot capture failed');
    }
  },
};

// ============================================================================
// dlab.capture.record.start
// ============================================================================
export const startRecordingTool: MCPTool = {
  name: 'dlab.capture.record.start',
  description: 'Start recording the screen. Returns a session ID to stop the recording later.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID to save the recording to'),
    duration: z.number().optional().describe('Auto-stop after this many seconds'),
    displayId: z.number().optional().describe('Specific display ID'),
  }),
  handler: async (params) => {
    if (!checkFFmpeg()) {
      return createErrorResult('FFmpeg is required for screen recording. Install it with: brew install ffmpeg');
    }

    const result = await startRecording({
      projectId: params.projectId,
      type: 'video',
      duration: params.duration,
      displayId: params.displayId,
    });

    if ('sessionId' in result) {
      return createJsonResult({
        message: 'Recording started',
        sessionId: result.sessionId,
        note: params.duration
          ? `Will auto-stop after ${params.duration} seconds`
          : 'Use dlab.capture.record.stop to stop the recording',
      });
    } else {
      return createErrorResult(result.error);
    }
  },
};

// ============================================================================
// dlab.capture.record.stop
// ============================================================================
export const stopRecordingTool: MCPTool = {
  name: 'dlab.capture.record.stop',
  description: 'Stop an active screen recording.',
  inputSchema: z.object({
    sessionId: z.string().describe('Recording session ID from dlab.capture.record.start'),
  }),
  handler: async (params) => {
    const result = await stopRecording(params.sessionId);

    if (result.success) {
      return createJsonResult({
        message: 'Recording stopped',
        filePath: result.filePath,
        duration: result.duration ? `${result.duration.toFixed(1)} seconds` : undefined,
      });
    } else {
      return createErrorResult(result.error || 'Failed to stop recording');
    }
  },
};

// ============================================================================
// dlab.capture.record.list
// ============================================================================
export const listRecordingsTool: MCPTool = {
  name: 'dlab.capture.record.list',
  description: 'List active screen recording sessions.',
  inputSchema: z.object({}),
  handler: async () => {
    const sessions = getActiveRecordings();

    if (sessions.length === 0) {
      return createTextResult('No active recording sessions');
    }

    return createJsonResult({
      activeRecordings: sessions,
      count: sessions.length,
    });
  },
};

// ============================================================================
// dlab.capture.displays
// ============================================================================
export const listDisplaysTool: MCPTool = {
  name: 'dlab.capture.displays',
  description: 'List available displays/screens for capture.',
  inputSchema: z.object({}),
  handler: async () => {
    const displays = listDisplays();

    return createJsonResult({
      displays,
      count: displays.length,
    });
  },
};

// ============================================================================
// dlab.capture.windows
// ============================================================================
export const listWindowsTool: MCPTool = {
  name: 'dlab.capture.windows',
  description: 'List available windows for capture (macOS only).',
  inputSchema: z.object({}),
  handler: async () => {
    const windows = listWindows();

    if (windows.length === 0) {
      return createTextResult('No windows found or not supported on this platform');
    }

    return createJsonResult({
      windows,
      count: windows.length,
    });
  },
};

// ============================================================================
// dlab.capture.emulator
// ============================================================================
export const captureEmulatorTool: MCPTool = {
  name: 'dlab.capture.emulator',
  description: 'Capture a screenshot from an iOS Simulator or Android Emulator.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID to save the screenshot to'),
    deviceId: z.string().optional().describe('Device ID (auto-detects booted device if not specified)'),
  }),
  handler: async (params) => {
    let deviceId = params.deviceId;

    if (!deviceId) {
      const bootedDevice = getBootedEmulator();
      if (!bootedDevice) {
        return createErrorResult('No booted emulator found. Start an emulator or specify deviceId.');
      }
      deviceId = bootedDevice.id;
    }

    const result = await captureEmulatorScreenshot({
      projectId: params.projectId,
      deviceId,
      type: 'screenshot',
    });

    if (result.success) {
      return createJsonResult({
        message: 'Emulator screenshot captured',
        filePath: result.filePath,
        device: result.device,
      });
    } else {
      return createErrorResult(result.error || 'Emulator capture failed');
    }
  },
};

// ============================================================================
// dlab.capture.emulator.record.start
// ============================================================================
export const startEmulatorRecordingTool: MCPTool = {
  name: 'dlab.capture.emulator.record.start',
  description: 'Start recording from an iOS Simulator or Android Emulator.',
  inputSchema: z.object({
    projectId: z.string().describe('Project ID to save the recording to'),
    deviceId: z.string().optional().describe('Device ID (auto-detects booted device if not specified)'),
    duration: z.number().optional().describe('Auto-stop after this many seconds (Android max: 180)'),
  }),
  handler: async (params) => {
    let deviceId = params.deviceId;

    if (!deviceId) {
      const bootedDevice = getBootedEmulator();
      if (!bootedDevice) {
        return createErrorResult('No booted emulator found. Start an emulator or specify deviceId.');
      }
      deviceId = bootedDevice.id;
    }

    const result = await startEmulatorRecording({
      projectId: params.projectId,
      deviceId,
      type: 'video',
      duration: params.duration,
    });

    if ('sessionId' in result) {
      return createJsonResult({
        message: 'Emulator recording started',
        sessionId: result.sessionId,
        outputPath: result.outputPath,
        platform: result.platform,
      });
    } else {
      return createErrorResult(result.error);
    }
  },
};

// ============================================================================
// dlab.capture.emulator.record.stop
// ============================================================================
export const stopEmulatorRecordingTool: MCPTool = {
  name: 'dlab.capture.emulator.record.stop',
  description: 'Stop an active emulator recording.',
  inputSchema: z.object({
    sessionId: z.string().describe('Recording session ID'),
    platform: z.enum(['ios', 'android']).optional().describe('Platform hint'),
  }),
  handler: async (params) => {
    const result = await stopEmulatorRecording(params.sessionId, params.platform);

    if (result.success) {
      return createJsonResult({
        message: 'Emulator recording stopped',
        filePath: result.filePath,
      });
    } else {
      return createErrorResult(result.error || 'Failed to stop recording');
    }
  },
};

// ============================================================================
// dlab.capture.emulators
// ============================================================================
export const listEmulatorsTool: MCPTool = {
  name: 'dlab.capture.emulators',
  description: 'List available iOS Simulators and Android Emulators.',
  inputSchema: z.object({}),
  handler: async () => {
    const emulators = listAllEmulators();

    if (emulators.length === 0) {
      const hasSimctl = checkSimctl();
      const hasAdb = checkADB();

      let hint = 'No emulators found. ';
      if (!hasSimctl && !hasAdb) {
        hint += 'Neither Xcode nor ADB is available.';
      } else if (!hasSimctl) {
        hint += 'Xcode/simctl not available. ';
      } else if (!hasAdb) {
        hint += 'ADB not available. ';
      }

      return createTextResult(hint);
    }

    const booted = emulators.filter((e) => e.state === 'booted');
    const shutdown = emulators.filter((e) => e.state === 'shutdown');

    return createJsonResult({
      booted,
      shutdown,
      total: emulators.length,
    });
  },
};

// ============================================================================
// EXPORTS
// ============================================================================
export const captureTools: MCPTool[] = [
  captureScreenTool,
  startRecordingTool,
  stopRecordingTool,
  listRecordingsTool,
  listDisplaysTool,
  listWindowsTool,
  captureEmulatorTool,
  startEmulatorRecordingTool,
  stopEmulatorRecordingTool,
  listEmulatorsTool,
];
