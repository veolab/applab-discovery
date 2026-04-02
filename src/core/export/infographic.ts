/**
 * Infographic HTML Exporter
 * Generates a self-contained HTML file with interactive frame player,
 * hotspots, annotations, and baseline status.
 * Zero external dependencies - works offline via file://
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InfographicFrame {
  id: string;
  step_name: string;
  description: string;
  base64: string;
  baseline_status: 'ok' | 'changed' | 'not_validated';
  hotspots: Array<{
    id: string;
    x_percent: number;
    y_percent: number;
    label: string;
    title: string;
    description: string;
    color: string;
  }>;
}

export interface InfographicData {
  name: string;
  platform: string;
  recorded_at: string;
  overview?: string;
  frames: InfographicFrame[];
}

export interface InfographicFrameRecord {
  imagePath: string;
  ocrText?: string | null;
}

export interface FrameValidationIssue {
  path: string;
  reason: 'missing' | 'not_file' | 'unreadable';
}

export interface ResolvedInfographicFrameInputs {
  frameFiles: string[];
  frameOcr: Array<{ ocrText?: string | null }>;
  dataUrls: string[];
  invalidFrames: FrameValidationIssue[];
  source: 'db' | 'filesystem' | 'none';
  candidateCount: number;
}

export interface InfographicExportOptions {
  projectId: string;
  outputPath?: string;
  compress?: boolean;
  noBaseline?: boolean;
}

export interface InfographicExportResult {
  success: boolean;
  outputPath?: string;
  size?: number;
  frameCount?: number;
  error?: string;
}

/**
 * Find the HTML template file in dist or src
 */
function findTemplate(): string | null {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const possiblePaths = [
    join(__dir, 'infographic-template.html'),
    join(__dir, '..', 'export', 'infographic-template.html'),
    join(process.cwd(), 'dist', 'export', 'infographic-template.html'),
    join(process.cwd(), 'src', 'core', 'export', 'infographic-template.html'),
  ];
  for (const p of possiblePaths) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Read an image file and convert to base64 data URI
 */
function imageToBase64(imagePath: string): string {
  try {
    if (!existsSync(imagePath) || !statSync(imagePath).isFile()) return '';
    const buffer = readFileSync(imagePath);
    const ext = extname(imagePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.gif': 'image/gif',
    };
    const mime = mimeTypes[ext] || 'image/png';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

/**
 * Strip markdown formatting from text (bold, italic, headers, lists)
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/\*(.+?)\*/g, '$1')        // *italic*
    .replace(/__(.+?)__/g, '$1')        // __underline__
    .replace(/_(.+?)_/g, '$1')          // _italic_
    .replace(/`(.+?)`/g, '$1')          // `code`
    .replace(/^#{1,3}\s+/gm, '')        // ### headers
    .replace(/^-\s+/gm, '')             // - list items
    .replace(/^\d+\.\s+/gm, '')         // 1. numbered
    .replace(/\[(.+?)\]\(.*?\)/g, '$1') // [link](url)
    .trim();
}

/**
 * Collect frame image files from project directories
 */
export function collectFrameImages(
  framesDir: string,
  videoPath?: string | null,
  projectsDir?: string,
  projectId?: string,
): string[] {
  const imageExts = /\.(png|jpg|jpeg|webp|gif)$/i;
  const dirs = [
    framesDir,
    ...(videoPath ? [join(videoPath, 'screenshots'), videoPath] : []),
    ...(projectsDir && projectId ? [
      join(projectsDir, 'maestro-recordings', projectId, 'screenshots'),
      join(projectsDir, 'web-recordings', projectId, 'screenshots'),
    ] : []),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir)
      .filter(f => imageExts.test(f))
      .sort()
      .map(f => join(dir, f));
    if (files.length > 0) return files;
  }
  return [];
}

function validateFrameInputs(
  frameFiles: string[],
  frameOcr: Array<{ ocrText?: string | null }>,
): Omit<ResolvedInfographicFrameInputs, 'source' | 'candidateCount'> {
  const validFrameFiles: string[] = [];
  const validFrameOcr: Array<{ ocrText?: string | null }> = [];
  const dataUrls: string[] = [];
  const invalidFrames: FrameValidationIssue[] = [];

  frameFiles.forEach((filePath, index) => {
    if (!filePath || !existsSync(filePath)) {
      invalidFrames.push({ path: filePath || `frame-${index + 1}`, reason: 'missing' });
      return;
    }

    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      invalidFrames.push({ path: filePath, reason: 'unreadable' });
      return;
    }

    if (!stats.isFile()) {
      invalidFrames.push({ path: filePath, reason: 'not_file' });
      return;
    }

    const dataUrl = imageToBase64(filePath);
    if (!dataUrl) {
      invalidFrames.push({ path: filePath, reason: 'unreadable' });
      return;
    }

    validFrameFiles.push(filePath);
    validFrameOcr.push(frameOcr[index] || { ocrText: null });
    dataUrls.push(dataUrl);
  });

  return {
    frameFiles: validFrameFiles,
    frameOcr: validFrameOcr,
    dataUrls,
    invalidFrames,
  };
}

