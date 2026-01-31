/**
 * DiscoveryLab Canvas Render Module
 * Text overlays, frame composition, and image rendering
 */

import { createCanvas, loadImage, registerFont, Canvas, CanvasRenderingContext2D } from 'canvas';
import * as fs from 'fs';
import * as path from 'path';
import { DeviceModel, MockupConfig, getDevice, generateCSS3DTransform } from './mockup.js';

// ============================================================================
// TYPES
// ============================================================================
export interface TextOverlay {
  text: string;
  x: number;
  y: number;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: 'normal' | 'bold';
  color?: string;
  align?: 'left' | 'center' | 'right';
  baseline?: 'top' | 'middle' | 'bottom';
  maxWidth?: number;
  lineHeight?: number;
  shadow?: {
    color: string;
    blur: number;
    offsetX: number;
    offsetY: number;
  };
  background?: {
    color: string;
    padding: number;
    borderRadius: number;
  };
}

export interface ImageOverlay {
  src: string; // Path to image
  x: number;
  y: number;
  width?: number;
  height?: number;
  opacity?: number;
  borderRadius?: number;
}

export interface FrameComposition {
  width: number;
  height: number;
  backgroundColor?: string;
  backgroundGradient?: {
    type: 'linear' | 'radial';
    colors: string[];
    stops?: number[];
    angle?: number; // For linear gradient
  };
  layers: CompositionLayer[];
}

export interface CompositionLayer {
  type: 'image' | 'text' | 'shape' | 'device';
  zIndex: number;
  opacity?: number;
  transform?: {
    rotate?: number;
    scaleX?: number;
    scaleY?: number;
    translateX?: number;
    translateY?: number;
  };
  // Type-specific properties
  image?: ImageOverlay;
  text?: TextOverlay;
  shape?: ShapeLayer;
  device?: DeviceLayer;
}

export interface ShapeLayer {
  type: 'rectangle' | 'circle' | 'rounded-rect';
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  borderRadius?: number;
  shadow?: {
    color: string;
    blur: number;
    offsetX: number;
    offsetY: number;
  };
}

export interface DeviceLayer {
  deviceId: string;
  screenshotPath: string;
  x: number;
  y: number;
  scale?: number;
  rotation?: { x: number; y: number; z: number };
  shadow?: boolean;
}

export interface RenderOptions {
  quality?: number; // 0-100 for JPEG
  format?: 'png' | 'jpeg';
  antialiasing?: boolean;
}

export interface RenderResult {
  success: boolean;
  error?: string;
  buffer?: Buffer;
  dataUrl?: string;
  width?: number;
  height?: number;
}

