import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const RUNTIME_ROOT = join(PROJECT_ROOT, 'runtime');
const WORKSPACE_MANIFEST = join(RUNTIME_ROOT, 'Cargo.toml');
const CRATE_MANIFEST = join(RUNTIME_ROOT, 'crates', 'esvp-host-runtime', 'Cargo.toml');
const DIST_RUNTIME_ROOT = join(PROJECT_ROOT, 'dist', 'runtime', 'esvp-host-runtime');
const DIST_TEMPLATES_DIR = join(PROJECT_ROOT, 'dist', 'templates');
const DIST_TEMPLATE_BUNDLE_DIR = join(DIST_TEMPLATES_DIR, 'bundle');
const DIST_TEMPLATE_PUBLIC_DIR = join(DIST_TEMPLATE_BUNDLE_DIR, 'public');
const DIST_TEMPLATE_BUNDLE_FILE = join(DIST_TEMPLATE_BUNDLE_DIR, 'bundle.js');
const OPTIONS = parseArgs(process.argv.slice(2));
const BEST_EFFORT = OPTIONS.bestEffort;
const TARGET = OPTIONS.target || resolveHostTargetTriple();
const BINARY_NAME = resolveBinaryName(TARGET);
const DEFAULT_ANDROID_MOCKUP = 'mockup-android-galaxy.png';

main();

