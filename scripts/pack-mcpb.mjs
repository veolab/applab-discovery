import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const STAGE_ROOT = join(PROJECT_ROOT, 'dist', 'mcpb');
const RELEASES_ROOT = join(PROJECT_ROOT, 'dist', 'releases');

main();

function main() {
  if (!existsSync(join(STAGE_ROOT, 'manifest.json'))) {
    console.error('[mcpb] Missing dist/mcpb/manifest.json. Run `npm run mcpb:stage` first.');
    process.exit(1);
  }

  rmSync(RELEASES_ROOT, { recursive: true, force: true });
  mkdirSync(RELEASES_ROOT, { recursive: true });

  const result = spawnSync('npx', ['-y', '@anthropic-ai/mcpb', 'pack'], {
    cwd: STAGE_ROOT,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  const producedBundles = readdirSync(STAGE_ROOT)
    .filter((name) => name.endsWith('.mcpb'))
    .sort();

  if (producedBundles.length === 0) {
    console.error('[mcpb] `mcpb pack` completed but no .mcpb file was produced.');
    process.exit(1);
  }

  const bundleName = producedBundles[producedBundles.length - 1];
  const manifest = JSON.parse(readFileSync(join(STAGE_ROOT, 'manifest.json'), 'utf8'));
  const outputName = `${manifest.name || 'discoverylab'}-${manifest.version || '0.0.0'}.mcpb`;
  const source = join(STAGE_ROOT, bundleName);
  const destination = join(RELEASES_ROOT, outputName);
  renameSync(source, destination);

  console.log(`[mcpb] bundle ready at ${destination}`);
}
