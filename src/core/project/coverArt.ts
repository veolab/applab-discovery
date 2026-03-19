import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, basename, extname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createCanvas, loadImage } from 'canvas';

const COVER_WIDTH = 1280;
const COVER_HEIGHT = 800;
const ICON_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const LINK_TAG_REGEX = /<link\b[^>]*>/gi;
const IGNORED_MOBILE_APP_IDS = new Set([
  'com.apple.springboard',
  'com.android.systemui',
  'com.google.android.apps.nexuslauncher',
  'com.android.launcher',
  'com.android.launcher3',
  'com.sec.android.app.launcher',
  'com.miui.home',
  'com.example.app',
]);

function shellQuoteArg(value: string): string {
  const str = String(value ?? '');
  if (!str) return "''";
  return `'${str.replace(/'/g, `'\"'\"'`)}'`;
}

function normalizeMobileAppId(appId: string | null | undefined): string | null {
  if (typeof appId !== 'string') return null;
  const value = appId.trim();
  return value || null;
}

export function isIgnoredMobileAppId(appId: string | null | undefined): boolean {
  const normalized = normalizeMobileAppId(appId);
  if (!normalized) return true;
  if (IGNORED_MOBILE_APP_IDS.has(normalized)) return true;

  const lowered = normalized.toLowerCase();
  return lowered.includes('launcher')
    || lowered.endsWith('.home')
    || lowered.endsWith('.xctrunner')
    || lowered.includes('uitests')
    || lowered.includes('maestro-driver')
    || lowered.includes('# todo');
}

async function createIconCoverFromSource(iconSource: string | Buffer, outputPath: string): Promise<string | null> {
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    const image = await loadImage(iconSource as any);
    const canvas = createCanvas(COVER_WIDTH, COVER_HEIGHT);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);

    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, COVER_WIDTH - 2, COVER_HEIGHT - 2);

    const maxIconWidth = COVER_WIDTH * 0.38;
    const maxIconHeight = COVER_HEIGHT * 0.48;
    const scale = Math.min(maxIconWidth / image.width, maxIconHeight / image.height);
    const drawWidth = Math.max(1, Math.round(image.width * scale));
    const drawHeight = Math.max(1, Math.round(image.height * scale));
    const drawX = Math.round((COVER_WIDTH - drawWidth) / 2);
    const drawY = Math.round((COVER_HEIGHT - drawHeight) / 2);

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.14)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 12;
    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
    ctx.restore();

    writeFileSync(outputPath, canvas.toBuffer('image/png'));
    return outputPath;
  } catch {
    return null;
  }
}

function walkFiles(rootDir: string, maxEntries = 400): string[] {
  if (!existsSync(rootDir)) return [];

  const result: string[] = [];
  const queue = [rootDir];

  while (queue.length > 0 && result.length < maxEntries) {
    const current = queue.shift();
    if (!current) continue;

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!ICON_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      result.push(fullPath);
      if (result.length >= maxEntries) break;
    }
  }

  return result;
}

function getIOSIconBaseScore(filePath: string): number {
  const name = basename(filePath).toLowerCase();
  let score = 0;

  if (name.includes('appicon')) score += 600;
  else if (name.includes('icon')) score += 300;
  if (name.includes('@3x')) score += 120;
  if (name.includes('@2x')) score += 80;
  if (name.includes('60x60')) score += 60;
  if (name.includes('76x76')) score += 50;
  if (name.includes('83.5x83.5')) score += 55;
  if (name.includes('notification')) score -= 220;
  if (name.includes('spotlight')) score -= 180;
  if (name.includes('settings')) score -= 160;
  if (name.includes('marketing')) score -= 120;
  if (name.includes('launch')) score -= 300;

  return score;
}

async function pickBestIOSIconFile(appBundlePath: string): Promise<string | null> {
  const candidates = walkFiles(appBundlePath).filter((filePath) => {
    const name = basename(filePath).toLowerCase();
    return name.includes('icon') || name.includes('appicon');
  });

  let bestPath: string | null = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    try {
      const image = await loadImage(candidate);
      const stat = statSync(candidate);
      const score = getIOSIconBaseScore(candidate) + (image.width * image.height) + Math.min(stat.size, 200_000) / 10;
      if (score > bestScore) {
        bestScore = score;
        bestPath = candidate;
      }
    } catch {
      continue;
    }
  }

  return bestPath;
}