export function resolveInfographicFrameInputs(
  dbFrames: InfographicFrameRecord[],
  framesDir: string,
  videoPath?: string | null,
  projectsDir?: string,
  projectId?: string,
): ResolvedInfographicFrameInputs {
  if (dbFrames.length > 0) {
    const dbValidation = validateFrameInputs(
      dbFrames.map((frame) => frame.imagePath),
      dbFrames.map((frame) => ({ ocrText: frame.ocrText ?? null })),
    );

    if (dbValidation.frameFiles.length > 0) {
      return {
        ...dbValidation,
        source: 'db',
        candidateCount: dbFrames.length,
      };
    }

    const fallbackFrameFiles = collectFrameImages(framesDir, videoPath, projectsDir, projectId);
    const fallbackValidation = validateFrameInputs(
      fallbackFrameFiles,
      fallbackFrameFiles.map(() => ({ ocrText: null })),
    );

    if (fallbackValidation.frameFiles.length > 0) {
      return {
        ...fallbackValidation,
        invalidFrames: [...dbValidation.invalidFrames, ...fallbackValidation.invalidFrames],
        source: 'filesystem',
        candidateCount: dbFrames.length + fallbackFrameFiles.length,
      };
    }

    return {
      ...fallbackValidation,
      invalidFrames: [...dbValidation.invalidFrames, ...fallbackValidation.invalidFrames],
      source: 'none',
      candidateCount: dbFrames.length + fallbackFrameFiles.length,
    };
  }

  const fallbackFrameFiles = collectFrameImages(framesDir, videoPath, projectsDir, projectId);
  const fallbackValidation = validateFrameInputs(
    fallbackFrameFiles,
    fallbackFrameFiles.map(() => ({ ocrText: null })),
  );

  return {
    ...fallbackValidation,
    source: fallbackValidation.frameFiles.length > 0 ? 'filesystem' : 'none',
    candidateCount: fallbackFrameFiles.length,
  };
}

/**
 * Build InfographicData from project database record and frame files
 */
