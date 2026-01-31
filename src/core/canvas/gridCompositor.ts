/**
 * DiscoveryLab Grid Compositor
 * Creates static image grids for evidence screenshots
 * Inspired by timeline-lab but focused on PNG export
 */

import { createCanvas, loadImage, CanvasRenderingContext2D, Image } from 'canvas';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

export type AspectRatio = '9:16' | '1:1' | '16:9';

export type GridLayout =
  | 'single'      // 1 image
  | 'duo-h'       // 2 images horizontal
  | 'duo-v'       // 2 images vertical
  | 'trio-h'      // 3 images horizontal
  | 'trio-v'      // 3 images vertical
  | 'quad'        // 2x2 grid
  | 'featured'    // 1 large + 2 small
  | 'masonry'     // Pinterest-style 3 columns
  | 'carousel'    // Overlapping cards
  | 'stacked';    // 3D perspective stack

export type BackgroundType = 'solid' | 'gradient' | 'image';

export interface BackgroundConfig {
  type: BackgroundType;
  color?: string;           // For solid
  gradientStart?: string;   // For gradient
  gradientEnd?: string;
  gradientAngle?: number;   // degrees
  imagePath?: string;       // For image background
}

export interface GridConfig {
  aspectRatio: AspectRatio;
  layout: GridLayout;
  background: BackgroundConfig;
  padding: number;          // Outer padding in pixels
  cellPadding: number;      // Gap between cells
  cornerRadius: number;     // Corner radius for cells
  shadowEnabled: boolean;
  shadowBlur: number;
  outputWidth: number;      // Base width (height calculated from aspect ratio)
  imageFit: 'cover' | 'contain'; // How images fit in cells: cover (fill, crop) or contain (fit, letterbox)
}

export interface GridCell {
  imagePath: string;
  label?: string;
}

export interface GridResult {
  success: boolean;
  outputPath?: string;
  width?: number;
  height?: number;
  error?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const ASPECT_RATIOS: Record<AspectRatio, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
};

const DEFAULT_CONFIG: GridConfig = {
  aspectRatio: '9:16',
  layout: 'quad',
  background: {
    type: 'gradient',
    gradientStart: '#1a1a2e',
    gradientEnd: '#16213e',
    gradientAngle: 135,
  },
  padding: 40,
  cellPadding: 16,
  cornerRadius: 16,
  shadowEnabled: true,
  shadowBlur: 20,
  outputWidth: 1080,
  imageFit: 'cover',
};

// ============================================================================
// LAYOUT CALCULATORS
// ============================================================================

interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function calculateCells(
  layout: GridLayout,
  canvasWidth: number,
  canvasHeight: number,
  padding: number,
  cellPadding: number,
  imageCount: number
): CellRect[] {
  const contentWidth = canvasWidth - padding * 2;
  const contentHeight = canvasHeight - padding * 2;
  const cells: CellRect[] = [];

  switch (layout) {
    case 'single': {
      cells.push({
        x: padding,
        y: padding,
        width: contentWidth,
        height: contentHeight,
      });
      break;
    }

    case 'duo-h': {
      const cellWidth = (contentWidth - cellPadding) / 2;
      cells.push(
        { x: padding, y: padding, width: cellWidth, height: contentHeight },
        { x: padding + cellWidth + cellPadding, y: padding, width: cellWidth, height: contentHeight }
      );
      break;
    }

    case 'duo-v': {
      const cellHeight = (contentHeight - cellPadding) / 2;
      cells.push(
        { x: padding, y: padding, width: contentWidth, height: cellHeight },
        { x: padding, y: padding + cellHeight + cellPadding, width: contentWidth, height: cellHeight }
      );
      break;
    }

    case 'trio-h': {
      const cellWidth = (contentWidth - cellPadding * 2) / 3;
      for (let i = 0; i < 3; i++) {
        cells.push({
          x: padding + i * (cellWidth + cellPadding),
          y: padding,
          width: cellWidth,
          height: contentHeight,
        });
      }
      break;
    }

    case 'trio-v': {
      const cellHeight = (contentHeight - cellPadding * 2) / 3;
      for (let i = 0; i < 3; i++) {
        cells.push({
          x: padding,
          y: padding + i * (cellHeight + cellPadding),
          width: contentWidth,
          height: cellHeight,
        });
      }
      break;
    }

    case 'quad': {
      const cellWidth = (contentWidth - cellPadding) / 2;
      const cellHeight = (contentHeight - cellPadding) / 2;
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) {
          cells.push({
            x: padding + col * (cellWidth + cellPadding),
            y: padding + row * (cellHeight + cellPadding),
            width: cellWidth,
            height: cellHeight,
          });
        }
      }
      break;
    }

    case 'featured': {
      // Large image on left (60%), two stacked on right (40%)
      const leftWidth = contentWidth * 0.6 - cellPadding / 2;
      const rightWidth = contentWidth * 0.4 - cellPadding / 2;
      const rightHeight = (contentHeight - cellPadding) / 2;

      cells.push(
        { x: padding, y: padding, width: leftWidth, height: contentHeight },
        { x: padding + leftWidth + cellPadding, y: padding, width: rightWidth, height: rightHeight },
        { x: padding + leftWidth + cellPadding, y: padding + rightHeight + cellPadding, width: rightWidth, height: rightHeight }
      );
      break;
    }

    case 'masonry': {
      // 3-column masonry layout
      const colWidth = (contentWidth - cellPadding * 2) / 3;
      const heights = [0, 0, 0];
      const count = Math.min(imageCount, 6);

      for (let i = 0; i < count; i++) {
        const col = i % 3;
        const cellHeight = i < 3 ? contentHeight * 0.55 : contentHeight * 0.45 - cellPadding;

        cells.push({
          x: padding + col * (colWidth + cellPadding),
          y: padding + heights[col],
          width: colWidth,
          height: cellHeight,
        });

        heights[col] += cellHeight + cellPadding;
      }
      break;
    }

    case 'carousel': {
      // Overlapping cards with scale effect
      const cardWidth = contentWidth * 0.7;
      const cardHeight = contentHeight * 0.85;
      const overlap = cardWidth * 0.3;
      const count = Math.min(imageCount, 3);

      for (let i = 0; i < count; i++) {
        const scale = 1 - i * 0.05;
        const w = cardWidth * scale;
        const h = cardHeight * scale;
        cells.push({
          x: padding + (contentWidth - w) / 2 + (i - 1) * overlap,
          y: padding + (contentHeight - h) / 2 + i * 10,
          width: w,
          height: h,
        });
      }
      break;
    }

    case 'stacked': {
      // 3D perspective stack
      const cardWidth = contentWidth * 0.8;
      const cardHeight = contentHeight * 0.7;
      const count = Math.min(imageCount, 4);
      const offsetY = 30;
      const offsetX = 15;

      for (let i = count - 1; i >= 0; i--) {
        cells.push({
          x: padding + (contentWidth - cardWidth) / 2 + i * offsetX,
          y: padding + (contentHeight - cardHeight) / 2 - i * offsetY,
          width: cardWidth,
          height: cardHeight,
        });
      }
      break;
    }

    default:
      // Default to single
      cells.push({
        x: padding,
        y: padding,
        width: contentWidth,
        height: contentHeight,
      });
  }

  return cells;
}

// ============================================================================
// DRAWING HELPERS
// ============================================================================

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: BackgroundConfig,
  bgImage?: Image
): void {
  if (config.type === 'image' && bgImage) {
    // Draw background image (cover style)
    const scale = Math.max(width / bgImage.width, height / bgImage.height);
    const scaledWidth = bgImage.width * scale;
    const scaledHeight = bgImage.height * scale;
    const offsetX = (width - scaledWidth) / 2;
    const offsetY = (height - scaledHeight) / 2;

    ctx.drawImage(bgImage, offsetX, offsetY, scaledWidth, scaledHeight);
  } else if (config.type === 'gradient') {
    const angle = (config.gradientAngle || 135) * Math.PI / 180;
    const length = Math.sqrt(width * width + height * height);
    const x1 = width / 2 - Math.cos(angle) * length / 2;
    const y1 = height / 2 - Math.sin(angle) * length / 2;
    const x2 = width / 2 + Math.cos(angle) * length / 2;
    const y2 = height / 2 + Math.sin(angle) * length / 2;

    const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
    gradient.addColorStop(0, config.gradientStart || '#1a1a2e');
    gradient.addColorStop(1, config.gradientEnd || '#16213e');

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  } else {
    // Solid color
    ctx.fillStyle = config.color || '#1a1a2e';
    ctx.fillRect(0, 0, width, height);
  }
}

function drawShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  blur: number
): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = blur / 3;
  ctx.fillStyle = 'white';
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.fill();
  ctx.restore();
}

/**
 * Calculate actual image bounds within cell based on fit mode
 */
