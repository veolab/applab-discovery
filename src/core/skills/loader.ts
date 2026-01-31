/**
 * DiscoveryLab Skills System - Loader
 *
 * Discovers and loads SKILL.md files from various locations:
 * 1. Bundled skills: src/mcp/tools/[name]/SKILL.md
 * 2. User skills: ~/.discoverylab/skills/[name]/SKILL.md
 * 3. Workspace skills: ./.discoverylab/skills/[name]/SKILL.md
 *
 * Inspired by Clawdbot's hierarchical skill loading.
 */

import { readdir, stat, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Skill, SkillLoadResult, SkillRegistry } from './types.js';
import { readSkillMd } from './parser.js';
import { checkSkillRequirements, getInstallInstructions } from './gating.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Bundled skills directory (relative to this file) */
const BUNDLED_SKILLS_DIR = join(__dirname, '../../mcp/tools');

/** User skills directory */
const USER_SKILLS_DIR = join(homedir(), '.discoverylab', 'skills');

/** Workspace skills directory (relative to cwd) */
const WORKSPACE_SKILLS_DIR = join(process.cwd(), '.discoverylab', 'skills');

// ============================================================================
// SKILL DISCOVERY
// ============================================================================

/**
 * Check if a path exists
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find SKILL.md files in a directory
 */
async function findSkillFiles(baseDir: string): Promise<string[]> {
  const skillFiles: string[] = [];

  if (!(await pathExists(baseDir))) {
    return skillFiles;
  }

  try {
    const entries = await readdir(baseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = join(baseDir, entry.name, 'SKILL.md');
        if (await pathExists(skillPath)) {
          skillFiles.push(skillPath);
        }
      }
    }
  } catch {
    // Ignore errors reading directory
  }

  return skillFiles;
}

/**
 * Discover all skill files from all locations
 */
async function discoverSkillFiles(): Promise<{
  bundled: string[];
  user: string[];
  workspace: string[];
}> {
  const [bundled, user, workspace] = await Promise.all([
    findSkillFiles(BUNDLED_SKILLS_DIR),
    findSkillFiles(USER_SKILLS_DIR),
    findSkillFiles(WORKSPACE_SKILLS_DIR),
  ]);

  return { bundled, user, workspace };
}

// ============================================================================
// SKILL LOADING
// ============================================================================

/**
 * Load a single skill from SKILL.md
 */
async function loadSkill(skillPath: string): Promise<Skill> {
  const { metadata, content } = await readSkillMd(skillPath);

  // Check requirements
  const gatingResult = checkSkillRequirements(metadata);

  const skill: Skill = {
    metadata,
    content,
    path: skillPath,
    available: gatingResult.satisfied,
  };

  if (!gatingResult.satisfied) {
    skill.unavailableReasons = [];

    if (gatingResult.missingBins.length > 0) {
      skill.unavailableReasons.push(`Missing binaries: ${gatingResult.missingBins.join(', ')}`);
    }
    if (gatingResult.missingEnv.length > 0) {
      skill.unavailableReasons.push(`Missing env vars: ${gatingResult.missingEnv.join(', ')}`);
    }
    if (gatingResult.osUnsupported) {
      skill.unavailableReasons.push(gatingResult.summary);
    }

    // Add install instructions if available
    const instructions = getInstallInstructions(metadata, gatingResult);
    if (instructions.length > 0) {
      skill.unavailableReasons.push(`Install: ${instructions.join(' && ')}`);
    }
  }

  return skill;
}

/**
 * Load all skills from discovered files
 * Later sources override earlier ones (workspace > user > bundled)
 */
