/**
 * Template Bundle Loader
 *
 * Search order:
 * 1. Explicit override: DISCOVERYLAB_TEMPLATE_DIR or DISCOVERYLAB_TEMPLATE_SOURCE_DIR
 * 2. Bundled with npm package: <package>/dist/templates/
 * 3. Local legacy override: ~/.discoverylab/templates/
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

// tsup currently bundles this module into dist/chunk-*.js, but other build
// layouts may preserve the original dist/core/templates/loader.js path.
// Search a few likely bundled locations relative to the runtime module.
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_TEMPLATES_DIR_CANDIDATES = [
  join(__dirname, 'templates'),
  join(__dirname, '..', 'templates'),
  join(__dirname, '..', '..', 'templates'),
];

let cachedManifest: TemplateManifest | null = null;
let cachedTemplatesDir: string | null = null;
let cachedAt = 0;
const CACHE_TTL = 30_000; // 30s

/**
 * Find the templates directory.
 * Priority: explicit override > bundled (dist/templates/) > legacy local override
 */
function resolveTemplatesDir(): string | null {
  // 1. Explicit override
  const explicitOverride = process.env.DISCOVERYLAB_TEMPLATE_DIR?.trim()
    || process.env.DISCOVERYLAB_TEMPLATE_SOURCE_DIR?.trim();
  if (explicitOverride) {
    const overrideManifest = join(explicitOverride, MANIFEST_FILE);
    const overrideBundle = join(explicitOverride, BUNDLE_DIR);
    if (existsSync(overrideManifest) && existsSync(overrideBundle)) {
      return explicitOverride;
    }
  }

  // 2. Bundled with npm package
  for (const candidate of BUNDLED_TEMPLATES_DIR_CANDIDATES) {
    const bundledManifest = join(candidate, MANIFEST_FILE);
    const bundledBundle = join(candidate, BUNDLE_DIR);
    if (existsSync(bundledManifest) && existsSync(bundledBundle)) {
      return candidate;
    }
  }

  // 3. Local legacy override (user-installed or dev)
  const localManifest = join(TEMPLATES_DIR, MANIFEST_FILE);
  const localBundle = join(TEMPLATES_DIR, BUNDLE_DIR);
  if (existsSync(localManifest) && existsSync(localBundle)) {
    return TEMPLATES_DIR;
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
