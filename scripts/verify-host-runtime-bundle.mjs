import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const MANIFEST_PATH = join(PROJECT_ROOT, 'dist', 'runtime', 'esvp-host-runtime', 'manifest.json');

main();

function main() {
  if (!existsSync(MANIFEST_PATH)) {
    exitWithMessage('Missing dist/runtime/esvp-host-runtime/manifest.json. Build and stage the host runtime before publishing.');
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (error) {
    exitWithMessage(`Failed to read host runtime manifest: ${error instanceof Error ? error.message : String(error)}`);
  }

  const targets = manifest?.targets && typeof manifest.targets === 'object'
    ? Object.entries(manifest.targets)
    : [];
  if (targets.length === 0) {
    exitWithMessage('Host runtime manifest does not list any bundled targets.');
  }

  for (const [target, targetInfo] of targets) {
    const relativePath = targetInfo && typeof targetInfo === 'object' ? targetInfo.path : null;
    if (typeof relativePath !== 'string' || !relativePath.trim()) {
      exitWithMessage(`Host runtime manifest target ${target} is missing its binary path.`);
    }

    const binaryPath = join(PROJECT_ROOT, 'dist', 'runtime', 'esvp-host-runtime', relativePath);
    if (!existsSync(binaryPath)) {
      exitWithMessage(`Bundled host runtime binary missing for ${target}: ${binaryPath}`);
    }
  }

  console.log(`[esvp-host-runtime] verified ${targets.length} bundled target(s) in dist/runtime/esvp-host-runtime`);
}

function exitWithMessage(message) {
  console.error(`[esvp-host-runtime] ${message}`);
  process.exit(1);
}
