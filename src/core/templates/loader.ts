/**
 * Template Bundle Loader
 *
 * Search order:
 * 1. Bundled with npm package: <package>/dist/templates/
 * 2. Local override: ~/.discoverylab/templates/
 *
 * This allows templates to ship with the npm package (compiled bundle,
 * source code protected) while also supporting local dev/override.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES_DIR } from '../../db/index.js';
import type { TemplateManifest, TemplateInfo, TemplateId } from './types.js';

const MANIFEST_FILE = 'manifest.json';
const BUNDLE_DIR = 'bundle';

// Resolve the bundled templates path relative to this file
// In built package: dist/core/templates/loader.js → dist/templates/
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_TEMPLATES_DIR = join(__dirname, '..', '..', 'templates');

let cachedManifest: TemplateManifest | null = null;
let cachedTemplatesDir: string | null = null;
let cachedAt = 0;
const CACHE_TTL = 30_000; // 30s

/**
 * Find the templates directory.
 * Priority: local override (~/.discoverylab/templates/) > bundled (dist/templates/)
 */
function resolveTemplatesDir(): string | null {
  // 1. Local override (user-installed or dev)
  const localManifest = join(TEMPLATES_DIR, MANIFEST_FILE);
  const localBundle = join(TEMPLATES_DIR, BUNDLE_DIR);
  if (existsSync(localManifest) && existsSync(localBundle)) {
    return TEMPLATES_DIR;
  }

  // 2. Bundled with npm package
  const bundledManifest = join(BUNDLED_TEMPLATES_DIR, MANIFEST_FILE);
  const bundledBundle = join(BUNDLED_TEMPLATES_DIR, BUNDLE_DIR);
  if (existsSync(bundledManifest) && existsSync(bundledBundle)) {
    return BUNDLED_TEMPLATES_DIR;
  }

  return null;
}

/**
 * Load the template manifest from disk.
 * Returns null if templates are not available.
 */
export function loadManifest(): TemplateManifest | null {
  const now = Date.now();
  if (cachedManifest && now - cachedAt < CACHE_TTL) {
    return cachedManifest;
  }

  const dir = resolveTemplatesDir();
  if (!dir) {
    cachedManifest = null;
    cachedTemplatesDir = null;
    cachedAt = now;
    return null;
  }

  try {
    const raw = readFileSync(join(dir, MANIFEST_FILE), 'utf-8');
    const manifest: TemplateManifest = JSON.parse(raw);
    cachedManifest = manifest;
    cachedTemplatesDir = dir;
    cachedAt = now;
    return manifest;
  } catch {
    cachedManifest = null;
    cachedTemplatesDir = null;
    cachedAt = now;
    return null;
  }
}

/**
 * Check if templates are available (bundled or installed)
 */
export function isTemplatesInstalled(): boolean {
  return loadManifest() !== null;
}

/**
 * Get list of available templates
 */
export function getAvailableTemplates(): TemplateInfo[] {
  const manifest = loadManifest();
  return manifest?.templates ?? [];
}

/**
 * Get a specific template by ID
 */
export function getTemplate(id: TemplateId): TemplateInfo | null {
  const templates = getAvailableTemplates();
  return templates.find(t => t.id === id) ?? null;
}

/**
 * Get the Remotion bundle path for rendering
 */
export function getBundlePath(): string | null {
  // Ensure manifest is loaded (sets cachedTemplatesDir)
  loadManifest();
  if (!cachedTemplatesDir) return null;
  const bundlePath = join(cachedTemplatesDir, BUNDLE_DIR);
  if (!existsSync(bundlePath)) return null;
  return bundlePath;
}

/**
 * Invalidate the cached manifest (e.g. after install)
 */
export function invalidateManifestCache(): void {
  cachedManifest = null;
  cachedTemplatesDir = null;
  cachedAt = 0;
}
