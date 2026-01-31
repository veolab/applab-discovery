/**
 * DiscoveryLab Skills System
 *
 * A skill system inspired by Clawdbot's SKILL.md pattern.
 *
 * Features:
 * - SKILL.md files with YAML frontmatter for metadata
 * - Dependency gating (bins, env vars, OS)
 * - Hierarchical loading (bundled < user < workspace)
 * - Auto-discovery of skills
 *
 * Usage:
 *   import { getSkillRegistry, formatSkillList } from './skills';
 *
 *   // Get the registry
 *   const registry = await getSkillRegistry();
 *
 *   // List available skills
 *   const skills = registry.getAvailable();
 *   console.log(formatSkillList(skills));
 *
 *   // Check if a specific skill is available
 *   if (registry.isAvailable('maestro')) {
 *     // Use maestro tools
 *   }
 */

export * from './types.js';
export * from './parser.js';
export * from './gating.js';
export {
  loadSkills,
  createSkillRegistry,
  getSkillRegistry,
  reloadSkillRegistry,
  formatSkillInfo,
  formatSkillList,
} from './loader.js';