// ============================================================================
// CANVAS RENDERER CLASS
// ============================================================================
export class CanvasRenderer {
  private canvas: Canvas;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  // --------------------------------------------------------------------------
  // BACKGROUND
  // --------------------------------------------------------------------------
  fillBackground(color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  fillBackgroundGradient(
    type: 'linear' | 'radial',
    colors: string[],
    stops?: number[],
    angle: number = 0
  ): void {
    let gradient;

    if (type === 'linear') {
      const radians = (angle * Math.PI) / 180;
      const x1 = this.width / 2 - Math.cos(radians) * this.width / 2;
      const y1 = this.height / 2 - Math.sin(radians) * this.height / 2;
      const x2 = this.width / 2 + Math.cos(radians) * this.width / 2;
      const y2 = this.height / 2 + Math.sin(radians) * this.height / 2;
      gradient = this.ctx.createLinearGradient(x1, y1, x2, y2);
    } else {
      gradient = this.ctx.createRadialGradient(
        this.width / 2, this.height / 2, 0,
        this.width / 2, this.height / 2, Math.max(this.width, this.height) / 2
      );
    }

    const colorStops = stops || colors.map((_, i) => i / (colors.length - 1));
    colors.forEach((color, i) => {
      gradient.addColorStop(colorStops[i], color);
    });

    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  // --------------------------------------------------------------------------
  // TEXT RENDERING
  // --------------------------------------------------------------------------
  drawText(overlay: TextOverlay): void {
    const {
      text,
      x,
      y,
      fontSize = 16,
      fontFamily = 'system-ui, -apple-system, sans-serif',
      fontWeight = 'normal',
      color = '#000000',
      align = 'left',
      baseline = 'top',
      maxWidth,
      lineHeight = 1.4,
      shadow,
      background,
    } = overlay;

    this.ctx.save();

    // Font setup
    this.ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    this.ctx.fillStyle = color;
    this.ctx.textAlign = align;
    this.ctx.textBaseline = baseline;

    // Handle multiline text
    const lines = this.wrapText(text, maxWidth || this.width - x * 2, fontSize);
    const totalHeight = lines.length * fontSize * lineHeight;

    // Background
    if (background) {
      const maxLineWidth = Math.max(...lines.map(line => this.ctx.measureText(line).width));
      const bgX = align === 'center' ? x - maxLineWidth / 2 - background.padding :
                  align === 'right' ? x - maxLineWidth - background.padding : x - background.padding;
      const bgY = y - background.padding;
      const bgWidth = maxLineWidth + background.padding * 2;
      const bgHeight = totalHeight + background.padding * 2;

      this.ctx.fillStyle = background.color;
      this.roundRect(bgX, bgY, bgWidth, bgHeight, background.borderRadius);
      this.ctx.fill();
      this.ctx.fillStyle = color;
    }

    // Shadow
    if (shadow) {
      this.ctx.shadowColor = shadow.color;
      this.ctx.shadowBlur = shadow.blur;
      this.ctx.shadowOffsetX = shadow.offsetX;
      this.ctx.shadowOffsetY = shadow.offsetY;
    }

    // Draw text lines
    lines.forEach((line, i) => {
      this.ctx.fillText(line, x, y + i * fontSize * lineHeight);
    });

    this.ctx.restore();
  }

  private wrapText(text: string, maxWidth: number, fontSize: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = this.ctx.measureText(testLine);

      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines.length ? lines : [''];
  }

  // --------------------------------------------------------------------------
  // IMAGE RENDERING
  // --------------------------------------------------------------------------
  async drawImage(overlay: ImageOverlay): Promise<void> {
    const { src, x, y, width, height, opacity = 1, borderRadius = 0 } = overlay;

    try {
      const img = await loadImage(src);
      const imgWidth = width || img.width;
      const imgHeight = height || img.height;

      this.ctx.save();
      this.ctx.globalAlpha = opacity;

      if (borderRadius > 0) {
        this.ctx.beginPath();
        this.roundRect(x, y, imgWidth, imgHeight, borderRadius);
        this.ctx.clip();
      }

      this.ctx.drawImage(img, x, y, imgWidth, imgHeight);
      this.ctx.restore();
    } catch (error) {
      console.error(`Failed to load image: ${src}`, error);
    }
  }

  // --------------------------------------------------------------------------
  // SHAPE RENDERING
  // --------------------------------------------------------------------------
  drawShape(shape: ShapeLayer): void {
    const { type, x, y, width, height, fill, stroke, strokeWidth = 1, borderRadius = 0, shadow } = shape;

    this.ctx.save();

    if (shadow) {
      this.ctx.shadowColor = shadow.color;
      this.ctx.shadowBlur = shadow.blur;
      this.ctx.shadowOffsetX = shadow.offsetX;
      this.ctx.shadowOffsetY = shadow.offsetY;
    }

    this.ctx.beginPath();

    switch (type) {
      case 'rectangle':
        this.ctx.rect(x, y, width, height);
        break;
      case 'circle':
        const radius = Math.min(width, height) / 2;
        this.ctx.arc(x + radius, y + radius, radius, 0, Math.PI * 2);
        break;
      case 'rounded-rect':
        this.roundRect(x, y, width, height, borderRadius);
        break;
    }

    if (fill) {
      this.ctx.fillStyle = fill;
      this.ctx.fill();
    }

    if (stroke) {
      this.ctx.strokeStyle = stroke;
      this.ctx.lineWidth = strokeWidth;
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  private roundRect(x: number, y: number, width: number, height: number, radius: number): void {
    this.ctx.beginPath();
    this.ctx.moveTo(x + radius, y);
    this.ctx.lineTo(x + width - radius, y);
    this.ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    this.ctx.lineTo(x + width, y + height - radius);
    this.ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    this.ctx.lineTo(x + radius, y + height);
    this.ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    this.ctx.lineTo(x, y + radius);
    this.ctx.quadraticCurveTo(x, y, x + radius, y);
    this.ctx.closePath();
  }

  // --------------------------------------------------------------------------
  // DEVICE MOCKUP RENDERING
  // --------------------------------------------------------------------------
  async drawDevice(layer: DeviceLayer): Promise<void> {
    const device = getDevice(layer.deviceId);
    if (!device) {
      console.error(`Device not found: ${layer.deviceId}`);
      return;
    }

    const { x, y, scale = 1, shadow = true, screenshotPath } = layer;
    const { dimensions, colors } = device;

    // Calculate scaled dimensions
    const deviceWidth = dimensions.width * scale * 4;
    const deviceHeight = dimensions.height * scale * 4;
    const cornerRadius = dimensions.cornerRadius * scale * 4;
    const screenWidth = dimensions.screenWidth * scale * 4;
    const screenHeight = dimensions.screenHeight * scale * 4;
    const bezelTop = dimensions.bezelTop * scale * 4;
    const bezelSide = dimensions.bezelSide * scale * 4;

    this.ctx.save();

    // Shadow
    if (shadow) {
      this.ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      this.ctx.shadowBlur = 30 * scale;
      this.ctx.shadowOffsetX = 0;
      this.ctx.shadowOffsetY = 15 * scale;
    }

    // Device frame
    this.ctx.fillStyle = colors.frame;
    this.roundRect(x, y, deviceWidth, deviceHeight, cornerRadius);
    this.ctx.fill();

    // Reset shadow for screen
    this.ctx.shadowColor = 'transparent';

    // Screen background
    const screenX = x + bezelSide;
    const screenY = y + bezelTop;
    this.ctx.fillStyle = colors.screen;
    this.roundRect(screenX, screenY, screenWidth, screenHeight, cornerRadius * 0.8);
    this.ctx.fill();

    // Screenshot
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      try {
        const screenshot = await loadImage(screenshotPath);

        // Clip to screen area
        this.ctx.save();
        this.ctx.beginPath();
        this.roundRect(screenX, screenY, screenWidth, screenHeight, cornerRadius * 0.8);
        this.ctx.clip();

        // Draw screenshot to fit screen
        this.ctx.drawImage(screenshot, screenX, screenY, screenWidth, screenHeight);
        this.ctx.restore();
      } catch (error) {
        console.error(`Failed to load screenshot: ${screenshotPath}`, error);
      }
    }

    this.ctx.restore();
  }

  // --------------------------------------------------------------------------
  // COMPOSITION
  // --------------------------------------------------------------------------
  async renderComposition(composition: FrameComposition): Promise<void> {
    // Background
    if (composition.backgroundGradient) {
      const { type, colors, stops, angle } = composition.backgroundGradient;
      this.fillBackgroundGradient(type, colors, stops, angle);
    } else {
      this.fillBackground(composition.backgroundColor || '#ffffff');
    }

    // Sort layers by zIndex
    const sortedLayers = [...composition.layers].sort((a, b) => a.zIndex - b.zIndex);

    // Render each layer
    for (const layer of sortedLayers) {
      this.ctx.save();

      if (layer.opacity !== undefined) {
        this.ctx.globalAlpha = layer.opacity;
      }

      if (layer.transform) {
        const { rotate = 0, scaleX = 1, scaleY = 1, translateX = 0, translateY = 0 } = layer.transform;
        this.ctx.translate(translateX, translateY);
        this.ctx.rotate((rotate * Math.PI) / 180);
        this.ctx.scale(scaleX, scaleY);
      }

      switch (layer.type) {
        case 'image':
          if (layer.image) await this.drawImage(layer.image);
          break;
        case 'text':
          if (layer.text) this.drawText(layer.text);
          break;
        case 'shape':
          if (layer.shape) this.drawShape(layer.shape);
          break;
        case 'device':
          if (layer.device) await this.drawDevice(layer.device);
          break;
      }

      this.ctx.restore();
    }
  }

  // --------------------------------------------------------------------------
  // OUTPUT
  // --------------------------------------------------------------------------
  toBuffer(format: 'png' | 'jpeg' = 'png', quality: number = 90): Buffer {
    if (format === 'jpeg') {
      return this.canvas.toBuffer('image/jpeg', { quality: quality / 100 });
    }
    return this.canvas.toBuffer('image/png');
  }

  toDataURL(format: 'png' | 'jpeg' = 'png', quality: number = 90): string {
    if (format === 'jpeg') {
      return this.canvas.toDataURL('image/jpeg', quality / 100);
    }
    return this.canvas.toDataURL('image/png');
  }

  async saveToFile(filePath: string, format?: 'png' | 'jpeg', quality: number = 90): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    const outputFormat = format || (ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : 'png');
    const buffer = this.toBuffer(outputFormat, quality);
    await fs.promises.writeFile(filePath, buffer);
  }

  getCanvas(): Canvas {
    return this.canvas;
  }

  getContext(): CanvasRenderingContext2D {
    return this.ctx;
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================
export async function renderToBuffer(
  composition: FrameComposition,
  options: RenderOptions = {}
): Promise<RenderResult> {
  try {
    const renderer = new CanvasRenderer(composition.width, composition.height);
    await renderer.renderComposition(composition);

    const format = options.format || 'png';
    const quality = options.quality || 90;
    const buffer = renderer.toBuffer(format, quality);

    return {
      success: true,
      buffer,
      width: composition.width,
      height: composition.height,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function renderToFile(
  composition: FrameComposition,
  filePath: string,
  options: RenderOptions = {}
): Promise<RenderResult> {
  try {
    const renderer = new CanvasRenderer(composition.width, composition.height);
    await renderer.renderComposition(composition);

    const format = options.format || 'png';
    const quality = options.quality || 90;
    await renderer.saveToFile(filePath, format, quality);

    return {
      success: true,
      width: composition.width,
      height: composition.height,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function renderToDataURL(
  composition: FrameComposition,
  options: RenderOptions = {}
): Promise<RenderResult> {
  try {
    const renderer = new CanvasRenderer(composition.width, composition.height);
    await renderer.renderComposition(composition);

    const format = options.format || 'png';
    const quality = options.quality || 90;
    const dataUrl = renderer.toDataURL(format, quality);

    return {
      success: true,
      dataUrl,
      width: composition.width,
      height: composition.height,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// PRESET COMPOSITIONS
// ============================================================================
export function createDeviceMockupComposition(
  deviceId: string,
  screenshotPath: string,
  options: {
    width?: number;
    height?: number;
    backgroundColor?: string;
    scale?: number;
    title?: string;
    subtitle?: string;
  } = {}
): FrameComposition {
  const device = getDevice(deviceId);
  const width = options.width || 1920;
  const height = options.height || 1080;
  const scale = options.scale || 1;

  const layers: CompositionLayer[] = [];

  // Device layer (centered)
  if (device) {
    const deviceWidth = device.dimensions.width * scale * 4;
    const deviceHeight = device.dimensions.height * scale * 4;
    const deviceX = (width - deviceWidth) / 2;
    const deviceY = (height - deviceHeight) / 2;

    layers.push({
      type: 'device',
      zIndex: 1,
      device: {
        deviceId,
        screenshotPath,
        x: deviceX,
        y: deviceY,
        scale,
        shadow: true,
      },
    });
  }

  // Title
  if (options.title) {
    layers.push({
      type: 'text',
      zIndex: 2,
      text: {
        text: options.title,
        x: width / 2,
        y: 60,
        fontSize: 48,
        fontWeight: 'bold',
        color: '#1a1a1a',
        align: 'center',
      },
    });
  }

  // Subtitle
  if (options.subtitle) {
    layers.push({
      type: 'text',
      zIndex: 2,
      text: {
        text: options.subtitle,
        x: width / 2,
        y: height - 60,
        fontSize: 24,
        color: '#666666',
        align: 'center',
      },
    });
  }

  return {
    width,
    height,
    backgroundColor: options.backgroundColor || '#f5f5f7',
    layers,
  };
}

export function createComparisonComposition(
  devices: Array<{ deviceId: string; screenshotPath: string; label?: string }>,
  options: {
    width?: number;
    height?: number;
    backgroundColor?: string;
    title?: string;
  } = {}
): FrameComposition {
  const width = options.width || 1920;
  const height = options.height || 1080;
  const layers: CompositionLayer[] = [];

  const count = devices.length;
  const spacing = width / (count + 1);
  const scale = count > 2 ? 0.6 : 0.8;

  devices.forEach((item, index) => {
    const device = getDevice(item.deviceId);
    if (!device) return;

    const deviceWidth = device.dimensions.width * scale * 4;
    const deviceHeight = device.dimensions.height * scale * 4;
    const x = spacing * (index + 1) - deviceWidth / 2;
    const y = (height - deviceHeight) / 2;

    layers.push({
      type: 'device',
      zIndex: index + 1,
      device: {
        deviceId: item.deviceId,
        screenshotPath: item.screenshotPath,
        x,
        y,
        scale,
        shadow: true,
      },
    });

    if (item.label) {
      layers.push({
        type: 'text',
        zIndex: 10 + index,
        text: {
          text: item.label,
          x: x + deviceWidth / 2,
          y: y + deviceHeight + 30,
          fontSize: 18,
          color: '#666666',
          align: 'center',
        },
      });
    }
  });

  if (options.title) {
    layers.push({
      type: 'text',
      zIndex: 20,
      text: {
        text: options.title,
        x: width / 2,
        y: 50,
        fontSize: 42,
        fontWeight: 'bold',
        color: '#1a1a1a',
        align: 'center',
      },
    });
  }

  return {
    width,
    height,
    backgroundColor: options.backgroundColor || '#f5f5f7',
    layers,
  };
}
