/**
 * DiscoveryLab Skills System - SKILL.md Parser
 *
 * Parses SKILL.md files with YAML frontmatter.
 *
 * Format:
 * ```
 * ---
 * name: skill-name
 * description: Brief description
 * emoji: "🎯"
 * requires:
 *   bins: [ffmpeg]
 *   env: [API_KEY]
 * os: [darwin, linux]
 * ---
 *
 * # Skill Instructions
 *
 * Markdown content...
 * ```
 */

import { readFile } from 'node:fs/promises';
import type { SkillMetadata } from './types.js';

// ============================================================================
// SIMPLE YAML PARSER (for frontmatter only)
// ============================================================================

/**
 * Simple YAML parser for SKILL.md frontmatter
 * Supports: strings, numbers, booleans, arrays, nested objects
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  const stack: { obj: Record<string, unknown>; indent: number }[] = [{ obj: result, indent: -1 }];

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const match = line.match(/^(\s*)([^:]+):\s*(.*)$/);
    if (!match) continue;

    const [, spaces, key, rawValue] = match;
    const indent = spaces.length;
    const trimmedKey = key.trim();
    const value = rawValue.trim();

    // Pop stack until we find the right parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const current = stack[stack.length - 1].obj;

    // Handle different value types
    if (value === '') {
      // Nested object - create and push to stack
      const nested: Record<string, unknown> = {};
      current[trimmedKey] = nested;
      stack.push({ obj: nested, indent });
    } else if (value.startsWith('[') && value.endsWith(']')) {
      // Array: [item1, item2]
      const arrayContent = value.slice(1, -1);
      current[trimmedKey] = arrayContent
        .split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0)
        .map((s: string) => parseYamlValue(s));
    } else {
      current[trimmedKey] = parseYamlValue(value);
    }
  }

  return result;
}

/**
 * Parse a single YAML value
 */
function parseYamlValue(value: string): unknown {
  // Remove quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Null
  if (value === 'null' || value === '~') return null;

  // Number
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;

  // String
  return value;
}

// ============================================================================
// FRONTMATTER PARSER
// ============================================================================

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedSkillMd {
  metadata: SkillMetadata;
  content: string;
}

/**
 * Parse SKILL.md file content
 */
export function parseSkillMd(fileContent: string, filePath: string): ParsedSkillMd {
  const match = fileContent.match(FRONTMATTER_REGEX);

  if (!match) {
    throw new Error(`Invalid SKILL.md format: missing YAML frontmatter in ${filePath}`);
  }

  const [, yamlContent, markdownContent] = match;

  let metadata: SkillMetadata;
  try {
    const parsed = parseSimpleYaml(yamlContent);
    metadata = parsed as unknown as SkillMetadata;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to parse YAML frontmatter in ${filePath}: ${msg}`);
  }

  // Validate required fields
  if (!metadata.name) {
    throw new Error(`Missing required field 'name' in ${filePath}`);
  }
  if (!metadata.description) {
    throw new Error(`Missing required field 'description' in ${filePath}`);
  }

  // Normalize arrays
  if (metadata.requires) {
    if (metadata.requires.bins && !Array.isArray(metadata.requires.bins)) {
      metadata.requires.bins = [metadata.requires.bins];
    }
    if (metadata.requires.env && !Array.isArray(metadata.requires.env)) {
      metadata.requires.env = [metadata.requires.env];
    }
    if (metadata.requires.packages && !Array.isArray(metadata.requires.packages)) {
      metadata.requires.packages = [metadata.requires.packages];
    }
  }

  if (metadata.os && !Array.isArray(metadata.os)) {
    metadata.os = [metadata.os];
  }

  if (metadata.tools && !Array.isArray(metadata.tools)) {
    metadata.tools = [metadata.tools];
  }

  if (metadata.tags && !Array.isArray(metadata.tags)) {
    metadata.tags = [metadata.tags];
  }

  return {
    metadata,
    content: markdownContent.trim(),
  };
}

/**
 * Read and parse SKILL.md file from disk
 */
export async function readSkillMd(filePath: string): Promise<ParsedSkillMd> {
  const content = await readFile(filePath, 'utf-8');
  return parseSkillMd(content, filePath);
}

// ============================================================================
// SKILL.MD GENERATOR
// ============================================================================

/**
 * Generate SKILL.md content from metadata
 */
export function generateSkillMd(metadata: SkillMetadata, content: string): string {
  const yaml = generateYamlFrontmatter(metadata);
  return `---\n${yaml}---\n\n${content}`;
}

function generateYamlFrontmatter(metadata: SkillMetadata): string {
  const lines: string[] = [];

  lines.push(`name: ${metadata.name}`);
  lines.push(`description: "${metadata.description}"`);

  if (metadata.emoji) {
    lines.push(`emoji: "${metadata.emoji}"`);
  }

  if (metadata.version) {
    lines.push(`version: "${metadata.version}"`);
  }

  if (metadata.author) {
    lines.push(`author: "${metadata.author}"`);
  }

  if (metadata.category) {
    lines.push(`category: ${metadata.category}`);
  }

  if (metadata.requires) {
    lines.push('requires:');
    if (metadata.requires.bins?.length) {
      lines.push(`  bins: [${metadata.requires.bins.join(', ')}]`);
    }
    if (metadata.requires.env?.length) {
      lines.push(`  env: [${metadata.requires.env.join(', ')}]`);
    }
    if (metadata.requires.packages?.length) {
      lines.push(`  packages: [${metadata.requires.packages.join(', ')}]`);
    }
  }

  if (metadata.os?.length) {
    lines.push(`os: [${metadata.os.join(', ')}]`);
  }

  if (metadata.always) {
    lines.push('always: true');
  }

  if (metadata.install) {
    lines.push('install:');
    if (metadata.install.brew) {
      lines.push(`  brew: ${metadata.install.brew}`);
    }
    if (metadata.install.apt) {
      lines.push(`  apt: ${metadata.install.apt}`);
    }
    if (metadata.install.npm) {
      lines.push(`  npm: ${metadata.install.npm}`);
    }
    if (metadata.install.manual) {
      lines.push(`  manual: "${metadata.install.manual}"`);
    }
  }

  if (metadata.tools?.length) {
    lines.push(`tools: [${metadata.tools.join(', ')}]`);
  }

  if (metadata.tags?.length) {
    lines.push(`tags: [${metadata.tags.join(', ')}]`);
  }

  return lines.join('\n') + '\n';
}
