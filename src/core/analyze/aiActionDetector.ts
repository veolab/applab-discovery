/**
 * AI-Powered Action Detector
 * Analyzes screenshots to detect user actions and generate Maestro YAML
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

interface DetectedAction {
  type: 'tap' | 'swipe' | 'scroll' | 'type' | 'wait' | 'launch' | 'back';
  description: string;
  element?: string;
  text?: string;
  coordinates?: { x: number; y: number };
  direction?: 'up' | 'down' | 'left' | 'right';
  confidence: number;
}

interface AnalysisResult {
  actions: DetectedAction[];
  appName?: string;
  summary: string;
  skipped?: boolean;
}

export interface ActionDetectorProvider {
  name: string;
  sendMessageWithImages?: (prompt: string, imagePaths: string[]) => Promise<string>;
  sendMessage?: (prompt: string) => Promise<string>;
}

/**
 * Build the analysis prompt for a given number of screenshots
 */
function buildAnalysisPrompt(screenshotCount: number): string {
  return `You are analyzing a sequence of ${screenshotCount} mobile app screenshots taken during a user testing session. Your task is to detect what actions the user performed between each screenshot.

Analyze the visual changes between consecutive screenshots and identify:
1. Taps on buttons, links, or UI elements
2. Text input in fields
3. Scroll/swipe gestures
4. Navigation actions (back, etc.)
5. App launches or screen transitions

For each detected action, determine:
- The type of action (tap, type, scroll, swipe, back, launch, wait)
- A description of what element was interacted with
- The approximate screen coordinates if it's a tap (as percentage of screen, e.g., x: 50, y: 30 means center-top)
- Any text that was typed
- Scroll/swipe direction

Respond in JSON format:
{
  "appName": "detected app name or null",
  "actions": [
    {
      "type": "tap|type|scroll|swipe|back|launch|wait",
      "description": "what the action does",
      "element": "button text or element description",
      "text": "typed text if type action",
      "coordinates": {"x": 50, "y": 75},
      "direction": "up|down|left|right for scroll/swipe",
      "confidence": 0.0-1.0
    }
  ],
  "summary": "brief summary of the user flow"
}

  Be conservative - only include actions you're confident about (confidence > 0.7).
  Focus on meaningful interactions, not every tiny change.
  Return ONLY valid JSON (no Markdown, no code fences, no extra commentary).`;
}

/**
 * Parse JSON analysis result from raw LLM response text
 */
function sanitizePreview(text: string, maxLength = 400): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty response)';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function extractCodeFenceCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  while ((match = fenceRegex.exec(text)) !== null) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  return candidates;
}

function extractBraceObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1).trim();
        if (candidate) candidates.push(candidate);
        start = -1;
      }
    }
  }

  return candidates;
}

function coerceAnalysisResult(parsed: unknown): AnalysisResult {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Parsed response is not an object');
  }

  const obj = parsed as Partial<AnalysisResult>;
  return {
    actions: Array.isArray(obj.actions) ? obj.actions : [],
    appName: typeof obj.appName === 'string' ? obj.appName : undefined,
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    skipped: typeof obj.skipped === 'boolean' ? obj.skipped : undefined,
  };
}

function parseAnalysisResponse(text: string): AnalysisResult {
  const raw = String(text || '').trim();
  if (!raw) {
    throw new Error('Could not parse JSON from response (empty response)');
  }

  const candidates: string[] = [raw, ...extractCodeFenceCandidates(raw), ...extractBraceObjectCandidates(raw)];
  const seen = new Set<string>();
  let lastError: unknown = null;

  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      return coerceAnalysisResult(JSON.parse(normalized));
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : 'unknown parse error';
  throw new Error(`Could not parse JSON from response (${detail}). Preview: ${sanitizePreview(raw)}`);
}

/**
 * Analyze screenshots using Anthropic API with vision (base64 images)
 */
async function analyzeWithAnthropicVision(
  apiKey: string,
  screenshotPaths: string[],
  prompt: string
): Promise<AnalysisResult> {
  const anthropic = new Anthropic({ apiKey });

  const imageContents: Anthropic.ImageBlockParam[] = screenshotPaths.map(imagePath => {
    const imageData = readFileSync(imagePath);
    const base64 = imageData.toString('base64');
    return {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: base64
      }
    };
  });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          ...imageContents,
          { type: 'text', text: prompt }
        ]
      }
    ]
  });

  const textContent = response.content.find(c => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  return parseAnalysisResponse(textContent.text);
}

/**
 * Analyze screenshots to detect user actions using Claude Vision
 */
