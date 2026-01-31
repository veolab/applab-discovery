/**
 * DiscoveryLab Skills System - Dependency Gating
 *
 * Checks if skill requirements are satisfied:
 * - Binary executables (bins)
 * - Environment variables (env)
 * - Operating system (os)
 *
 * Inspired by Clawdbot's dependency gating pattern.
 */

import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import type { SkillMetadata, GatingResult, SupportedOS } from './types.js';

// ============================================================================
// BINARY CHECKING
// ============================================================================

/**
 * Check if a binary exists in PATH
 */
export function checkBinary(name: string): boolean {
  try {
    const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check multiple binaries
 */
export function checkBinaries(bins: string[]): string[] {
  return bins.filter((bin) => !checkBinary(bin));
}

// ============================================================================
// ENVIRONMENT VARIABLE CHECKING
// ============================================================================

/**
 * Check if an environment variable is set
 */
export function checkEnvVar(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value !== '';
}

/**
 * Check multiple environment variables
 */
export function checkEnvVars(envs: string[]): string[] {
  return envs.filter((env) => !checkEnvVar(env));
}

// ============================================================================
// OS CHECKING
// ============================================================================

/**
 * Get current OS as SupportedOS type
 */
export function getCurrentOS(): SupportedOS {
  const os = platform();
  if (os === 'darwin' || os === 'linux' || os === 'win32') {
    return os;
  }
  // Fallback for other Unix-like systems
  return 'linux';
}

/**
 * Check if current OS is supported
 */
export function checkOS(supportedOS: SupportedOS[]): boolean {
  const currentOS = getCurrentOS();
  return supportedOS.includes(currentOS);
}

// ============================================================================
// FULL GATING CHECK
// ============================================================================

/**
 * Check all requirements for a skill
 */
export function checkSkillRequirements(metadata: SkillMetadata): GatingResult {
  // Always available if marked as such
  if (metadata.always) {
    return {
      satisfied: true,
      missingBins: [],
      missingEnv: [],
      osUnsupported: false,
      summary: 'Skill is always available',
    };
  }

  const missingBins = metadata.requires?.bins
    ? checkBinaries(metadata.requires.bins)
    : [];

  const missingEnv = metadata.requires?.env
    ? checkEnvVars(metadata.requires.env)
    : [];

  const osUnsupported = metadata.os
    ? !checkOS(metadata.os)
    : false;

  const satisfied =
    missingBins.length === 0 &&
    missingEnv.length === 0 &&
    !osUnsupported;

  // Build summary
  const reasons: string[] = [];
  if (missingBins.length > 0) {
    reasons.push(`Missing binaries: ${missingBins.join(', ')}`);
  }
  if (missingEnv.length > 0) {
    reasons.push(`Missing env vars: ${missingEnv.join(', ')}`);
  }
  if (osUnsupported) {
    const currentOS = getCurrentOS();
    reasons.push(`OS '${currentOS}' not supported (requires: ${metadata.os?.join(', ')})`);
  }

  const summary = satisfied
    ? 'All requirements satisfied'
    : reasons.join('; ');

  return {
    satisfied,
    missingBins,
    missingEnv,
    osUnsupported,
    summary,
  };
}

// ============================================================================
// INSTALL INSTRUCTIONS
// ============================================================================

/**
 * Get install instructions for missing dependencies
 */
export function getInstallInstructions(metadata: SkillMetadata, result: GatingResult): string[] {
  const instructions: string[] = [];

  if (result.missingBins.length > 0 && metadata.install) {
    const os = getCurrentOS();

    if (os === 'darwin' && metadata.install.brew) {
      instructions.push(`brew install ${metadata.install.brew}`);
    } else if (os === 'linux' && metadata.install.apt) {
      instructions.push(`apt install ${metadata.install.apt}`);
    } else if (metadata.install.npm) {
      instructions.push(`npm install -g ${metadata.install.npm}`);
    } else if (metadata.install.manual) {
      instructions.push(metadata.install.manual);
    }
  }

  if (result.missingEnv.length > 0) {
    for (const env of result.missingEnv) {
      instructions.push(`Set environment variable: export ${env}=<value>`);
    }
  }

  return instructions;
}
