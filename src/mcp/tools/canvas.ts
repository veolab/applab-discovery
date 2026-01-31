/**
 * DiscoveryLab Canvas Tools
 * MCP tools for device mockups and canvas rendering
 */

import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult } from '../server.js';
import { EXPORTS_DIR, getDatabase } from '../../db/index.js';
import {
  devices,
  listDevices,
  listDevicesByType,
  getDevice,
  rotationPresets,
  generateSVGMockup,
  generateHTMLMockup,
  createMockupConfig,
} from '../../core/canvas/mockup.js';
import {
  CanvasRenderer,
  renderToFile,
  renderToBuffer,
  createDeviceMockupComposition,
  createComparisonComposition,
} from '../../core/canvas/render.js';

// ============================================================================
// dlab.canvas.devices
// ============================================================================
export const canvasDevicesTool: MCPTool = {
  name: 'dlab.canvas.devices',
  description: 'List all available device models for mockups (phones, tablets, browsers).',
  inputSchema: z.object({
    type: z.enum(['phone', 'tablet', 'browser', 'all']).optional().describe('Filter by device type'),
  }),
  handler: async (params) => {
    const deviceType = params.type;

    let deviceList;
    if (deviceType && deviceType !== 'all') {
      deviceList = listDevicesByType(deviceType);
    } else {
      deviceList = listDevices();
    }

    const result = deviceList.map(d => ({
      id: d.id,
      name: d.name,
      type: d.type,
      dimensions: {
        width: d.dimensions.width,
        height: d.dimensions.height,
        screenWidth: d.dimensions.screenWidth,
        screenHeight: d.dimensions.screenHeight,
      },
    }));

    return createTextResult(JSON.stringify(result, null, 2));
  },
};

// ============================================================================
// dlab.canvas.presets
// ============================================================================
export const canvasPresetsTool: MCPTool = {
  name: 'dlab.canvas.presets',
  description: 'List available rotation presets for device mockups.',
  inputSchema: z.object({}),
  handler: async () => {
    const presets = Object.entries(rotationPresets).map(([name, rotation]) => ({
      name,
      rotation,
      description: getPresetDescription(name),
    }));

    return createTextResult(JSON.stringify(presets, null, 2));
  },
};

function getPresetDescription(name: string): string {
  const descriptions: Record<string, string> = {
    flat: 'Device flat, facing camera directly',
    tiltLeft: 'Slight tilt to the left',
    tiltRight: 'Slight tilt to the right',
    hero: 'Dramatic hero shot, tilted left with slight rotation',
    heroRight: 'Dramatic hero shot, tilted right',
    dramatic: 'Maximum dramatic angle',
    topDown: 'Looking down from above',
    isometric: 'Isometric view (3D-like)',
  };
  return descriptions[name] || 'Custom rotation';
}