function readIOSPlist(plistPath: string): Record<string, unknown> | null {
  try {
    const output = execSync(`plutil -convert json -o - ${shellQuoteArg(plistPath)}`, {
      encoding: 'utf8',
      timeout: 2500,
    });
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function listIOSAppBundles(deviceId: string): Array<{
  appBundlePath: string;
  bundleId: string | null;
}> {
  const applicationsDir = join(
    homedir(),
    'Library',
    'Developer',
    'CoreSimulator',
    'Devices',
    deviceId,
    'data',
    'Containers',
    'Bundle',
    'Application'
  );
  if (!existsSync(applicationsDir)) return [];

  const bundles: Array<{
    appBundlePath: string;
    bundleId: string | null;
  }> = [];

  let containerDirs: string[] = [];
  try {
    containerDirs = readdirSync(applicationsDir);
  } catch {
    return bundles;
  }

  for (const containerDir of containerDirs) {
    const containerPath = join(applicationsDir, containerDir);
    let entries: string[] = [];
    try {
      entries = readdirSync(containerPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue;
      const appBundlePath = join(containerPath, entry);
      const info = readIOSPlist(join(appBundlePath, 'Info.plist'));
      const bundleId = typeof info?.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : null;

      bundles.push({
        appBundlePath,
        bundleId,
      });
    }
  }

  return bundles;
}

function findBestIOSAppBundle(deviceId: string, appId: string | null | undefined): string | null {
  const normalizedAppId = normalizeMobileAppId(appId);
  if (!normalizedAppId) return null;
  const bundles = listIOSAppBundles(deviceId);

  for (const bundle of bundles) {
    const bundleId = normalizeMobileAppId(bundle.bundleId);
    if (isIgnoredMobileAppId(bundleId)) continue;
    if (bundleId === normalizedAppId) {
      return bundle.appBundlePath;
    }
  }

  return null;
}

function getAndroidDensityScore(entry: string): number {
  const lowered = entry.toLowerCase();
  if (lowered.includes('xxxhdpi')) return 800;
  if (lowered.includes('xxhdpi')) return 700;
  if (lowered.includes('xhdpi')) return 600;
  if (lowered.includes('hdpi')) return 500;
  if (lowered.includes('mdpi')) return 400;
  if (lowered.includes('ldpi')) return 300;
  if (lowered.includes('anydpi')) return 200;
  return 100;
}

function getAndroidIconEntryScore(entry: string): number {
  const lowered = entry.toLowerCase();
  if (!/^res\/.+\.(png|jpg|jpeg|webp)$/.test(lowered)) return -Infinity;
  if (!(lowered.includes('ic_launcher') || lowered.includes('app_icon') || lowered.includes('/icon'))) return -Infinity;
  if (lowered.includes('foreground') || lowered.includes('background') || lowered.includes('monochrome')) return -Infinity;

  let score = getAndroidDensityScore(lowered);
  if (lowered.includes('ic_launcher.png') || lowered.includes('ic_launcher.webp')) score += 400;
  if (lowered.includes('round')) score -= 20;
  if (lowered.includes('playstore')) score -= 80;
  if (lowered.endsWith('.png')) score += 20;

  return score;
}

function pickBestAndroidIconEntry(entries: string[]): string | null {
  let bestEntry: string | null = null;
  let bestScore = -Infinity;

  for (const entry of entries) {
    const score = getAndroidIconEntryScore(entry);
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  return bestEntry;
}

async function fetchBinary(url: string, timeoutMs = 3500): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'image/*,*/*;q=0.8',
      },
    });

    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs = 2500): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeWebIconCandidate(candidate: string, pageUrl: string): string | null {
  if (typeof candidate !== 'string') return null;
  const value = candidate.trim();
  if (!value) return null;

  if (value.startsWith('data:image/')) {
    return value;
  }

  try {
    return new URL(value, pageUrl).toString();
  } catch {
    return null;
  }
}

function extractIconCandidatesFromHtml(html: string, pageUrl: string): string[] {
  const candidates: string[] = [];
  for (const match of html.matchAll(LINK_TAG_REGEX)) {
    const tag = match[0];
    const relMatch = tag.match(/\brel=["']([^"']+)["']/i);
    const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
    const relValue = relMatch?.[1] || '';
    if (!hrefMatch?.[1] || !/(?:^|\s)(icon|apple-touch-icon|mask-icon)(?:\s|$)/i.test(relValue)) {
      continue;
    }

    const resolved = normalizeWebIconCandidate(hrefMatch[1], pageUrl);
    if (resolved) {
      candidates.push(resolved);
    }
  }
  return candidates;
}