export function buildInfographicData(
  project: {
    id: string;
    name: string;
    marketingTitle?: string | null;
    marketingDescription?: string | null;
    platform?: string | null;
    createdAt?: Date | string | null;
    aiSummary?: string | null;
  },
  frameFiles: string[],
  frameOcr: Array<{ ocrText?: string | null }>,
  annotations?: Array<{ label: string }>,
): InfographicData {
  const validatedFrames = validateFrameInputs(frameFiles, frameOcr);
  const usableFrameFiles = validatedFrames.frameFiles;
  const usableFrameOcr = validatedFrames.frameOcr;
  const dataUrls = validatedFrames.dataUrls;

  // Parse user flow steps from aiSummary
  let flowSteps: string[] = [];
  let uiElements: string[] = [];
  if (project.aiSummary) {
    const flowMatch = project.aiSummary.match(/## (?:User Flow|Likely User Flow)\n([\s\S]*?)(?=\n##|\n$|$)/);
    if (flowMatch) {
      flowSteps = (flowMatch[1].match(/^\d+\.\s+(.+)$/gm) || []).map(s => s.replace(/^\d+\.\s+/, ''));
    }
    const uiMatch = project.aiSummary.match(/## (?:UI Elements Found|Key UI Elements)\n([\s\S]*?)(?=\n##|\n$|$)/);
    if (uiMatch) {
      uiElements = (uiMatch[1].match(/^-\s+(.+)$/gm) || []).map(s => s.replace(/^-\s+/, ''));
    }
  }

  let overview = '';
  if (project.aiSummary) {
    const overviewMatch = project.aiSummary.match(/## (?:App Overview|Page \/ App Overview|Overview|Summary)\n([\s\S]*?)(?=\n##|\n$|$)/);
    if (overviewMatch) {
      const overviewBody = overviewMatch[1]
        .split(/\n\s*\n/)
        .map((chunk) => chunk.trim())
        .filter(Boolean)[0] || overviewMatch[1];
      overview = stripMarkdown(overviewBody).slice(0, 240);
    }
  }
  if (!overview && project.marketingDescription) {
    overview = stripMarkdown(project.marketingDescription).slice(0, 240);
  }

  // Distribute UI elements across frames for hotspots
  const elementsPerFrame = Math.max(1, Math.ceil(uiElements.length / Math.max(usableFrameFiles.length, 1)));
  const hotspotColors = ['#818CF8', '#34D399', '#F59E0B', '#EC4899', '#06B6D4', '#8B5CF6'];

  // Predefined positions for hotspots (distributed around the screen)
  const hotspotPositions = [
    { x: 50, y: 8 },   // top center (nav bar)
    { x: 15, y: 30 },  // left middle
    { x: 85, y: 30 },  // right middle
    { x: 50, y: 50 },  // center
    { x: 50, y: 85 },  // bottom center (tab bar)
    { x: 15, y: 70 },  // bottom left
  ];

  const frames: InfographicFrame[] = usableFrameFiles.map((filePath, i) => {
    const rawStepName = annotations?.[i]?.label || flowSteps[i] || `Step ${i + 1}`;
    const stepName = stripMarkdown(rawStepName);
    const ocr = usableFrameOcr[i]?.ocrText || '';
    const rawDesc = flowSteps[i] || ocr.slice(0, 100) || `Screen ${i + 1}`;
    const description = stripMarkdown(rawDesc);

    // Assign UI elements as hotspots for this frame
    const hotspots: InfographicFrame['hotspots'] = [];
    const startIdx = i * elementsPerFrame;
    const frameElements = uiElements.slice(startIdx, startIdx + elementsPerFrame).slice(0, 4);

    frameElements.forEach((el, j) => {
      const cleanEl = stripMarkdown(el);
      const pos = hotspotPositions[j % hotspotPositions.length];
      hotspots.push({
        id: String.fromCharCode(65 + j),
        x_percent: pos.x,
        y_percent: pos.y,
        label: cleanEl.slice(0, 20),
        title: cleanEl.slice(0, 40),
        description: cleanEl,
        color: hotspotColors[j % hotspotColors.length],
      });
    });

    // If no UI elements, try to extract from OCR keywords
    if (hotspots.length === 0 && ocr) {
      const ocrWords = ocr.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
      ocrWords.forEach((w, j) => {
        const pos = hotspotPositions[j % hotspotPositions.length];
        hotspots.push({
          id: String.fromCharCode(65 + j),
          x_percent: pos.x,
          y_percent: pos.y,
          label: w.slice(0, 15),
          title: w,
          description: `Text found: "${w}"`,
          color: hotspotColors[j % hotspotColors.length],
        });
      });
    }

    return {
      id: `frame-${i}`,
      step_name: stepName,
      description,
      base64: dataUrls[i] || imageToBase64(filePath),
      baseline_status: 'not_validated' as const,
      hotspots,
    };
  });

  return {
    name: project.marketingTitle || project.name,
    platform: project.platform || 'unknown',
    recorded_at: project.createdAt instanceof Date
      ? project.createdAt.toISOString()
      : typeof project.createdAt === 'string' ? project.createdAt : new Date().toISOString(),
    overview,
    frames,
  };
}

/**
 * Generate infographic HTML as a string (for inline rendering in Claude Desktop)
 */
export function generateInfographicHtmlString(data: InfographicData): string | null {
  const templatePath = findTemplate();
  if (!templatePath) return null;

  let html = readFileSync(templatePath, 'utf-8');
  html = html.replace('__TITLE__', data.name);
  const dataJson = JSON.stringify(data);
  html = html.replace(
    'window.FLOW_DATA || { name: \'Flow\', frames: [] }',
    `window.FLOW_DATA || ${dataJson}`
  );
  return html;
}

/**
 * Generate the self-contained HTML infographic file
 */
export function generateInfographicHtml(
  data: InfographicData,
  outputPath: string,
): InfographicExportResult {
  try {
    const templatePath = findTemplate();
    if (!templatePath) {
      return { success: false, error: 'Infographic template not found' };
    }

    let html = readFileSync(templatePath, 'utf-8');

    // Inject title
    html = html.replace('__TITLE__', data.name);

    // Inject data
    const dataJson = JSON.stringify(data);
    html = html.replace(
      'window.FLOW_DATA || { name: \'Flow\', frames: [] }',
      `window.FLOW_DATA || ${dataJson}`
    );

    // Ensure output directory exists
    const outDir = dirname(outputPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    writeFileSync(outputPath, html, 'utf-8');

    const stat = statSync(outputPath);
    return {
      success: true,
      outputPath,
      size: stat.size,
      frameCount: data.frames.length,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