function calculateImageBounds(
  image: Image,
  cell: CellRect,
  imageFit: 'cover' | 'contain'
): { x: number; y: number; width: number; height: number; drawWidth: number; drawHeight: number; offsetX: number; offsetY: number } {
  const imageAspect = image.width / image.height;
  const cellAspect = cell.width / cell.height;

  let drawWidth: number;
  let drawHeight: number;
  let offsetX: number;
  let offsetY: number;

  if (imageFit === 'cover') {
    // Cover mode: fill the entire cell, cropping as needed (no black bars)
    if (imageAspect > cellAspect) {
      drawHeight = cell.height;
      drawWidth = cell.height * imageAspect;
      offsetX = (cell.width - drawWidth) / 2;
      offsetY = 0;
    } else {
      drawWidth = cell.width;
      drawHeight = cell.width / imageAspect;
      offsetX = 0;
      offsetY = (cell.height - drawHeight) / 2;
    }
    // In cover mode, visible bounds = cell bounds
    return {
      x: cell.x,
      y: cell.y,
      width: cell.width,
      height: cell.height,
      drawWidth, drawHeight, offsetX, offsetY
    };
  } else {
    // Contain mode: fit entire image, letterbox as needed
    if (imageAspect > cellAspect) {
      drawWidth = cell.width;
      drawHeight = cell.width / imageAspect;
      offsetX = 0;
      offsetY = (cell.height - drawHeight) / 2;
    } else {
      drawHeight = cell.height;
      drawWidth = cell.height * imageAspect;
      offsetX = (cell.width - drawWidth) / 2;
      offsetY = 0;
    }
    // In contain mode, visible bounds = actual image bounds
    return {
      x: cell.x + offsetX,
      y: cell.y + offsetY,
      width: drawWidth,
      height: drawHeight,
      drawWidth, drawHeight, offsetX, offsetY
    };
  }
}

function drawImageInCell(
  ctx: CanvasRenderingContext2D,
  image: Image,
  cell: CellRect,
  cornerRadius: number,
  imageFit: 'cover' | 'contain' = 'cover',
  shadowEnabled: boolean = false,
  shadowBlur: number = 20
): void {
  const bounds = calculateImageBounds(image, cell, imageFit);

  // In contain mode, draw shadow for actual image bounds (not full cell)
  // This prevents white background in letterbox areas
  if (shadowEnabled && imageFit === 'contain') {
    drawShadow(ctx, bounds.x, bounds.y, bounds.width, bounds.height, cornerRadius, shadowBlur);
  }

  // Clip to the visible image area (not full cell in contain mode)
  ctx.save();
  if (imageFit === 'cover') {
    drawRoundedRect(ctx, cell.x, cell.y, cell.width, cell.height, cornerRadius);
  } else {
    drawRoundedRect(ctx, bounds.x, bounds.y, bounds.width, bounds.height, cornerRadius);
  }
  ctx.clip();

  // Draw image
  ctx.drawImage(
    image,
    cell.x + bounds.offsetX,
    cell.y + bounds.offsetY,
    bounds.drawWidth,
    bounds.drawHeight
  );

  ctx.restore();
}

// ============================================================================
// MAIN COMPOSITOR
// ============================================================================