// ============================================================================
// dlab.canvas.create
// ============================================================================
export const canvasCreateTool: MCPTool = {
  name: 'dlab.canvas.create',
  description: 'Create a device mockup from a screenshot. Returns the path to the generated image.',
  inputSchema: z.object({
    screenshot: z.string().describe('Path to the screenshot image'),
    device: z.string().optional().describe('Device ID (default: iphone-15-pro)'),
    rotation: z.enum(['flat', 'tiltLeft', 'tiltRight', 'hero', 'heroRight', 'dramatic', 'topDown', 'isometric']).optional().describe('Rotation preset'),
    width: z.number().optional().describe('Output width (default: 1920)'),
    height: z.number().optional().describe('Output height (default: 1080)'),
    backgroundColor: z.string().optional().describe('Background color (default: #f5f5f7)'),
    title: z.string().optional().describe('Title text to display'),
    subtitle: z.string().optional().describe('Subtitle text to display'),
    output: z.string().optional().describe('Output path (auto-generated if not specified)'),
    format: z.enum(['png', 'jpeg']).optional().describe('Output format (default: png)'),
  }),
  handler: async (params) => {
    const {
      screenshot,
      device = 'iphone-15-pro',
      rotation = 'flat',
      width = 1920,
      height = 1080,
      backgroundColor = '#f5f5f7',
      title,
      subtitle,
      output,
      format = 'png',
    } = params;

    // Validate screenshot exists
    if (!fs.existsSync(screenshot)) {
      return createErrorResult(`Screenshot not found: ${screenshot}`);
    }

    // Validate device
    const deviceModel = getDevice(device);
    if (!deviceModel) {
      const availableDevices = listDevices().map(d => d.id).join(', ');
      return createErrorResult(`Device not found: ${device}. Available: ${availableDevices}`);
    }

    // Determine output path
    const outputPath = output || path.join(
      EXPORTS_DIR,
      `mockup_${device}_${Date.now()}.${format}`
    );

    // Ensure output directory exists
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

    try {
      // Get rotation values
      const rotationValues = rotationPresets[rotation] || rotationPresets.flat;

      // Calculate device scale based on output dimensions
      const deviceAspect = deviceModel.dimensions.width / deviceModel.dimensions.height;
      const outputAspect = width / height;
      let scale = 1;
      if (deviceAspect > outputAspect) {
        scale = (width * 0.6) / (deviceModel.dimensions.width * 4);
      } else {
        scale = (height * 0.7) / (deviceModel.dimensions.height * 4);
      }

      // Create composition
      const composition = createDeviceMockupComposition(device, screenshot, {
        width,
        height,
        backgroundColor,
        scale,
        title,
        subtitle,
      });

      // Render to file
      const result = await renderToFile(composition, outputPath, {
        format,
        quality: format === 'jpeg' ? 90 : undefined,
      });

      if (!result.success) {
        return createErrorResult(result.error || 'Failed to render mockup');
      }

      const stats = await fs.promises.stat(outputPath);

      return createTextResult(JSON.stringify({
        success: true,
        output: outputPath,
        size: stats.size,
        dimensions: { width, height },
        device: deviceModel.name,
      }, null, 2));
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

// ============================================================================
// dlab.canvas.compare
// ============================================================================
export const canvasCompareTool: MCPTool = {
  name: 'dlab.canvas.compare',
  description: 'Create a comparison mockup showing multiple devices side by side.',
  inputSchema: z.object({
    screenshots: z.array(z.object({
      path: z.string().describe('Path to screenshot'),
      device: z.string().describe('Device ID'),
      label: z.string().optional().describe('Label for this device'),
    })).describe('Array of screenshots with device info'),
    width: z.number().optional().describe('Output width (default: 1920)'),
    height: z.number().optional().describe('Output height (default: 1080)'),
    backgroundColor: z.string().optional().describe('Background color (default: #f5f5f7)'),
    title: z.string().optional().describe('Title text'),
    output: z.string().optional().describe('Output path'),
    format: z.enum(['png', 'jpeg']).optional().describe('Output format (default: png)'),
  }),
  handler: async (params) => {
    const {
      screenshots,
      width = 1920,
      height = 1080,
      backgroundColor = '#f5f5f7',
      title,
      output,
      format = 'png',
    } = params;

    if (screenshots.length === 0) {
      return createErrorResult('At least one screenshot is required');
    }

    // Validate all screenshots exist
    for (const s of screenshots) {
      if (!fs.existsSync(s.path)) {
        return createErrorResult(`Screenshot not found: ${s.path}`);
      }
      if (!getDevice(s.device)) {
        return createErrorResult(`Device not found: ${s.device}`);
      }
    }

    // Determine output path
    const outputPath = output || path.join(
      EXPORTS_DIR,
      `comparison_${Date.now()}.${format}`
    );

    // Ensure output directory exists
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

    try {
      const devices = screenshots.map(s => ({
        deviceId: s.device,
        screenshotPath: s.path,
        label: s.label,
      }));

      const composition = createComparisonComposition(devices, {
        width,
        height,
        backgroundColor,
        title,
      });

      const result = await renderToFile(composition, outputPath, {
        format,
        quality: format === 'jpeg' ? 90 : undefined,
      });

      if (!result.success) {
        return createErrorResult(result.error || 'Failed to render comparison');
      }

      const stats = await fs.promises.stat(outputPath);

      return createTextResult(JSON.stringify({
        success: true,
        output: outputPath,
        size: stats.size,
        dimensions: { width, height },
        deviceCount: screenshots.length,
      }, null, 2));
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

// ============================================================================
// dlab.canvas.svg
// ============================================================================
export const canvasSvgTool: MCPTool = {
  name: 'dlab.canvas.svg',
  description: 'Generate an SVG mockup (lightweight, for web embedding).',
  inputSchema: z.object({
    device: z.string().optional().describe('Device ID (default: iphone-15-pro)'),
    width: z.number().optional().describe('Output width (default: 1920)'),
    height: z.number().optional().describe('Output height (default: 1080)'),
    backgroundColor: z.string().optional().describe('Background color (default: #ffffff)'),
    shadow: z.boolean().optional().describe('Include shadow (default: true)'),
    output: z.string().optional().describe('Output path'),
  }),
  handler: async (params) => {
    const {
      device = 'iphone-15-pro',
      width = 1920,
      height = 1080,
      backgroundColor = '#ffffff',
      shadow = true,
      output,
    } = params;

    const deviceModel = getDevice(device);
    if (!deviceModel) {
      return createErrorResult(`Device not found: ${device}`);
    }

    const config = createMockupConfig({
      device,
      screenshot: '', // SVG doesn't need actual screenshot
      outputWidth: width,
      outputHeight: height,
      backgroundColor,
      shadow,
    });

    if (!config) {
      return createErrorResult('Failed to create mockup configuration');
    }

    const svg = generateSVGMockup(config);

    // Save to file if output specified
    if (output) {
      await fs.promises.mkdir(path.dirname(output), { recursive: true });
      await fs.promises.writeFile(output, svg);
      return createTextResult(JSON.stringify({
        success: true,
        output,
        size: Buffer.byteLength(svg, 'utf8'),
      }, null, 2));
    }

    // Return SVG content
    return createTextResult(svg);
  },
};

// ============================================================================
// dlab.canvas.html
// ============================================================================
export const canvasHtmlTool: MCPTool = {
  name: 'dlab.canvas.html',
  description: 'Generate an HTML mockup with CSS 3D transforms (for interactive preview).',
  inputSchema: z.object({
    screenshot: z.string().optional().describe('Path to screenshot image'),
    device: z.string().optional().describe('Device ID (default: iphone-15-pro)'),
    rotation: z.enum(['flat', 'tiltLeft', 'tiltRight', 'hero', 'heroRight', 'dramatic', 'topDown', 'isometric']).optional().describe('Rotation preset'),
    width: z.number().optional().describe('Output width (default: 1920)'),
    height: z.number().optional().describe('Output height (default: 1080)'),
    backgroundColor: z.string().optional().describe('Background color'),
    output: z.string().optional().describe('Output path'),
  }),
  handler: async (params) => {
    const {
      screenshot,
      device = 'iphone-15-pro',
      rotation = 'flat',
      width = 1920,
      height = 1080,
      backgroundColor = '#f5f5f7',
      output,
    } = params;

    const deviceModel = getDevice(device);
    if (!deviceModel) {
      return createErrorResult(`Device not found: ${device}`);
    }

    const rotationValues = rotationPresets[rotation] || rotationPresets.flat;

    // Read screenshot as data URL if provided
    let screenshotDataUrl: string | undefined;
    if (screenshot && fs.existsSync(screenshot)) {
      const buffer = await fs.promises.readFile(screenshot);
      const ext = path.extname(screenshot).toLowerCase();
      const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      screenshotDataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    }

    const config = createMockupConfig({
      device,
      screenshot: screenshot || '',
      rotation: rotationValues,
      outputWidth: width,
      outputHeight: height,
      backgroundColor,
    });

    if (!config) {
      return createErrorResult('Failed to create mockup configuration');
    }

    const html = generateHTMLMockup(config, screenshotDataUrl);

    // Save to file if output specified
    if (output) {
      await fs.promises.mkdir(path.dirname(output), { recursive: true });
      await fs.promises.writeFile(output, html);
      return createTextResult(JSON.stringify({
        success: true,
        output,
        size: Buffer.byteLength(html, 'utf8'),
      }, null, 2));
    }

    // Return HTML content
    return createTextResult(html);
  },
};

// ============================================================================
// EXPORTS
// ============================================================================
export const canvasTools: MCPTool[] = [
  canvasDevicesTool,
  canvasPresetsTool,
  canvasCreateTool,
  canvasCompareTool,
  canvasSvgTool,
  canvasHtmlTool,
];
