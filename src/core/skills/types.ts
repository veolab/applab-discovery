/**
 * DiscoveryLab Skills System - Types
 *
 * Inspired by Clawdbot's SKILL.md pattern.
 * Skills are self-describing tools with metadata and dependency gating.
 */

// ============================================================================
// SKILL METADATA (YAML frontmatter in SKILL.md)
// ============================================================================

export interface SkillRequirements {
  /** Required binary executables (e.g., ['ffmpeg', 'maestro']) */
  bins?: string[];

  /** Required environment variables (e.g., ['ANTHROPIC_API_KEY']) */
  env?: string[];

  /** Required npm packages (for runtime checking) */
  packages?: string[];
}

export interface SkillInstallInfo {
  /** Homebrew package name */
  brew?: string;

  /** APT package name */
  apt?: string;

  /** npm package name */
  npm?: string;

  /** Manual install instructions */
  manual?: string;
}

export interface SkillMetadata {
  /** Unique skill name (e.g., 'maestro', 'playwright') */
  name: string;

  /** Short description for tool listing */
  description: string;

  /** Emoji icon for UI display */
  emoji?: string;

  /** Version string */
  version?: string;

  /** Author name */
  author?: string;

  /** Skill category */
  category?: SkillCategory;

  /** Dependency requirements */
  requires?: SkillRequirements;

  /** Supported operating systems */
  os?: SupportedOS[];

  /** Always load regardless of dependencies */
  always?: boolean;

  /** Installation instructions */
  install?: SkillInstallInfo;

  /** Related tools exported by this skill */
  tools?: string[];

  /** Tags for discovery */
  tags?: string[];
}

export type SkillCategory =
  | 'testing'
  | 'capture'
  | 'analyze'
  | 'export'
  | 'canvas'
  | 'integrations'
  | 'ui'
  | 'project'
  | 'setup';

export type SupportedOS = 'darwin' | 'linux' | 'win32';

// ============================================================================
// SKILL DEFINITION
// ============================================================================

export interface Skill {
  /** Parsed metadata from SKILL.md frontmatter */
  metadata: SkillMetadata;

  /** Full markdown content (instructions) */
  content: string;

  /** Path to SKILL.md file */
  path: string;

  /** Whether skill is currently available (deps satisfied) */
  available: boolean;

  /** Reasons why skill is unavailable */
  unavailableReasons?: string[];
}

// ============================================================================
// SKILL LOADING RESULT
// ============================================================================

export interface SkillLoadResult {
  /** Successfully loaded skills */
  loaded: Skill[];

  /** Skills that failed to load */
  failed: Array<{
    path: string;
    error: string;
  }>;

  /** Skills unavailable due to missing dependencies */
  unavailable: Skill[];
}

// ============================================================================
// SKILL GATING RESULT
// ============================================================================

export interface GatingResult {
  /** Whether all requirements are met */
  satisfied: boolean;

  /** Missing binary executables */
  missingBins: string[];

  /** Missing environment variables */
  missingEnv: string[];

  /** OS mismatch */
  osUnsupported: boolean;

  /** Human-readable summary */
  summary: string;
}

// ============================================================================
// SKILL REGISTRY
// ============================================================================

export interface SkillRegistry {
  /** All discovered skills */
  skills: Map<string, Skill>;

  /** Get available skills only */
  getAvailable(): Skill[];

  /** Get skill by name */
  get(name: string): Skill | undefined;

  /** Check if skill is available */
  isAvailable(name: string): boolean;

  /** Reload all skills */
  reload(): Promise<SkillLoadResult>;
}
