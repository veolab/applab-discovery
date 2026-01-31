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

/**
 * Analyze screenshots to detect user actions using Claude Vision
 */
export async function analyzeScreenshotsForActions(
  screenshotsDir: string,
  maxScreenshots: number = 20
): Promise<AnalysisResult> {
  // Check for API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[AIActionDetector] ⚠️ ANTHROPIC_API_KEY not set - AI analysis unavailable');
    console.warn('[AIActionDetector] Set your API key to enable automatic action detection from screenshots');
    return {
      actions: [],
      summary: 'API key not configured',
      skipped: true
    };
  }

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

  console.log(`[AIActionDetector] Analyzing ${selectedFiles.length} screenshots...`);

  try {
    const anthropic = new Anthropic({ apiKey });

    // Prepare image content for Claude
    const imageContents: Anthropic.ImageBlockParam[] = selectedFiles.map(file => {
      const imagePath = join(screenshotsDir, file);
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

    // Create the analysis prompt
    const prompt = `You are analyzing a sequence of ${selectedFiles.length} mobile app screenshots taken during a user testing session. Your task is to detect what actions the user performed between each screenshot.

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
Focus on meaningful interactions, not every tiny change.`;

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

    // Parse the response
    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from Claude');
    }

    // Extract JSON from response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse JSON from response');
    }

    const result = JSON.parse(jsonMatch[0]) as AnalysisResult;
    console.log(`[AIActionDetector] Detected ${result.actions.length} actions`);

    return result;

  } catch (error) {
    console.error('[AIActionDetector] Analysis failed:', error);
    return {
      actions: [],
      summary: `AI analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
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
