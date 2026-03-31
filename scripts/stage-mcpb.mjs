import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const DIST_ROOT = join(PROJECT_ROOT, 'dist');
const DIST_SERVER_ROOT = join(DIST_ROOT, 'mcpb', 'server');
const DIST_NODE_MODULES_ROOT = join(DIST_ROOT, 'mcpb', 'node_modules');
const DIST_BUNDLE_ROOT = join(DIST_ROOT, 'mcpb');
const PACKAGE_PATH = join(PROJECT_ROOT, 'package.json');
const DIST_ENTRYPOINT = join(DIST_ROOT, 'index.js');

main();

function main() {
  assertExists(PACKAGE_PATH, 'Missing package.json.');
  assertExists(DIST_ENTRYPOINT, 'Missing dist/index.js. Run `npm run build` first.');

  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  const manifest = buildManifest(pkg);

  rmSync(DIST_BUNDLE_ROOT, { recursive: true, force: true });
  mkdirSync(DIST_SERVER_ROOT, { recursive: true });
  mkdirSync(DIST_NODE_MODULES_ROOT, { recursive: true });

  for (const entry of readdirSync(DIST_ROOT, { withFileTypes: true })) {
    if (entry.name === 'mcpb') continue;
    cpSync(join(DIST_ROOT, entry.name), join(DIST_SERVER_ROOT, entry.name), {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
    });
  }

  for (const modulePath of getProductionModulePaths()) {
    const moduleRelativePath = relative(PROJECT_ROOT, modulePath);
    const destination = join(DIST_BUNDLE_ROOT, moduleRelativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(modulePath, destination, {
      recursive: true,
      dereference: true,
      preserveTimestamps: true,
    });
  }

  const stagePackageJson = {
    name: `${pkg.name}-desktop-extension`,
    private: true,
    version: pkg.version,
    type: 'module',
  };

  writeFileSync(join(DIST_BUNDLE_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(DIST_BUNDLE_ROOT, 'package.json'), `${JSON.stringify(stagePackageJson, null, 2)}\n`, 'utf8');

  copyIfPresent(join(PROJECT_ROOT, 'assets', 'icons', 'icons8-claude-500.png'), join(DIST_BUNDLE_ROOT, 'icon.png'));
  copyIfPresent(join(PROJECT_ROOT, 'README.md'), join(DIST_BUNDLE_ROOT, 'README.md'));

  console.log(`[mcpb] staged desktop extension bundle at ${DIST_BUNDLE_ROOT}`);
}

function buildManifest(pkg) {
  const claudePluginTools = Array.isArray(pkg['claude-plugin']?.tools)
    ? pkg['claude-plugin'].tools
    : [];
  const repo = normalizeRepository(pkg.repository);

  return {
    $schema: 'https://unpkg.com/@anthropic-ai/mcpb@latest/schemas/mcpb-manifest-latest.schema.json',
    manifest_version: '0.3',
    name: 'discoverylab',
    display_name: 'DiscoveryLab',
    version: pkg.version,
    description: 'Local DiscoveryLab MCP for Claude Desktop.',
    long_description: 'Open local AppLab projects, inspect captured flows, run DiscoveryLab setup checks, and use ESVP-native tools from Claude Desktop without manual JSON configuration.',
    author: {
      name: 'Anderson Melo',
      url: repo?.url || 'https://github.com/veolab/applab-discovery',
    },
    repository: repo || {
      type: 'git',
      url: 'https://github.com/veolab/applab-discovery',
    },
    homepage: 'https://github.com/veolab/applab-discovery',
    documentation: 'https://github.com/veolab/applab-discovery',
    support: 'https://github.com/veolab/applab-discovery/issues',
    icon: existsSync(join(PROJECT_ROOT, 'assets', 'icons', 'icons8-claude-500.png')) ? 'icon.png' : undefined,
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
    license: typeof pkg.license === 'string' ? pkg.license : 'MIT',
    compatibility: {
      platforms: ['darwin', 'win32'],
      runtimes: {
        node: pkg.engines?.node || '>=20.0.0',
      },
    },
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: {
        command: 'node',
        args: ['server/index.js'],
      },
    },
    tools: claudePluginTools.map((name) => ({ name })),
    tools_generated: false,
  };
}

function normalizeRepository(repository) {
  if (!repository) return null;
  if (typeof repository === 'string') {
    return { type: 'git', url: repository };
  }
  if (typeof repository === 'object' && typeof repository.url === 'string') {
    return {
      type: typeof repository.type === 'string' ? repository.type : 'git',
      url: repository.url,
    };
  }
  return null;
}

function getProductionModulePaths() {
  const output = execFileSync('npm', ['ls', '--omit=dev', '--parseable'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const seen = new Set();
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /(^|[\\/])node_modules([\\/]|$)/.test(line))
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
}

function copyIfPresent(source, destination) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true, preserveTimestamps: true });
}

function assertExists(path, message) {
  if (!existsSync(path)) {
    console.error(`[mcpb] ${message}`);
    process.exit(1);
  }
}