function main() {
  syncTemplateBundle();

  if (!existsSync(WORKSPACE_MANIFEST) || !existsSync(CRATE_MANIFEST)) {
    exitWithMessage('ESVP host runtime sources were not found in ./runtime.', 1);
  }

  if (!OPTIONS.sourceBinary) {
    const cargoVersion = spawnSync('cargo', ['--version'], {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (cargoVersion.status !== 0) {
      if (BEST_EFFORT) {
        console.warn('[esvp-host-runtime] cargo not found; skipping bundled runtime build.');
        process.exit(0);
      }
      exitWithMessage('cargo was not found. Install Rust or run the build in best-effort mode.', 1);
    }

    const build = spawnSync(
      'cargo',
      [
        'build',
        '--release',
        '--manifest-path',
        WORKSPACE_MANIFEST,
        '-p',
        'esvp-host-runtime',
        ...(TARGET ? ['--target', resolveRustTargetTriple(TARGET)] : []),
      ],
      {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
      }
    );
    if (build.status !== 0) {
      exitWithMessage(`cargo build failed with exit code ${build.status ?? 1}.`, build.status ?? 1);
    }
  }

  const sourceBinary = OPTIONS.sourceBinary
    ? resolve(PROJECT_ROOT, OPTIONS.sourceBinary)
    : join(RUNTIME_ROOT, 'target', resolveRustTargetTriple(TARGET), 'release', BINARY_NAME);
  if (!existsSync(sourceBinary)) {
    exitWithMessage(`Built runtime binary was not found at ${sourceBinary}.`, 1);
  }

  const targetDir = join(DIST_RUNTIME_ROOT, TARGET);
  const destinationBinary = join(targetDir, BINARY_NAME);
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(sourceBinary, destinationBinary);
  if (process.platform !== 'win32') {
    chmodSync(destinationBinary, 0o755);
  }

  const manifestPath = join(DIST_RUNTIME_ROOT, 'manifest.json');
  const manifest = readManifest(manifestPath);
  manifest.version = readPackageVersion(CRATE_MANIFEST) || manifest.version || '0.1.0';
  manifest.targets[TARGET] = {
    path: `${TARGET}/${BINARY_NAME}`,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`[esvp-host-runtime] bundled ${TARGET} -> ${destinationBinary}`);
}

function syncTemplateBundle() {
  const sourceDir = resolveTemplateSourceDir();
  if (!sourceDir) {
    console.warn('[templates] No template bundle found. Skipping dist/templates sync.');
    console.warn('[templates] Expected DISCOVERYLAB_TEMPLATE_SOURCE_DIR or ~/.discoverylab/templates with manifest.json + bundle/.');
    return;
  }

  rmSync(DIST_TEMPLATES_DIR, { recursive: true, force: true });
  mkdirSync(DIST_TEMPLATES_DIR, { recursive: true });
  cpSync(sourceDir, DIST_TEMPLATES_DIR, { recursive: true });
  ensureAndroidMockupAlias();
  patchTemplateBundleForAndroidMockups();

  const templateIds = loadTemplateIds(DIST_TEMPLATES_DIR);
  console.log(
    `[templates] synced ${templateIds.length} template${templateIds.length === 1 ? '' : 's'} from ${sourceDir} -> ${DIST_TEMPLATES_DIR}`
  );
}

function resolveTemplateSourceDir() {
  const sourceEnv = process.env.DISCOVERYLAB_TEMPLATE_SOURCE_DIR?.trim();
  const candidates = [
    sourceEnv || null,
    join(homedir(), '.discoverylab', 'templates'),
    join(PROJECT_ROOT, 'vendor', 'templates'),
  ];

  for (const candidate of candidates) {
    if (candidate && hasTemplateBundle(candidate)) {
      return candidate;
    }
  }

  return null;
}

function hasTemplateBundle(dir) {
  return existsSync(join(dir, 'manifest.json')) && existsSync(join(dir, 'bundle'));
}

function loadTemplateIds(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return Array.isArray(manifest?.templates)
      ? manifest.templates.map((template) => template?.id).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function ensureAndroidMockupAlias() {
  if (!existsSync(DIST_TEMPLATE_PUBLIC_DIR)) {
    return;
  }

  const destination = join(DIST_TEMPLATE_PUBLIC_DIR, DEFAULT_ANDROID_MOCKUP);
  if (existsSync(destination)) {
    return;
  }

  const candidates = [
    join(DIST_TEMPLATE_PUBLIC_DIR, 'mockup-android-google-pixel-9-pro.png'),
    join(DIST_TEMPLATE_PUBLIC_DIR, 'mockup-android.png'),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) {
    console.warn(`[templates] Could not create ${DEFAULT_ANDROID_MOCKUP}; no Android mockup source asset was found.`);
    return;
  }

  copyFileSync(source, destination);
  console.log(`[templates] created ${DEFAULT_ANDROID_MOCKUP} from ${source.split('/').pop()}`);
}

function patchTemplateBundleForAndroidMockups() {
  if (!existsSync(DIST_TEMPLATE_BUNDLE_FILE)) {
    return;
  }

  const original = readFileSync(DIST_TEMPLATE_BUNDLE_FILE, 'utf8');
  if (original.includes('resolvedDeviceMockup = deviceMockup || inputProps.deviceMockup || "mockup-android-galaxy.png"')) {
    return;
  }

  let patched = original;
  patched = replaceRequired(
    patched,
    `const AndroidFrame = ({
  children,
  width,
  height
}) => {`,
    `const AndroidFrame = ({
  children,
  width,
  height,
  deviceMockup
}) => {`,
    'AndroidFrame signature'
  );
  patched = replaceRequired(
    patched,
    `src: (0,esm.staticFile)("mockup-android.png"),`,
    `src: (0,esm.staticFile)(deviceMockup || "mockup-android-galaxy.png"),`,
    'AndroidFrame asset source'
  );
  patched = replaceRequired(
    patched,
    `const DeviceFrame = ({
  platform,
  children,
  width,
  height
}) => {`,
    `const DeviceFrame = ({
  platform,
  children,
  width,
  height,
  deviceMockup
}) => {`,
    'DeviceFrame signature'
  );
  patched = replaceRegexRequired(
    patched,
    /  if \(platform === "android"\) \{\n    const h\d* = height \|\| 820;\n    const w\d* = width \|\| h\d* \* ANDROID_ASPECT;\n    return \/\* @__PURE__ \*\/ \(0,jsx_runtime\.jsx\)\(AndroidFrame, \{ width: w\d*, height: h\d*, children \}\);\n  \}/,
    `  if (platform === "android") {
    const inputProps = typeof window === "undefined" || (0,esm.getRemotionEnvironment)().isPlayer ? {} : (0,esm.getInputProps)() ?? {};
    const resolvedDeviceMockup = deviceMockup || inputProps.deviceMockup || "mockup-android-galaxy.png";
    const h2 = height || 820;
    const w2 = width || h2 * ANDROID_ASPECT;
    return /* @__PURE__ */ (0,jsx_runtime.jsx)(AndroidFrame, { deviceMockup: resolvedDeviceMockup, width: w2, height: h2, children });
  }`,
    'DeviceFrame Android branch'
  );

  if (patched !== original) {
    writeFileSync(DIST_TEMPLATE_BUNDLE_FILE, patched, 'utf8');
    console.log('[templates] patched bundle.js for Android mockup selection');
  }
}

function replaceRequired(source, searchValue, replacementValue, label) {
  if (!source.includes(searchValue)) {
    throw new Error(`[templates] Failed to patch ${label}; upstream template bundle changed.`);
  }
  return source.replace(searchValue, replacementValue);
}

function replaceRegexRequired(source, pattern, replacementValue, label) {
  if (!pattern.test(source)) {
    throw new Error(`[templates] Failed to patch ${label}; upstream template bundle changed.`);
  }
  return source.replace(pattern, replacementValue);
}

function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    return {
      name: 'esvp-host-runtime',
      version: '0.1.0',
      apiVersion: 'v1',
      targets: {},
    };
  }

  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return {
      name: 'esvp-host-runtime',
      version: '0.1.0',
      apiVersion: 'v1',
      targets: {},
    };
  }
}

function readPackageVersion(manifestPath) {
  const manifest = readFileSync(manifestPath, 'utf8');
  const match = manifest.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

function resolveHostTargetTriple() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';

  exitWithMessage(`Unsupported platform/arch for ESVP host runtime bundle: ${platform}/${arch}`, 1);
}

function resolveRustTargetTriple(target) {
  const mapping = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc',
  };
  const resolved = mapping[target];
  if (!resolved) {
    exitWithMessage(`Unsupported runtime target: ${target}`, 1);
  }
  return resolved;
}

function resolveBinaryName(target) {
  return target.startsWith('win32-') ? 'esvp-host-runtime.exe' : 'esvp-host-runtime';
}

function parseArgs(argv) {
  const options = {
    bestEffort: false,
    target: null,
    sourceBinary: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--best-effort') {
      options.bestEffort = true;
      continue;
    }
    if (arg === '--target') {
      options.target = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (arg === '--source-binary') {
      options.sourceBinary = argv[index + 1] || null;
      index += 1;
      continue;
    }
  }

  return options;
}

function exitWithMessage(message, code) {
  console.error(`[esvp-host-runtime] ${message}`);
  process.exit(code);
}