async function fetchImageSource(candidate: string): Promise<string | Buffer | null> {
  if (candidate.startsWith('data:image/')) {
    return candidate;
  }

  const buffer = await fetchBinary(candidate);
  if (!buffer) return null;
  return buffer;
}

async function renderFirstAvailableWebIcon(candidates: Iterable<string>, outputPath: string): Promise<string | null> {
  for (const candidate of candidates) {
    const source = await fetchImageSource(candidate);
    if (!source) continue;

    const rendered = await createIconCoverFromSource(source, outputPath);
    if (rendered) {
      return rendered;
    }
  }
  return null;
}

export async function createMobileAppIconCover(params: {
  platform: 'ios' | 'android';
  deviceId: string;
  appId: string | null | undefined;
  outputDir: string;
  adbPath?: string | null;
}): Promise<string | null> {
  const appId = normalizeMobileAppId(params.appId);
  const hasUsableAppId = !!appId && !isIgnoredMobileAppId(appId);
  if (!hasUsableAppId) return null;

  const outputPath = join(params.outputDir, 'cover-app-icon.png');

  if (params.platform === 'ios') {
    try {
      let appBundlePath = findBestIOSAppBundle(params.deviceId, appId);

      if (!appBundlePath && hasUsableAppId && appId) {
        appBundlePath = execSync(
          `xcrun simctl get_app_container "${params.deviceId}" "${appId}" app`,
          { encoding: 'utf8', timeout: 4000 }
        ).trim();
      }

      if (!appBundlePath) return null;
      const iconPath = await pickBestIOSIconFile(appBundlePath);
      if (!iconPath) return null;
      return await createIconCoverFromSource(iconPath, outputPath);
    } catch {
      return null;
    }
  }

  if (!params.adbPath || !hasUsableAppId || !appId) return null;

  const tempDir = join(tmpdir(), `discoverylab-icon-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });

  try {
    const packagePathsOutput = execSync(
      `"${params.adbPath}" -s "${params.deviceId}" shell pm path "${appId}"`,
      { encoding: 'utf8', timeout: 4000 }
    );

    const remoteApkPaths = packagePathsOutput
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.replace(/^package:/, ''));

    for (const [index, remoteApkPath] of remoteApkPaths.entries()) {
      const localApkPath = join(tempDir, `app-${index}.apk`);
      try {
        execSync(
          `"${params.adbPath}" -s "${params.deviceId}" pull ${shellQuoteArg(remoteApkPath)} ${shellQuoteArg(localApkPath)}`,
          { stdio: 'pipe', timeout: 4500 }
        );
      } catch {
        continue;
      }

      try {
        const entriesOutput = execSync(`unzip -Z1 ${shellQuoteArg(localApkPath)}`, {
          encoding: 'utf8',
          timeout: 3000,
          maxBuffer: 8 * 1024 * 1024,
        });
        const entry = pickBestAndroidIconEntry(entriesOutput.split('\n').map(line => line.trim()).filter(Boolean));
        if (!entry) continue;

        const iconBuffer = execSync(`unzip -p ${shellQuoteArg(localApkPath)} ${shellQuoteArg(entry)}`, {
          timeout: 3000,
          maxBuffer: 8 * 1024 * 1024,
        });
        const rendered = await createIconCoverFromSource(iconBuffer, outputPath);
        if (rendered) return rendered;
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function createWebFaviconCover(params: {
  pageUrl: string | null | undefined;
  outputDir: string;
  explicitCandidates?: string[];
}): Promise<string | null> {
  if (typeof params.pageUrl !== 'string' || !params.pageUrl.trim()) return null;

  let pageUrl: URL;
  try {
    pageUrl = new URL(params.pageUrl);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(pageUrl.protocol)) return null;

  const outputPath = join(params.outputDir, 'cover-site-icon.png');
  const candidates = new Set<string>();

  for (const candidate of params.explicitCandidates || []) {
    const normalized = normalizeWebIconCandidate(candidate, pageUrl.toString());
    if (normalized) candidates.add(normalized);
  }

  const html = await fetchText(pageUrl.toString());
  if (html) {
    for (const candidate of extractIconCandidatesFromHtml(html, pageUrl.toString())) {
      candidates.add(candidate);
    }
  }

  candidates.add(new URL('/favicon.ico', pageUrl).toString());
  candidates.add(new URL('/favicon.png', pageUrl).toString());
  candidates.add(new URL('/apple-touch-icon.png', pageUrl).toString());
  return renderFirstAvailableWebIcon(candidates, outputPath);
}