export async function analyzeScreenshotsForActions(
  screenshotsDir: string,
  maxScreenshots: number = 20,
  provider?: ActionDetectorProvider | ActionDetectorProvider[]
): Promise<AnalysisResult> {
  // Get sorted screenshot files
  const files = readdirSync(screenshotsDir)
    .filter(f => f.endsWith('.png'))
    .sort();

  if (files.length < 2) {
    return {
      actions: [],
      summary: 'Not enough screenshots for action detection'
    };
  }

  // Sample screenshots if too many
  const selectedFiles = files.length > maxScreenshots
    ? sampleArray(files, maxScreenshots)
    : files;

  const screenshotPaths = selectedFiles.map(file => join(screenshotsDir, file));
  const prompt = buildAnalysisPrompt(selectedFiles.length);
  const providerCandidates = (Array.isArray(provider) ? provider : [provider]).filter(
    (p): p is ActionDetectorProvider => !!p
  );

  console.log(`[AIActionDetector] Analyzing ${selectedFiles.length} screenshots...`);
  const strategyErrors: string[] = [];

  // Strategy 1: Anthropic API vision (fastest — single call with base64 images)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      console.log('[AIActionDetector] Using Anthropic API vision (fast path)');
      const result = await analyzeWithAnthropicVision(apiKey, screenshotPaths, prompt);
      console.log(`[AIActionDetector] Detected ${result.actions.length} actions`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      strategyErrors.push(`anthropic-api vision: ${message}`);
      console.warn(`[AIActionDetector] Anthropic vision failed: ${message}`);
    }
  }

  // Strategy 2+: Provider with image support (e.g. Claude CLI, Ollama vision)
  for (const candidate of providerCandidates) {
    if (!candidate.sendMessageWithImages) continue;
    try {
      console.log(`[AIActionDetector] Using provider: ${candidate.name} (image support)`);
      const response = await candidate.sendMessageWithImages(prompt, screenshotPaths);
      const result = parseAnalysisResponse(response);
      console.log(`[AIActionDetector] Detected ${result.actions.length} actions`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      strategyErrors.push(`${candidate.name}: ${message}`);
      console.warn(`[AIActionDetector] Provider failed (${candidate.name}): ${message}`);
    }
  }

  if (strategyErrors.length > 0) {
    const combined = strategyErrors.slice(0, 3).join(' | ');
    console.error('[AIActionDetector] Analysis failed across all vision strategies:', combined);
    return {
      actions: [],
      summary: `AI analysis failed: ${combined}`
    };
  }

  console.warn('[AIActionDetector] ⚠️ No vision-capable provider available');
  console.warn('[AIActionDetector] Set ANTHROPIC_API_KEY, ensure Claude CLI is available, or configure a vision-capable Ollama model');
  return {
    actions: [],
    summary: 'No vision-capable AI provider available',
    skipped: true
  };
}

/**
 * Convert detected actions to Maestro YAML format
 */
export function generateMaestroYaml(
  actions: DetectedAction[],
  appId?: string,
  appName?: string
): string {
  const lines: string[] = [
    `# Auto-generated Maestro test flow`,
    `# Generated by DiscoveryLab AI Action Detector`,
    `# ${new Date().toISOString()}`,
    '',
    'appId: ' + (appId || 'com.example.app # TODO: Set your app ID'),
    ''
  ];

  if (appName) {
    lines.push(`# App: ${appName}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  for (const action of actions) {
    if (action.confidence < 0.7) continue;

    switch (action.type) {
      case 'launch':
        lines.push(`- launchApp`);
        break;

      case 'tap':
        if (action.element) {
          // Try to tap by text first
          lines.push(`- tapOn:`);
          lines.push(`    text: "${escapeYaml(action.element)}"`);
        } else if (action.coordinates) {
          // Fall back to coordinates
          lines.push(`- tapOn:`);
          lines.push(`    point: "${action.coordinates.x}%,${action.coordinates.y}%"`);
        }
        break;

      case 'type':
        if (action.text) {
          lines.push(`- inputText: "${escapeYaml(action.text)}"`);
        }
        break;

      case 'scroll':
      case 'swipe':
        if (action.direction) {
          const direction = action.direction === 'up' ? 'DOWN'
            : action.direction === 'down' ? 'UP'
            : action.direction === 'left' ? 'RIGHT'
            : 'LEFT';
          lines.push(`- scroll:`);
          lines.push(`    direction: ${direction}`);
        }
        break;

      case 'back':
        lines.push(`- pressKey: back`);
        break;

      case 'wait':
        lines.push(`- extendedWaitUntil:`);
        lines.push(`    visible: ".*"`);
        lines.push(`    timeout: 5000`);
        break;
    }

    // Add comment describing the action
    if (action.description) {
      lines[lines.length - 1] += ` # ${action.description}`;
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Sample array evenly
 */
function sampleArray<T>(arr: T[], count: number): T[] {
  if (arr.length <= count) return arr;

  const result: T[] = [];
  const step = (arr.length - 1) / (count - 1);

  for (let i = 0; i < count; i++) {
    const index = Math.round(i * step);
    result.push(arr[index]);
  }

  return result;
}

/**
 * Escape string for YAML
 */
function escapeYaml(str: string): string {
  return str.replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
