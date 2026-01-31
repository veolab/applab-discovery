/**
 * DiscoveryLab OCR Processing Module
 * Text recognition using Apple Vision framework (macOS) or Tesseract fallback
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// TYPES
// ============================================================================
export interface OCRResult {
  success: boolean;
  text?: string;
  blocks?: TextBlock[];
  confidence?: number;
  error?: string;
  engine?: 'vision' | 'tesseract';
}

export interface TextBlock {
  text: string;
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface OCROptions {
  languages?: string[]; // e.g., ['en', 'es', 'pt']
  recognitionLevel?: 'fast' | 'accurate';
  minConfidence?: number; // 0-1, filter results below this
}

// ============================================================================
// SWIFT VISION HELPER PATH
// ============================================================================
function getSwiftHelperPath(): string {
  // Try multiple locations
  const possiblePaths = [
    join(__dirname, '..', '..', 'swift', 'VisionHelper'),
    join(__dirname, '..', '..', '..', 'src', 'swift', 'VisionHelper'),
    join(process.cwd(), 'src', 'swift', 'VisionHelper'),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return possiblePaths[0]; // Return expected path even if not built
}

// ============================================================================
// APPLE VISION OCR (macOS only)
// ============================================================================
export async function recognizeTextWithVision(
  imagePath: string,
  options: OCROptions = {}
): Promise<OCRResult> {
  if (platform() !== 'darwin') {
    return { success: false, error: 'Apple Vision is only available on macOS', engine: 'vision' };
  }

  if (!existsSync(imagePath)) {
    return { success: false, error: `Image file not found: ${imagePath}`, engine: 'vision' };
  }

  const helperPath = getSwiftHelperPath();

  // If Swift helper is compiled, use it
  if (existsSync(helperPath)) {
    return runSwiftHelper(helperPath, imagePath, options);
  }

  // Fall back to AppleScript-based approach
  return runVisionViaAppleScript(imagePath, options);
}

async function runSwiftHelper(
  helperPath: string,
  imagePath: string,
  options: OCROptions
): Promise<OCRResult> {
  return new Promise((resolve) => {
    const args = ['ocr', imagePath];

    if (options.recognitionLevel === 'fast') {
      args.push('--fast');
    }

    if (options.languages?.length) {
      args.push('--languages', options.languages.join(','));
    }

    const proc = spawn(helperPath, args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr || 'VisionHelper failed', engine: 'vision' });
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve({
          success: true,
          text: result.text,
          blocks: result.blocks,
          confidence: result.confidence,
          engine: 'vision',
        });
      } catch {
        // Plain text output
        resolve({
          success: true,
          text: stdout.trim(),
          engine: 'vision',
        });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message, engine: 'vision' });
    });
  });
}

async function runVisionViaAppleScript(imagePath: string, _options: OCROptions): Promise<OCRResult> {
  // Use shortcuts/automator or direct Swift execution via osascript
  // This is a fallback when the Swift helper isn't compiled

  const swiftCode = `
import Cocoa
import Vision

let imagePath = "${imagePath.replace(/"/g, '\\"')}"
guard let image = NSImage(contentsOfFile: imagePath),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("Error: Could not load image")
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try? handler.perform([request])

var allText = ""
if let results = request.results {
    for observation in results {
        if let candidate = observation.topCandidates(1).first {
            allText += candidate.string + "\\n"
        }
    }
}

print(allText)
`;

  const tempFile = join(tmpdir(), `vision-ocr-${randomUUID()}.swift`);

  try {
    writeFileSync(tempFile, swiftCode);

    const output = execSync(`swift ${tempFile}`, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    unlinkSync(tempFile);

    return {
      success: true,
      text: output.trim(),
      engine: 'vision',
    };
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch {}

    const message = error instanceof Error ? error.message : 'Vision OCR failed';
    return { success: false, error: message, engine: 'vision' };
  }
}

// ============================================================================
// TESSERACT OCR (Cross-platform fallback)
// ============================================================================
export async function recognizeTextWithTesseract(
  imagePath: string,
  options: OCROptions = {}
): Promise<OCRResult> {
  if (!existsSync(imagePath)) {
    return { success: false, error: `Image file not found: ${imagePath}`, engine: 'tesseract' };
  }

  // Check if tesseract is installed
  try {
    execSync('tesseract --version', { stdio: 'ignore' });
  } catch {
    return { success: false, error: 'Tesseract is not installed', engine: 'tesseract' };
  }

  return new Promise((resolve) => {
    const args: string[] = [imagePath, 'stdout'];

    // Language
    if (options.languages?.length) {
      args.push('-l', options.languages.join('+'));
    }

    // PSM (Page Segmentation Mode) - 3 is fully automatic
    args.push('--psm', '3');

    // Output format
    args.push('-c', 'tessedit_create_hocr=0');

    const proc = spawn('tesseract', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        resolve({ success: false, error: stderr || 'Tesseract failed', engine: 'tesseract' });
        return;
      }

      resolve({
        success: true,
        text: stdout.trim(),
        engine: 'tesseract',
      });
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message, engine: 'tesseract' });
    });
  });
}

// ============================================================================
// UNIFIED OCR API
// ============================================================================
export async function recognizeText(imagePath: string, options: OCROptions = {}): Promise<OCRResult> {
  // On macOS, prefer Vision framework
  if (platform() === 'darwin') {
    const visionResult = await recognizeTextWithVision(imagePath, options);
    if (visionResult.success) {
      return visionResult;
    }

    // Fall back to Tesseract if Vision fails
    console.warn('Vision OCR failed, trying Tesseract:', visionResult.error);
  }

  // Try Tesseract
  return recognizeTextWithTesseract(imagePath, options);
}

// ============================================================================
// BATCH OCR
// ============================================================================
export interface BatchOCRResult {
  success: boolean;
  results: Array<{
    imagePath: string;
    ocr: OCRResult;
  }>;
  totalText: string;
}

export async function recognizeTextBatch(
  imagePaths: string[],
  options: OCROptions = {}
): Promise<BatchOCRResult> {
  const results: BatchOCRResult['results'] = [];
  const textParts: string[] = [];

  for (const imagePath of imagePaths) {
    const ocr = await recognizeText(imagePath, options);
    results.push({ imagePath, ocr });

    if (ocr.success && ocr.text) {
      textParts.push(ocr.text);
    }
  }

  return {
    success: results.some((r) => r.ocr.success),
    results,
    totalText: textParts.join('\n\n---\n\n'),
  };
}

// ============================================================================
// TEXT ANALYSIS
// ============================================================================
export interface TextAnalysis {
  wordCount: number;
  uniqueWords: number;
  sentences: string[];
  keywords: string[];
  language?: string;
}

export function analyzeText(text: string): TextAnalysis {
  if (!text || text.trim().length === 0) {
    return {
      wordCount: 0,
      uniqueWords: 0,
      sentences: [],
      keywords: [],
    };
  }

  // Split into words
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.replace(/[^\w]/g, ''));

  const uniqueWords = new Set(words);

  // Split into sentences
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Extract keywords (simple frequency-based)
  const wordFreq = new Map<string, number>();
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up',
    'about', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'again', 'further', 'then', 'once',
    'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
    'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
    'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
  ]);

  for (const word of words) {
    if (word.length > 2 && !stopWords.has(word)) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }
  }

  // Sort by frequency and take top keywords
  const keywords = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);

  return {
    wordCount: words.length,
    uniqueWords: uniqueWords.size,
    sentences,
    keywords,
  };
}

// ============================================================================
// UTILITY
// ============================================================================
export function checkVisionAvailable(): boolean {
  if (platform() !== 'darwin') {
    return false;
  }

  try {
    // Check if Vision framework is available
    execSync('swift -e "import Vision"', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function checkTesseractAvailable(): boolean {
  try {
    execSync('tesseract --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getAvailableOCREngines(): string[] {
  const engines: string[] = [];

  if (checkVisionAvailable()) {
    engines.push('vision');
  }

  if (checkTesseractAvailable()) {
    engines.push('tesseract');
  }

  return engines;
}