export async function loadSkills(): Promise<SkillLoadResult> {
  const result: SkillLoadResult = {
    loaded: [],
    failed: [],
    unavailable: [],
  };

  const { bundled, user, workspace } = await discoverSkillFiles();

  // Process in order: bundled first, then user, then workspace
  // Later ones with same name will override
  const allPaths = [...bundled, ...user, ...workspace];
  const skillsByName = new Map<string, Skill>();

  for (const path of allPaths) {
    try {
      const skill = await loadSkill(path);
      skillsByName.set(skill.metadata.name, skill);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      result.failed.push({ path, error: msg });
    }
  }

  // Separate available and unavailable
  for (const skill of skillsByName.values()) {
    if (skill.available) {
      result.loaded.push(skill);
    } else {
      result.unavailable.push(skill);
    }
  }

  return result;
}

// ============================================================================
// SKILL REGISTRY
// ============================================================================

/**
 * Create a skill registry
 */
export function createSkillRegistry(): SkillRegistry {
  const skills = new Map<string, Skill>();

  return {
    skills,

    getAvailable(): Skill[] {
      return Array.from(skills.values()).filter((s) => s.available);
    },

    get(name: string): Skill | undefined {
      return skills.get(name);
    },

    isAvailable(name: string): boolean {
      const skill = skills.get(name);
      return skill?.available ?? false;
    },

    async reload(): Promise<SkillLoadResult> {
      skills.clear();
      const result = await loadSkills();

      for (const skill of [...result.loaded, ...result.unavailable]) {
        skills.set(skill.metadata.name, skill);
      }

      return result;
    },
  };
}

// ============================================================================
// SINGLETON REGISTRY
// ============================================================================

let globalRegistry: SkillRegistry | null = null;

/**
 * Get the global skill registry (lazy initialization)
 */
export async function getSkillRegistry(): Promise<SkillRegistry> {
  if (!globalRegistry) {
    globalRegistry = createSkillRegistry();
    await globalRegistry.reload();
  }
  return globalRegistry;
}

/**
 * Reload the global skill registry
 */
export async function reloadSkillRegistry(): Promise<SkillLoadResult> {
  if (!globalRegistry) {
    globalRegistry = createSkillRegistry();
  }
  return globalRegistry.reload();
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get skill info for display
 */
export function formatSkillInfo(skill: Skill): string {
  const lines: string[] = [];

  const statusIcon = skill.available ? '✓' : '✗';
  const emoji = skill.metadata.emoji || '📦';

  lines.push(`${emoji} ${skill.metadata.name} [${statusIcon}]`);
  lines.push(`   ${skill.metadata.description}`);

  if (skill.metadata.version) {
    lines.push(`   Version: ${skill.metadata.version}`);
  }

  if (skill.metadata.requires) {
    if (skill.metadata.requires.bins?.length) {
      lines.push(`   Requires: ${skill.metadata.requires.bins.join(', ')}`);
    }
    if (skill.metadata.requires.env?.length) {
      lines.push(`   Env vars: ${skill.metadata.requires.env.join(', ')}`);
    }
  }

  if (!skill.available && skill.unavailableReasons?.length) {
    lines.push(`   ⚠ ${skill.unavailableReasons.join('\n   ⚠ ')}`);
  }

  return lines.join('\n');
}

/**
 * List all skills with their status
 */
export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) {
    return 'No skills found';
  }

  const available = skills.filter((s) => s.available);
  const unavailable = skills.filter((s) => !s.available);

  const lines: string[] = [];

  if (available.length > 0) {
    lines.push('Available Skills:');
    for (const skill of available) {
      const emoji = skill.metadata.emoji || '📦';
      lines.push(`  ${emoji} ${skill.metadata.name} - ${skill.metadata.description}`);
    }
  }

  if (unavailable.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Unavailable Skills (missing dependencies):');
    for (const skill of unavailable) {
      const emoji = skill.metadata.emoji || '📦';
      lines.push(`  ${emoji} ${skill.metadata.name} - ${skill.metadata.description}`);
      if (skill.unavailableReasons?.length) {
        lines.push(`     ⚠ ${skill.unavailableReasons[0]}`);
      }
    }
  }

  return lines.join('\n');
}