export async function composeGrid(
  images: GridCell[],
  config: Partial<GridConfig> = {},
  outputPath: string
): Promise<GridResult> {
  try {
    const cfg: GridConfig = { ...DEFAULT_CONFIG, ...config };

    // Calculate canvas dimensions from aspect ratio
    const aspectDef = ASPECT_RATIOS[cfg.aspectRatio];
    const scale = cfg.outputWidth / aspectDef.width;
    const canvasWidth = Math.round(aspectDef.width * scale);
    const canvasHeight = Math.round(aspectDef.height * scale);

    // Create canvas
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    // Load background image if needed
    let bgImage: Image | undefined;
    if (cfg.background.type === 'image' && cfg.background.imagePath && existsSync(cfg.background.imagePath)) {
      bgImage = await loadImage(cfg.background.imagePath);
    }

    // Draw background
    drawBackground(ctx, canvasWidth, canvasHeight, cfg.background, bgImage);

    // Calculate cell positions
    const cells = calculateCells(
      cfg.layout,
      canvasWidth,
      canvasHeight,
      cfg.padding,
      cfg.cellPadding,
      images.length
    );

    // Load and draw images
    for (let i = 0; i < Math.min(images.length, cells.length); i++) {
      const cell = cells[i];
      const imageCell = images[i];

      if (!existsSync(imageCell.imagePath)) {
        continue;
      }

      const image = await loadImage(imageCell.imagePath);

      // Draw shadow at cell level ONLY in cover mode
      // (In contain mode, shadow is drawn inside drawImageInCell at actual image bounds)
      if (cfg.shadowEnabled && cfg.imageFit === 'cover') {
        drawShadow(ctx, cell.x, cell.y, cell.width, cell.height, cfg.cornerRadius, cfg.shadowBlur);
      }

      // Draw image in cell (passes shadow params for contain mode handling)
      drawImageInCell(ctx, image, cell, cfg.cornerRadius, cfg.imageFit, cfg.shadowEnabled, cfg.shadowBlur);
    }

    // Export to PNG
    const buffer = canvas.toBuffer('image/png');

    // Ensure output directory exists
    const outputDir = outputPath.substring(0, outputPath.lastIndexOf('/'));
    if (outputDir && !existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(outputPath, buffer);

    return {
      success: true,
      outputPath,
      width: canvasWidth,
      height: canvasHeight,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Grid composition failed';
    return {
      success: false,
      error: message,
    };
  }
}

// ============================================================================
// LAYOUT RECOMMENDATIONS
// ============================================================================

export function recommendLayout(imageCount: number, aspectRatio: AspectRatio): GridLayout {
  if (imageCount === 1) return 'single';
  if (imageCount === 2) return aspectRatio === '16:9' ? 'duo-h' : 'duo-v';
  if (imageCount === 3) return aspectRatio === '9:16' ? 'trio-v' : 'featured';
  if (imageCount === 4) return 'quad';
  if (imageCount >= 5) return 'masonry';
  return 'quad';
}

export function getLayoutInfo(layout: GridLayout): { name: string; maxImages: number; description: string } {
  const layouts: Record<GridLayout, { name: string; maxImages: number; description: string }> = {
    'single': { name: 'Single', maxImages: 1, description: 'One large image' },
    'duo-h': { name: 'Side by Side', maxImages: 2, description: 'Two images horizontally' },
    'duo-v': { name: 'Stacked', maxImages: 2, description: 'Two images vertically' },
    'trio-h': { name: '3 Across', maxImages: 3, description: 'Three images in a row' },
    'trio-v': { name: '3 Down', maxImages: 3, description: 'Three images in a column' },
    'quad': { name: 'Grid 2x2', maxImages: 4, description: 'Four images in a grid' },
    'featured': { name: 'Featured', maxImages: 3, description: 'One large + two small' },
    'masonry': { name: 'Masonry', maxImages: 6, description: 'Pinterest-style columns' },
    'carousel': { name: 'Carousel', maxImages: 3, description: 'Overlapping cards' },
    'stacked': { name: '3D Stack', maxImages: 4, description: 'Perspective stack effect' },
  };
  return layouts[layout];
}

export function getAllLayouts(): GridLayout[] {
  return ['single', 'duo-h', 'duo-v', 'trio-h', 'trio-v', 'quad', 'featured', 'masonry', 'carousel', 'stacked'];
}

// ============================================================================
// BACKGROUND UTILITIES
// ============================================================================

export function getAvailableBackgrounds(backgroundsDir: string): Array<{ id: string; name: string; path: string }> {
  if (!existsSync(backgroundsDir)) {
    return [];
  }

  const files = readdirSync(backgroundsDir)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

  return files.map(f => ({
    id: f.replace(/\.[^.]+$/, ''),
    name: f.replace(/[-_]/g, ' ').replace(/\.[^.]+$/, ''),
    path: join(backgroundsDir, f),
  }));
}

export const PRESET_GRADIENTS = [
  { id: 'dark-blue', name: 'Dark Blue', start: '#1a1a2e', end: '#16213e' },
  { id: 'midnight', name: 'Midnight', start: '#0f0c29', end: '#302b63' },
  { id: 'ocean', name: 'Ocean', start: '#2193b0', end: '#6dd5ed' },
  { id: 'sunset', name: 'Sunset', start: '#ff7e5f', end: '#feb47b' },
  { id: 'aurora', name: 'Aurora', start: '#00c6ff', end: '#0072ff' },
  { id: 'forest', name: 'Forest', start: '#134e5e', end: '#71b280' },
  { id: 'berry', name: 'Berry', start: '#8e2de2', end: '#4a00e0' },
  { id: 'noir', name: 'Noir', start: '#0a0a0a', end: '#1a1a1a' },
];

export const PRESET_SOLID_COLORS = [
  { id: 'black', name: 'Black', color: '#000000' },
  { id: 'dark-gray', name: 'Dark Gray', color: '#1a1a1a' },
  { id: 'navy', name: 'Navy', color: '#0a1628' },
  { id: 'charcoal', name: 'Charcoal', color: '#2d2d2d' },
  { id: 'white', name: 'White', color: '#ffffff' },
];
