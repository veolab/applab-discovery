/**
 * DiscoveryLab HTTP Server
 * Hono-based server for serving the web UI and API endpoints
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, mkdirSync, copyFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { exec, execSync, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { getDatabase, getSqlite, projects, projectExports, frames, testVariables, DATA_DIR, PROJECTS_DIR, EXPORTS_DIR, FRAMES_DIR } from '../db/index.js';
import { isTemplatesInstalled, getAvailableTemplates, getTemplate, getBundlePath } from '../core/templates/loader.js';
import { startRender, getRenderJob, getCachedRender } from '../core/templates/renderer.js';
import type { TemplateProps, TemplateId, TerminalTab } from '../core/templates/types.js';
import { APP_VERSION } from '../core/appVersion.js';
import { findAndroidSdkPath, getAdbCommand, getEmulatorPath, listConnectedAndroidDevices, resolveAndroidDeviceSerial } from '../core/android/adb.js';
import { getMaestroRecorder, isMaestroInstalled, runMaestroTest, isIdbInstalled, tapViaIdb, killZombieMaestroProcesses, listMaestroDevices, parseMaestroActionsFromYaml } from '../core/testing/maestro.js';
import type { MaestroRecordingSession } from '../core/testing/maestro.js';
import { runPlaywrightTest } from '../core/testing/playwright.js';
import { analyzeScreenshotsForActions, generateMaestroYaml } from '../core/analyze/aiActionDetector.js';
import type { ActionDetectorProvider } from '../core/analyze/aiActionDetector.js';
import { redactSensitiveTestInput, redactQuotedStringsInText } from '../core/security/sensitiveInput.js';
import { encryptLocalSecret, decryptLocalSecret } from '../core/security/localSecretStore.js';
import { createMobileAppIconCover, createWebFaviconCover, isIgnoredMobileAppId } from '../core/project/coverArt.js';
import {
  attachPlaywrightNetworkCapture,
  PLAYWRIGHT_NETWORK_RESOURCE_TYPES,
  type CapturedNetworkEntry,
  type NetworkCaptureMeta,
} from '../core/testing/networkCapture.js';
import {
  collectESVPSessionNetworkData,
  validateMaestroRecordingWithESVP,
} from '../core/integrations/esvp-mobile.js';
import { buildAppLabNetworkProfile } from '../core/integrations/esvp-network-profile.js';
import {
  ensureLocalCaptureProxyProfile,
  finalizeAllLocalCaptureProxySessions,
  finalizeLocalCaptureProxySession,
  listLocalCaptureProxyStates,
} from '../core/integrations/local-network-proxy.js';
import {
  finalizeLocalAppHttpTraceCollector,
  getLocalAppHttpTraceBootstrap,
  ingestLocalAppHttpTrace,
  resolveLocalAppHttpTraceCollectorById,
  startLocalAppHttpTraceCollector,
  type LocalAppHttpTraceCollectorState,
} from '../core/integrations/local-app-http-trace.js';
import {
  attachESVPNetworkTrace,
  configureESVPNetwork,
  createESVPSession,
  getESVPReplayConsistency,
  inspectESVPSession,
  replayESVPSession,
  runESVPActions,
  validateESVPReplay,
} from '../core/integrations/esvp.js';
import { LOCAL_ESVP_SERVER_URL } from '../core/integrations/esvp-local-runtime.js';
import { executeBatchExport, registerAdapter, getAvailableAdapters, type ProjectDataProvider } from '../core/export/pipeline.js';
import { notionAdapter } from '../core/export/adapters/notion.js';
import type { BatchExportManifest } from '../core/export/adapters/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ANALYZING_PROJECT_STATUSES = new Set(['analyzing', 'processing', 'pending', 'in_progress']);
const BACKGROUND_ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000; // 10 min hard timeout for OCR/AI jobs
const STALE_ANALYSIS_TIMEOUT_MS = 15 * 60 * 1000; // 15 min stale protection on reads

// ============================================================================
// SMART ANNOTATION CACHE & BACKGROUND PRE-GENERATION
// ============================================================================

interface CachedAnnotations {
  projectId: string;
  title: string;
  subtitle: string;
  steps: string[];
  generatedAt: number;
}

const annotationCache = new Map<string, CachedAnnotations>();
let pregenInProgress = false;

/**
 * Check if the machine is busy with resource-intensive tasks.
 * Only pre-generate when idle to avoid impacting user experience.
 */
function isMachineBusy(): boolean {
  try {
    // Check active recording
    const recorder = getMaestroRecorder();
    if (recorder.isRecording()) return true;

    // Check active render jobs
    const job = getRenderJob(''); // empty = checks if any active
    // Actually check all active renders
    // renderJobs is private, so check via the session-level state
  } catch { /* ignore */ }

  // Check active analysis
  for (const [, progress] of analysisProgressByProject) {
    if (progress.status === 'running') return true;
  }

  return false;
}

/**
 * Schedule smart annotation pre-generation after analyzer completes.
 * Waits 3s then checks if machine is idle before proceeding.
 */
function scheduleSmartAnnotationPregen(projectId: string) {
  setTimeout(async () => {
    if (pregenInProgress || isMachineBusy()) {
      console.log(`[SmartAnnotations] Skipping pregen for ${projectId} - machine busy`);
      return;
    }

    // Check if already cached
    if (annotationCache.has(projectId)) return;

    pregenInProgress = true;
    console.log(`[SmartAnnotations] Pre-generating annotations for ${projectId}...`);

    try {
      const db = getDatabase();
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      if (!project?.aiSummary) return;

      const dbFrames = await db.select().from(frames)
        .where(eq(frames.projectId, projectId))
        .orderBy(frames.frameNumber)
        .limit(10);

      if (dbFrames.length === 0) return;

      const provider = await getLLMProvider();
      if (!provider) {
        // Fallback: parse from aiSummary
        const flowMatch = project.aiSummary.match(/## (?:User Flow|Likely User Flow)\n([\s\S]*?)(?=\n##|\n$|$)/);
        const flowLines = flowMatch ? (flowMatch[1].match(/^\d+\.\s+(.+)$/gm) || []) : [];
        annotationCache.set(projectId, {
          projectId,
          title: project.marketingTitle || cleanProjectTitle(project.name) || 'App Flow',
          subtitle: project.marketingDescription || '',
          steps: dbFrames.map((_, i) => flowLines[i]?.replace(/^\d+\.\s+/, '').slice(0, 40) || `Step ${i + 1}`),
          generatedAt: Date.now(),
        });
        return;
      }

      // Re-check busy state before LLM call
      if (isMachineBusy()) return;

      const framesContext = dbFrames.map((f, i) =>
        `Frame ${i + 1}: "${(f.ocrText || '').slice(0, 200)}"`
      ).join('\n');

      const prompt = `You create labels for an app flow infographic. Be concise.

App Intelligence:
${project.aiSummary.slice(0, 2000)}

Frames OCR (in order):
${framesContext}

Return ONLY valid JSON, no extra text:
{
  "title": "catchy 3-5 word title for this flow",
  "subtitle": "one sentence about the app",
  "steps": [${dbFrames.map((_, i) => `{"label": "max 6 words for frame ${i + 1}"}`).join(', ')}]
}`;

      const response = await provider.sendMessage(prompt);
      const jsonMatch = (typeof response === 'string' ? response : '').match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        annotationCache.set(projectId, {
          projectId,
          title: parsed.title || 'App Flow',
          subtitle: parsed.subtitle || '',
          steps: Array.isArray(parsed.steps) ? parsed.steps.map((s: { label?: string }) => s.label || '') : [],
          generatedAt: Date.now(),
        });
        console.log(`[SmartAnnotations] Cached annotations for ${projectId}`);

        // Broadcast to frontend that annotations are ready
        broadcastToClients({
          type: 'smartAnnotationsReady',
          data: { projectId },
        });
      }
    } catch (e) {
      console.error(`[SmartAnnotations] Pregen failed for ${projectId}:`, e);
    } finally {
      pregenInProgress = false;
    }
  }, 3000); // Wait 3s after analysis completes
}

function isAnalyzingProjectStatus(status: unknown): boolean {
  return typeof status === 'string' && ANALYZING_PROJECT_STATUSES.has(status);
}

function toEpochMs(value: unknown): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

type TestVariableOwnerType = 'mobile-recording' | 'web-recording' | 'project';
type TestVariablePlatform = 'mobile' | 'web' | 'both';

type TestVariableApiRecord = {
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
  platform: TestVariablePlatform;
  notes: string | null;
  createdAt: number | null;
  updatedAt: number | null;
};

type MobileReplayRunStatus = 'running' | 'completed' | 'failed' | 'canceled';
type MobileReplayRunRecord = {
  runId: string;
  recordingId: string;
  status: MobileReplayRunStatus;
  flowPath: string;
  usedKeys: string[];
  deviceId: string | null;
  deviceName: string | null;
  devicePlatform: 'ios' | 'android' | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  error: string | null;
  output: string | null;
};

const ALLOWED_TEST_VAR_OWNER_TYPES = new Set<TestVariableOwnerType>(['mobile-recording', 'web-recording', 'project']);
const ALLOWED_TEST_VAR_PLATFORMS = new Set<TestVariablePlatform>(['mobile', 'web', 'both']);
const TEST_VAR_KEY_REGEX = /^[A-Z][A-Z0-9_]{0,63}$/;
const SCRIPT_PLACEHOLDER_REGEX = /\$\{([A-Z][A-Z0-9_]*)\}/g;
const mobileReplayRuns = new Map<string, MobileReplayRunRecord>();

function getMobileRecordingDir(recordingId: string): string {
  return join(PROJECTS_DIR, 'maestro-recordings', recordingId);
}

function getMobileRecordingSessionPath(recordingId: string): string {
  return join(getMobileRecordingDir(recordingId), 'session.json');
}

async function readMobileRecordingSessionData(recordingId: string): Promise<any> {
  const sessionPath = getMobileRecordingSessionPath(recordingId);
  if (!existsSync(sessionPath)) {
    throw new Error('Recording not found');
  }
  return JSON.parse(readFileSync(sessionPath, 'utf-8'));
}

async function writeMobileRecordingSessionData(recordingId: string, sessionData: any): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const sessionPath = getMobileRecordingSessionPath(recordingId);
  await writeFile(sessionPath, JSON.stringify(sessionData, null, 2));
}

function normalizeRecordingAppIdForESVP(appId?: string): string | undefined {
  const value = String(appId || '').trim();
  if (!value) return undefined;
  if (value === 'com.example.app') return undefined;
  if (value.includes('# TODO')) return undefined;
  return value;
}

function resolveRecordingExecutor(session: any): 'adb' | 'maestro-ios' | 'ios-sim' {
  return session?.platform === 'ios' ? 'ios-sim' : 'adb';
}

function getFirstRecordingScreenshotPath(session: any): string | undefined {
  if (typeof session?.screenshotsDir !== 'string' || !existsSync(session.screenshotsDir)) {
    return undefined;
  }
  const files = readdirSync(session.screenshotsDir)
    .filter((file) => file.toLowerCase().endsWith('.png'))
    .sort();
  if (files.length === 0) return undefined;
  return join(session.screenshotsDir, files[0]);
}

function buildDefaultESVPNetworkProfile(session?: { platform?: string | null; deviceId?: string | null }) {
  return buildAppLabNetworkProfile(
    {
      enabled: true,
      mode: 'external-proxy',
      profile: 'applab-standard-capture',
      label: 'App Lab Standard Capture',
    },
    {
      platform: session?.platform,
      deviceId: session?.deviceId,
    }
  );
}

function resolveRequestedAppLabCaptureMode(profile?: Record<string, unknown> | null): string {
  if (!profile || !profile.capture || typeof profile.capture !== 'object' || Array.isArray(profile.capture)) return '';
  const capture = profile.capture as Record<string, unknown>;
  if (typeof capture.applabMode === 'string' && capture.applabMode.trim()) {
    return capture.applabMode.trim().toLowerCase();
  }
  if (typeof capture.mode === 'string' && capture.mode.trim()) {
    return capture.mode.trim().toLowerCase();
  }
  return '';
}

function resolvePersistedNetworkProfile(
  runtimeNetwork?: Record<string, unknown> | null,
  existingNetwork?: Record<string, unknown> | null,
  fallbackProfile?: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (runtimeNetwork?.effective_profile && typeof runtimeNetwork.effective_profile === 'object') {
    return runtimeNetwork.effective_profile as Record<string, unknown>;
  }
  if (runtimeNetwork?.active_profile && typeof runtimeNetwork.active_profile === 'object') {
    return runtimeNetwork.active_profile as Record<string, unknown>;
  }
  if (existingNetwork?.effectiveProfile && typeof existingNetwork.effectiveProfile === 'object') {
    return existingNetwork.effectiveProfile as Record<string, unknown>;
  }
  if (existingNetwork?.activeProfile && typeof existingNetwork.activeProfile === 'object') {
    return existingNetwork.activeProfile as Record<string, unknown>;
  }
  return fallbackProfile || null;
}

async function touchProjectUpdatedAt(projectId: string): Promise<void> {
  const db = getDatabase();
  await db.update(projects)
    .set({ updatedAt: new Date() })
    .where(eq(projects.id, projectId));
}

type AnalysisFlowKind = 'mobile' | 'web';
type AnalysisStepStatus = 'running' | 'done' | 'failed' | 'skipped';
type AnalysisStepRange = { start: number; end: number };
type ProjectAnalysisProgressState = {
  projectId: string;
  flow: AnalysisFlowKind;
  step: string;
  status: AnalysisStepStatus;
  detail: string | null;
  error: string | null;
  percent: number;
  etaSeconds: number | null;
  startedAt: number;
  updatedAt: number;
  totalUnits: number | null;
  completedUnits: number | null;
};

const ANALYSIS_PROGRESS_RANGES: Record<AnalysisFlowKind, Record<string, AnalysisStepRange>> = {
  mobile: {
    queued: { start: 1, end: 4 },
    ocr: { start: 4, end: 62 },
    summary: { start: 62, end: 82 },
    actions: { start: 82, end: 95 },
    save: { start: 95, end: 100 },
    done: { start: 100, end: 100 },
    error: { start: 0, end: 100 },
  },
  web: {
    queued: { start: 1, end: 4 },
    extract: { start: 4, end: 30 },
    ocr: { start: 30, end: 78 },
    summary: { start: 78, end: 96 },
    save: { start: 96, end: 100 },
    done: { start: 100, end: 100 },
    error: { start: 0, end: 100 },
  },
};

const analysisProgressByProject = new Map<string, ProjectAnalysisProgressState>();
const analysisProgressCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clampAnalysisPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function getAnalysisStepRange(flow: AnalysisFlowKind, step: string): AnalysisStepRange {
  return ANALYSIS_PROGRESS_RANGES[flow][step] || ANALYSIS_PROGRESS_RANGES[flow].save;
}

function computeAnalysisPercent(
  flow: AnalysisFlowKind,
  step: string,
  status: AnalysisStepStatus,
  completedUnits?: number | null,
  totalUnits?: number | null
): number {
  const range = getAnalysisStepRange(flow, step);
  if (status === 'done' || status === 'skipped') {
    return range.end;
  }

  const span = Math.max(0, range.end - range.start);
  let ratio = 0;
  if (typeof completedUnits === 'number' && typeof totalUnits === 'number' && totalUnits > 0) {
    ratio = Math.max(0, Math.min(1, completedUnits / totalUnits));
    if (status === 'running' && ratio === 0) {
      ratio = 0.02;
    }
  } else if (status === 'running') {
    ratio = 0.08;
  }

  return clampAnalysisPercent(range.start + (span * ratio));
}

function computeAnalysisEtaSeconds(
  startedAt: number,
  percent: number,
  status: AnalysisStepStatus
): number | null {
  if (status !== 'running') return null;
  const normalized = clampAnalysisPercent(percent);
  if (normalized < 3 || normalized >= 100) return null;

  const elapsedMs = Math.max(Date.now() - startedAt, 1000);
  const ratio = normalized / 100;
  const estimatedTotalMs = elapsedMs / ratio;
  const remainingMs = Math.max(estimatedTotalMs - elapsedMs, 0);

  return Math.max(1, Math.ceil(Math.min(remainingMs, BACKGROUND_ANALYSIS_TIMEOUT_MS) / 1000));
}

function scheduleProjectAnalysisProgressCleanup(projectId: string, delayMs = 60_000): void {
  const existingTimer = analysisProgressCleanupTimers.get(projectId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timeout = setTimeout(() => {
    analysisProgressCleanupTimers.delete(projectId);
    analysisProgressByProject.delete(projectId);
  }, delayMs);

  analysisProgressCleanupTimers.set(projectId, timeout);
}

function getProjectAnalysisProgress(projectId: string): ProjectAnalysisProgressState | null {
  const existing = analysisProgressByProject.get(projectId);
  if (!existing) return null;

  return {
    ...existing,
    etaSeconds: computeAnalysisEtaSeconds(existing.startedAt, existing.percent, existing.status),
  };
}

function setProjectAnalysisProgress(params: {
  projectId: string;
  flow: AnalysisFlowKind;
  step: string;
  status: AnalysisStepStatus;
  detail?: string;
  error?: string;
  completedUnits?: number | null;
  totalUnits?: number | null;
  startedAt?: number;
  broadcast?: boolean;
}): ProjectAnalysisProgressState {
  const existingTimer = analysisProgressCleanupTimers.get(params.projectId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    analysisProgressCleanupTimers.delete(params.projectId);
  }

  const existing = analysisProgressByProject.get(params.projectId);
  const startedAt = existing?.startedAt ?? params.startedAt ?? Date.now();
  const sameStep = existing?.step === params.step;
  const completedUnits = params.completedUnits !== undefined
    ? params.completedUnits
    : sameStep
      ? existing?.completedUnits ?? null
      : null;
  const totalUnits = params.totalUnits !== undefined
    ? params.totalUnits
    : sameStep
      ? existing?.totalUnits ?? null
      : null;
  const percent = computeAnalysisPercent(
    params.flow,
    params.step,
    params.status,
    completedUnits,
    totalUnits
  );

  const next: ProjectAnalysisProgressState = {
    projectId: params.projectId,
    flow: params.flow,
    step: params.step,
    status: params.status,
    detail: params.detail ?? (sameStep ? existing?.detail ?? null : null),
    error: params.error ?? null,
    percent: Math.round(percent),
    etaSeconds: computeAnalysisEtaSeconds(startedAt, percent, params.status),
    startedAt,
    updatedAt: Date.now(),
    totalUnits,
    completedUnits,
  };

  analysisProgressByProject.set(params.projectId, next);

  if (params.status === 'done' || params.status === 'failed' || params.step === 'done' || params.step === 'error') {
    scheduleProjectAnalysisProgressCleanup(params.projectId);
  }

  if (params.broadcast !== false) {
    broadcastToClients({
      type: 'analysisProgress',
      data: {
        projectId: params.projectId,
        step: params.step,
        status: params.status,
        detail: next.detail,
        error: next.error,
        percent: next.percent,
        etaSeconds: next.etaSeconds,
        flow: next.flow,
        totalUnits: next.totalUnits,
        completedUnits: next.completedUnits,
        startedAt: next.startedAt,
      }
    });
  }

  return next;
}

function clearProjectAnalysisProgress(projectId: string): void {
  const timer = analysisProgressCleanupTimers.get(projectId);
  if (timer) {
    clearTimeout(timer);
    analysisProgressCleanupTimers.delete(projectId);
  }
  analysisProgressByProject.delete(projectId);
}

function withProjectAnalysisProgress<T extends { id: string; status: unknown }>(
  project: T
): T & { analysisProgress: ProjectAnalysisProgressState | null } {
  return {
    ...project,
    analysisProgress: isAnalyzingProjectStatus(project.status) ? getProjectAnalysisProgress(project.id) : null,
  };
}

async function isLocalTcpPortReachable(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 350
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });

    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForLocalTcpPort(
  port: number,
  options: { host?: string; timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const host = options.host || '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 200;
  const startedAt = Date.now();

  while ((Date.now() - startedAt) < timeoutMs) {
    if (await isLocalTcpPortReachable(port, host)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return false;
}

function startProjectAnalysisProgress(
  projectId: string,
  flow: AnalysisFlowKind,
  detail: string
): ProjectAnalysisProgressState {
  return setProjectAnalysisProgress({
    projectId,
    flow,
    step: 'queued',
    status: 'running',
    detail,
  });
}

function pruneMobileReplayRuns(maxEntries = 80): void {
  const now = Date.now();
  const entries = Array.from(mobileReplayRuns.entries())
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt);

  for (const [runId, run] of entries) {
    const isTerminal = run.status === 'completed' || run.status === 'failed' || run.status === 'canceled';
    const staleMs = isTerminal ? 30 * 60 * 1000 : 6 * 60 * 60 * 1000;
    if (now - run.updatedAt > staleMs) {
      mobileReplayRuns.delete(runId);
    }
  }

  if (mobileReplayRuns.size <= maxEntries) return;
  const overflow = Array.from(mobileReplayRuns.entries())
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(0, mobileReplayRuns.size - maxEntries);
  for (const [runId] of overflow) {
    mobileReplayRuns.delete(runId);
  }
}

function normalizeTestVariableOwnerType(value: unknown): TestVariableOwnerType | null {
  if (typeof value !== 'string') return null;
  return ALLOWED_TEST_VAR_OWNER_TYPES.has(value as TestVariableOwnerType) ? (value as TestVariableOwnerType) : null;
}

function normalizeTestVariablePlatform(value: unknown): TestVariablePlatform {
  if (typeof value !== 'string') return 'both';
  return ALLOWED_TEST_VAR_PLATFORMS.has(value as TestVariablePlatform) ? (value as TestVariablePlatform) : 'both';
}

function normalizeTestVariableKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase();
  if (!TEST_VAR_KEY_REGEX.test(key)) return null;
  return key;
}

function parseScriptPlaceholders(code: string): string[] {
  if (typeof code !== 'string' || !code) return [];
  const found = new Set<string>();
  let match: RegExpExecArray | null = null;
  const regex = new RegExp(SCRIPT_PLACEHOLDER_REGEX);
  while ((match = regex.exec(code)) !== null) {
    const key = match[1]?.trim();
    if (key) found.add(key);
  }
  return Array.from(found).sort();
}

function renderDotEnvTest(variables: TestVariableApiRecord[]): string {
  const lines: string[] = [];
  for (const variable of variables) {
    if (!variable?.key) continue;
    if (variable.notes && variable.notes.trim()) {
      lines.push(`# ${variable.notes.trim()}`);
    }
    if (variable.platform && variable.platform !== 'both') {
      lines.push(`# platform: ${variable.platform}`);
    }
    const escaped = String(variable.value ?? '').replace(/\n/g, '\\n');
    lines.push(`${variable.key}=${escaped}`);
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function parseDotEnvTest(rawText: string): Array<{
  key: string;
  value: string;
  notes?: string | null;
  platform?: TestVariablePlatform;
}> {
  const result: Array<{ key: string; value: string; notes?: string | null; platform?: TestVariablePlatform }> = [];
  if (typeof rawText !== 'string' || !rawText.trim()) return result;

  let pendingNotes: string[] = [];
  let pendingPlatform: TestVariablePlatform | undefined;
  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      pendingNotes = [];
      pendingPlatform = undefined;
      continue;
    }
    if (trimmed.startsWith('#')) {
      const comment = trimmed.slice(1).trim();
      const platformMatch = comment.match(/^platform:\s*(mobile|web|both)$/i);
      if (platformMatch) {
        pendingPlatform = normalizeTestVariablePlatform(platformMatch[1].toLowerCase());
      } else if (comment) {
        pendingNotes.push(comment);
      }
      continue;
    }

    const equalIndex = line.indexOf('=');
    if (equalIndex <= 0) continue;
    const key = normalizeTestVariableKey(line.slice(0, equalIndex));
    if (!key) continue;
    const value = line.slice(equalIndex + 1).replace(/\\n/g, '\n');
    result.push({
      key,
      value,
      notes: pendingNotes.length > 0 ? pendingNotes.join(' ') : null,
      platform: pendingPlatform || 'both',
    });
    pendingNotes = [];
    pendingPlatform = undefined;
  }
  return result;
}

function testVariableAppliesToPlatform(variablePlatform: TestVariablePlatform, targetPlatform: 'mobile' | 'web'): boolean {
  return variablePlatform === 'both' || variablePlatform === targetPlatform;
}

function applyScriptPlaceholderValues(
  code: string,
  replacements: Record<string, string>
): { code: string; placeholders: string[]; usedKeys: string[]; missingKeys: string[] } {
  const placeholders = parseScriptPlaceholders(code);
  const usedKeys: string[] = [];
  const missingKeys: string[] = [];
  const usedSet = new Set<string>();
  const missingSet = new Set<string>();

  const substituted = String(code || '').replace(SCRIPT_PLACEHOLDER_REGEX, (full, key) => {
    const normalizedKey = String(key || '').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(replacements, normalizedKey)) {
      if (!usedSet.has(normalizedKey)) {
        usedSet.add(normalizedKey);
        usedKeys.push(normalizedKey);
      }
      return replacements[normalizedKey];
    }
    if (!missingSet.has(normalizedKey)) {
      missingSet.add(normalizedKey);
      missingKeys.push(normalizedKey);
    }
    return full;
  });

  return { code: substituted, placeholders, usedKeys, missingKeys };
}

function applyPlaywrightScriptPlaceholderValues(
  code: string,
  replacements: Record<string, string>
): { code: string; placeholders: string[]; usedKeys: string[]; missingKeys: string[] } {
  const placeholders = parseScriptPlaceholders(code);
  const usedKeys: string[] = [];
  const missingKeys: string[] = [];
  const usedSet = new Set<string>();
  const missingSet = new Set<string>();

  let output = String(code || '');
  for (const placeholderKey of placeholders) {
    const value = replacements[placeholderKey];
    if (value === undefined) {
      if (!missingSet.has(placeholderKey)) {
        missingSet.add(placeholderKey);
        missingKeys.push(placeholderKey);
      }
      continue;
    }
    if (!usedSet.has(placeholderKey)) {
      usedSet.add(placeholderKey);
      usedKeys.push(placeholderKey);
    }

    const quotedPattern = new RegExp(`(['"])\\\\$\\\\{${placeholderKey}\\\\}\\1`, 'g');
    output = output.replace(quotedPattern, JSON.stringify(value));

    const rawPattern = new RegExp(`\\\\$\\\\{${placeholderKey}\\\\}`, 'g');
    output = output.replace(rawPattern, value);
  }

  return { code: output, placeholders, usedKeys, missingKeys };
}

async function getTestVariablesForOwner(ownerType: TestVariableOwnerType, ownerId: string): Promise<TestVariableApiRecord[]> {
  const db = getDatabase();
  const rows = await db
    .select()
    .from(testVariables)
    .where(and(eq(testVariables.ownerType, ownerType), eq(testVariables.ownerId, ownerId)));

  return rows
    .map((row) => {
      let decrypted = '';
      try {
        decrypted = decryptLocalSecret(row.valueEncrypted);
      } catch {
        decrypted = '';
      }
      return {
        id: row.id,
        key: row.key,
        value: decrypted,
        isSecret: row.isSecret === true,
        platform: normalizeTestVariablePlatform(row.platform) as TestVariablePlatform,
        notes: row.notes ?? null,
        createdAt: toEpochMs(row.createdAt),
        updatedAt: toEpochMs(row.updatedAt),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

async function saveTestVariablesForOwner(
  ownerType: TestVariableOwnerType,
  ownerId: string,
  variablesInput: unknown
): Promise<TestVariableApiRecord[]> {
  if (!Array.isArray(variablesInput)) {
    throw new Error('variables must be an array');
  }

  const normalizedRows: Array<{
    id: string;
    key: string;
    valueEncrypted: string;
    isSecret: boolean;
    platform: TestVariablePlatform;
    notes: string | null;
  }> = [];
  const seenKeys = new Set<string>();

  for (const item of variablesInput) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const key = normalizeTestVariableKey(obj.key);
    if (!key) continue;
    if (seenKeys.has(key)) {
      throw new Error(`Duplicate variable key: ${key}`);
    }
    seenKeys.add(key);

    const rawValue = typeof obj.value === 'string' ? obj.value : String(obj.value ?? '');
    const isSecret = obj.isSecret !== false;
    const platform = normalizeTestVariablePlatform(obj.platform);
    const notes = typeof obj.notes === 'string' ? obj.notes.trim().slice(0, 300) : '';

    normalizedRows.push({
      id: typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : crypto.randomUUID(),
      key,
      valueEncrypted: encryptLocalSecret(rawValue),
      isSecret,
      platform,
      notes: notes || null,
    });
  }

  const db = getDatabase();
  const existing = await db
    .select({ id: testVariables.id })
    .from(testVariables)
    .where(and(eq(testVariables.ownerType, ownerType), eq(testVariables.ownerId, ownerId)));
  const keepIds = new Set(normalizedRows.map((row) => row.id));
  const deleteIds = existing.map((row) => row.id).filter((id) => !keepIds.has(id));
  if (deleteIds.length > 0) {
    await db.delete(testVariables).where(inArray(testVariables.id, deleteIds));
  }

  const now = new Date();
  for (const row of normalizedRows) {
    await db
      .insert(testVariables)
      .values({
        id: row.id,
        ownerId,
        ownerType,
        key: row.key,
        valueEncrypted: row.valueEncrypted,
        isSecret: row.isSecret,
        platform: row.platform,
        notes: row.notes,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [testVariables.ownerId, testVariables.ownerType, testVariables.key],
        set: {
          valueEncrypted: row.valueEncrypted,
          isSecret: row.isSecret,
          platform: row.platform,
          notes: row.notes,
          updatedAt: now,
        },
      });
  }

  return getTestVariablesForOwner(ownerType, ownerId);
}

async function deleteTestVariablesForOwner(ownerType: TestVariableOwnerType, ownerId: string): Promise<void> {
  const db = getDatabase();
  await db.delete(testVariables).where(and(eq(testVariables.ownerType, ownerType), eq(testVariables.ownerId, ownerId)));
}

async function resolveExecutionVariablesForScript(params: {
  ownerType: TestVariableOwnerType;
  ownerId: string;
  platform: 'mobile' | 'web';
  code: string;
}): Promise<{
  variables: TestVariableApiRecord[];
  envMap: Record<string, string>;
  placeholders: string[];
  usedKeys: string[];
  missingKeys: string[];
  codeResolved: string;
  envTestText: string;
}> {
  const variables = await getTestVariablesForOwner(params.ownerType, params.ownerId);
  const scopedVars = variables.filter((variable) => testVariableAppliesToPlatform(variable.platform, params.platform));
  const envMap = Object.fromEntries(scopedVars.map((v) => [v.key, v.value]));
  const applied = applyScriptPlaceholderValues(params.code, envMap);
  return {
    variables: scopedVars,
    envMap,
    placeholders: applied.placeholders,
    usedKeys: applied.usedKeys,
    missingKeys: applied.missingKeys,
    codeResolved: applied.code,
    envTestText: renderDotEnvTest(scopedVars),
  };
}

async function markProjectAnalysisTimeout(
  projectId: string,
  reason: string,
  options: { silentIfNotAnalyzing?: boolean } = {}
): Promise<void> {
  const db = getDatabase();
  const existing = await db.select({
    id: projects.id,
    name: projects.name,
    status: projects.status,
  }).from(projects).where(eq(projects.id, projectId)).limit(1);

  if (existing.length === 0) return;
  const current = existing[0];
  if (options.silentIfNotAnalyzing && !isAnalyzingProjectStatus(current.status)) {
    return;
  }

  const timeoutMessage = `Analysis timed out: ${reason}`;
  await db.update(projects).set({
    status: 'timeout',
    aiSummary: timeoutMessage,
    updatedAt: new Date(),
  }).where(eq(projects.id, projectId));

  console.warn(`[AnalysisTimeout] Project ${projectId} marked as timeout: ${reason}`);
  const existingProgress = getProjectAnalysisProgress(projectId);
  setProjectAnalysisProgress({
    projectId,
    flow: existingProgress?.flow || 'mobile',
    step: 'error',
    status: 'failed',
    detail: reason,
    error: timeoutMessage,
  });
  broadcastToClients({
    type: 'projectAnalysisUpdated',
    data: { projectId, status: 'timeout', reason }
  });
}

async function expireStaleAnalyzingProjects(projectRows: Array<{ id: string; status: unknown; updatedAt?: unknown }>): Promise<void> {
  const now = Date.now();
  const stale: Array<{ id: string; ageMs: number }> = [];

  for (const row of projectRows) {
    if (!isAnalyzingProjectStatus(row.status)) continue;
    const updatedAtMs = toEpochMs(row.updatedAt);
    if (!updatedAtMs) continue;
    const ageMs = now - updatedAtMs;
    if (ageMs > STALE_ANALYSIS_TIMEOUT_MS) {
      stale.push({ id: row.id, ageMs });
    }
  }

  for (const item of stale) {
    const minutes = Math.round(item.ageMs / 60000);
    await markProjectAnalysisTimeout(item.id, `stale analysis status (${minutes} min without update)`, {
      silentIfNotAnalyzing: true,
    }).catch(err => {
      console.warn('[AnalysisTimeout] Failed to expire stale project:', item.id, err);
    });
  }
}

function runOCRInBackgroundWithWatchdog(
  projectId: string,
  screenshotsDir: string,
  screenshotFiles: string[],
  sourceLabel: string
): void {
  startProjectAnalysisProgress(projectId, 'mobile', `Preparing analysis for ${screenshotFiles.length} screenshot${screenshotFiles.length === 1 ? '' : 's'}...`);
  let finished = false;
  const watchdog = setTimeout(() => {
    if (finished) return;
    void markProjectAnalysisTimeout(projectId, `${sourceLabel} exceeded ${Math.round(BACKGROUND_ANALYSIS_TIMEOUT_MS / 60000)} min`, {
      silentIfNotAnalyzing: true,
    });
  }, BACKGROUND_ANALYSIS_TIMEOUT_MS);

  void runOCRInBackground(projectId, screenshotsDir, screenshotFiles)
    .catch(err => {
      console.error(`[${sourceLabel}] OCR failed for project ${projectId}:`, err);
    })
    .finally(() => {
      finished = true;
      clearTimeout(watchdog);
    });
}

function runProjectAnalysisInBackgroundWithWatchdog(
  projectId: string,
  sourceLabel: string
): void {
  startProjectAnalysisProgress(projectId, 'web', 'Preparing capture analysis...');
  let finished = false;
  const watchdog = setTimeout(() => {
    if (finished) return;
    void markProjectAnalysisTimeout(projectId, `${sourceLabel} exceeded ${Math.round(BACKGROUND_ANALYSIS_TIMEOUT_MS / 60000)} min`, {
      silentIfNotAnalyzing: true,
    });
  }, BACKGROUND_ANALYSIS_TIMEOUT_MS);

  void analyzeProjectInBackground(projectId)
    .catch(err => {
      console.error(`[${sourceLabel}] Project analysis failed for ${projectId}:`, err);
    })
    .finally(() => {
      finished = true;
      clearTimeout(watchdog);
    });
}

// Cache the paths
const ADB_PATH = getAdbCommand();
const EMULATOR_PATH = getEmulatorPath();

// ============================================================================
// AI-POWERED PROJECT NAMING
// ============================================================================

/**
 * Generate a meaningful project name from OCR text
 * Analyzes extracted text to identify app names, screen names, and key content
 */
function generateSmartProjectName(ocrText: string, fallbackName: string): string {
  if (!ocrText || ocrText.trim().length < 3) {
    return fallbackName;
  }

  // Common UI patterns to detect
  const patterns = {
    // App names often appear in headers/titles
    appName: /^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*$/m,
    // Screen titles like "Settings", "Profile", "Home"
    screenTitle: /^(Settings|Profile|Home|Dashboard|Login|Sign\s*[Ii]n|Sign\s*[Uu]p|Cart|Checkout|Search|Messages|Notifications|Account|Orders|Products|Menu|About|Contact|Help)$/im,
    // Navigation items
    navItem: /(Home|Back|Next|Done|Cancel|Save|Edit|Delete|Add|Create|New|View|Share|Send)/i,
    // Form labels
    formLabel: /(Email|Password|Username|Name|Phone|Address|Date|Time|Amount|Price)/i,
  };

  const lines = ocrText.split('\n').map(l => l.trim()).filter(l => l.length > 2 && l.length < 50);
  const words = ocrText.split(/\s+/).filter(w => w.length > 2);

  // Try to find app/screen name in first few lines
  const firstLines = lines.slice(0, 5);
  for (const line of firstLines) {
    // Check for capitalized title-like text
    if (/^[A-Z][a-zA-Z\s]{2,30}$/.test(line) && !/^\d/.test(line)) {
      // Avoid generic words
      const generic = ['loading', 'please', 'wait', 'error', 'success', 'welcome', 'hello'];
      if (!generic.some(g => line.toLowerCase().includes(g))) {
        return line.slice(0, 40);
      }
    }
  }

  // Look for screen type patterns
  for (const line of lines) {
    const screenMatch = line.match(patterns.screenTitle);
    if (screenMatch) {
      return `${screenMatch[1]} Screen`;
    }
  }

  // Extract most frequent meaningful words
  const wordFreq = new Map<string, number>();
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up',
    'about', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'again', 'further', 'then', 'once',
    'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
    'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'now',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
    'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
    'tap', 'click', 'press', 'swipe', 'scroll', 'ok', 'yes', 'no',
  ]);

  for (const word of words) {
    const cleanWord = word.toLowerCase().replace(/[^\w]/g, '');
    if (cleanWord.length > 2 && !stopWords.has(cleanWord) && !/^\d+$/.test(cleanWord)) {
      wordFreq.set(cleanWord, (wordFreq.get(cleanWord) || 0) + 1);
    }
  }

  // Get top 3 keywords
  const topWords = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));

  if (topWords.length > 0) {
    return topWords.join(' ');
  }

  return fallbackName;
}

/**
 * Analyze frames and select the best one for thumbnail
 * Best = frame with most text content (indicates meaningful screen)
 */
interface FrameAnalysis {
  path: string;
  textLength: number;
  text: string;
}

async function selectBestFrame(framePaths: string[]): Promise<{ bestFrame: string | null; analyses: FrameAnalysis[] }> {
  if (framePaths.length === 0) {
    return { bestFrame: null, analyses: [] };
  }

  // Filter out blank (white/black) frames before OCR analysis
  const { isBlankFrame } = await import('../core/analyze/frames.js');
  const validPaths = framePaths.filter(p => !isBlankFrame(p).isBlank);
  const candidates = validPaths.length > 0 ? validPaths : framePaths;

  const { recognizeText } = await import('../core/analyze/ocr.js');
  const analyses: FrameAnalysis[] = [];

  for (const framePath of candidates.slice(0, 10)) { // Analyze max 10 frames
    try {
      const result = await recognizeText(framePath);
      analyses.push({
        path: framePath,
        textLength: result.success && result.text ? result.text.length : 0,
        text: result.success && result.text ? result.text : '',
      });
    } catch {
      analyses.push({ path: framePath, textLength: 0, text: '' });
    }
  }

  // Sort by text length descending
  analyses.sort((a, b) => b.textLength - a.textLength);

  // Select frame with most text, or middle frame if no text found
  const bestFrame = analyses[0]?.textLength > 50
    ? analyses[0].path
    : candidates[Math.floor(candidates.length / 2)] || candidates[0];

  return { bestFrame, analyses };
}

// ============================================================================
// APP SETUP
// ============================================================================
const app = new Hono();

// Register export destination adapters
registerAdapter(notionAdapter);

// CORS for development
app.use('*', cors());

// ============================================================================
// SETUP WIZARD PAGE
// ============================================================================
app.get('/setup', async (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DiscoveryLab Setup</title>
    <style>
        :root {
            --bg-primary: #0a0a0a;
            --bg-surface: #111111;
            --bg-elevated: #1a1a1a;
            --text-primary: #ffffff;
            --text-secondary: #888888;
            --accent: #0A84FF;
            --success: #30D158;
            --warning: #FF9F0A;
            --error: #FF453A;
            --border: #333333;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'SF Mono', 'Menlo', monospace;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
        }
        .setup-container {
            max-width: 700px;
            width: 100%;
        }
        .header {
            text-align: center;
            margin-bottom: 48px;
        }
        .logo {
            font-size: 32px;
            font-weight: bold;
            margin-bottom: 8px;
        }
        .logo span { color: var(--accent); }
        .subtitle {
            color: var(--text-secondary);
            font-size: 14px;
        }
        .terminal {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
        }
        .terminal-header {
            background: var(--bg-elevated);
            padding: 12px 16px;
            display: flex;
            align-items: center;
            gap: 8px;
            border-bottom: 1px solid var(--border);
        }
        .terminal-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
        }
        .terminal-dot.red { background: #FF5F56; }
        .terminal-dot.yellow { background: #FFBD2E; }
        .terminal-dot.green { background: #27CA40; }
        .terminal-title {
            margin-left: auto;
            color: var(--text-secondary);
            font-size: 12px;
        }
        .terminal-body {
            padding: 24px;
            font-size: 14px;
            line-height: 1.8;
        }
        .line {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 8px 0;
            border-bottom: 1px solid var(--border);
        }
        .line:last-child { border-bottom: none; }
        .status-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            flex-shrink: 0;
        }
        .status-icon.ok { background: rgba(48, 209, 88, 0.2); color: var(--success); }
        .status-icon.missing { background: rgba(255, 69, 58, 0.2); color: var(--error); }
        .status-icon.optional { background: rgba(255, 159, 10, 0.2); color: var(--warning); }
        .status-icon.loading { background: rgba(10, 132, 255, 0.2); color: var(--accent); animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .dep-info {
            flex: 1;
        }
        .dep-name {
            font-weight: 500;
        }
        .dep-version {
            color: var(--text-secondary);
            font-size: 12px;
        }
        .dep-action {
            font-size: 12px;
        }
        .dep-action a {
            color: var(--accent);
            text-decoration: none;
        }
        .dep-action a:hover { text-decoration: underline; }
        .install-cmd {
            background: var(--bg-primary);
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 12px;
            color: var(--text-secondary);
            cursor: pointer;
            border: 1px solid var(--border);
            transition: all 0.2s;
        }
        .install-cmd:hover {
            border-color: var(--accent);
            color: var(--text-primary);
        }
        .progress-section {
            margin-top: 32px;
            padding-top: 24px;
            border-top: 1px solid var(--border);
        }
        .progress-bar {
            height: 4px;
            background: var(--bg-elevated);
            border-radius: 2px;
            overflow: hidden;
            margin-bottom: 16px;
        }
        .progress-fill {
            height: 100%;
            background: var(--accent);
            border-radius: 2px;
            transition: width 0.5s ease;
        }
        .progress-text {
            display: flex;
            justify-content: space-between;
            font-size: 12px;
            color: var(--text-secondary);
        }
        .btn-primary {
            display: block;
            width: 100%;
            padding: 16px;
            border: none;
            border-radius: 10px;
            background: var(--accent);
            color: white;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            margin-top: 24px;
            font-family: inherit;
            transition: all 0.2s;
        }
        .btn-primary:hover { background: #409CFF; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .footer-note {
            text-align: center;
            margin-top: 24px;
            font-size: 12px;
            color: var(--text-secondary);
        }
        .footer-note a { color: var(--accent); text-decoration: none; }
    </style>
</head>
<body>
    <div class="setup-container">
        <div class="header">
            <div class="logo">Discovery<span>Lab</span></div>
            <div class="subtitle">AI-Powered App Testing & Evidence Generator</div>
        </div>

        <div class="terminal">
            <div class="terminal-header">
                <div class="terminal-dot red"></div>
                <div class="terminal-dot yellow"></div>
                <div class="terminal-dot green"></div>
                <span class="terminal-title">Setup Wizard</span>
            </div>
            <div class="terminal-body" id="setupContent">
                <div style="text-align: center; padding: 40px;">
                    <div class="status-icon loading" style="margin: 0 auto 16px; width: 40px; height: 40px; font-size: 20px;">...</div>
                    <div>Checking dependencies...</div>
                </div>
            </div>
        </div>

        <button class="btn-primary" id="continueBtn" disabled onclick="window.location.href='/'">
            Continue to DiscoveryLab
        </button>

        <div class="footer-note">
            Need help? Check the <a href="https://github.com/yourusername/discoverylab" target="_blank">documentation</a>
        </div>
    </div>

    <script>
        async function checkDependencies() {
            try {
                const response = await fetch('/api/setup/status');
                const data = await response.json();
                renderStatus(data);
            } catch (error) {
                document.getElementById('setupContent').innerHTML = \`
                    <div style="color: var(--error); text-align: center; padding: 24px;">
                        Failed to check dependencies. Is the server running?
                    </div>
                \`;
            }
        }

        function renderStatus(data) {
            const container = document.getElementById('setupContent');
            const deps = data.dependencies || [];
            const required = deps.filter(d => d.required);
            const optional = deps.filter(d => !d.required);
            const installedRequired = required.filter(d => d.installed).length;
            const totalRequired = required.length;
            const progress = totalRequired > 0 ? (installedRequired / totalRequired) * 100 : 100;

            let html = '';

            // Required dependencies
            html += '<div style="margin-bottom: 24px;"><div style="color: var(--text-secondary); font-size: 12px; margin-bottom: 12px;">REQUIRED</div>';
            for (const dep of required) {
                html += renderDep(dep);
            }
            html += '</div>';

            // Optional dependencies
            if (optional.length > 0) {
                html += '<div><div style="color: var(--text-secondary); font-size: 12px; margin-bottom: 12px;">OPTIONAL</div>';
                for (const dep of optional) {
                    html += renderDep(dep);
                }
                html += '</div>';
            }

            // Progress section
            html += \`
                <div class="progress-section">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: \${progress}%"></div>
                    </div>
                    <div class="progress-text">
                        <span>\${installedRequired}/\${totalRequired} required dependencies</span>
                        <span>\${data.ready ? 'Ready!' : 'Install missing dependencies'}</span>
                    </div>
                </div>
            \`;

            container.innerHTML = html;

            // Enable continue button if ready
            const btn = document.getElementById('continueBtn');
            if (data.ready) {
                btn.disabled = false;
                btn.textContent = 'Continue to DiscoveryLab';
            } else {
                btn.disabled = false;
                btn.textContent = 'Continue Anyway (some features may not work)';
            }
        }

        function renderDep(dep) {
            const statusClass = dep.installed ? 'ok' : (dep.required ? 'missing' : 'optional');
            const statusIcon = dep.installed ? '✓' : (dep.required ? '✗' : '○');
            const version = dep.installed ? dep.version : 'not installed';

            let actionHtml = '';
            if (!dep.installed && dep.installHint) {
                actionHtml = \`
                    <div class="dep-action">
                        <code class="install-cmd" onclick="copyCommand(this)" title="Click to copy">\${dep.installHint}</code>
                    </div>
                \`;
            } else if (dep.installed) {
                actionHtml = '<div class="dep-action" style="color: var(--success);">Installed</div>';
            }

            return \`
                <div class="line">
                    <div class="status-icon \${statusClass}">\${statusIcon}</div>
                    <div class="dep-info">
                        <div class="dep-name">\${dep.name}</div>
                        <div class="dep-version">\${version}</div>
                    </div>
                    \${actionHtml}
                </div>
            \`;
        }

        function copyCommand(el) {
            navigator.clipboard.writeText(el.textContent);
            const original = el.textContent;
            el.textContent = 'Copied!';
            el.style.color = 'var(--success)';
            setTimeout(() => {
                el.textContent = original;
                el.style.color = '';
            }, 1500);
        }

        // Start checking
        checkDependencies();

        // Refresh every 5 seconds
        setInterval(checkDependencies, 5000);
    </script>
</body>
</html>
  `);
});

// ============================================================================
// STATIC FILES
// ============================================================================
app.get('/', (c) => {
  const cwd = process.cwd();

  // Check multiple possible locations for the HTML file
  // Prioritize __dirname (absolute) over process.cwd() (relative) for npm-installed packages
  const possiblePaths = [
    join(__dirname, 'index.html'),                 // Production: bundled (dist/index.html alongside server)
    join(__dirname, '..', 'web', 'index.html'),   // Parent/web
    join(__dirname, '..', '..', 'src', 'web', 'index.html'), // Two levels up/src/web
    join(cwd, 'src', 'web', 'index.html'),        // Development: running from project root
    join(cwd, 'dist', 'index.html'),              // Production: running from project root
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      const html = readFileSync(path, 'utf-8');
      return c.html(html);
    }
  }

  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>DiscoveryLab</title>
      <style>
        body { font-family: system-ui; background: #000; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .container { text-align: center; }
        h1 { color: #0A84FF; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>DiscoveryLab</h1>
        <p>UI files not found. Run from project root.</p>
      </div>
    </body>
    </html>
  `);
});

// ============================================================================
// HEALTH CHECK
// ============================================================================
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// PROJECTS API
// ============================================================================

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type ProjectRecord = typeof projects.$inferSelect;
type NormalizedProjectRecord = ProjectRecord & {
  tags: string[];
  taskHubLinks: unknown[];
  taskRequirements: unknown[];
  taskTestMap: unknown[];
  analysisProgress: ProjectAnalysisProgressState | null;
};

function resolveVideoPath(videoPath: string | null): string | null {
  if (!videoPath) return null;
  try {
    if (!existsSync(videoPath)) return videoPath;
    if (!statSync(videoPath).isDirectory()) return videoPath;

    // Check video/ subdirectory first (Playwright pattern)
    const videoDir = join(videoPath, 'video');
    if (existsSync(videoDir) && statSync(videoDir).isDirectory()) {
      const videoFiles = readdirSync(videoDir).filter(f => /\.(mp4|mov|webm)$/i.test(f));
      if (videoFiles.length > 0) return join(videoDir, videoFiles[0]);
    }

    // Check directly in directory (Maestro pattern: recording.mp4)
    const directFiles = readdirSync(videoPath).filter(f => /\.(mp4|mov|webm)$/i.test(f));
    if (directFiles.length > 0) return join(videoPath, directFiles[0]);

    return videoPath;
  } catch {
    return videoPath;
  }
}

function resolveRecordingBaseDir(videoPath: string | null): string | null {
  if (!videoPath || !existsSync(videoPath)) return null;

  try {
    if (statSync(videoPath).isDirectory()) {
      return videoPath;
    }

    const parentDir = dirname(videoPath);
    return basename(parentDir) === 'video' ? dirname(parentDir) : parentDir;
  } catch {
    return null;
  }
}

function normalizeProjectRecord(project: ProjectRecord): NormalizedProjectRecord {
  const normalized = {
    ...project,
    videoPath: resolveVideoPath(project.videoPath),
    tags: parseJsonField(project.tags, [] as string[]),
    taskHubLinks: parseJsonField(project.taskHubLinks, [] as unknown[]),
    taskRequirements: parseJsonField(project.taskRequirements, [] as unknown[]),
    taskTestMap: parseJsonField(project.taskTestMap, [] as unknown[]),
  };

  return withProjectAnalysisProgress(normalized) as NormalizedProjectRecord;
}

function getRecordingSessionFinalUrl(sessionData: any): string | null {
  if (!sessionData || typeof sessionData !== 'object') return null;

  const actions = Array.isArray(sessionData.actions) ? sessionData.actions : [];
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (typeof action?.url === 'string' && action.url.trim()) {
      return action.url.trim();
    }
  }

  return typeof sessionData.url === 'string' && sessionData.url.trim()
    ? sessionData.url.trim()
    : null;
}

function isSyntheticProjectCover(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const filename = basename(filePath).toLowerCase();
  return filename === 'cover-app-icon.png' || filename === 'cover-site-icon.png';
}

async function maybeRepairMobileProjectThumbnail(project: ProjectRecord): Promise<ProjectRecord> {
  if (project.platform !== 'ios' && project.platform !== 'android') {
    return project;
  }

  if (project.thumbnailPath && isSyntheticProjectCover(project.thumbnailPath) && existsSync(project.thumbnailPath)) {
    return project;
  }

  const recordingBaseDir = resolveRecordingBaseDir(project.videoPath);
  if (!recordingBaseDir || !existsSync(recordingBaseDir)) {
    return project;
  }

  const sessionPath = join(recordingBaseDir, 'session.json');
  if (!existsSync(sessionPath)) {
    return project;
  }

  try {
    const sessionData = JSON.parse(readFileSync(sessionPath, 'utf8'));
    if (
      (sessionData?.platform !== 'ios' && sessionData?.platform !== 'android')
      || typeof sessionData?.deviceId !== 'string'
    ) {
      return project;
    }

    const iconCoverPath = await createMobileAppIconCover({
      platform: sessionData.platform,
      deviceId: sessionData.deviceId,
      appId: typeof sessionData.appId === 'string' ? sessionData.appId : null,
      outputDir: recordingBaseDir,
      adbPath: ADB_PATH,
    });

    if (!iconCoverPath || !existsSync(iconCoverPath)) {
      return project;
    }

    if (project.thumbnailPath !== iconCoverPath) {
      const db = getDatabase();
      await db.update(projects)
        .set({
          thumbnailPath: iconCoverPath,
        })
        .where(eq(projects.id, project.id));
    }

    return {
      ...project,
      thumbnailPath: iconCoverPath,
    };
  } catch {
    return project;
  }
}

// List projects
app.get('/api/projects', async (c) => {
  try {
    const db = getDatabase();
    const status = c.req.query('status');
    const platform = c.req.query('platform');
    const limit = parseInt(c.req.query('limit') || '20', 10);

    let results = await db.select().from(projects).orderBy(desc(projects.updatedAt)).limit(limit);
    await expireStaleAnalyzingProjects(results.map((p) => ({
      id: p.id,
      status: p.status,
      updatedAt: p.updatedAt,
    })));
    results = await db.select().from(projects).orderBy(desc(projects.updatedAt)).limit(limit);

    // Filter if needed
    if (status) {
      results = results.filter((p) => p.status === status);
    }
    if (platform) {
      results = results.filter((p) => p.platform === platform);
    }

    results = await Promise.all(results.map((p) => maybeRepairMobileProjectThumbnail(p as ProjectRecord)));

    return c.json({
      count: results.length,
      projects: results.map((p) => normalizeProjectRecord(p as ProjectRecord)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const statusCode = message === 'Recording already in progress' ? 409 : 500;
    return c.json({ error: message }, statusCode);
  }
});

// Delete all projects
app.delete('/api/projects/all', async (c) => {
  try {
    const db = getDatabase();
    const { rmSync, existsSync } = await import('node:fs');

    // Get all projects to delete their files
    const allProjects = await db.select().from(projects);

    // Delete project files
    for (const project of allProjects) {
      if (project.videoPath && existsSync(project.videoPath)) {
        try {
          const projectDir = project.videoPath.substring(0, project.videoPath.lastIndexOf('/'));
          rmSync(projectDir, { recursive: true, force: true });
        } catch {}
      }
    }

    // Delete from database
    await db.delete(frames);
    await db.delete(projectExports);
    await db.delete(testVariables);
    await db.delete(projects);

    return c.json({ success: true, deleted: allProjects.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get single project
app.get('/api/projects/:id', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');
    const { existsSync, readFileSync } = await import('node:fs');

    const result = await db.select().from(projects).where(eq(projects.id, id)).limit(1);

    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const rawProject = await maybeRepairMobileProjectThumbnail(result[0] as ProjectRecord);
    const project = normalizeProjectRecord(rawProject);
    const recordingBaseDir = resolveRecordingBaseDir(rawProject.videoPath);
    const actualVideoPath = resolveVideoPath(rawProject.videoPath);

    // Get exports
    const exports = await db
      .select()
      .from(projectExports)
      .where(eq(projectExports.projectId, id))
      .orderBy(desc(projectExports.createdAt));

    // Get frames
    const projectFrames = await db
      .select()
      .from(frames)
      .where(eq(frames.projectId, id))
      .orderBy(frames.frameNumber);

    // Try to load actions and viewport from session.json if project has videoPath (recording directory)
    let actions: any[] = [];
    let viewport: { width: number; height: number } | undefined;
    let networkEntries: CapturedNetworkEntry[] = [];
    let networkCapture: NetworkCaptureMeta | null = null;
    let esvp: Record<string, unknown> | null = null;

    if (recordingBaseDir && existsSync(recordingBaseDir)) {
      const sessionPath = join(recordingBaseDir, 'session.json');
      if (existsSync(sessionPath)) {
        try {
          const sessionData = JSON.parse(readFileSync(sessionPath, 'utf8'));
          if (sessionData.actions && Array.isArray(sessionData.actions)) {
            actions = sessionData.actions;
          }
          if (sessionData.viewport) {
            viewport = sessionData.viewport;
          }
          if (Array.isArray(sessionData.networkEntries)) {
            networkEntries = sessionData.networkEntries;
          }
          if (sessionData.networkCapture && typeof sessionData.networkCapture === 'object') {
            networkCapture = sessionData.networkCapture;
          }
          if (sessionData.esvp && typeof sessionData.esvp === 'object') {
            esvp = sessionData.esvp;
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
    }

    return c.json(withProjectAnalysisProgress({
      ...project,
      videoPath: actualVideoPath, // Return the actual video file path
      exports,
      frames: projectFrames,
      actions,
      viewport,
      networkEntries,
      networkCapture,
      esvp,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Create project
app.post('/api/projects', async (c) => {
  try {
    const db = getDatabase();
    const body = await c.req.json();

    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(projects).values({
      id,
      name: body.name || 'Untitled Project',
      platform: body.platform || null,
      linkedTicket: body.linkedTicket || null,
      tags: body.tags ? JSON.stringify(body.tags) : null,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });

    return c.json({ id, message: 'Project created' }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Sync orphan project directories to database
app.post('/api/projects/sync-orphans', async (c) => {
  try {
    const db = getDatabase();
    const { readdirSync, statSync, existsSync } = await import('node:fs');

    // Ensure PROJECTS_DIR exists
    if (!existsSync(PROJECTS_DIR)) {
      return c.json({ synced: 0, projects: [], message: 'Projects directory does not exist' });
    }

    // List all directories in PROJECTS_DIR
    const dirs = readdirSync(PROJECTS_DIR)
      .filter(d => {
        const p = join(PROJECTS_DIR, d);
        return statSync(p).isDirectory() && !d.startsWith('.');
      });

    // Get existing project IDs from DB
    const existing = await db.select({ id: projects.id }).from(projects);
    const existingIds = new Set(existing.map(p => p.id));

    // Find orphans (exclude special directories)
    const specialDirs = new Set(['maestro-recordings', 'web-recordings', 'frames']);
    const orphans = dirs.filter(d => !existingIds.has(d) && !specialDirs.has(d));

    // Create DB entries for orphans
    const created: string[] = [];
    for (const id of orphans) {
      const dirPath = join(PROJECTS_DIR, id);
      const platform = id.includes('_web_') ? 'web' : 'mobile';
      const now = new Date();

      await db.insert(projects).values({
        id,
        name: `Imported - ${id}`,
        videoPath: dirPath,
        platform,
        status: 'ready',
        createdAt: now,
        updatedAt: now
      });
      created.push(id);
    }

    return c.json({ synced: created.length, projects: created });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Update project
app.patch('/api/projects/:id', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');
    const body = await c.req.json();

    // Check exists
    const existing = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (existing.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const updates: any = { updatedAt: new Date() };

    if (body.name !== undefined) updates.name = body.name;
    if (body.marketingTitle !== undefined) updates.marketingTitle = body.marketingTitle;
    if (body.marketingDescription !== undefined) updates.marketingDescription = body.marketingDescription;
    if (body.manualNotes !== undefined) updates.manualNotes = body.manualNotes;
    if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags);
    if (body.linkedTicket !== undefined) updates.linkedTicket = body.linkedTicket;
    if (body.status !== undefined) updates.status = body.status;
    if (body.aiSummary !== undefined) updates.aiSummary = body.aiSummary;

    await db.update(projects).set(updates).where(eq(projects.id, id));

    return c.json({ message: 'Project updated' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Update project external links (Jira, Notion, Figma)
app.put('/api/projects/:id/links', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');
    const body = await c.req.json();

    // Check exists
    const existing = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (existing.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const updates: any = { updatedAt: new Date() };

    // Legacy single URL fields (backwards compatibility)
    if (body.linkedJiraUrl !== undefined) updates.linkedJiraUrl = body.linkedJiraUrl;
    if (body.linkedNotionUrl !== undefined) updates.linkedNotionUrl = body.linkedNotionUrl;
    if (body.linkedFigmaUrl !== undefined) updates.linkedFigmaUrl = body.linkedFigmaUrl;

    // Task Hub - Multiple links with metadata
    if (body.taskHubLinks !== undefined) {
      updates.taskHubLinks = typeof body.taskHubLinks === 'string'
        ? body.taskHubLinks
        : JSON.stringify(body.taskHubLinks);
    }
    if (body.taskRequirements !== undefined) {
      updates.taskRequirements = typeof body.taskRequirements === 'string'
        ? body.taskRequirements
        : JSON.stringify(body.taskRequirements);
    }
    if (body.taskTestMap !== undefined) {
      updates.taskTestMap = typeof body.taskTestMap === 'string'
        ? body.taskTestMap
        : JSON.stringify(body.taskTestMap);
    }

    await db.update(projects).set(updates).where(eq(projects.id, id));

    return c.json({
      message: 'Links updated',
      linkedJiraUrl: body.linkedJiraUrl || null,
      linkedNotionUrl: body.linkedNotionUrl || null,
      linkedFigmaUrl: body.linkedFigmaUrl || null,
      taskHubLinks: body.taskHubLinks || null,
      taskRequirements: body.taskRequirements || null,
      taskTestMap: body.taskTestMap || null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// MCP INTEGRATION ENDPOINTS - Fetch metadata from Jira, Notion, Figma
// ============================================================================

function extractJiraIssueKey(url: string): string | null {
  const ticketMatch = url.match(/([A-Z][A-Z0-9]+-\d+)/);
  return ticketMatch ? ticketMatch[1] : null;
}

function jiraAdfToPlainText(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(jiraAdfToPlainText).join('');
  if (typeof node !== 'object') return '';

  const record = node as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const content = jiraAdfToPlainText(record.content);

  switch (type) {
    case 'text':
      return typeof record.text === 'string' ? record.text : '';
    case 'paragraph':
      return `${content}\n`;
    case 'hardBreak':
      return '\n';
    case 'bulletList':
    case 'orderedList':
      return `${content}\n`;
    case 'listItem':
      return content ? `• ${content}` : '';
    default:
      return content;
  }
}

function sanitizeJiraText(text: string, maxLength = 600): string {
  const trimmed = text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
}

async function fetchJiraIssueDetails(
  baseUrl: string,
  issueKey: string
): Promise<{
  summary: string;
  status: string | null;
  description: string | null;
  assigneeName: string | null;
  priority: string | null;
  issueType: string | null;
  reporterName: string | null;
} | null> {
  const jiraEmail = jiraSettings.email || process.env.JIRA_EMAIL;
  const jiraToken = jiraSettings.apiToken || process.env.JIRA_API_TOKEN;
  if (!jiraEmail || !jiraToken) return null;

  try {
    const authHeader = `Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')}`;
    const url = `${baseUrl}/rest/api/3/issue/${issueKey}?fields=summary,status,assignee,description,priority,issuetype,reporter`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: authHeader,
      },
    });
    if (!response.ok) return null;

    const data = await response.json() as { fields?: Record<string, unknown> };
    const fields = data.fields || {};

    const summary = typeof fields.summary === 'string' ? fields.summary : issueKey;
    const statusName = (fields.status as { name?: string } | undefined)?.name || null;
    const assigneeName = (fields.assignee as { displayName?: string } | undefined)?.displayName || null;
    const priorityName = (fields.priority as { name?: string } | undefined)?.name || null;
    const issueType = (fields.issuetype as { name?: string } | undefined)?.name || null;
    const reporterName = (fields.reporter as { displayName?: string } | undefined)?.displayName || null;

    let descriptionText: string | null = null;
    if (typeof fields.description === 'string') {
      descriptionText = fields.description;
    } else if (fields.description) {
      descriptionText = jiraAdfToPlainText(fields.description);
    }

    const description = descriptionText ? sanitizeJiraText(descriptionText) : null;

    return {
      summary,
      status: statusName,
      description,
      assigneeName,
      priority: priorityName,
      issueType,
      reporterName,
    };
  } catch (error) {
    console.warn('[Jira] Failed to fetch issue details:', error instanceof Error ? error.message : error);
    return null;
  }
}

// Helper function to extract metadata from URL
async function extractLinkMetadata(
  url: string,
  type: string
): Promise<{ success: boolean; metadata: any; error?: string }> {
  try {
    const parsedUrl = new URL(url);

    switch (type) {
      case 'jira': {
        const ticketKey = extractJiraIssueKey(url);
        const baseUrl = jiraSettings.baseUrl || process.env.JIRA_BASE_URL || parsedUrl.origin;
        const metadata: Record<string, unknown> = {
          ticketKey,
          domain: parsedUrl.hostname,
          baseUrl,
          type: 'jira',
          title: ticketKey ? `Jira Issue ${ticketKey}` : 'Jira Issue',
          status: null,
          description: null,
          assignee: null,
          assigneeName: null,
          priority: null,
          issueType: null,
          reporterName: null,
          mcpAvailable: false,
          fetchedAt: new Date().toISOString()
        };

        if (ticketKey) {
          const details = await fetchJiraIssueDetails(baseUrl, ticketKey);
          if (details) {
            metadata.title = `${ticketKey} — ${details.summary}`;
            metadata.status = details.status;
            metadata.description = details.description;
            metadata.assigneeName = details.assigneeName;
            metadata.priority = details.priority;
            metadata.issueType = details.issueType;
            metadata.reporterName = details.reporterName;
            metadata.mcpAvailable = true;
            metadata.fetchedAt = new Date().toISOString();
          }
        }

        return { success: true, metadata };
      }

      case 'notion': {
        const pageIdMatch = url.match(/([a-f0-9]{32}|[a-f0-9-]{36})/i);
        const pageId = pageIdMatch ? pageIdMatch[1] : null;

        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const pageName = pathParts[pathParts.length - 1]?.replace(/-[a-f0-9]{32}$/i, '').replace(/-/g, ' ');

        return {
          success: true,
          metadata: {
            pageId,
            domain: parsedUrl.hostname,
            type: 'notion',
            title: pageName || 'Notion Page',
            workspace: pathParts[0] || null,
            content: null,
            lastEdited: null,
            mcpAvailable: false,
            fetchedAt: new Date().toISOString()
          }
        };
      }

      case 'figma': {
        const fileMatch = url.match(/file\/([a-zA-Z0-9]+)/);
        const nodeMatch = url.match(/node-id=([^&]+)/);
        const fileKey = fileMatch ? fileMatch[1] : null;
        const nodeId = nodeMatch ? decodeURIComponent(nodeMatch[1]) : null;

        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const fileName = pathParts[2]?.replace(/-/g, ' ') || 'Figma Design';

        return {
          success: true,
          metadata: {
            fileKey,
            nodeId,
            domain: parsedUrl.hostname,
            type: 'figma',
            title: fileName,
            thumbnailUrl: null,
            lastModified: null,
            mcpAvailable: false,
            fetchedAt: new Date().toISOString()
          }
        };
      }

      case 'github': {
        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const owner = pathParts[0];
        const repo = pathParts[1];
        const itemType = pathParts[2];
        const itemNumber = pathParts[3];

        return {
          success: true,
          metadata: {
            owner,
            repo,
            itemType: itemType === 'pull' ? 'pull_request' : itemType,
            itemNumber: itemNumber ? parseInt(itemNumber) : null,
            domain: parsedUrl.hostname,
            type: 'github',
            title: itemNumber ? `${owner}/${repo}#${itemNumber}` : `${owner}/${repo}`,
            state: null,
            labels: null,
            mcpAvailable: false,
            fetchedAt: new Date().toISOString()
          }
        };
      }

      default:
        return { success: false, metadata: null, error: `Unsupported link type: ${type}` };
    }
  } catch (err) {
    return { success: false, metadata: null, error: err instanceof Error ? err.message : 'Invalid URL' };
  }
}

// Fetch metadata from external link via MCP or web fetch
app.post('/api/mcp/fetch', async (c) => {
  try {
    const body = await c.req.json();
    const { url, type } = body;

    if (!url || !type) {
      return c.json({ error: 'URL and type are required' }, 400);
    }

    const result = await extractLinkMetadata(url, type);

    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({
      success: true,
      metadata: result.metadata,
      message: 'Basic metadata extracted. Full MCP integration pending.'
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Batch fetch metadata for multiple links
app.post('/api/mcp/fetch-batch', async (c) => {
  try {
    const body = await c.req.json();
    const { links } = body;

    if (!Array.isArray(links)) {
      return c.json({ error: 'Links array is required' }, 400);
    }

    const results = await Promise.all(
      links.map(async (link: { id: string; url: string; type: string }) => {
        const result = await extractLinkMetadata(link.url, link.type);
        return {
          id: link.id,
          success: result.success,
          metadata: result.metadata,
          error: result.error || null
        };
      })
    );

    return c.json({
      success: true,
      results
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// AI PROCESSING ENDPOINT - Generate requirements and test map from links
// ============================================================================

// Generate requirements and test map from linked content
app.post('/api/ai/generate-task-info', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, links } = body;

    if (!projectId) {
      return c.json({ error: 'Project ID is required' }, 400);
    }

    if (!links || !Array.isArray(links) || links.length === 0) {
      return c.json({ error: 'At least one link is required' }, 400);
    }

    // Analyze links and generate requirements based on link types and metadata
    const requirements: { id: string; text: string; source: string; priority: string }[] = [];
    const testMap: { id: string; description: string; type: string; completed: boolean }[] = [];

    // Process each link to generate requirements
    for (const link of links) {
      const { type, title, url, metadata } = link;

      switch (type) {
        case 'jira': {
          const ticketKey = metadata?.ticketKey || title || 'Jira Issue';
          requirements.push({
            id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            text: `Implement functionality as specified in ${ticketKey}`,
            source: ticketKey,
            priority: metadata?.priority || 'medium'
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Verify ${ticketKey} acceptance criteria are met`,
            type: 'functional',
            completed: false
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Test edge cases for ${ticketKey}`,
            type: 'edge-case',
            completed: false
          });
          break;
        }

        case 'notion': {
          const pageName = metadata?.title || title || 'Notion Page';
          requirements.push({
            id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            text: `Follow specifications from "${pageName}"`,
            source: pageName,
            priority: 'medium'
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Validate against "${pageName}" documentation`,
            type: 'documentation',
            completed: false
          });
          break;
        }

        case 'figma': {
          const designName = metadata?.title || title || 'Figma Design';
          requirements.push({
            id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            text: `Match UI/UX specifications from "${designName}"`,
            source: designName,
            priority: 'high'
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Visual regression test against "${designName}"`,
            type: 'visual',
            completed: false
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Responsive design verification for "${designName}"`,
            type: 'responsive',
            completed: false
          });
          break;
        }

        case 'github': {
          const repoInfo = metadata?.title || title || 'GitHub';
          requirements.push({
            id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            text: `Address issue/PR: ${repoInfo}`,
            source: repoInfo,
            priority: 'medium'
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Verify fix for ${repoInfo}`,
            type: 'regression',
            completed: false
          });
          break;
        }
      }
    }

    // Add general test cases
    testMap.push({
      id: `test_${Date.now()}_general`,
      description: 'Cross-browser compatibility check',
      type: 'compatibility',
      completed: false
    });
    testMap.push({
      id: `test_${Date.now()}_perf`,
      description: 'Performance validation',
      type: 'performance',
      completed: false
    });

    // Update project with generated data
    const db = getDatabase();
    await db.update(projects).set({
      taskRequirements: JSON.stringify(requirements),
      taskTestMap: JSON.stringify(testMap),
      updatedAt: new Date()
    }).where(eq(projects.id, projectId));

    return c.json({
      success: true,
      requirements,
      testMap,
      message: 'Task info generated successfully'
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// AI-powered Jira card summary
app.post('/api/ai/jira-summary', async (c) => {
  try {
    const body = await c.req.json();
    const { title, status, description, assigneeName, priority, issueType, reporterName } = body;

    if (!title && !description) {
      return c.json({ error: 'No Jira data to summarize' }, 400);
    }

    const provider = await getLLMProvider();
    if (!provider) {
      return c.json({ error: 'No LLM provider available', summary: null });
    }

    const jiraDataParts = [
      title ? `Title: ${title}` : '',
      status ? `Status: ${status}` : '',
      issueType ? `Type: ${issueType}` : '',
      priority ? `Priority: ${priority}` : '',
      assigneeName ? `Assignee: ${assigneeName}` : '',
      reporterName ? `Reporter: ${reporterName}` : '',
      description ? `Description: ${description.slice(0, 1500)}` : '',
    ].filter(Boolean).join('\n');

    const prompt = `Summarize this Jira card in 2-3 concise sentences. Focus on what the task is about, its current status, and key details. Be direct, no filler words.\n\n${jiraDataParts}`;

    const summary = await provider.sendMessage(prompt);

    return c.json({ success: true, summary: summary.trim() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message, summary: null }, 500);
  }
});

// ============================================================================
// SMART TITLE & MARKETING DESCRIPTION
// ============================================================================

/**
 * Clean device names, timestamps, and "Recording" prefix from project titles.
 * e.g. "iOS: iPhone 14 Pro Recording - 2026-03-23 10:30:00" → "App Recording"
 * Returns empty string if nothing meaningful remains, so caller can fallback.
 */
function cleanProjectTitle(rawName: string): string {
  return rawName
    // Remove platform prefixes like "iOS:", "Android:", "Web:"
    .replace(/^(iOS|Android|Web)\s*:\s*/i, '')
    // Remove device model names
    .replace(/\b(iPhone|iPad|iPod|Pixel|Galaxy|Samsung|Motorola|OnePlus|Xiaomi|Huawei|Emulator|Simulator|emulator-\d+)\s*(\d+\s*)?(Pro|Max|Plus|Ultra|Mini|Air|SE|lite)?\s*/gi, '')
    // Remove "Recording -" or "Recording" standalone
    .replace(/\bRecording\s*-?\s*/gi, '')
    // Remove "Test -" patterns like "Test - 5 actions"
    .replace(/\bTest\s*-\s*\d+\s*actions?\s*-?\s*/gi, '')
    // Remove ISO timestamps and date patterns
    .replace(/\d{4}-\d{2}-\d{2}(\s+\d{2}:\d{2}(:\d{2})?)?/g, '')
    // Remove trailing dashes and extra whitespace
    .replace(/\s*-\s*$/, '')
    .replace(/^\s*-\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Generate or update marketing title (cleaned) for a project
app.post('/api/ai/clean-title', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId } = body;
    if (!projectId) return c.json({ error: 'projectId required' }, 400);

    const db = getDatabase();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const cleaned = cleanProjectTitle(project.name);
    const marketingTitle = cleaned || project.name;

    await db.update(projects)
      .set({ marketingTitle, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return c.json({ success: true, originalTitle: project.name, marketingTitle });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Update marketing title manually (user editable)
app.put('/api/projects/:id/marketing-title', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { marketingTitle } = body;
    if (!marketingTitle || typeof marketingTitle !== 'string') {
      return c.json({ error: 'marketingTitle required' }, 400);
    }

    const db = getDatabase();
    await db.update(projects)
      .set({ marketingTitle: marketingTitle.trim(), updatedAt: new Date() })
      .where(eq(projects.id, id));

    return c.json({ success: true, marketingTitle: marketingTitle.trim() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Generate marketing-quality description using LLM
app.post('/api/ai/marketing-description', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId } = body;
    if (!projectId) return c.json({ error: 'projectId required' }, 400);

    const db = getDatabase();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    if (!project.aiSummary && !project.ocrText) {
      return c.json({ error: 'Project has no analysis data. Run analyzer first.' }, 400);
    }

    const provider = await getLLMProvider();
    if (!provider) {
      return c.json({ error: 'No LLM provider available' }, 500);
    }

    const cleanedTitle = project.marketingTitle || cleanProjectTitle(project.name) || project.name;
    const analysisData = project.aiSummary || project.ocrText?.slice(0, 3000) || '';

    const prompt = `You are a professional copywriter for app marketing. Given this app analysis, write a compelling 2-3 sentence marketing description suitable for a portfolio, Notion page, or app store listing.

App Title: ${cleanedTitle}
Platform: ${project.platform || 'unknown'}

App Analysis:
${analysisData.slice(0, 4000)}

Rules:
- Focus on what the app does and its value to users
- Professional, engaging tone
- No technical jargon or QA terminology
- No markdown formatting - plain text only
- 2-3 sentences max`;

    const response = await provider.sendMessage(prompt);
    const description = typeof response === 'string' ? response.trim() : '';

    if (!description) {
      return c.json({ error: 'LLM returned empty response' }, 500);
    }

    // Save to database
    await db.update(projects)
      .set({
        marketingDescription: description,
        marketingTitle: project.marketingTitle || cleanedTitle,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    return c.json({
      success: true,
      marketingTitle: project.marketingTitle || cleanedTitle,
      marketingDescription: description,
      provider: provider.name,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Update marketing description manually (user editable)
app.put('/api/projects/:id/marketing-description', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { marketingDescription } = body;
    if (!marketingDescription || typeof marketingDescription !== 'string') {
      return c.json({ error: 'marketingDescription required' }, 400);
    }

    const db = getDatabase();
    await db.update(projects)
      .set({ marketingDescription: marketingDescription.trim(), updatedAt: new Date() })
      .where(eq(projects.id, id));

    return c.json({ success: true, marketingDescription: marketingDescription.trim() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Delete project
app.delete('/api/projects/:id', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');
    const { rmSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Delete from database
    await db.delete(frames).where(eq(frames.projectId, id));
    await db.delete(projects).where(eq(projects.id, id));
    await deleteTestVariablesForOwner('project', id);
    await deleteTestVariablesForOwner('mobile-recording', id);
    await deleteTestVariablesForOwner('web-recording', id);

    // Also delete associated recording directories if they exist
    const mobileRecordingDir = join(PROJECTS_DIR, 'maestro-recordings', id);
    const webRecordingDir = join(PROJECTS_DIR, 'web-recordings', id);
    const projectDir = join(PROJECTS_DIR, id);

    // Try to delete mobile recording dir
    if (existsSync(mobileRecordingDir)) {
      rmSync(mobileRecordingDir, { recursive: true, force: true });
      console.log(`[Delete] Removed mobile recording: ${id}`);
    }

    // Try to delete web recording dir
    if (existsSync(webRecordingDir)) {
      rmSync(webRecordingDir, { recursive: true, force: true });
      console.log(`[Delete] Removed web recording: ${id}`);
    }

    // Try to delete project dir (for uploads and other captures)
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
      console.log(`[Delete] Removed project directory: ${id}`);
    }

    // Delete exports dir (template renders, grids, viz screenshots)
    const { EXPORTS_DIR: exportsDir, FRAMES_DIR: framesDir } = await import('../db/index.js');
    const projectExportsDir = join(exportsDir, id);
    if (existsSync(projectExportsDir)) {
      rmSync(projectExportsDir, { recursive: true, force: true });
      console.log(`[Delete] Removed exports directory: ${id}`);
    }

    // Delete frames dir
    const projectFramesDir = join(framesDir, id);
    if (existsSync(projectFramesDir)) {
      rmSync(projectFramesDir, { recursive: true, force: true });
      console.log(`[Delete] Removed frames directory: ${id}`);
    }

    return c.json({ message: 'Project deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// FILE UPLOAD API (with AI-powered naming and thumbnail selection)
// ============================================================================
app.post('/api/upload', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const db = getDatabase();
    const { mkdirSync, writeFileSync, existsSync: fsExists, readdirSync } = await import('node:fs');
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const { PROJECTS_DIR, FRAMES_DIR } = await import('../db/index.js');

    // Create project
    const id = crypto.randomUUID();
    const now = new Date();

    // Create project directory
    const projectDir = join(PROJECTS_DIR, id);
    if (!fsExists(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }

    // Save file
    const fileName = file.name;
    const filePath = join(projectDir, fileName);
    const arrayBuffer = await file.arrayBuffer();
    writeFileSync(filePath, Buffer.from(arrayBuffer));

    // Detect platform from filename
    let platform: string | null = null;
    const lowerName = fileName.toLowerCase();
    if (lowerName.includes('ios') || lowerName.includes('iphone') || lowerName.includes('ipad')) {
      platform = 'ios';
    } else if (lowerName.includes('android') || lowerName.includes('pixel')) {
      platform = 'android';
    } else if (lowerName.includes('web') || lowerName.includes('browser')) {
      platform = 'web';
    }

    // Determine file type
    const ext = fileName.toLowerCase().split('.').pop() || '';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext);
    const isVideo = ['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext);

    // AI-powered analysis
    let smartName = fileName.replace(/\.[^/.]+$/, ''); // Default: filename without extension
    let thumbnailPath: string | null = null;
    let ocrText = '';
    let framePaths: string[] = [];

    try {
      if (isVideo) {
        // Create frames directory for this project
        const projectFramesDir = join(FRAMES_DIR, id);
        if (!fsExists(projectFramesDir)) {
          mkdirSync(projectFramesDir, { recursive: true });
        }

        // Extract key frames using FFmpeg (1 frame per second, max 15 frames)
        const framePattern = join(projectFramesDir, 'frame_%04d.png');
        try {
          await execAsync(`ffmpeg -i "${filePath}" -vf "fps=1" -frames:v 15 "${framePattern}" -y 2>/dev/null`);
        } catch {
          // FFmpeg might not be installed, continue without frames
        }

        // Get extracted frame paths
        if (fsExists(projectFramesDir)) {
          framePaths = readdirSync(projectFramesDir)
            .filter(f => f.endsWith('.png'))
            .sort()
            .map(f => join(projectFramesDir, f));
        }

        if (framePaths.length > 0) {
          // Run OCR and select best frame
          const { bestFrame, analyses } = await selectBestFrame(framePaths);
          thumbnailPath = bestFrame;

          // Combine all OCR text for smart naming
          ocrText = analyses.map(a => a.text).join('\n');

          // Generate smart name from OCR content
          smartName = generateSmartProjectName(ocrText, smartName);
        }
      } else if (isImage) {
        // Single image - run OCR directly
        const { recognizeText } = await import('../core/analyze/ocr.js');
        const ocrResult = await recognizeText(filePath);

        if (ocrResult.success && ocrResult.text) {
          ocrText = ocrResult.text;
          smartName = generateSmartProjectName(ocrText, smartName);
        }

        // Use the image itself as thumbnail
        thumbnailPath = filePath;
      }
    } catch (analysisError) {
      // AI analysis failed, continue with defaults
      console.warn('AI analysis failed:', analysisError);
    }

    // Insert project with AI-generated data
    await db.insert(projects).values({
      id,
      name: smartName,
      videoPath: filePath,
      thumbnailPath: thumbnailPath,
      ocrText: ocrText || null,
      platform,
      status: 'draft',
      frameCount: framePaths.length || (isImage ? 1 : 0),
      createdAt: now,
      updatedAt: now,
    });

    return c.json({
      id,
      message: 'File uploaded and analyzed',
      fileName,
      filePath,
      platform,
      smartName,
      thumbnailPath,
      framesExtracted: framePaths.length,
      ocrDetected: ocrText.length > 0
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// CAPTURE API
// ============================================================================
app.post('/api/capture/start', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const { mkdirSync, existsSync: fsExists } = await import('node:fs');
    const { PROJECTS_DIR } = await import('../db/index.js');
    const db = getDatabase();

    // Create project
    const id = crypto.randomUUID();
    const now = new Date();
    const projectDir = join(PROJECTS_DIR, id);

    if (!fsExists(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }

    const screenshotPath = join(projectDir, 'capture.png');
    const captureType = body.sourceType || body.type || 'screen';
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : '';

    // Detect platform
    const osPlatform = process.platform === 'darwin' ? 'macos' : process.platform;

    if (osPlatform === 'macos') {
      try {
        if (captureType === 'simulator') {
          // Capture iOS Simulator
          const simulatorId = sourceId.replace(/^simulator:/i, '') || 'booted';
          await execAsync(`xcrun simctl io "${simulatorId}" screenshot "${screenshotPath}"`);
        } else if (captureType === 'android') {
          const adbPath = ADB_PATH || 'adb';
          const resolvedDeviceId = resolveAndroidDeviceSerial(sourceId || body.deviceId, adbPath);
          if (!resolvedDeviceId) {
            return c.json({
              error: 'No Android device connected',
              hint: 'Start an Android emulator or connect a device, then try again.'
            }, 400);
          }

          const tempDevicePath = `/sdcard/discoverylab-capture-${Date.now()}.png`;
          await execAsync(`"${adbPath}" -s "${resolvedDeviceId}" shell screencap -p "${tempDevicePath}"`);
          await execAsync(`"${adbPath}" -s "${resolvedDeviceId}" pull "${tempDevicePath}" "${screenshotPath}"`);
          await execAsync(`"${adbPath}" -s "${resolvedDeviceId}" shell rm "${tempDevicePath}"`).catch(() => {});
        } else {
          // Capture screen - try interactive mode if silent fails
          try {
            await execAsync(`screencapture -x "${screenshotPath}"`);
          } catch (captureErr) {
            // Permission error - try interactive capture or give instructions
            const errMsg = captureErr instanceof Error ? captureErr.message : '';
            if (errMsg.includes('could not create image')) {
              return c.json({
                error: 'Screen Recording permission required',
                details: 'Go to System Settings > Privacy & Security > Screen Recording and enable permission for Terminal or your IDE.',
                hint: 'After enabling, restart your terminal and try again.'
              }, 403);
            }
            throw captureErr;
          }
        }
      } catch (cmdErr) {
        const errMsg = cmdErr instanceof Error ? cmdErr.message : 'Capture failed';
        if (errMsg.includes('No booted device') || errMsg.includes('No devices are booted')) {
          return c.json({
            error: 'No iOS Simulator running',
            hint: 'Open Xcode > Simulator to start an iOS simulator, or use "Full Screen" capture instead.'
          }, 400);
        }
        throw cmdErr;
      }
    } else {
      return c.json({ error: 'Screen capture only supported on macOS' }, 400);
    }

    // Check if capture was successful
    if (!fsExists(screenshotPath)) {
      return c.json({ error: 'Capture failed - no file was created' }, 500);
    }

    // Insert project
    await db.insert(projects).values({
      id,
      name: `Capture ${now.toLocaleString()}`,
      videoPath: screenshotPath,
      platform: captureType === 'simulator' ? 'ios' : captureType === 'android' ? 'android' : 'macos',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });

    return c.json({
      id,
      message: 'Capture completed',
      path: screenshotPath,
      type: captureType
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get available capture sources
app.get('/api/capture/sources', async (c) => {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const platform = process.platform;

    const sources: Array<{id: string, name: string, type: string}> = [];

    if (platform === 'darwin') {
      sources.push({ id: 'screen', name: 'Full Screen', type: 'screen' });
      sources.push({ id: 'window', name: 'Window', type: 'window' });

      // Check for iOS Simulator
      try {
        const { stdout } = await execAsync('xcrun simctl list devices booted -j');
        const data = JSON.parse(stdout);
        for (const runtime of Object.values(data.devices) as any[]) {
          for (const device of runtime) {
            if (device.state === 'Booted') {
              sources.push({
                id: `simulator:${device.udid}`,
                name: `iOS: ${device.name}`,
                type: 'simulator'
              });
            }
          }
        }
      } catch {
        // No simulators running
      }

      // Check for Android emulator (using detected SDK path)
      if (ADB_PATH) {
        try {
          const { stdout } = await execAsync(`"${ADB_PATH}" devices`);
          const lines = stdout.trim().split('\n').slice(1);
          for (const line of lines) {
            if (line.includes('device') || line.includes('emulator')) {
              const deviceId = line.split('\t')[0];
              sources.push({
                id: `android:${deviceId}`,
                name: `Android: ${deviceId}`,
                type: 'android'
              });
            }
          }
        } catch {
          // No Android devices
        }
      }
    }

    return c.json({ sources });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// CAPTURE RECORDING API (Mobile & Web screen recording)
// ============================================================================

// State for capture recording sessions
let captureSession: {
  type: 'mobile' | 'web';
  deviceId?: string;
  platform?: string;
  deviceName?: string;
  appId?: string | null;
  url?: string;
  faviconCandidates?: string[];
  startTime: number;
  videoPath?: string;
  screenshotsDir?: string;
  process?: any;
  browser?: any;
  context?: any;
  page?: any;
  projectId?: string;
  networkEntries?: CapturedNetworkEntry[];
  networkCapture?: NetworkCaptureMeta;
  networkDetach?: () => void;
} | null = null;

// Get current capture session status
app.get('/api/capture/status', (c) => {
  if (!captureSession) {
    return c.json({ active: false });
  }
  return c.json({
    active: true,
    type: captureSession.type,
    startTime: captureSession.startTime,
    projectId: captureSession.projectId,
    url: captureSession.url,
    deviceName: captureSession.deviceName,
    platform: captureSession.platform
  });
});

// Start mobile screen recording
app.post('/api/capture/mobile/start', async (c) => {
  try {
    if (captureSession) {
      return c.json({ error: 'A recording session is already active' }, 400);
    }

    const body = await c.req.json();
    const { deviceId, platform, deviceName } = body;

    if (!deviceId || !platform) {
      return c.json({ error: 'Device ID and platform required' }, 400);
    }

    let targetDeviceId = String(deviceId).trim();
    if (platform === 'android') {
      const resolvedSerial = resolveAndroidDeviceSerial(targetDeviceId);
      if (!resolvedSerial) {
        return c.json({
          error: `Android device "${targetDeviceId}" not found. Select a running emulator/device and try again.`
        }, 400);
      }
      targetDeviceId = resolvedSerial;
    }

    const { exec, spawn } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { mkdirSync } = await import('node:fs');
    const execAsync = promisify(exec);

    // Create project directory
    const projectId = `capture_${Date.now()}`;
    const projectDir = join(PROJECTS_DIR, projectId);
    const screenshotsDir = join(projectDir, 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    const videoPath = join(projectDir, 'recording.mp4');
    const initialAppId = getForegroundAppIdForPlatform(platform, targetDeviceId);

    // Start video recording based on platform
    let recordProcess: any = null;

    if (platform === 'ios') {
      // iOS Simulator video recording
      recordProcess = spawn('xcrun', ['simctl', 'io', targetDeviceId, 'recordVideo', videoPath], {
        stdio: 'pipe'
      });
    } else if (platform === 'android') {
      // Android screen recording via adb
      const adbPath = ADB_PATH || 'adb';
      recordProcess = spawn(adbPath, ['-s', targetDeviceId, 'shell', 'screenrecord', '/sdcard/recording.mp4'], {
        stdio: 'pipe'
      });
    }

    captureSession = {
      type: 'mobile',
      deviceId: targetDeviceId,
      platform,
      deviceName,
      appId: initialAppId,
      startTime: Date.now(),
      videoPath,
      screenshotsDir,
      process: recordProcess,
      projectId
    };

    // Create project in database with "processing" status
    const db = getDatabase();
    await db.insert(projects).values({
      id: projectId,
      name: `${deviceName || platform.toUpperCase()} Recording - ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
      videoPath: projectDir,
      platform,
      status: 'processing',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return c.json({
      success: true,
      projectId,
      message: 'Mobile recording started'
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Stop mobile screen recording
app.post('/api/capture/mobile/stop', async (c) => {
  try {
    if (!captureSession || captureSession.type !== 'mobile') {
      return c.json({ error: 'No active mobile recording session' }, 400);
    }

    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    const session = captureSession;
    const projectId = session.projectId!;
    const projectDir = dirname(session.videoPath || '');

    // Stop recording process
    if (session.process) {
      session.process.kill('SIGINT');
      // Wait a bit for the process to finish writing
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // For Android, pull the video file
    if (session.platform === 'android' && session.deviceId) {
      const adbPath = ADB_PATH || 'adb';
      try {
        const resolvedDeviceId = resolveAndroidDeviceSerial(session.deviceId) || session.deviceId;
        await execAsync(`"${adbPath}" -s "${resolvedDeviceId}" pull /sdcard/recording.mp4 "${session.videoPath}"`);
        await execAsync(`"${adbPath}" -s "${resolvedDeviceId}" shell rm /sdcard/recording.mp4`);
      } catch (err) {
        console.error('Failed to pull Android recording:', err);
      }
    }

    const resolvedAppId = session.deviceId && session.platform
      ? (session.appId || getForegroundAppIdForPlatform(session.platform as 'ios' | 'android', session.deviceId))
      : null;
    const iconCoverPath = (resolvedAppId && session.deviceId && session.platform && projectDir)
      ? await createMobileAppIconCover({
          platform: session.platform as 'ios' | 'android',
          deviceId: session.deviceId,
          appId: resolvedAppId,
          outputDir: projectDir,
          adbPath: ADB_PATH,
        })
      : null;

    captureSession = null;

    // Update project status to trigger OCR analysis
    const db = getDatabase();
    await db.update(projects)
      .set({
        thumbnailPath: iconCoverPath || undefined,
        status: 'processing',
        updatedAt: new Date()
      })
      .where(eq(projects.id, projectId));

    // Trigger OCR analysis in background
    runProjectAnalysisInBackgroundWithWatchdog(projectId, 'CaptureStop');

    return c.json({
      success: true,
      projectId,
      videoPath: session.videoPath,
      thumbnailPath: iconCoverPath,
      message: 'Recording stopped, analyzing...'
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    captureSession = null;
    return c.json({ error: message }, 500);
  }
});

// Start web browser recording
app.post('/api/capture/web/start', async (c) => {
  try {
    if (captureSession) {
      return c.json({ error: 'A recording session is already active' }, 400);
    }

    const body = await c.req.json();
    const { url, captureResolution: captureResKey, viewportMode, viewportResolution: vpResKey } = body;
    const startUrl = url || 'about:blank';

    // Resolve capture resolution from settings (default 1080p)
    const CAPTURE_RESOLUTIONS: Record<string, { width: number; height: number }> = {
      '720': { width: 1280, height: 720 },
      '1080': { width: 1920, height: 1080 },
      '1440': { width: 2560, height: 1440 },
      '2160': { width: 3840, height: 2160 },
    };
    const captureRes = CAPTURE_RESOLUTIONS[captureResKey || '1080'] || CAPTURE_RESOLUTIONS['1080'];
    const vpRes = CAPTURE_RESOLUTIONS[vpResKey || captureResKey || '1080'] || captureRes;

    const { mkdirSync } = await import('node:fs');

    // Create project directory
    const projectId = `capture_web_${Date.now()}`;
    const projectDir = join(PROJECTS_DIR, projectId);
    const screenshotsDir = join(projectDir, 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    // Launch Playwright browser with video recording
    let browser: any = null;
    let page: any = null;
    const networkEntries: CapturedNetworkEntry[] = [];
    const networkCapture: NetworkCaptureMeta = {
      truncated: false,
      maxEntries: 1200,
      resourceTypes: [...PLAYWRIGHT_NETWORK_RESOURCE_TYPES],
    };

    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({
        headless: false,
        channel: 'chrome'  // Use user's installed Chrome instead of Playwright's Chromium
      });

      const context = await browser.newContext({
        recordVideo: {
          dir: projectDir,
          size: captureRes
        },
        viewport: viewportMode === 'fixed' ? vpRes : null
      });

      // Hide scrollbars in all pages created in this context
      const hideScrollbarJS = `
        function __hideScrollbars() {
          const s = document.createElement('style');
          s.textContent = '::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}html,body,*{scrollbar-width:none!important}';
          (document.head || document.documentElement).appendChild(s);
        }
        if (document.head || document.body) { __hideScrollbars(); }
        else { document.addEventListener('DOMContentLoaded', __hideScrollbars); }
      `;
      await context.addInitScript({ content: hideScrollbarJS });

      page = await context.newPage();
      const networkHandle = attachPlaywrightNetworkCapture(page, {
        entries: networkEntries,
        meta: networkCapture,
      });
      await page.goto(startUrl);
      try { await page.addStyleTag({ content: '::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}html,body,*{scrollbar-width:none!important}' }); } catch { /* ignore */ }

      captureSession = {
        type: 'web',
        url: startUrl,
        startTime: Date.now(),
        screenshotsDir,
        browser,
        context,
        page,
        projectId,
        networkEntries,
        networkCapture,
        networkDetach: networkHandle.detach,
      };

      // Create project in database
      const db = getDatabase();
      await db.insert(projects).values({
        id: projectId,
        name: `Web Recording - ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
        videoPath: projectDir,
        platform: 'web',
        status: 'processing',
        createdAt: new Date(),
        updatedAt: new Date()
      });

      return c.json({
        success: true,
        projectId,
        message: 'Browser recording started'
      });

    } catch (err) {
      if (browser) await browser.close();
      throw err;
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('playwright') || message.includes('Cannot find module')) {
      return c.json({
        error: 'Playwright not installed',
        hint: 'Run: npm install playwright && npx playwright install chromium'
      }, 400);
    }
    return c.json({ error: message }, 500);
  }
});

// Stop web browser recording
app.post('/api/capture/web/stop', async (c) => {
  try {
    if (!captureSession || captureSession.type !== 'web') {
      return c.json({ error: 'No active web recording session' }, 400);
    }

    const session = captureSession;
    const projectId = session.projectId!;
    const endedAt = Date.now();
    const { writeFileSync } = await import('node:fs');
    const projectDir = join(PROJECTS_DIR, projectId);
    let finalPageUrl = session.url || null;
    let faviconCandidates: string[] = [];

    if (session.page) {
      try {
        const pageMeta = await session.page.evaluate(() => {
          const doc = (globalThis as any).document;
          const locationHref = (globalThis as any).location?.href || '';
          const links = Array.from(doc?.querySelectorAll?.('link[rel]') || [])
            .filter((link: any) => /\b(icon|apple-touch-icon|mask-icon)\b/i.test(link?.getAttribute?.('rel') || ''))
            .map((link: any) => link?.href)
            .filter(Boolean);

          return {
            url: locationHref,
            faviconCandidates: links,
          };
        });

        finalPageUrl = pageMeta?.url || finalPageUrl;
        faviconCandidates = Array.isArray(pageMeta?.faviconCandidates) ? pageMeta.faviconCandidates : [];
      } catch {
        // Ignore favicon extraction errors and fall back to URL heuristics.
      }
    }

    // Close browser to finalize video
    if (session.page) {
      await session.page.close();
    }
    if (session.context) {
      await session.context.close();
    }
    if (session.browser) {
      await session.browser.close();
    }

    // Wait for video file to be written
    await new Promise(resolve => setTimeout(resolve, 1000));
    session.networkDetach?.();

    if (projectId) {
      const sessionPath = join(projectDir, 'session.json');
      writeFileSync(sessionPath, JSON.stringify({
        id: projectId,
        name: `Web Capture - ${new Date(session.startTime).toISOString()}`,
        url: finalPageUrl || session.url,
        platform: 'web',
        startedAt: session.startTime,
        endedAt,
        status: 'stopped',
        viewport: { width: 1280, height: 720 },
        actions: [],
        networkEntries: session.networkEntries || [],
        networkCapture: session.networkCapture || null,
      }, null, 2));
    }

    const faviconCoverPath = await createWebFaviconCover({
      pageUrl: finalPageUrl || session.url,
      explicitCandidates: faviconCandidates,
      outputDir: projectDir,
    });

    captureSession = null;

    // Update project status
    const db = getDatabase();
    await db.update(projects)
      .set({
        thumbnailPath: faviconCoverPath || undefined,
        status: 'processing',
        updatedAt: new Date()
      })
      .where(eq(projects.id, projectId));

    // Trigger OCR analysis in background
    runProjectAnalysisInBackgroundWithWatchdog(projectId, 'WebCaptureStop');

    return c.json({
      success: true,
      projectId,
      thumbnailPath: faviconCoverPath,
      message: 'Recording stopped, analyzing...'
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    captureSession = null;
    return c.json({ error: message }, 500);
  }
});

// Background OCR analysis function
async function analyzeProjectInBackground(projectId: string) {
  const db = getDatabase();
  const broadcastProgress = (
    step: string,
    status: AnalysisStepStatus,
    detail?: string,
    error?: string,
    completedUnits?: number | null,
    totalUnits?: number | null
  ) => {
    setProjectAnalysisProgress({
      projectId,
      flow: 'web',
      step,
      status,
      detail,
      error,
      completedUnits,
      totalUnits,
    });
  };

  try {
    // Get project
    const result = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (result.length === 0) return;

    const project = result[0];
    const projectDir = project.videoPath;

    if (!projectDir || !existsSync(projectDir)) {
      broadcastProgress('error', 'failed', 'Capture directory not found', 'Project directory is missing');
      await db.update(projects)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      broadcastToClients({
        type: 'projectAnalysisUpdated',
        data: { projectId, status: 'failed' }
      });
      return;
    }

    // Find video file in project directory
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(projectDir);
    const videoFile = files.find(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mov'));

    if (!videoFile) {
      broadcastProgress('save', 'done', 'Capture saved without video analysis');
      setProjectAnalysisProgress({
        projectId,
        flow: 'web',
        step: 'done',
        status: 'done',
        detail: 'Capture saved',
        completedUnits: 1,
        totalUnits: 1,
      });
      await db.update(projects)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      broadcastToClients({
        type: 'projectAnalysisUpdated',
        data: { projectId, status: 'completed' }
      });
      return;
    }

    const videoPath = join(projectDir, videoFile);

    // Extract frames from video
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { mkdirSync } = await import('node:fs');
    const execAsync = promisify(exec);

    const framesDir = join(projectDir, 'frames');
    mkdirSync(framesDir, { recursive: true });

    // Extract 1 frame per second
    broadcastProgress('extract', 'running', 'Extracting frames from video...');
    await execAsync(`ffmpeg -i "${videoPath}" -vf "fps=1" -q:v 2 "${framesDir}/frame_%04d.jpg" -y`);
    broadcastProgress('extract', 'done', 'Frames extracted');

    // Get frame files and filter out blank (white/black) frames from browser startup
    const { isBlankFrame } = await import('../core/analyze/frames.js');
    const { unlinkSync } = await import('node:fs');
    const allFrameFiles = readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
    const frameFiles: string[] = [];
    for (const f of allFrameFiles) {
      const { isBlank } = isBlankFrame(join(framesDir, f));
      if (isBlank) {
        try { unlinkSync(join(framesDir, f)); } catch { /* ignore */ }
      } else {
        frameFiles.push(f);
      }
    }
    if (frameFiles.length < allFrameFiles.length) {
      console.log(`[BackgroundOCR] Filtered ${allFrameFiles.length - frameFiles.length} blank frames (${frameFiles.length} remaining)`);
    }

    if (frameFiles.length === 0) {
      broadcastProgress('save', 'done', 'No frames extracted from video');
      setProjectAnalysisProgress({
        projectId,
        flow: 'web',
        step: 'done',
        status: 'done',
        detail: 'Capture saved',
        completedUnits: 1,
        totalUnits: 1,
      });
      await db.update(projects)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      broadcastToClients({
        type: 'projectAnalysisUpdated',
        data: { projectId, status: 'completed' }
      });
      return;
    }

    // Run OCR on frames
    let allOcrText = '';
    let bestFrame = frameFiles[0];
    const ocrEngines = new Set<string>();
    const ocrConfidences: number[] = [];

    try {
      const { recognizeText } = await import('../core/analyze/ocr.js');
      const ocrFrames = frameFiles.slice(0, 10);
      broadcastProgress('ocr', 'running', `Processing 0/${ocrFrames.length} frames...`, undefined, 0, ocrFrames.length);

      for (const [index, frameFile] of ocrFrames.entries()) {
        const framePath = join(framesDir, frameFile);
        const ocrResult = await recognizeText(framePath);
        if (ocrResult.success && ocrResult.text) {
          allOcrText += ocrResult.text + '\n\n';
          if (ocrResult.engine) {
            ocrEngines.add(ocrResult.engine);
          }
          if (typeof ocrResult.confidence === 'number') {
            ocrConfidences.push(ocrResult.confidence);
          }
        }

        broadcastProgress(
          'ocr',
          'running',
          `Processing ${index + 1}/${ocrFrames.length} frames...`,
          undefined,
          index + 1,
          ocrFrames.length
        );
      }

      broadcastProgress(
        'ocr',
        'done',
        allOcrText ? `Extracted ${allOcrText.length} characters` : 'No text detected',
        undefined,
        ocrFrames.length,
        ocrFrames.length
      );
    } catch (err) {
      console.error('OCR analysis error:', err);
      const errorMessage = err instanceof Error ? err.message : 'OCR failed';
      broadcastProgress('ocr', 'failed', 'OCR failed', errorMessage);
    }

    let aiSummary = allOcrText
      ? `Analyzed ${frameFiles.length} frame(s). Text detected via OCR.`
      : `Analyzed ${frameFiles.length} frame(s). No text detected via OCR.`;

    if (allOcrText) {
      try {
        broadcastProgress('summary', 'running', 'Connecting to LLM provider...');
        const provider = await getLLMProvider();
        if (provider) {
          console.log(`[BackgroundOCR] Generating web App Intelligence summary with ${provider.name}...`);
          broadcastProgress('summary', 'running', `Using ${provider.name}...`);
          const summaryResult = await generateAppIntelligenceSummary(provider, allOcrText, 'web');
          aiSummary = summaryResult.summary;
          if (!summaryResult.ok) {
            console.warn(`[BackgroundOCR] Web summary generation failed via ${summaryResult.providerName}: ${summaryResult.error || 'unknown error'}`);
            broadcastProgress(
              'summary',
              'failed',
              'Summary generation failed',
              summaryResult.error || `Provider failed: ${summaryResult.providerName}`
            );
          } else {
            broadcastProgress('summary', 'done', `Generated ${aiSummary.length} character summary`);
          }
        } else {
          broadcastProgress('summary', 'skipped', 'No LLM provider configured');
        }
      } catch (summaryError) {
        console.warn('[BackgroundOCR] Web summary generation failed (unexpected wrapper error):', summaryError);
        const errorMessage = summaryError instanceof Error ? summaryError.message : 'Summary generation failed';
        broadcastProgress('summary', 'failed', 'Summary generation failed', errorMessage);
      }
    } else {
      broadcastProgress('summary', 'skipped', 'Skipped — no text to analyze');
    }

    // Update project with results
    const extractedThumbnailPath = join(framesDir, bestFrame);
    const resolvedThumbnailPath = project.thumbnailPath && existsSync(project.thumbnailPath)
      ? project.thumbnailPath
      : existsSync(extractedThumbnailPath)
        ? extractedThumbnailPath
        : null;
    const ocrEngine = ocrEngines.has('vision')
      ? 'vision'
      : ocrEngines.has('tesseract')
        ? 'tesseract'
        : null;
    const ocrConfidence = ocrConfidences.length > 0
      ? ocrConfidences.reduce((sum, value) => sum + value, 0) / ocrConfidences.length
      : null;

    broadcastProgress('save', 'running', 'Saving results to database...');
    await db.update(projects)
      .set({
        status: 'analyzed',
        ocrText: allOcrText || null,
        ocrEngine,
        ocrConfidence,
        thumbnailPath: resolvedThumbnailPath,
        aiSummary,
        updatedAt: new Date()
      })
      .where(eq(projects.id, projectId));

    broadcastProgress('save', 'done', 'Analysis complete');
    setProjectAnalysisProgress({
      projectId,
      flow: 'web',
      step: 'done',
      status: 'done',
      detail: 'Analysis complete',
      completedUnits: 1,
      totalUnits: 1,
    });

    broadcastToClients({
      type: 'projectAnalysisUpdated',
      data: { projectId, status: 'analyzed' }
    });

  } catch (error) {
    console.error('Background analysis error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    broadcastProgress('error', 'failed', undefined, errorMessage);
    await db.update(projects)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    broadcastToClients({
      type: 'projectAnalysisUpdated',
      data: { projectId, status: 'failed' }
    });
  }
}

// ============================================================================
// ANALYZE API
// ============================================================================
app.post('/api/analyze/:id', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');

    // Get project
    const result = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const project = result[0];
    let ocrText = '';
    let aiSummary = '';
    let frameCount = 0;

    // Check if it's an image or video
    const filePath = project.videoPath;
    if (filePath && existsSync(filePath)) {
      const ext = filePath.toLowerCase().split('.').pop();
      const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext || '');
      const isVideo = ['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext || '');

      if (isImage) {
        // Run OCR on the image
        try {
          const { recognizeText } = await import('../core/analyze/ocr.js');
          const ocrResult = await recognizeText(filePath);
          if (ocrResult.success && ocrResult.text) {
            ocrText = ocrResult.text;
            frameCount = 1;
          }
        } catch (err) {
          console.error('OCR error:', err);
        }
      } else if (isVideo) {
        // Extract frames and run OCR
        try {
          const { exec } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const { mkdirSync, readdirSync } = await import('node:fs');
          const execAsync = promisify(exec);
          const { FRAMES_DIR } = await import('../db/index.js');

          // Create frames directory for this project
          const projectFramesDir = join(FRAMES_DIR, id);
          if (!existsSync(projectFramesDir)) {
            mkdirSync(projectFramesDir, { recursive: true });
          }

          // Extract key frames using FFmpeg (1 frame per second)
          const framePattern = join(projectFramesDir, 'frame_%04d.png');
          try {
            const { stderr } = await execAsync(`ffmpeg -i "${filePath}" -vf "fps=1" -frames:v 10 "${framePattern}" -y 2>&1`);
            if (stderr) console.log('[FFmpeg] Output:', stderr.slice(0, 500));
          } catch (ffmpegError) {
            console.error('[FFmpeg] Frame extraction failed:', ffmpegError);
            // Try fallback: extract keyframes only (I-frames)
            try {
              console.log('[FFmpeg] Trying keyframe fallback...');
              await execAsync(`ffmpeg -i "${filePath}" -vf "select='eq(pict_type,I)'" -frames:v 10 "${framePattern}" -y 2>&1`);
            } catch (fallbackError) {
              console.error('[FFmpeg] Keyframe fallback also failed:', fallbackError);
            }
          }

          // Get extracted frames
          const frameFiles = readdirSync(projectFramesDir)
            .filter(f => f.endsWith('.png'))
            .sort()
            .map(f => join(projectFramesDir, f));

          frameCount = frameFiles.length;
          console.log(`[FFmpeg] Extracted ${frameCount} frames from video`);

          // Run OCR on frames
          if (frameFiles.length > 0) {
            const { recognizeTextBatch } = await import('../core/analyze/ocr.js');
            const batchResult = await recognizeTextBatch(frameFiles.slice(0, 5)); // OCR first 5 frames
            if (batchResult.success && batchResult.totalText) {
              ocrText = batchResult.totalText;
            }
          }
        } catch (err) {
          console.error('Video analysis error:', err);
        }
      }

      // Generate simple AI summary from OCR text
      if (ocrText) {
        const words = ocrText.split(/\s+/).filter(w => w.length > 2);
        const uniqueWords = [...new Set(words.map(w => w.toLowerCase()))];
        const topWords = uniqueWords.slice(0, 20).join(', ');

        aiSummary = `Analyzed ${frameCount} frame(s). Found ${words.length} words. Key terms: ${topWords || 'none detected'}.`;
      } else {
        aiSummary = `Analyzed ${frameCount} frame(s). No text detected via OCR.`;
      }
    } else {
      aiSummary = 'No media file found for analysis.';
    }

    // Update project with analysis results
    await db.update(projects).set({
      status: 'analyzed',
      ocrText: ocrText || null,
      aiSummary,
      frameCount,
      updatedAt: new Date()
    }).where(eq(projects.id, id));

    return c.json({
      message: 'Analysis complete',
      projectId: id,
      status: 'analyzed',
      frameCount,
      ocrTextLength: ocrText.length,
      aiSummary
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// CANVAS API
// ============================================================================
app.post('/api/canvas/mockup', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, deviceId, imagePath } = body;

    if (!imagePath || !existsSync(imagePath)) {
      return c.json({ error: 'Image file not found' }, 400);
    }

    // For now, return the image path as preview (real mockup generation would use canvas)
    return c.json({
      success: true,
      projectId,
      deviceId,
      previewUrl: `/api/file?path=${encodeURIComponent(imagePath)}`,
      outputPath: imagePath
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/canvas/export', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, deviceId, format } = body;

    const db = getDatabase();
    const result = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);

    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const project = result[0];
    if (!project.videoPath) {
      return c.json({ error: 'No media file in project' }, 400);
    }

    return c.json({
      success: true,
      downloadUrl: `/api/file?path=${encodeURIComponent(project.videoPath)}`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// GRID API - Static image grid composition
// ============================================================================

// Get available grid layouts
// Get cached smart annotations for a project (pre-generated after analysis)
app.get('/api/grid/smart-annotations/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  const cached = annotationCache.get(projectId);
  if (cached) {
    return c.json({ ready: true, ...cached });
  }
  return c.json({ ready: false });
});

app.get('/api/grid/layouts', async (c) => {
  try {
    const { getAllLayouts, getLayoutInfo } = await import('../core/canvas/gridCompositor.js');
    const layouts = getAllLayouts().map(layout => ({
      id: layout,
      ...getLayoutInfo(layout),
    }));
    return c.json({ layouts });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get available backgrounds
app.get('/api/grid/backgrounds', async (c) => {
  try {
    const { getAvailableBackgrounds, PRESET_GRADIENTS, PRESET_SOLID_COLORS } = await import('../core/canvas/gridCompositor.js');

    // Get backgrounds from assets folder (check multiple locations like /assets/* route)
    const possibleBgDirs = [
      join(__dirname, '..', 'assets', 'backgrounds'),
      join(__dirname, '..', '..', 'assets', 'backgrounds'),
      join(process.cwd(), 'assets', 'backgrounds'),
    ];
    const backgroundsDir = possibleBgDirs.find(d => existsSync(d)) || possibleBgDirs[0];
    const imageBackgrounds = getAvailableBackgrounds(backgroundsDir);

    return c.json({
      images: imageBackgrounds.map(bg => ({
        ...bg,
        previewUrl: `/api/file?path=${encodeURIComponent(bg.path)}`,
      })),
      gradients: PRESET_GRADIENTS,
      solidColors: PRESET_SOLID_COLORS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Generate grid preview
app.post('/api/grid/preview', async (c) => {
  try {
    const body = await c.req.json();
    const { images, config } = body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return c.json({ error: 'No images provided' }, 400);
    }

    const { composeGrid, recommendLayout } = await import('../core/canvas/gridCompositor.js');
    const { EXPORTS_DIR } = await import('../db/index.js');
    const { mkdirSync } = await import('node:fs');

    // Create preview directory
    const previewDir = join(EXPORTS_DIR, 'grid-previews');
    if (!existsSync(previewDir)) {
      mkdirSync(previewDir, { recursive: true });
    }

    // Generate preview filename
    const previewId = crypto.randomUUID();
    const outputPath = join(previewDir, `preview-${previewId}.png`);

    // Auto-recommend layout if not specified
    const gridConfig = {
      ...config,
      layout: config?.layout || recommendLayout(images.length, config?.aspectRatio || '9:16'),
    };

    // Resolve background image path if using image background
    if (gridConfig.background?.type === 'image' && gridConfig.background?.imageId) {
      const possibleBgDirs = [
        join(__dirname, '..', 'assets', 'backgrounds'),
        join(__dirname, '..', '..', 'assets', 'backgrounds'),
        join(process.cwd(), 'assets', 'backgrounds'),
      ];
      const backgroundsDir = possibleBgDirs.find(d => existsSync(d)) || possibleBgDirs[0];
      const { getAvailableBackgrounds } = await import('../core/canvas/gridCompositor.js');
      const bgs = getAvailableBackgrounds(backgroundsDir);
      const bg = bgs.find(b => b.id === gridConfig.background.imageId);
      if (bg) {
        gridConfig.background.imagePath = bg.path;
      }
    }

    const isInfographicLayout = ['flow-horizontal', 'flow-vertical', 'infographic'].includes(gridConfig.layout);

    let result;
    let smartTitle = config?.title || 'App Flow';
    let smartSubtitle = config?.subtitle || '';
    let stepLabels: string[] = images.map((_: unknown, i: number) => `Step ${i + 1}`);

    if (isInfographicLayout) {
      const { composeInfographic } = await import('../core/canvas/gridCompositor.js');
      const arrowDir: 'right' | 'down' | 'none' = gridConfig.layout === 'flow-horizontal' ? 'right' : gridConfig.layout === 'flow-vertical' ? 'down' : 'none';

      const projectId = body.projectId;
      if (projectId) {
        // Check cache first (pre-generated after analysis)
        const cached = annotationCache.get(projectId);
        if (cached) {
          smartTitle = cached.title;
          smartSubtitle = cached.subtitle;
          stepLabels = images.map((_: unknown, i: number) => cached.steps[i] || `Step ${i + 1}`);
        } else try {
          const db = getDatabase();
          const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);

          if (project?.aiSummary) {
            // Project has been analyzed - use AI for smart annotations
            // Try to get per-frame OCR from frames table
            const dbFrames = await db.select().from(frames)
              .where(eq(frames.projectId, projectId))
              .orderBy(frames.frameNumber)
              .limit(images.length);

            const framesOcr = dbFrames.map((f: { ocrText?: string | null }) => f.ocrText?.slice(0, 300) || '');

            const provider = await getLLMProvider();
            if (provider) {
              const framesContext = images.map((img: { path: string; label?: string }, i: number) => {
                const ocr = framesOcr[i] || img.label || '';
                return `Frame ${i + 1}: "${ocr.slice(0, 200)}"`;
              }).join('\n');

              const prompt = `You create labels for an app flow infographic. Be concise.

App Intelligence:
${project.aiSummary.slice(0, 2000)}

Frames OCR (in order):
${framesContext}

Return ONLY valid JSON, no extra text:
{
  "title": "catchy 3-5 word title for this flow",
  "subtitle": "one sentence about the app",
  "steps": [${images.map((_: unknown, i: number) => `{"label": "max 6 words for frame ${i + 1}"}`).join(', ')}]
}`;

              try {
                const response = await provider.sendMessage(prompt);
                const jsonMatch = (typeof response === 'string' ? response : '').match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  const parsed = JSON.parse(jsonMatch[0]);
                  if (parsed.title) smartTitle = parsed.title;
                  if (parsed.subtitle) smartSubtitle = parsed.subtitle;
                  if (Array.isArray(parsed.steps)) {
                    stepLabels = parsed.steps.map((s: { label?: string }, i: number) => s.label || `Step ${i + 1}`);
                  }
                  // Cache for future requests
                  annotationCache.set(projectId, {
                    projectId, title: smartTitle, subtitle: smartSubtitle,
                    steps: stepLabels, generatedAt: Date.now(),
                  });
                }
              } catch { /* LLM failed, use fallbacks */ }
            } else {
              // No LLM: parse User Flow from aiSummary
              const flowMatch = project.aiSummary.match(/## (?:User Flow|Likely User Flow)\n([\s\S]*?)(?=\n##|\n$|$)/);
              if (flowMatch) {
                const flowLines = flowMatch[1].match(/^\d+\.\s+(.+)$/gm) || [];
                stepLabels = images.map((_: unknown, i: number) => {
                  if (flowLines[i]) return flowLines[i].replace(/^\d+\.\s+/, '').slice(0, 40);
                  return `Step ${i + 1}`;
                });
              }
              smartTitle = project.marketingTitle || cleanProjectTitle(project.name) || 'App Flow';
              smartSubtitle = project.marketingDescription || '';
            }
          } else {
            // No analyzer yet - use basic labels from image names
            smartTitle = project.marketingTitle || cleanProjectTitle(project.name) || 'App Flow';
          }
        } catch { /* DB error, use defaults */ }
      }

      const infographicImages = images.map((img: { path: string; label?: string }, i: number) => ({
        imagePath: img.path,
        label: img.label,
        stepNumber: i + 1,
        annotation: stepLabels[i] || img.label || `Step ${i + 1}`,
        flowArrow: ((i < images.length - 1) ? arrowDir : 'none') as 'right' | 'down' | 'none',
      }));

      result = await composeInfographic(
        infographicImages,
        {
          title: smartTitle,
          subtitle: smartSubtitle,
          footerText: config?.footerText,
          layout: gridConfig.layout,
          aspectRatio: gridConfig.aspectRatio,
          background: gridConfig.background,
          outputWidth: gridConfig.outputWidth,
        },
        outputPath,
      );
    } else {
      // Standard grid compositor
      const gridImages = images.map((img: { path: string; label?: string }) => ({
        imagePath: img.path,
        label: img.label,
      }));
      result = await composeGrid(gridImages, gridConfig, outputPath);
    }

    if (!result.success) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({
      success: true,
      previewId,
      previewUrl: `/api/file?path=${encodeURIComponent(outputPath)}`,
      width: result.width,
      height: result.height,
      // Return smart annotations so export can reuse them
      ...(isInfographicLayout ? { smartTitle, smartSubtitle, smartAnnotations: stepLabels } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Export final grid as PNG
app.post('/api/grid/export', async (c) => {
  try {
    const body = await c.req.json();
    const { images, config, projectId, filename } = body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return c.json({ error: 'No images provided' }, 400);
    }

    const { composeGrid, recommendLayout } = await import('../core/canvas/gridCompositor.js');
    const { EXPORTS_DIR } = await import('../db/index.js');
    const { mkdirSync } = await import('node:fs');

    // Create export directory
    const exportDir = projectId ? join(EXPORTS_DIR, projectId) : join(EXPORTS_DIR, 'grids');
    if (!existsSync(exportDir)) {
      mkdirSync(exportDir, { recursive: true });
    }

    // Generate export filename
    const timestamp = Date.now();
    const exportFilename = filename || `grid-${timestamp}.png`;
    const outputPath = join(exportDir, exportFilename);

    // Auto-recommend layout if not specified
    const gridConfig = {
      ...config,
      layout: config?.layout || recommendLayout(images.length, config?.aspectRatio || '9:16'),
      outputWidth: config?.outputWidth || 1080, // Default to 1080px width
    };

    // Resolve background image path
    if (gridConfig.background?.type === 'image' && gridConfig.background?.imageId) {
      const possibleBgDirs = [
        join(__dirname, '..', 'assets', 'backgrounds'),
        join(__dirname, '..', '..', 'assets', 'backgrounds'),
        join(process.cwd(), 'assets', 'backgrounds'),
      ];
      const backgroundsDir = possibleBgDirs.find(d => existsSync(d)) || possibleBgDirs[0];
      const { getAvailableBackgrounds } = await import('../core/canvas/gridCompositor.js');
      const bgs = getAvailableBackgrounds(backgroundsDir);
      const bg = bgs.find(b => b.id === gridConfig.background.imageId);
      if (bg) {
        gridConfig.background.imagePath = bg.path;
      }
    }

    // Use same smart annotation logic as preview (config.smartAnnotations passed from preview cache)
    const isInfographicLayout = ['flow-horizontal', 'flow-vertical', 'infographic'].includes(gridConfig.layout);

    let result;

    if (isInfographicLayout) {
      const { composeInfographic } = await import('../core/canvas/gridCompositor.js');
      const arrowDir: 'right' | 'down' | 'none' = gridConfig.layout === 'flow-horizontal' ? 'right' : gridConfig.layout === 'flow-vertical' ? 'down' : 'none';

      // Use annotations from config if passed (from preview), otherwise basic
      const annotations: string[] = config?.smartAnnotations || [];
      const infographicImages = images.map((img: { path: string; label?: string }, i: number) => ({
        imagePath: img.path,
        label: img.label,
        stepNumber: i + 1,
        annotation: annotations[i] || img.label || `Step ${i + 1}`,
        flowArrow: ((i < images.length - 1) ? arrowDir : 'none') as 'right' | 'down' | 'none',
      }));

      result = await composeInfographic(
        infographicImages,
        {
          title: config?.smartTitle || config?.title || 'App Flow',
          subtitle: config?.smartSubtitle || config?.subtitle || '',
          footerText: config?.footerText,
          layout: gridConfig.layout,
          aspectRatio: gridConfig.aspectRatio,
          background: gridConfig.background,
          outputWidth: gridConfig.outputWidth,
        },
        outputPath,
      );
    } else {
      const gridImages = images.map((img: { path: string; label?: string }) => ({
        imagePath: img.path,
        label: img.label,
      }));
      result = await composeGrid(gridImages, gridConfig, outputPath);
    }

    if (!result.success) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({
      success: true,
      path: outputPath,
      downloadUrl: `/api/file?path=${encodeURIComponent(outputPath)}&download=true`,
      width: result.width,
      height: result.height,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Generate infographic with annotations, step badges, and flow arrows
app.post('/api/grid/infographic', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, images, config } = body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return c.json({ error: 'No images provided' }, 400);
    }

    const { composeInfographic } = await import('../core/canvas/gridCompositor.js');
    const { EXPORTS_DIR } = await import('../db/index.js');

    const exportDir = projectId ? join(EXPORTS_DIR, projectId) : join(EXPORTS_DIR, 'grids');
    if (!existsSync(exportDir)) {
      mkdirSync(exportDir, { recursive: true });
    }

    const outputPath = join(exportDir, `infographic-${Date.now()}.png`);

    const result = await composeInfographic(
      images.map((img: any, i: number) => ({
        imagePath: img.path || img.imagePath,
        label: img.label,
        stepNumber: img.stepNumber ?? (i + 1),
        annotation: img.annotation,
        flowArrow: img.flowArrow || (config?.layout === 'flow-horizontal' ? 'right' : config?.layout === 'flow-vertical' ? 'down' : 'none'),
      })),
      {
        title: config?.title || 'App Flow',
        subtitle: config?.subtitle || '',
        footerText: config?.footerText,
        layout: config?.layout || 'flow-horizontal',
        aspectRatio: config?.aspectRatio,
        outputWidth: config?.outputWidth,
      },
      outputPath,
    );

    if (!result.success) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({
      success: true,
      path: outputPath,
      downloadUrl: `/api/file?path=${encodeURIComponent(outputPath)}&download=true`,
      width: result.width,
      height: result.height,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// AI-powered frame annotation - generates step labels from OCR data
app.post('/api/ai/annotate-frames', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, frameIds } = body;
    if (!projectId) return c.json({ error: 'projectId required' }, 400);

    const db = getDatabase();
    let projectFrames;
    if (frameIds && Array.isArray(frameIds) && frameIds.length > 0) {
      projectFrames = await db.select().from(frames)
        .where(and(eq(frames.projectId, projectId), inArray(frames.id, frameIds)))
        .orderBy(frames.frameNumber);
    } else {
      projectFrames = await db.select().from(frames)
        .where(eq(frames.projectId, projectId))
        .orderBy(frames.frameNumber)
        .limit(10);
    }

    if (!projectFrames.length) {
      return c.json({ error: 'No frames found' }, 404);
    }

    const provider = await getLLMProvider();
    if (!provider) {
      // Fallback: generate simple numbered labels
      const annotations = projectFrames.map((f, i) => ({
        frameId: f.id,
        stepNumber: i + 1,
        label: `Step ${i + 1}`,
        annotation: f.ocrText?.slice(0, 50) || `Screen ${i + 1}`,
      }));
      return c.json({ success: true, annotations, provider: 'fallback' });
    }

    const framesData = projectFrames.map((f, i) =>
      `Step ${i + 1}: OCR text: "${(f.ocrText || '').slice(0, 200)}"`
    ).join('\n');

    const prompt = `Given these ${projectFrames.length} app screenshots in sequence, generate a brief label (max 8 words) for each step in the user flow.

${framesData}

Return ONLY a valid JSON array with no extra text:
[{"step": 1, "label": "Opens login screen"}, ...]`;

    const response = await provider.sendMessage(prompt);
    const text = typeof response === 'string' ? response.trim() : '';

    let parsed: Array<{ step: number; label: string }> = [];
    try {
      // Extract JSON from response (may have markdown code fences)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // Fallback to simple labels
      parsed = projectFrames.map((_, i) => ({ step: i + 1, label: `Step ${i + 1}` }));
    }

    const annotations = projectFrames.map((f, i) => ({
      frameId: f.id,
      framePath: f.imagePath,
      stepNumber: i + 1,
      label: parsed[i]?.label || `Step ${i + 1}`,
      annotation: parsed[i]?.label || f.ocrText?.slice(0, 50) || `Screen ${i + 1}`,
    }));

    return c.json({ success: true, annotations, provider: provider.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get project frames for grid selection
app.get('/api/grid/project-frames/:id', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');

    const result = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const project = result[0];
    const { FRAMES_DIR } = await import('../db/index.js');
    const { readdirSync } = await import('node:fs');

    const availableFrames: Array<{ path: string; previewUrl: string; name: string }> = [];
    const { isBlankFrame } = await import('../core/analyze/frames.js');

    // Check for extracted frames in global FRAMES_DIR
    const projectFramesDir = join(FRAMES_DIR, id);
    if (existsSync(projectFramesDir)) {
      const frameFiles = readdirSync(projectFramesDir)
        .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
        .sort();

      for (const f of frameFiles) {
        const framePath = join(projectFramesDir, f);
        // Skip blank (white/black) frames
        if (isBlankFrame(framePath).isBlank) continue;
        availableFrames.push({
          path: framePath,
          previewUrl: `/api/file?path=${encodeURIComponent(framePath)}`,
          name: f,
        });
      }
    }

    // Also check for frames in project-specific directory (mobile recordings)
    const projectFramesDir2 = join(PROJECTS_DIR, id, 'frames');
    if (existsSync(projectFramesDir2)) {
      const frameFiles = readdirSync(projectFramesDir2)
        .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
        .sort();

      for (const f of frameFiles) {
        const framePath = join(projectFramesDir2, f);
        // Avoid duplicates
        if (!availableFrames.some(frame => frame.path === framePath)) {
          availableFrames.push({
            path: framePath,
            previewUrl: `/api/file?path=${encodeURIComponent(framePath)}`,
            name: f,
          });
        }
      }
    }

    // Also include the main project file if it's an image
    if (project.videoPath) {
      const ext = project.videoPath.toLowerCase().split('.').pop();
      if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext || '')) {
        availableFrames.unshift({
          path: project.videoPath,
          previewUrl: `/api/file?path=${encodeURIComponent(project.videoPath)}`,
          name: project.name || 'Main Image',
        });
      }
    }

    // Include thumbnail if different from videoPath and it is a real capture/frame.
    if (
      project.thumbnailPath
      && project.thumbnailPath !== project.videoPath
      && !isSyntheticProjectCover(project.thumbnailPath)
    ) {
      availableFrames.unshift({
        path: project.thumbnailPath,
        previewUrl: `/api/file?path=${encodeURIComponent(project.thumbnailPath)}`,
        name: 'Thumbnail',
      });
    }

    // Also check for screenshots in recording session directory (web testing projects)
    if (project.videoPath && existsSync(project.videoPath)) {
      const { statSync } = await import('node:fs');
      const stats = statSync(project.videoPath);
      if (stats.isDirectory()) {
        // This is a recording session directory, check for screenshots subdirectory
        const screenshotsDir = join(project.videoPath, 'screenshots');
        if (existsSync(screenshotsDir)) {
          const screenshotFiles = readdirSync(screenshotsDir)
            .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
            .sort();

          for (const f of screenshotFiles) {
            const screenshotPath = join(screenshotsDir, f);
            // Check if this path is already in availableFrames
            if (!availableFrames.some(frame => frame.path === screenshotPath)) {
              availableFrames.push({
                path: screenshotPath,
                previewUrl: `/api/file?path=${encodeURIComponent(screenshotPath)}`,
                name: f,
              });
            }
          }
        }
      }
    }

    return c.json({
      projectId: id,
      projectName: project.name,
      frames: availableFrames,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// EXPORT API
// ============================================================================
function sanitizeProjectExportSlug(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'project';
}

function ensureExportParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function writeExportJson(filePath: string, data: unknown): void {
  ensureExportParentDir(filePath);
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writeExportText(filePath: string, text: string): void {
  ensureExportParentDir(filePath);
  writeFileSync(filePath, text, 'utf8');
}

function copyPathIntoExportBundle(sourcePath: string | null | undefined, destinationPath: string): boolean {
  if (!sourcePath || !existsSync(sourcePath)) return false;

  ensureExportParentDir(destinationPath);
  if (statSync(sourcePath).isDirectory()) {
    cpSync(sourcePath, destinationPath, { recursive: true });
  } else {
    copyFileSync(sourcePath, destinationPath);
  }

  return true;
}

function looksLikeRecordingDirectory(dirPath: string | null | undefined): boolean {
  if (!dirPath || !existsSync(dirPath)) return false;

  try {
    if (!statSync(dirPath).isDirectory()) return false;
  } catch {
    return false;
  }

  return [
    join(dirPath, 'session.json'),
    join(dirPath, 'screenshots'),
    join(dirPath, 'video'),
    join(dirPath, 'test.yaml'),
    join(dirPath, 'test.spec.ts'),
  ].some((candidate) => existsSync(candidate));
}

function resolveProjectBundleRecordingDir(originalVideoPath: string | null, resolvedVideoPath: string | null): string | null {
  const candidates = [
    originalVideoPath,
    resolveRecordingBaseDir(originalVideoPath),
    resolveRecordingBaseDir(resolvedVideoPath),
  ].filter((value, index, items): value is string => !!value && items.indexOf(value) === index);

  for (const candidate of candidates) {
    if (looksLikeRecordingDirectory(candidate)) {
      return candidate;
    }
  }

  return null;
}


function collectProjectExportFramePaths(projectId: string, recordingBaseDir: string | null): string[] {
  const candidateDirs = [
    join(FRAMES_DIR, projectId),
    join(PROJECTS_DIR, projectId, 'frames'),
    recordingBaseDir ? join(recordingBaseDir, 'screenshots') : null,
    recordingBaseDir,
  ].filter((value, index, items): value is string => !!value && items.indexOf(value) === index);

  const framePaths: string[] = [];
  const seen = new Set<string>();

  for (const dirPath of candidateDirs) {
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      continue;
    }

    const files = readdirSync(dirPath)
      .filter((entry) => /\.(png|jpg|jpeg|webp)$/i.test(entry))
      .filter((entry) => !entry.startsWith('._'))
      .sort();

    for (const entry of files) {
      const absolutePath = join(dirPath, entry);
      if (seen.has(absolutePath)) {
        continue;
      }

      seen.add(absolutePath);
      framePaths.push(absolutePath);
    }
  }

  return framePaths;
}

function resolveAppLabBundleIconPath(): string | null {
  const candidates = [
    join(__dirname, '..', '..', 'assets', 'applab-bundle-icon.png'),
    join(__dirname, '..', 'assets', 'applab-bundle-icon.png'),
    join(process.cwd(), 'assets', 'applab-bundle-icon.png'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function copyProjectExportArtifacts(sourceDir: string, destinationDir: string): number {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    return 0;
  }

  let copiedCount = 0;
  for (const entry of readdirSync(sourceDir)) {
    if (/\.(applab|esvp)$/i.test(entry)) continue;
    if (copyPathIntoExportBundle(join(sourceDir, entry), join(destinationDir, entry))) {
      copiedCount += 1;
    }
  }

  return copiedCount;
}

async function runExportCommand(command: string, args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errorOutput = '';

    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      errorOutput += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(errorOutput.trim() || `${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function createProjectArchive(sourceDir: string, outputPath: string): Promise<void> {
  ensureExportParentDir(outputPath);

  if (process.platform === 'darwin') {
    try {
      await runExportCommand('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', sourceDir, outputPath]);
      return;
    } catch {
      // Fall through to zip for environments without ditto.
    }
  }

  await runExportCommand('zip', ['-qr', outputPath, basename(sourceDir)], dirname(sourceDir));
}

function resolveProjectESVPSessionId(esvp: Record<string, unknown> | null): string | null {
  if (!esvp) return null;

  const validation = esvp.validation && typeof esvp.validation === 'object'
    ? esvp.validation as Record<string, unknown>
    : null;
  const network = esvp.network && typeof esvp.network === 'object'
    ? esvp.network as Record<string, unknown>
    : null;

  const validationId = typeof validation?.sourceSessionId === 'string' ? validation.sourceSessionId.trim() : '';
  const networkId = typeof network?.sourceSessionId === 'string' ? network.sourceSessionId.trim() : '';
  const directId = typeof esvp.currentSessionId === 'string' ? esvp.currentSessionId.trim() : '';

  return validationId || networkId || directId || null;
}

function resolveProjectESVPServerUrl(esvp: Record<string, unknown> | null): string | undefined {
  return normalizePersistedLocalESVPServerUrl(esvp?.serverUrl, esvp?.connectionMode);
}

function normalizePersistedLocalESVPServerUrl(serverUrl: unknown, connectionMode?: unknown): string | undefined {
  const normalized = typeof serverUrl === 'string' ? serverUrl.trim().replace(/\/+$/, '') : '';
  if (normalized === LOCAL_ESVP_SERVER_URL) {
    return LOCAL_ESVP_SERVER_URL;
  }
  if (!normalized && connectionMode === 'local') {
    return LOCAL_ESVP_SERVER_URL;
  }
  return undefined;
}

function resolvePersistedLocalESVPServerUrl(serverUrl: unknown, esvp: Record<string, unknown> | null): string {
  return (
    normalizePersistedLocalESVPServerUrl(serverUrl, 'local') ||
    resolveProjectESVPServerUrl(esvp) ||
    LOCAL_ESVP_SERVER_URL
  );
}

function cloneJsonRecord<T extends Record<string, unknown> | null>(value: T): T {
  if (!value) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function detachPortableESVPForExport(
  esvp: Record<string, unknown> | null,
  snapshotAttached = false,
): { value: Record<string, unknown> | null; detached: boolean } {
  if (!esvp) {
    return { value: null, detached: false };
  }

  const cloned = cloneJsonRecord(esvp) || {};
  const connectionMode = typeof cloned.connectionMode === 'string' ? cloned.connectionMode.trim().toLowerCase() : '';
  const serverUrl = typeof cloned.serverUrl === 'string' ? cloned.serverUrl.trim() : '';
  const shouldDetach = connectionMode === 'local' || !serverUrl;

  if (!shouldDetach) {
    return { value: cloned, detached: false };
  }

  cloned.currentSessionId = null;
  cloned.serverUrl = null;
  cloned.detachedForExport = true;
  cloned.snapshotAttached = snapshotAttached;

  if (cloned.network && typeof cloned.network === 'object') {
    const network = cloned.network as Record<string, unknown>;
    network.sourceSessionId = null;
    network.activeCaptureSessionId = null;
    network.detachedForExport = true;
  }

  if (cloned.validation && typeof cloned.validation === 'object') {
    const validation = cloned.validation as Record<string, unknown>;
    validation.sourceSessionId = null;
    validation.replaySessionId = null;
    validation.detachedForExport = true;
  }

  return { value: cloned, detached: true };
}

function detachPortableSessionDataForExport(
  sessionData: Record<string, unknown> | null,
  detachedEsvp: Record<string, unknown> | null,
  detached = false,
): Record<string, unknown> | null {
  if (!sessionData) return null;
  const cloned = cloneJsonRecord(sessionData) || {};

  if (detached) {
    cloned.esvp = detachedEsvp;
    if (cloned.networkCapture && typeof cloned.networkCapture === 'object') {
      const networkCapture = cloned.networkCapture as Record<string, unknown>;
      networkCapture.sessionId = null;
      networkCapture.detachedForExport = true;
    }
  }

  return cloned;
}

function isESVPReplayValidationSupported(result: Record<string, unknown> | null): boolean {
  if (!result) return true;
  if (result.supported === false) return false;
  if (result.replaySupported === false) return false;
  if (result.canReplay === false) return false;
  if (result.ok === false) return false;
  const httpStatus = typeof result.http_status === 'number' ? result.http_status : null;
  if (httpStatus === 409 || httpStatus === 422) return false;
  return true;
}

function getESVPReplayValidationReason(result: Record<string, unknown> | null): string | null {
  if (!result) return null;
  const candidates = [
    result.reason,
    result.error,
    result.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function normalizeESVPReplayValidationReason(
  result: Record<string, unknown> | null,
  fallbackExecutor?: string | null,
): string | null {
  const rawReason = getESVPReplayValidationReason(result);
  if (!rawReason) return null;

  const currentExecutorMatch = rawReason.match(/(?:executor atual|current executor)\s*=\s*([^) ,]+)/i);
  const currentExecutor = currentExecutorMatch?.[1] || fallbackExecutor || null;

  if (
    /(replay determin[ií]stico|deterministic replay)/i.test(rawReason) &&
    /executor\s*=\s*fake/i.test(rawReason)
  ) {
    return `Deterministic replay is currently available only for executor=fake${currentExecutor ? ` (current executor=${currentExecutor})` : ''}.`;
  }

  if (/nenhuma sess[aã]o esvp associada/i.test(rawReason)) {
    return 'No attached ESVP session was found.';
  }

  return rawReason;
}

function getStoredRecordingNetworkEntries(session: any): CapturedNetworkEntry[] {
  return Array.isArray(session?.networkEntries)
    ? session.networkEntries.filter((entry: unknown) => entry && typeof entry === 'object') as CapturedNetworkEntry[]
    : [];
}

function hasMeaningfulESVPNetworkSnapshot(input: {
  networkEntries?: CapturedNetworkEntry[];
  traceKinds?: string[];
  networkState?: any;
  networkProfileApplied?: unknown;
  managedProxy?: unknown;
  captureProxy?: unknown;
  appTraceCollector?: unknown;
}): boolean {
  const traceCount = Number(input.networkState?.trace_count || 0);
  return (
    (Array.isArray(input.networkEntries) && input.networkEntries.length > 0) ||
    (Array.isArray(input.traceKinds) && input.traceKinds.length > 0) ||
    traceCount > 0 ||
    !!input.networkState?.configured_at ||
    !!input.networkState?.active_profile ||
    !!input.networkState?.effective_profile ||
    !!input.networkState?.managed_proxy ||
    !!input.networkProfileApplied ||
    !!input.managedProxy ||
    !!input.captureProxy ||
    !!input.appTraceCollector
  );
}

app.post('/api/export', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, format, destination, includeOcr, includeSummary } = body;

    const db = getDatabase();
    const result = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);

    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const rawProject = result[0] as ProjectRecord;
    const normalizedProject = normalizeProjectRecord(rawProject);
    if (!rawProject.videoPath && format !== 'applab' && format !== 'esvp') {
      return c.json({ error: 'No media file in project' }, 400);
    }

    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    // Create export directory
    const exportDir = join(EXPORTS_DIR, projectId);
    if (!existsSync(exportDir)) {
      mkdirSync(exportDir, { recursive: true });
    }

    const timestamp = Date.now();
    let outputPath = '';
    let mimeType = 'image/png';
    const resolvedVideoPath = resolveVideoPath(rawProject.videoPath);

    // Check if videoPath is a directory (e.g., Maestro recordings)
    const isVideoPathDirectory = !!rawProject.videoPath && existsSync(rawProject.videoPath) && statSync(rawProject.videoPath).isDirectory();

    if (format === 'applab' || format === 'esvp') {
      const projectFrames = await db
        .select()
        .from(frames)
        .where(eq(frames.projectId, projectId))
        .orderBy(frames.frameNumber);

      const exportRecords = await db
        .select()
        .from(projectExports)
        .where(eq(projectExports.projectId, projectId))
        .orderBy(desc(projectExports.createdAt));

      const recordingBaseDir = resolveProjectBundleRecordingDir(rawProject.videoPath, resolvedVideoPath);
      const sessionPath = recordingBaseDir ? join(recordingBaseDir, 'session.json') : null;

      let sessionData: Record<string, unknown> | null = null;
      let networkEntries: CapturedNetworkEntry[] = [];
      let networkCapture: Record<string, unknown> | null = null;
      let esvp: Record<string, unknown> | null = null;

      if (sessionPath && existsSync(sessionPath)) {
        try {
          const parsed = JSON.parse(readFileSync(sessionPath, 'utf8'));
          sessionData = parsed && typeof parsed === 'object' ? parsed : null;
          networkEntries = Array.isArray(parsed?.networkEntries) ? parsed.networkEntries : [];
          networkCapture = parsed?.networkCapture && typeof parsed.networkCapture === 'object'
            ? parsed.networkCapture
            : null;
          esvp = parsed?.esvp && typeof parsed.esvp === 'object'
            ? parsed.esvp
            : null;
        } catch {
          sessionData = null;
        }
      }

      const stagingRoot = mkdtempSync(join(tmpdir(), `${format}-export-`));
      const bundleFolderName = `${sanitizeProjectExportSlug(rawProject.name)}-${new Date(timestamp).toISOString().slice(0, 10)}`;
      const bundleRoot = join(stagingRoot, bundleFolderName);
      mkdirSync(bundleRoot, { recursive: true });

      try {
        const summaryPath = rawProject.aiSummary ? 'analysis/app-intelligence.md' : null;
        const ocrPath = rawProject.ocrText ? 'analysis/ocr.txt' : null;
        const thumbnailName = rawProject.thumbnailPath ? basename(rawProject.thumbnailPath) : null;

        let bundledFrames = projectFrames.map((frame) => {
          const extensionMatch = basename(frame.imagePath).match(/(\.[^.]+)$/);
          const extension = extensionMatch ? extensionMatch[1] : '.png';
          const relativeImagePath = `frames/frame-${String(frame.frameNumber).padStart(4, '0')}${extension}`;
          copyPathIntoExportBundle(frame.imagePath, join(bundleRoot, relativeImagePath));
          return {
            ...frame,
            imagePath: relativeImagePath,
          };
        });

        if (bundledFrames.length === 0) {
          const fallbackFramePaths = collectProjectExportFramePaths(projectId, recordingBaseDir);
          bundledFrames = fallbackFramePaths.map((framePath, index) => {
            const extensionMatch = basename(framePath).match(/(\.[^.]+)$/);
            const extension = extensionMatch ? extensionMatch[1] : '.png';
            const relativeImagePath = `frames/frame-${String(index + 1).padStart(4, '0')}${extension}`;
            copyPathIntoExportBundle(framePath, join(bundleRoot, relativeImagePath));
            return {
              id: `${projectId}-fallback-frame-${index + 1}`,
              projectId,
              frameNumber: index + 1,
              imagePath: relativeImagePath,
              ocrText: null,
              timestamp,
              createdAt: new Date(timestamp),
              isKeyFrame: null,
            };
          });
        }

        const mediaFiles: Array<{ role: string; path: string }> = [];
        if (rawProject.thumbnailPath && existsSync(rawProject.thumbnailPath) && thumbnailName) {
          const relativePath = `media/${thumbnailName}`;
          copyPathIntoExportBundle(rawProject.thumbnailPath, join(bundleRoot, relativePath));
          mediaFiles.push({ role: 'thumbnail', path: relativePath });
        }

        const canonicalBundleIconPath = resolveAppLabBundleIconPath();
        const bundleIconRelativePath = canonicalBundleIconPath ? 'media/icon.png' : null;
        if (canonicalBundleIconPath && bundleIconRelativePath) {
          copyPathIntoExportBundle(canonicalBundleIconPath, join(bundleRoot, bundleIconRelativePath));
          mediaFiles.push({ role: 'icon', path: bundleIconRelativePath });
        }

        const recordingIncluded = false;
        const exportArtifactCount = 0;

        const esvpSessionId = resolveProjectESVPSessionId(esvp);
        const esvpServerUrl = resolveProjectESVPServerUrl(esvp);
        let esvpSnapshot: Record<string, unknown> | null = null;
        if (esvpSessionId) {
          try {
            const inspected = await inspectESVPSession(
              esvpSessionId,
              { includeTranscript: true, includeArtifacts: true },
              esvpServerUrl
            );
            esvpSnapshot = inspected && typeof inspected === 'object'
              ? inspected as Record<string, unknown>
              : null;
          } catch (error) {
            esvpSnapshot = {
              sessionId: esvpSessionId,
              serverUrl: esvpServerUrl || null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        const detachedEsvpResult = detachPortableESVPForExport(esvp, !!esvpSnapshot);
        const exportedESVP = detachedEsvpResult.value;
        const exportedSessionData = detachPortableSessionDataForExport(
          sessionData,
          exportedESVP,
          detachedEsvpResult.detached,
        );
        const exportedESVPSessionId = detachedEsvpResult.detached ? null : esvpSessionId;

        const packagedProject = {
          ...normalizedProject,
          videoPath: null,
          thumbnailPath: thumbnailName ? `media/${thumbnailName}` : normalizedProject.thumbnailPath,
          frames: bundledFrames,
          icon: bundleIconRelativePath
            ? {
                path: bundleIconRelativePath,
                kind: 'app-icon',
              }
            : null,
        };

        writeExportJson(join(bundleRoot, 'manifest.json'), {
          bundleVersion: 1,
          packageFormat: format,
          exportedAt: new Date(timestamp).toISOString(),
          exportedWith: {
            app: 'DiscoveryLab',
            version: APP_VERSION,
          },
          project: {
            id: rawProject.id,
            name: rawProject.name,
            platform: rawProject.platform || null,
            icon: bundleIconRelativePath
              ? {
                  path: bundleIconRelativePath,
                  kind: 'app-icon',
                }
              : null,
            frameCount: bundledFrames.length,
            hasRecordingFolder: recordingIncluded,
            hasNetworkTrace: networkEntries.length > 0 || !!networkCapture,
            hasOCR: !!rawProject.ocrText,
            hasAppIntelligence: !!rawProject.aiSummary,
            hasExportArtifacts: exportArtifactCount > 0,
          },
          included: {
            mediaFiles,
            frames: bundledFrames.length,
            recordingFolder: recordingIncluded,
            networkEntries: networkEntries.length,
            exportArtifacts: exportArtifactCount,
            esvpSessionId: exportedESVPSessionId || null,
          },
        });
        writeExportJson(join(bundleRoot, 'metadata', 'project.json'), packagedProject);
        writeExportJson(join(bundleRoot, 'metadata', 'exports.json'), exportRecords);
        if (exportedSessionData) {
          writeExportJson(join(bundleRoot, 'metadata', 'session.json'), exportedSessionData);
        }
        if (rawProject.taskHubLinks) {
          writeExportJson(join(bundleRoot, 'taskhub', 'links.json'), normalizedProject.taskHubLinks);
        }
        if (rawProject.taskRequirements) {
          writeExportJson(join(bundleRoot, 'taskhub', 'requirements.json'), normalizedProject.taskRequirements);
        }
        if (rawProject.taskTestMap) {
          writeExportJson(join(bundleRoot, 'taskhub', 'test-map.json'), normalizedProject.taskTestMap);
        }
        if (summaryPath) {
          writeExportText(join(bundleRoot, summaryPath), rawProject.aiSummary || '');
        }
        if (ocrPath) {
          writeExportText(join(bundleRoot, ocrPath), rawProject.ocrText || '');
        }
        if (bundledFrames.length > 0) {
          writeExportJson(join(bundleRoot, 'analysis', 'frames.json'), bundledFrames);
        }
        if (networkEntries.length > 0) {
          writeExportJson(join(bundleRoot, 'network', 'entries.json'), networkEntries);
        }
        if (networkCapture) {
          writeExportJson(join(bundleRoot, 'network', 'capture.json'), networkCapture);
        }
        if (exportedESVP) {
          writeExportJson(join(bundleRoot, 'network', 'esvp.json'), exportedESVP);
        }
        if (esvpSnapshot) {
          writeExportJson(join(bundleRoot, 'esvp', 'snapshot.json'), esvpSnapshot);
        }

        // Include template content (custom titles, scripts) if saved
        const templateContentPath = join(PROJECTS_DIR, projectId, 'template-content.json');
        if (existsSync(templateContentPath)) {
          mkdirSync(join(bundleRoot, 'templates'), { recursive: true });
          cpSync(templateContentPath, join(bundleRoot, 'templates', 'content.json'));
        }

        writeExportText(join(bundleRoot, 'README.txt'), [
          `${rawProject.name}`,
          `Exported from DiscoveryLab ${APP_VERSION} on ${new Date(timestamp).toISOString()}.`,
          '',
          'This package bundles the local project context for sharing or re-analysis.',
          '',
          'Included when available:',
          '- selected thumbnail and analyzed frames',
          '- lightweight project/session metadata',
          '- OCR text and app intelligence summary',
          '- network trace, capture metadata, and ESVP snapshot',
          '- Task Hub links, requirements, and test map',
          '',
          'Excluded by default to keep the bundle Claude-friendly:',
          '- original long-form media',
          '- recording folder',
          '- generated export assets and renders',
        ].join('\n'));

        outputPath = join(exportDir, `export-${timestamp}.${format}`);
        mimeType = 'application/zip';
        await createProjectArchive(bundleRoot, outputPath);
      } finally {
        rmSync(stagingRoot, { recursive: true, force: true });
      }
    } else if (isVideoPathDirectory && format === 'gif') {
      // Maestro recording: create animated GIF from screenshots
      outputPath = join(exportDir, `export-${timestamp}.gif`);
      mimeType = 'image/gif';

      // Find screenshots directory
      const screenshotsDir = join(rawProject.videoPath!, 'screenshots');
      const screenshotsDirExists = existsSync(screenshotsDir) && statSync(screenshotsDir).isDirectory();
      const sourceDir = screenshotsDirExists ? screenshotsDir : rawProject.videoPath!;

      // Get all PNG files sorted by name (timestamp order)
      const { readdirSync } = await import('node:fs');
      const pngFiles = readdirSync(sourceDir)
        .filter((f: string) => f.endsWith('.png'))
        .sort()
        .map((f: string) => join(sourceDir, f));

      if (pngFiles.length === 0) {
        return c.json({ error: 'No screenshots found in recording' }, 400);
      }

      // Create concat file for ffmpeg
      const concatPath = join(exportDir, `concat-${timestamp}.txt`);
      const concatContent = pngFiles.map((f: string) => `file '${f}'\nduration 0.5`).join('\n');
      writeFileSync(concatPath, concatContent);

      try {
        // Use ffmpeg concat demuxer to create animated GIF
        await execAsync(`ffmpeg -f concat -safe 0 -i "${concatPath}" -vf "fps=2,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" "${outputPath}" -y`);
        // Clean up concat file
        const { unlinkSync } = await import('node:fs');
        unlinkSync(concatPath);
      } catch (err) {
        // Clean up concat file on error
        try {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(concatPath);
        } catch {}
        return c.json({ error: 'GIF creation failed - FFmpeg required. Install with: brew install ffmpeg' }, 400);
      }
    } else if (isVideoPathDirectory && format === 'mp4') {
      // Maestro recording: create video from screenshots
      outputPath = join(exportDir, `export-${timestamp}.mp4`);
      mimeType = 'video/mp4';

      // Find screenshots directory
      const screenshotsDir = join(rawProject.videoPath!, 'screenshots');
      const screenshotsDirExists = existsSync(screenshotsDir) && statSync(screenshotsDir).isDirectory();
      const sourceDir = screenshotsDirExists ? screenshotsDir : rawProject.videoPath!;

      // Get all PNG files sorted by name (timestamp order)
      const { readdirSync } = await import('node:fs');
      const pngFiles = readdirSync(sourceDir)
        .filter((f: string) => f.endsWith('.png'))
        .sort()
        .map((f: string) => join(sourceDir, f));

      if (pngFiles.length === 0) {
        return c.json({ error: 'No screenshots found in recording' }, 400);
      }

      // Create concat file for ffmpeg
      const concatPath = join(exportDir, `concat-${timestamp}.txt`);
      const concatContent = pngFiles.map((f: string) => `file '${f}'\nduration 0.5`).join('\n');
      writeFileSync(concatPath, concatContent);

      try {
        // Use ffmpeg concat demuxer to create MP4
        await execAsync(`ffmpeg -f concat -safe 0 -i "${concatPath}" -vf "scale=480:-2" -c:v libx264 -pix_fmt yuv420p "${outputPath}" -y`);
        // Clean up concat file
        const { unlinkSync } = await import('node:fs');
        unlinkSync(concatPath);
      } catch (err) {
        // Clean up concat file on error
        try {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(concatPath);
        } catch {}
        return c.json({ error: 'Video creation failed - FFmpeg required. Install with: brew install ffmpeg' }, 400);
      }
    } else if (isVideoPathDirectory) {
      // Maestro recording: copy entire directory for other formats
      outputPath = join(exportDir, `export-${timestamp}`);
      cpSync(rawProject.videoPath!, outputPath, { recursive: true });
      mimeType = 'application/octet-stream';
    } else if (format === 'png' || format === 'jpg' || format === 'jpeg') {
      // Handle different formats for single files
      const ext = format === 'jpg' ? 'jpeg' : format;
      outputPath = join(exportDir, `export-${timestamp}.${format}`);
      mimeType = `image/${ext}`;

      // Convert if needed or just copy
      if (resolvedVideoPath?.endsWith(`.${format}`)) {
        copyFileSync(resolvedVideoPath, outputPath);
      } else {
        // Use sips for conversion on macOS
        try {
          await execAsync(`sips -s format ${format} "${resolvedVideoPath}" --out "${outputPath}"`);
        } catch {
          // If conversion fails, just copy
          copyFileSync(resolvedVideoPath!, outputPath);
          outputPath = join(exportDir, `export-${timestamp}${resolvedVideoPath?.substring(resolvedVideoPath.lastIndexOf('.'))}`);
        }
      }
    } else if (format === 'gif') {
      outputPath = join(exportDir, `export-${timestamp}.gif`);
      mimeType = 'image/gif';

      // Create GIF from single image
      try {
        await execAsync(`ffmpeg -i "${resolvedVideoPath}" -vf "fps=10,scale=320:-1:flags=lanczos" "${outputPath}" -y`);
      } catch {
        copyFileSync(resolvedVideoPath!, outputPath.replace('.gif', '.png'));
        outputPath = outputPath.replace('.gif', '.png');
        mimeType = 'image/png';
      }
    } else if (format === 'mp4') {
      outputPath = join(exportDir, `export-${timestamp}.mp4`);
      mimeType = 'video/mp4';

      if (resolvedVideoPath?.endsWith('.mp4')) {
        copyFileSync(resolvedVideoPath, outputPath);
      } else {
        // Create video from image
        try {
          await execAsync(`ffmpeg -loop 1 -i "${resolvedVideoPath}" -c:v libx264 -t 3 -pix_fmt yuv420p "${outputPath}" -y`);
        } catch {
          return c.json({ error: 'Video conversion failed - FFmpeg required' }, 400);
        }
      }
    } else {
      // Default: copy original
      const ext = resolvedVideoPath?.substring(resolvedVideoPath.lastIndexOf('.')) || '';
      outputPath = join(exportDir, `export-${timestamp}${ext}`);
      if (resolvedVideoPath) {
        copyFileSync(resolvedVideoPath, outputPath);
      }
    }

    // Create text file with OCR and summary if requested
    if ((includeOcr || includeSummary) && format !== 'applab' && format !== 'esvp') {
      let textContent = `# ${rawProject.name}\n\n`;
      textContent += `Exported: ${new Date().toISOString()}\n\n`;

      if (includeSummary && rawProject.aiSummary) {
        textContent += `## Summary\n${rawProject.aiSummary}\n\n`;
      }

      if (includeOcr && rawProject.ocrText) {
        textContent += `## OCR Text\n${rawProject.ocrText}\n`;
      }

      const textPath = join(exportDir, `export-${timestamp}.txt`);
      writeFileSync(textPath, textContent);
    }

    // Handle different destinations
    if (destination === 'local' || destination === 'clipboard') {
      return c.json({
        success: true,
        path: outputPath,
        downloadUrl: `/api/file?path=${encodeURIComponent(outputPath)}&download=true`
      });
    } else if (destination === 'notion' || destination === 'drive') {
      // For cloud destinations, return info about what would be uploaded
      return c.json({
        success: true,
        path: outputPath,
        downloadUrl: `/api/file?path=${encodeURIComponent(outputPath)}&download=true`,
        message: `File ready for ${destination}. Use the download link or MCP tools for cloud upload.`
      });
    }

    return c.json({
      success: true,
      path: outputPath,
      downloadUrl: `/api/file?path=${encodeURIComponent(outputPath)}&download=true`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// INTERACTIVE VISUALIZATION ENGINE
// ============================================================================

// Serve visualization as self-contained HTML
app.get('/api/visualization/:projectId/:templateId', async (c) => {
  try {
    const projectId = c.req.param('projectId');
    const templateId = c.req.param('templateId');

    const db = getDatabase();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const { FRAMES_DIR } = await import('../db/index.js');
    const projectFramesDir = join(FRAMES_DIR, projectId);

    // Get frames from database
    const dbFrames = await db.select().from(frames)
      .where(eq(frames.projectId, projectId))
      .orderBy(frames.frameNumber)
      .limit(10);

    // Build frame images list - fallback to filesystem if DB has no frames
    let frameImages: Array<{ imageUrl: string; label: string; number: number }> = [];

    if (dbFrames.length > 0) {
      frameImages = dbFrames.map((f, i) => ({
        imageUrl: `/api/file?path=${encodeURIComponent(f.imagePath)}`,
        label: f.ocrText?.slice(0, 40) || `Screen ${i + 1}`,
        number: i + 1,
      }));
    } else {
      // Fallback: look for screenshots in recording directories
      const screenshotsDirs = [
        join(projectFramesDir),
        ...(project.videoPath ? [
          join(project.videoPath, 'screenshots'),
          project.videoPath,
        ] : []),
        join(PROJECTS_DIR, 'maestro-recordings', projectId, 'screenshots'),
        join(PROJECTS_DIR, 'web-recordings', projectId, 'screenshots'),
      ];

      for (const dir of screenshotsDirs) {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
        const files = readdirSync(dir)
          .filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
          .sort()
          .slice(0, 10);
        if (files.length > 0) {
          frameImages = files.map((f, i) => ({
            imageUrl: `/api/file?path=${encodeURIComponent(join(dir, f))}`,
            label: `Screen ${i + 1}`,
            number: i + 1,
          }));
          break;
        }
      }

      // Last fallback: use thumbnail if nothing else
      if (frameImages.length === 0 && project.thumbnailPath && existsSync(project.thumbnailPath)) {
        frameImages = [{
          imageUrl: `/api/file?path=${encodeURIComponent(project.thumbnailPath)}`,
          label: 'App Screenshot',
          number: 1,
        }];
      }
    }

    // Build visualization data based on template
    // Use cleaned title - never show raw device names in visualizations
    const vizTitle = project.marketingTitle || cleanProjectTitle(project.name) || project.name;
    let vizData: Record<string, unknown> = {
      title: vizTitle,
      subtitle: '',
      platform: project.platform || 'unknown',
    };

    switch (templateId) {
      case 'flow-diagram':
        vizData = {
          ...vizData,
          steps: frameImages,
          direction: 'horizontal',
        };
        break;

      case 'device-showcase':
        vizData = {
          ...vizData,
          screens: frameImages,
        };
        break;

      case 'metrics-dashboard': {
        // Parse analysis data for metrics
        const summary = project.aiSummary || '';
        const ocrText = project.ocrText || '';

        // Count UI elements from OCR
        const buttonMatches = ocrText.match(/button|btn|tap|click|submit|save|cancel|ok|next/gi) || [];
        const navMatches = ocrText.match(/menu|tab|nav|home|back|settings|profile/gi) || [];
        const inputMatches = ocrText.match(/input|field|search|email|password|text|enter/gi) || [];
        const dataMatches = ocrText.match(/table|list|card|chart|graph|data|item/gi) || [];

        vizData = {
          ...vizData,
          screenCount: project.frameCount || frameImages.length,
          flowSteps: frameImages.length,
          uiElements: buttonMatches.length + navMatches.length + inputMatches.length,
          screens: frameImages,
          categories: [
            { name: 'Buttons & Actions', count: buttonMatches.length },
            { name: 'Navigation', count: navMatches.length },
            { name: 'Inputs & Forms', count: inputMatches.length },
            { name: 'Data & Views', count: dataMatches.length },
          ].filter(c => c.count > 0),
          steps: frameImages.map(f => ({ label: f.label })),
        };
        break;
      }

      case 'app-flow-map': {
        // AI-powered: analyze project data and generate narrative flow phases
        // Cache results to avoid re-generating (saves tokens)
        let phases: Array<{
          title: string;
          description: string;
          screens: typeof frameImages;
          insight?: string;
        }> = [];

        const { EXPORTS_DIR: expDir } = await import('../db/index.js');
        const cachePath = join(expDir, projectId, 'flowmap-cache.json');
        let cachedFlowMap: any = null;
        try {
          if (existsSync(cachePath)) {
            cachedFlowMap = JSON.parse(readFileSync(cachePath, 'utf-8'));
            // Validate cache is still relevant (same frame count)
            if (cachedFlowMap._frameCount === frameImages.length) {
              vizData.title = cachedFlowMap.title || vizData.title;
              vizData.subtitle = cachedFlowMap.subtitle || vizData.subtitle;
              // Rebuild phases with current image URLs (paths may change)
              phases = (cachedFlowMap.phases || []).map((p: any) => ({
                title: p.title,
                description: p.description,
                screens: (p.screenIndices || []).map((idx: number) => frameImages[idx]).filter(Boolean),
                insight: p.insight,
              }));
            } else {
              cachedFlowMap = null; // Invalidate
            }
          }
        } catch { cachedFlowMap = null; }

        if (!cachedFlowMap) {
        const provider = await getLLMProvider();
        if (provider && project.aiSummary && frameImages.length >= 2) {
          try {
            const framesInfo = frameImages.map((f, i) =>
              `Screen ${i + 1}: "${f.label}"`
            ).join('\n');

            const prompt = `You are creating a visual flow map for an app. Analyze the data and group screens into logical phases that tell a story.

App Intelligence:
${(project.aiSummary || '').slice(0, 2500)}

Screens captured (in order):
${framesInfo}

Group these ${frameImages.length} screens into 2-4 phases. Each phase is a logical step in the user journey.

Return ONLY valid JSON:
{
  "title": "compelling 3-5 word map title",
  "subtitle": "one sentence about the app experience",
  "phases": [
    {
      "title": "phase name (2-4 words)",
      "description": "what happens in this phase (1 sentence)",
      "screenIndices": [0, 1],
      "insight": "interesting UX observation about this phase (optional, 1 sentence)"
    }
  ]
}

Rules:
- Every screen must be assigned to exactly one phase
- screenIndices are 0-based, matching the screen order above
- Phase titles should tell a story progression (e.g. "Discovery", "Decision", "Action", "Confirmation")
- Insights should be specific observations, not generic`;

            const response = await provider.sendMessage(prompt);
            const jsonMatch = (typeof response === 'string' ? response : '').match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.title) vizData.title = parsed.title;
              if (parsed.subtitle) vizData.subtitle = parsed.subtitle;
              if (Array.isArray(parsed.phases)) {
                phases = parsed.phases.map((p: any) => ({
                  title: p.title || 'Phase',
                  description: p.description || '',
                  screens: (p.screenIndices || []).map((idx: number) => frameImages[idx]).filter(Boolean),
                  insight: p.insight || undefined,
                }));
              }
              // Store provider name for display
              (vizData as any)._providerName = provider.name;
            }
          } catch { /* LLM failed, use fallback */ }
        }

        // Fallback: simple sequential grouping
        if (phases.length === 0) {
          const chunkSize = Math.max(1, Math.ceil(frameImages.length / 3));
          const defaultTitles = ['Getting Started', 'Core Experience', 'Completing the Flow'];
          for (let i = 0; i < frameImages.length; i += chunkSize) {
            const chunk = frameImages.slice(i, i + chunkSize);
            phases.push({
              title: defaultTitles[Math.floor(i / chunkSize)] || `Phase ${Math.floor(i / chunkSize) + 1}`,
              description: `Screens ${i + 1}-${Math.min(i + chunkSize, frameImages.length)}`,
              screens: chunk,
            });
          }
        }

        // Save to cache (avoid re-generating on next open)
        try {
          const cacheDir = join(expDir, projectId);
          if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
          const cacheData = {
            title: vizData.title,
            subtitle: vizData.subtitle,
            _frameCount: frameImages.length,
            _providerName: (vizData as any)._providerName || 'fallback',
            phases: phases.map(p => ({
              title: p.title,
              description: p.description,
              screenIndices: p.screens.map(s => frameImages.findIndex(f => f.imageUrl === s.imageUrl)),
              insight: p.insight,
            })),
          };
          writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
        } catch { /* cache write failed, not critical */ }
        } // end if (!cachedFlowMap)

        const providerName = (vizData as any)._providerName || cachedFlowMap?._providerName || '';
        vizData = {
          ...vizData,
          providerName,
          phases: phases.map(p => ({
            title: p.title,
            description: p.description,
            screens: p.screens.map(s => ({
              imageUrl: s.imageUrl,
              label: s.label,
              detail: '',
            })),
            insight: p.insight,
          })),
        };
        break;
      }

      default:
        return c.json({ error: `Unknown template: ${templateId}` }, 400);
    }

    // Read HTML template and inject data
    // Look for HTML templates in multiple locations (dist, src, cwd)
    const possiblePaths = [
      join(__dirname, '..', 'visualizations', `${templateId}.html`),              // dist/visualizations/
      join(__dirname, 'visualizations', `${templateId}.html`),                     // dist/visualizations/ (alt)
      join(__dirname, '..', 'core', 'visualizations', 'templates', `${templateId}.html`), // dist/core/...
      join(process.cwd(), 'dist', 'visualizations', `${templateId}.html`),        // cwd/dist/visualizations/
      join(process.cwd(), 'src', 'core', 'visualizations', 'templates', `${templateId}.html`), // dev: src/
    ];

    let htmlContent = '';
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        htmlContent = readFileSync(p, 'utf-8');
        break;
      }
    }

    if (!htmlContent) {
      return c.json({ error: `Template file not found: ${templateId}` }, 404);
    }

    // Inject data before the closing </head> or before the first <script>
    const dataScript = `<script>window.__VISUALIZATION_DATA__ = ${JSON.stringify(vizData)};</script>`;
    htmlContent = htmlContent.replace('<script>', dataScript + '\n<script>');

    return c.html(htmlContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// List available visualization templates
app.get('/api/visualization/templates', async (c) => {
  return c.json({
    templates: [
      { id: 'flow-diagram', name: 'Flow Diagram', description: 'Screenshots connected by animated arrows' },
      { id: 'device-showcase', name: 'Device Showcase', description: '3D rotating carousel of screens' },
      { id: 'metrics-dashboard', name: 'Metrics Dashboard', description: 'Analysis data with animated charts' },
      { id: 'app-flow-map', name: 'App Flow Map', description: 'AI-powered narrative flow with grouped phases' },
    ],
  });
});

// Capture visualization as PNG screenshot
app.post('/api/visualization/screenshot', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, templateId, format } = body;

    if (!projectId || !templateId) {
      return c.json({ error: 'projectId and templateId required' }, 400);
    }

    const { EXPORTS_DIR } = await import('../db/index.js');
    const exportDir = join(EXPORTS_DIR, projectId);
    if (!existsSync(exportDir)) {
      mkdirSync(exportDir, { recursive: true });
    }

    const ext = format === 'gif' ? 'gif' : 'png';
    const outputPath = join(exportDir, `viz-${templateId}-${Date.now()}.${ext}`);

    // Get the server port to build the URL
    const serverPort = process.env.PORT || '3847';
    const vizUrl = `http://localhost:${serverPort}/api/visualization/${projectId}/${templateId}`;

    const { chromium } = await import('playwright');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

    await page.goto(vizUrl, { waitUntil: 'networkidle' });
    // Wait for CSS animations to play
    await page.waitForTimeout(2500);

    if (format === 'gif') {
      // Capture multiple frames for GIF
      const framesDir = join(exportDir, `viz-gif-frames-${Date.now()}`);
      mkdirSync(framesDir, { recursive: true });

      const frameCount = 20;
      const intervalMs = 200; // 5fps, 4 seconds total

      for (let i = 0; i < frameCount; i++) {
        await page.screenshot({ path: join(framesDir, `frame-${String(i).padStart(3, '0')}.png`) });
        await page.waitForTimeout(intervalMs);
      }

      await browser.close();

      // Compose GIF from frames using FFmpeg
      const { promisify } = await import('util');
      const execPromise = promisify(exec);
      try {
        await execPromise(
          `ffmpeg -framerate 5 -i "${join(framesDir, 'frame-%03d.png')}" -vf "scale=600:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 "${outputPath}" -y`,
          { timeout: 30000 }
        );
      } catch (ffmpegError) {
        // Fallback: just use first frame as PNG
        const { copyFileSync } = await import('node:fs');
        const fallbackPath = outputPath.replace('.gif', '.png');
        copyFileSync(join(framesDir, 'frame-000.png'), fallbackPath);
        // Clean up frames
        const { rmSync } = await import('node:fs');
        rmSync(framesDir, { recursive: true, force: true });
        return c.json({
          success: true,
          format: 'png',
          path: fallbackPath,
          downloadUrl: `/api/file?path=${encodeURIComponent(fallbackPath)}&download=true`,
          note: 'GIF conversion failed (FFmpeg required), exported as PNG instead',
        });
      }

      // Clean up frames
      const { rmSync } = await import('node:fs');
      rmSync(framesDir, { recursive: true, force: true });
    } else {
      // PNG screenshot
      await page.screenshot({ path: outputPath, fullPage: true });
      await browser.close();
    }

    return c.json({
      success: true,
      format: ext,
      path: outputPath,
      downloadUrl: `/api/file?path=${encodeURIComponent(outputPath)}&download=true`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// BATCH EXPORT PIPELINE
// ============================================================================

// Export project as self-contained HTML infographic
app.post('/api/export/infographic', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, open } = body;
    if (!projectId) return c.json({ error: 'projectId required' }, 400);

    const db = getDatabase();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const { FRAMES_DIR: fDir, EXPORTS_DIR: eDir, PROJECTS_DIR: pDir } = await import('../db/index.js');
    const { buildInfographicData, generateInfographicHtml, resolveInfographicFrameInputs } = await import('../core/export/infographic.js');

    const dbFrames = await db.select().from(frames)
      .where(eq(frames.projectId, projectId))
      .orderBy(frames.frameNumber)
      .limit(20);

    const resolvedFrames = resolveInfographicFrameInputs(
      dbFrames,
      join(fDir, projectId),
      project.videoPath,
      pDir,
      projectId,
    );

    if (resolvedFrames.frameFiles.length === 0) {
      return c.json({
        error: resolvedFrames.candidateCount > 0
          ? 'No readable frames found for infographic export.'
          : 'No frames found. Run analyzer first.',
        debug: {
          frameCandidates: resolvedFrames.candidateCount,
          validFrames: 0,
          source: resolvedFrames.source,
          invalidFrames: resolvedFrames.invalidFrames.slice(0, 5),
        },
      }, 400);
    }

    // Use cached smart annotations if available
    const cached = annotationCache.get(projectId);
    const annotations = cached?.steps?.map((s: string) => ({ label: s }));

    const data = buildInfographicData(project, resolvedFrames.frameFiles, resolvedFrames.frameOcr, annotations);
    if (data.frames.length === 0) {
      return c.json({
        error: 'Infographic export produced no embeddable frames.',
        debug: {
          frameCandidates: resolvedFrames.candidateCount,
          validFrames: resolvedFrames.frameFiles.length,
          source: resolvedFrames.source,
          invalidFrames: resolvedFrames.invalidFrames.slice(0, 5),
        },
      }, 400);
    }
    const slug = (project.marketingTitle || project.name || projectId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const outputPath = join(eDir, `${slug}-infographic.html`);
    const result = generateInfographicHtml(data, outputPath);

    if (!result.success) {
      return c.json({
        error: result.error,
        debug: {
          frameCandidates: resolvedFrames.candidateCount,
          validFrames: resolvedFrames.frameFiles.length,
          source: resolvedFrames.source,
          invalidFrames: resolvedFrames.invalidFrames.slice(0, 5),
        },
      }, 500);
    }

    if (open) {
      const { exec } = await import('node:child_process');
      exec(`open "${result.outputPath}"`);
    }

    return c.json({
      success: true,
      path: result.outputPath,
      downloadUrl: `/api/file?path=${encodeURIComponent(result.outputPath!)}&download=true`,
      size: result.size,
      frameCount: result.frameCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Import .applab project bundle
app.post('/api/import', async (c) => {
  try {
    const body = await c.req.json();
    const { filePath } = body;
    if (!filePath) return c.json({ error: 'filePath required' }, 400);

    const { importApplabBundle } = await import('../core/export/import.js');
    const { FRAMES_DIR: fDir, PROJECTS_DIR: pDir } = await import('../db/index.js');

    const db = getDatabase();
    const result = await importApplabBundle(filePath, db, { projects, frames }, {
      dataDir: DATA_DIR,
      framesDir: fDir,
      projectsDir: pDir,
    });

    if (!result.success) return c.json({ error: result.error }, 400);

    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Build default document from project data
app.get('/api/export/document/:projectId', async (c) => {
  try {
    const projectId = c.req.param('projectId');
    const db = getDatabase();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const projectFrames = await db.select().from(frames)
      .where(eq(frames.projectId, projectId))
      .orderBy(frames.frameNumber)
      .limit(20);

    // Fallback frames from filesystem if DB empty
    let frameData = projectFrames.map(f => ({ imagePath: f.imagePath, ocrText: f.ocrText }));
    if (frameData.length === 0 && project.videoPath) {
      const { FRAMES_DIR } = await import('../db/index.js');
      const dirs = [
        join(FRAMES_DIR, projectId),
        join(project.videoPath, 'screenshots'),
        join(PROJECTS_DIR, 'maestro-recordings', projectId, 'screenshots'),
        join(PROJECTS_DIR, 'web-recordings', projectId, 'screenshots'),
      ];
      for (const dir of dirs) {
        if (existsSync(dir) && statSync(dir).isDirectory()) {
          const files = readdirSync(dir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort().slice(0, 20);
          if (files.length > 0) {
            frameData = files.map((f, i) => ({ imagePath: join(dir, f), ocrText: null }));
            break;
          }
        }
      }
    }

    // Check for cached template render
    const { getCachedRender: getCached } = await import('../core/templates/renderer.js');
    const templateRenderPath = getCached(projectId, 'showcase') || getCached(projectId, 'studio') || null;

    const { buildDefaultDocument } = await import('../core/export/document.js');
    const doc = buildDefaultDocument({
      id: project.id,
      name: project.name,
      marketingTitle: project.marketingTitle,
      marketingDescription: project.marketingDescription,
      platform: project.platform,
      aiSummary: project.aiSummary,
      videoPath: project.videoPath,
      thumbnailPath: project.thumbnailPath,
      taskHubLinks: project.taskHubLinks,
      frames: frameData,
      duration: project.duration,
      templateRenderPath,
    });

    return c.json({ success: true, document: doc });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Create Notion page from document via REST API (hybrid: API for structure, Playwright for files)
app.post('/api/export/notion-page', async (c) => {
  try {
    const body = await c.req.json();
    const { document: doc, parentPageId } = body;

    if (!doc || !parentPageId) {
      return c.json({ error: 'document and parentPageId required' }, 400);
    }

    // Read notion settings for token
    const notionSettingsPath = join(DATA_DIR, 'notion-settings.json');
    let apiToken = '';
    if (existsSync(notionSettingsPath)) {
      const settings = JSON.parse(readFileSync(notionSettingsPath, 'utf-8'));
      apiToken = settings.apiToken || '';
    }

    if (!apiToken) {
      return c.json({ error: 'Notion API token not configured' }, 400);
    }

    const { createNotionPageViaApi } = await import('../core/export/adapters/notion-api.js');
    const result = await createNotionPageViaApi(doc, {
      token: apiToken,
      parentPageId,
    });

    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get available export adapters
app.get('/api/export/adapters', async (c) => {
  return c.json({ adapters: getAvailableAdapters() });
});

// Batch export via pipeline
app.post('/api/export/batch', async (c) => {
  try {
    const manifest = await c.req.json() as BatchExportManifest;

    if (!manifest.projects || !Array.isArray(manifest.projects) || manifest.projects.length === 0) {
      return c.json({ error: 'No projects in manifest' }, 400);
    }
    if (!manifest.destination?.type) {
      return c.json({ error: 'Destination type required' }, 400);
    }

    const { FRAMES_DIR } = await import('../db/index.js');

    const dataProvider: ProjectDataProvider = {
      async getProject(projectId: string) {
        const db = getDatabase();
        const [p] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
        return p || null;
      },
      getFramesDir(projectId: string) {
        return join(FRAMES_DIR, projectId);
      },
    };

    // Execute pipeline with progress broadcast via WebSocket
    const result = await executeBatchExport(manifest, dataProvider, (progress) => {
      broadcastToClients({
        type: 'batchExportProgress',
        data: progress,
      });
    });

    // Record exports in database
    const db = getDatabase();
    for (const r of result.results) {
      const { randomUUID } = await import('node:crypto');
      await db.insert(projectExports).values({
        id: randomUUID(),
        projectId: r.projectId,
        destination: manifest.destination.type,
        destinationUrl: r.destinationUrl || null,
        contentIncluded: JSON.stringify(
          manifest.projects.find(p => p.projectId === r.projectId)?.assets || []
        ),
        status: r.success ? 'completed' : 'failed',
        errorMessage: r.error || null,
        exportedAt: new Date(),
        createdAt: new Date(),
      });
    }

    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// STATIC ASSETS
// ============================================================================
app.get('/assets/*', async (c) => {
  try {
    const assetPath = c.req.path.replace('/assets/', '');
    const cwd = process.cwd();

    // Check multiple possible locations for assets
    // Prioritize __dirname (absolute) over process.cwd() for npm-installed packages
    const possiblePaths = [
      join(__dirname, '..', 'assets', assetPath),    // Production: dist/../assets
      join(__dirname, '..', '..', 'assets', assetPath), // Alternative structure
      join(cwd, 'assets', assetPath),                // Development: running from project root
      join(cwd, 'src', 'assets', assetPath),         // Development: src/assets
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(path);

        // Determine content type
        const ext = path.split('.').pop()?.toLowerCase() || '';
        const contentTypes: Record<string, string> = {
          'png': 'image/png',
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
          'gif': 'image/gif',
          'svg': 'image/svg+xml',
          'webp': 'image/webp',
          'ico': 'image/x-icon',
        };

        return new Response(content, {
          headers: {
            'Content-Type': contentTypes[ext] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000',
          }
        });
      }
    }

    return c.json({ error: 'Asset not found' }, 404);
  } catch (error) {
    return c.json({ error: 'Failed to serve asset' }, 500);
  }
});

// ============================================================================
// FILE SERVING API
// ============================================================================
app.get('/api/file', async (c) => {
  try {
    const filePath = c.req.query('path');
    const download = c.req.query('download') === 'true';

    if (!filePath) {
      return c.json({ error: 'Path required' }, 400);
    }

    const decodedPath = decodeURIComponent(filePath);
    const resolvedPath = resolveVideoPath(decodedPath) || decodedPath;

    if (!existsSync(resolvedPath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const { readFileSync, statSync } = await import('node:fs');
    const { basename, extname } = await import('node:path');

    const stat = statSync(resolvedPath);
    if (stat.isDirectory()) {
      return c.json({ error: 'Path resolves to a directory' }, 400);
    }

    const content = readFileSync(resolvedPath);
    const fileName = basename(resolvedPath);
    const ext = extname(resolvedPath).toLowerCase();

    // Determine content type
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.txt': 'text/plain',
      '.json': 'application/json',
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': stat.size.toString(),
    };

    if (download) {
      headers['Content-Disposition'] = `attachment; filename="${fileName}"`;
    }

    return new Response(content, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.get('/api/files', async (c) => {
  try {
    const dirPath = c.req.query('dir');
    if (!dirPath) {
      return c.json({ error: 'dir required' }, 400);
    }

    const decodedPath = decodeURIComponent(dirPath);
    if (!existsSync(decodedPath)) {
      return c.json({ error: 'Directory not found' }, 404);
    }

    const { readdirSync, statSync } = await import('node:fs');
    const files = readdirSync(decodedPath)
      .filter(name => {
        try {
          return statSync(join(decodedPath, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort();

    return c.json({ files });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// REVEAL IN FINDER API
// ============================================================================
app.post('/api/reveal', async (c) => {
  try {
    const body = await c.req.json();
    const { path: filePath } = body;

    if (!filePath || !existsSync(filePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    if (process.platform === 'darwin') {
      await execAsync(`open -R "${filePath}"`);
    } else if (process.platform === 'win32') {
      await execAsync(`explorer /select,"${filePath}"`);
    } else {
      await execAsync(`xdg-open "${filePath}"`);
    }

    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// OPEN SYSTEM SETTINGS API
// ============================================================================
app.post('/api/open-settings', async (c) => {
  try {
    const body = await c.req.json();
    const { settings } = body;

    if (process.platform !== 'darwin') {
      return c.json({ error: 'Only available on macOS' }, 400);
    }

    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    let url = '';
    switch (settings) {
      case 'screen-recording':
        url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
        break;
      case 'accessibility':
        url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
        break;
      case 'privacy':
        url = 'x-apple.systempreferences:com.apple.preference.security';
        break;
      default:
        return c.json({ error: 'Unknown settings type' }, 400);
    }

    await execAsync(`open "${url}"`);
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// TESTING API
// ============================================================================
app.get('/api/testing/status', async (c) => {
  try {
    const { execSync } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { isPlaywrightInstalled } = await import('../core/testing/playwright.js');

    let maestroInstalled = false;
    let playwrightInstalled = false;
    let xcrunAvailable = false;
    let adbAvailable = false;

    // Check for Maestro - it installs to ~/.maestro/bin
    const maestroPath = `${homedir()}/.maestro/bin/maestro`;
    try {
      if (existsSync(maestroPath)) {
        maestroInstalled = true;
      } else {
        execSync('which maestro', { stdio: 'pipe' });
        maestroInstalled = true;
      }
    } catch {}

    // Check for Playwright
    playwrightInstalled = await isPlaywrightInstalled().catch(() => false);

    // Check for xcrun (iOS Simulator support)
    try {
      execSync('xcrun simctl help', { stdio: 'pipe', timeout: 3000 });
      xcrunAvailable = true;
    } catch {}

    // Check for adb (Android Emulator support)
    try {
      if (ADB_PATH && existsSync(ADB_PATH)) {
        adbAvailable = true;
      } else {
        execSync('which adb', { stdio: 'pipe' });
        adbAvailable = true;
      }
    } catch {}

    return c.json({
      maestro: maestroInstalled,
      playwright: playwrightInstalled,
      xcrun: xcrunAvailable,
      adb: adbAvailable
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

function getClaudeDesktopConfigPath(): string {
  const home = homedir();
  return process.platform === 'win32'
    ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

function getClaudeDesktopAppCandidates(): string[] {
  const home = homedir();

  if (process.platform === 'darwin') {
    return [
      '/Applications/Claude.app',
      join(home, 'Applications', 'Claude.app'),
    ];
  }

  if (process.platform === 'win32') {
    return [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Claude', 'Claude.exe') : '',
      process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Claude', 'Claude.exe') : '',
      process.env['PROGRAMFILES(X86)'] ? join(process.env['PROGRAMFILES(X86)'] as string, 'Claude', 'Claude.exe') : '',
      process.env.APPDATA ? join(process.env.APPDATA, 'Claude', 'Claude.exe') : '',
    ].filter(Boolean);
  }

  return [];
}

function findClaudeDesktopApp(): { detected: boolean; launchTarget: string | null; installPath: string | null } {
  if (process.platform === 'darwin') {
    try {
      execSync('open -Ra "Claude"', { stdio: 'pipe', timeout: 2000 });
      return {
        detected: true,
        launchTarget: 'Claude',
        installPath: getClaudeDesktopAppCandidates().find((candidate) => existsSync(candidate)) || null,
      };
    } catch {
      const candidate = getClaudeDesktopAppCandidates().find((path) => existsSync(path));
      return {
        detected: Boolean(candidate),
        launchTarget: candidate ? 'Claude' : null,
        installPath: candidate || null,
      };
    }
  }

  const candidate = getClaudeDesktopAppCandidates().find((path) => existsSync(path));
  return {
    detected: Boolean(candidate),
    launchTarget: candidate || null,
    installPath: candidate || null,
  };
}

function detectDiscoveryLabClaudeDesktopMcp(): {
  configured: boolean;
  serverName: string | null;
  source: 'settings' | 'none';
  configPath: string;
} {
  const configPath = getClaudeDesktopConfigPath();
  if (!existsSync(configPath)) {
    return {
      configured: false,
      serverName: null,
      source: 'none',
      configPath,
    };
  }

  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') {
      return {
        configured: false,
        serverName: null,
        source: 'none',
        configPath,
      };
    }

    for (const [name, config] of Object.entries<any>(servers)) {
      const configString = [
        name,
        config?.command || '',
        ...(Array.isArray(config?.args) ? config.args : []),
        config?.url || '',
      ].join(' ').toLowerCase();

      if (
        name === 'discoverylab' ||
        configString.includes('@veolab/discoverylab') ||
        configString.includes('discoverylab') ||
        configString.includes('applab-discovery')
      ) {
        return {
          configured: true,
          serverName: name || 'discoverylab',
          source: 'settings',
          configPath,
        };
      }
    }
  } catch {
    // Ignore invalid config and fall through to not-configured response.
  }

  return {
    configured: false,
    serverName: null,
    source: 'none',
    configPath,
  };
}

// ============================================================================
// INTEGRATIONS API
// ============================================================================
app.get('/api/integrations/claude-desktop/status', async (c) => {
  try {
    const { platform } = await import('node:os');

    const app = findClaudeDesktopApp();
    const mcp = detectDiscoveryLabClaudeDesktopMcp();
    const launcherSupported = platform() === 'darwin' || platform() === 'win32';
    const ready = app.detected && launcherSupported && mcp.configured;

    let message = 'Claude Desktop launcher unavailable on this platform.';
    if (platform() === 'darwin' || platform() === 'win32') {
      if (!app.detected) {
        message = 'Claude Desktop was not detected on this machine.';
      } else if (!mcp.configured) {
        message = 'Claude Desktop is installed, but the DiscoveryLab local MCP is not configured yet.';
      } else {
        message = 'Claude Desktop is ready to open this project with the local DiscoveryLab MCP.';
      }
    }

    return c.json({
      ready,
      appDetected: app.detected,
      launcherSupported,
      launchTarget: app.launchTarget,
      installPath: app.installPath,
      mcpConfigured: mcp.configured,
      serverName: mcp.serverName,
      source: mcp.source,
      configPath: mcp.configPath,
      installCommand: 'npx -y @veolab/discoverylab@latest install --target desktop',
      message,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/integrations/claude-desktop/launch', async (c) => {
  try {
    const { platform } = await import('node:os');
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');

    const app = findClaudeDesktopApp();
    if (!app.detected || !app.launchTarget) {
      return c.json({ success: false, error: 'Claude Desktop was not detected on this machine.' }, 404);
    }

    const execAsync = promisify(exec);

    if (platform() === 'darwin') {
      await execAsync(`open -a "${app.launchTarget}"`);
    } else if (platform() === 'win32') {
      await execAsync(`cmd /c start "" "${app.launchTarget}"`);
    } else {
      return c.json({ success: false, error: 'Claude Desktop launcher is not supported on this platform.' }, 400);
    }

    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: message }, 500);
  }
});

app.get('/api/integrations/jira-mcp/status', async (c) => {
  try {
    const { execSync } = await import('node:child_process');
    const { existsSync, readFileSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');

    const claudeCliAvailable = isClaudeCliAvailable();
    let configured = false;
    let available = false;
    let serverName: string | null = null;
    let source: 'cli' | 'settings' | 'none' = 'none';
    let cliError: string | null = null;

    const keywordMatch = (value: string) => {
      const lowered = value.toLowerCase();
      return lowered.includes('atlassian') || lowered.includes('jira') || lowered.includes('rovo');
    };

    const detectFromSettings = (settings: any) => {
      const servers = settings?.mcpServers;
      if (!servers || typeof servers !== 'object') return null;

      for (const [name, config] of Object.entries<any>(servers)) {
        const configString = [
          name,
          config?.command || '',
          ...(Array.isArray(config?.args) ? config.args : []),
          config?.url || '',
        ].join(' ');

        if (keywordMatch(configString)) {
          return name;
        }
      }
      return null;
    };

    if (claudeCliAvailable) {
      try {
        const output = execSync('claude mcp list', {
          encoding: 'utf8',
          timeout: 4000,
          stdio: 'pipe',
          shell: '/bin/bash'
        }).trim();

        const lines = output.split('\n');
        const matchedLine = lines.find((line) => keywordMatch(line));
        if (matchedLine) {
          serverName = matchedLine.trim().split(/\s+/)[0] || 'atlassian-mcp';
          configured = true;
          available = true;
          source = 'cli';
        }
      } catch (error) {
        cliError = error instanceof Error ? error.message : 'Failed to run claude mcp list';
      }
    }

    if (!configured) {
      const settingsPaths = [
        join(homedir(), '.claude', 'settings.json'),
        join(homedir(), '.claude', 'settings.local.json')
      ];

      for (const filePath of settingsPaths) {
        if (!existsSync(filePath)) continue;
        try {
          const raw = readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          const detected = detectFromSettings(parsed);
          if (detected) {
            serverName = detected;
            configured = true;
            source = 'settings';
            break;
          }
        } catch {
          // Ignore invalid settings files
        }
      }
    }

    if (!available) {
      available = configured && claudeCliAvailable;
    }

    // Also check if Jira API settings are configured (direct REST API)
    const jiraApiConfigured = !!(jiraSettings.baseUrl && jiraSettings.email && jiraSettings.apiToken);
    if (jiraApiConfigured && !configured) {
      configured = true;
      available = true;
      source = 'settings' as typeof source;
      serverName = 'REST API (saved credentials)';
    }

    return c.json({
      available,
      configured,
      claudeCliAvailable,
      serverName,
      source,
      cliError,
      jiraApiConfigured
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/maestro/studio', async (c) => {
  try {
    const maestroAvailable = await isMaestroInstalled();
    if (!maestroAvailable) {
      return c.json({
        success: false,
        message: 'Maestro CLI is not installed or not available in PATH.',
      }, 400);
    }

    const maestroCandidates = [
      `${homedir()}/.maestro/bin/maestro`,
      '/opt/homebrew/bin/maestro',
      '/usr/local/bin/maestro',
      'maestro',
    ];
    const javaPath = '/opt/homebrew/opt/openjdk@17/bin';
    const env = { ...process.env, PATH: `${javaPath}:${process.env.PATH}` };
    const studioUrl = 'http://localhost:9999';
    const studioPort = 9999;
    const maestroCommand = maestroCandidates.find((candidate) => candidate === 'maestro' || existsSync(candidate)) || 'maestro';

    // Check if Maestro Studio is already running (port 9999)
    const isPortInUse = await isLocalTcpPortReachable(studioPort);

    if (isPortInUse) {
      return c.json({
        success: true,
        message: 'Maestro Studio already running',
        url: studioUrl,
        alreadyRunning: true
      });
    }

    // Check if a device is running
    let hasDevice = false;
    let deviceType = '';
    try {
      // Check for iOS Simulator
      const simResult = execSync('xcrun simctl list devices booted 2>/dev/null | grep -c "Booted"', { encoding: 'utf8', stdio: 'pipe' });
      if (parseInt(simResult.trim()) > 0) {
        hasDevice = true;
        deviceType = 'ios';
      }
    } catch {}

    if (!hasDevice && ADB_PATH) {
      try {
        // Check for Android Emulator (using detected SDK path)
        const adbResult = execSync(`"${ADB_PATH}" devices 2>/dev/null | grep -v "List" | grep -c "device$"`, { encoding: 'utf8', stdio: 'pipe' });
        if (parseInt(adbResult.trim()) > 0) {
          hasDevice = true;
          deviceType = 'android';
        }
      } catch {}
    }

    if (!hasDevice) {
      return c.json({
        success: false,
        message: 'No device running. Start iOS Simulator or Android Emulator first.',
        fallbackUrl: 'https://maestro.dev?utm_source=discoverylab#maestro-studio'
      }, 400);
    }

    // Run maestro studio in background
    const studioProcess = spawn(maestroCommand, ['studio'], {
      env,
      detached: true,
      stdio: 'ignore',
    });
    studioProcess.unref();

    const studioReady = await waitForLocalTcpPort(studioPort, { timeoutMs: 12_000, intervalMs: 200 });
    if (!studioReady) {
      return c.json({
        success: false,
        message: 'Maestro Studio did not become ready in time. Try again and check the local CLI output if it keeps failing.',
        url: studioUrl,
      }, 504);
    }

    return c.json({
      success: true,
      message: 'Maestro Studio ready',
      url: studioUrl,
      deviceType,
      alreadyRunning: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/ios-simulator', async (c) => {
  try {
    const { exec, execSync } = await import('node:child_process');
    const body = await c.req.json().catch(() => ({}));
    const requestedUdid = body.udid; // Optional: specific simulator UDID to boot

    if (requestedUdid) {
      // Boot specific simulator
      try {
        execSync(`xcrun simctl boot ${requestedUdid}`, { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        // Might already be booted, that's OK
      }
      // Open Simulator app to show the booted device
      exec('open -a Simulator', () => {});

      // Get device name for message
      try {
        const listOutput = execSync('xcrun simctl list devices -j', { encoding: 'utf8' });
        const simData = JSON.parse(listOutput);
        for (const [runtime, devices] of Object.entries(simData.devices) as any) {
          for (const device of devices) {
            if (device.udid === requestedUdid) {
              return c.json({ success: true, message: `Booting ${device.name}...` });
            }
          }
        }
      } catch {}
      return c.json({ success: true, message: 'Booting iOS Simulator...' });
    }

    // No specific UDID - just open Simulator app
    exec('open -a Simulator', (error) => {
      if (error) console.error('Failed to open Simulator:', error);
    });

    return c.json({ success: true, message: 'Opening iOS Simulator...' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/android-emulator', async (c) => {
  try {
    const { exec, execSync } = await import('node:child_process');
    const body = await c.req.json().catch(() => ({}));
    const requestedAvd = body.avd; // Optional: specific AVD to launch

    // Check if SDK is available
    if (!EMULATOR_PATH) {
      return c.json({
        success: false,
        message: 'Android SDK not found. Looking in: ~/Library/Android/sdk',
        hint: 'Install Android Studio or set ANDROID_HOME environment variable'
      }, 400);
    }

    try {
      const emulatorList = execSync(`"${EMULATOR_PATH}" -list-avds 2>/dev/null`, { encoding: 'utf8' });
      const avds = emulatorList.trim().split('\n').filter(Boolean);

      if (avds.length > 0) {
        const avdToLaunch = requestedAvd || avds[0];
        if (!avds.includes(avdToLaunch)) {
          return c.json({
            success: false,
            message: `AVD "${avdToLaunch}" not found`,
            availableAvds: avds
          }, 400);
        }

        // Start the emulator
        exec(`"${EMULATOR_PATH}" -avd ${avdToLaunch} &`, (error) => {
          if (error) console.error('Failed to start emulator:', error);
        });
        return c.json({ success: true, message: `Starting Android Emulator: ${avdToLaunch}`, availableAvds: avds });
      } else {
        return c.json({
          success: false,
          message: 'No Android Virtual Devices found. Create one in Android Studio first.',
          hint: 'Open Android Studio > Device Manager > Create Device'
        }, 400);
      }
    } catch (error) {
      return c.json({
        success: false,
        message: 'Failed to list Android emulators',
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 400);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// DEVICES API - List all available iOS/Android devices (like VS Code does)
// ============================================================================
app.get('/api/devices', async (c) => {
  try {
    const { execSync } = await import('node:child_process');
    const devices: Array<{
      id: string;
      name: string;
      platform: 'ios' | 'android';
      status: 'booted' | 'shutdown' | 'connected' | 'offline';
      type: 'simulator' | 'emulator' | 'physical';
    }> = [];

    // Get iOS Simulators (all, not just booted)
    try {
      const simOutput = execSync('xcrun simctl list devices -j', { encoding: 'utf8' });
      const simData = JSON.parse(simOutput);
      for (const [runtime, runtimeDevices] of Object.entries(simData.devices) as any) {
        // Only include iOS runtimes (skip watchOS, tvOS)
        if (!runtime.includes('iOS')) continue;
        const iosVersion = runtime.match(/iOS[- ](\d+[.-]\d+)/)?.[1]?.replace('-', '.') || '';
        for (const device of runtimeDevices) {
          devices.push({
            id: device.udid,
            name: `${device.name} (iOS ${iosVersion})`,
            platform: 'ios',
            status: device.state === 'Booted' ? 'booted' : 'shutdown',
            type: 'simulator'
          });
        }
      }
    } catch {}

    const connectedAndroidDevices = listConnectedAndroidDevices();

    // Get Android Emulators (AVDs)
    if (EMULATOR_PATH) {
      try {
        const avdOutput = execSync(`"${EMULATOR_PATH}" -list-avds`, { encoding: 'utf8' });
        const avds = avdOutput.trim().split('\n').filter(Boolean);
        const runningEmulatorByAvd = new Map<string, string>();

        for (const device of connectedAndroidDevices) {
          if (device.state === 'device' && device.serial.startsWith('emulator-') && device.avdName) {
            runningEmulatorByAvd.set(device.avdName, device.serial);
          }
        }

        for (const avd of avds) {
          const runningSerial = runningEmulatorByAvd.get(avd);
          const isRunning = Boolean(runningSerial);
          devices.push({
            id: runningSerial || avd,
            name: avd.replace(/_/g, ' '),
            platform: 'android',
            status: isRunning ? 'booted' : 'shutdown',
            type: 'emulator'
          });
        }
      } catch {}
    }

    // Get physical Android devices
    for (const device of connectedAndroidDevices) {
      if (device.serial.startsWith('emulator-')) continue;

      const isOffline = device.state === 'offline';
      const name = device.model || device.device || device.serial;
      devices.push({
        id: device.serial,
        name: name.replace(/_/g, ' '),
        platform: 'android',
        status: isOffline ? 'offline' : 'connected',
        type: 'physical'
      });
    }

    return c.json({
      devices,
      sdkStatus: {
        ios: true, // Xcode is generally available on macOS
        android: !!ADB_PATH,
        androidSdkPath: findAndroidSdkPath()
      }
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// List currently available mobile devices that Maestro can target (booted/connected only)
app.get('/api/testing/mobile/maestro-devices', async (c) => {
  try {
    const forceRefresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
    const devices = await listMaestroDevices({ forceRefresh });
    return c.json({ devices, refreshed: forceRefresh });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Mobile Recording using MaestroRecorder (captures touch events + generates YAML)
app.post('/api/testing/mobile/record/start', async (c) => {
  try {
    const { execSync } = await import('node:child_process');

    // Parse request body for user-selected device
    const body = await c.req.json().catch(() => ({}));
    const { deviceId: requestedDeviceId, platform: requestedPlatform } = body;

    // Detect running device
    let platform: 'ios' | 'android' | null = null;
    let deviceId = '';
    let deviceName = '';

    // If user explicitly selected a device, use it
    if (requestedDeviceId && requestedPlatform) {
      platform = requestedPlatform as 'ios' | 'android';
      deviceId = requestedDeviceId;

      if (platform === 'android') {
        const resolvedSerial = resolveAndroidDeviceSerial(deviceId);
        if (!resolvedSerial) {
          return c.json({
            error: `Selected Android device "${deviceId}" is not connected. Start the emulator/device and retry.`
          }, 400);
        }
        deviceId = resolvedSerial;
      }

      // Get device name for the selected device
      if (platform === 'ios') {
        try {
          const simOutput = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
          const simData = JSON.parse(simOutput);
          for (const [runtime, devices] of Object.entries(simData.devices) as any) {
            for (const device of devices) {
              if (device.udid === deviceId) {
                deviceName = device.name;
                break;
              }
            }
            if (deviceName) break;
          }
        } catch {}
        deviceName = deviceName || deviceId;
      } else if (platform === 'android' && ADB_PATH) {
        try {
          const adbOutput = execSync(`"${ADB_PATH}" devices -l`, { encoding: 'utf8' });
          const lines = adbOutput.split('\n').slice(1);
          for (const line of lines) {
            if (line.startsWith(deviceId)) {
              const modelMatch = line.match(/model:(\S+)/);
              deviceName = modelMatch?.[1] || deviceId;
              break;
            }
          }
        } catch {}
        deviceName = deviceName || deviceId;
      }
    } else {
      // Fallback: Auto-detect device (original logic)

      // Check iOS Simulator
      try {
        const simOutput = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
        const simData = JSON.parse(simOutput);
        for (const [runtime, devices] of Object.entries(simData.devices) as any) {
          for (const device of devices) {
            if (device.state === 'Booted') {
              platform = 'ios';
              deviceId = device.udid;
              deviceName = device.name;
              break;
            }
          }
          if (platform) break;
        }
      } catch {}

      // Check Android if no iOS (using detected SDK path)
      if (!platform && ADB_PATH) {
        try {
          const adbOutput = execSync(`"${ADB_PATH}" devices -l`, { encoding: 'utf8' });
          const lines = adbOutput.split('\n').slice(1);
          for (const line of lines) {
            if (line.includes('device') && !line.includes('offline')) {
              const parts = line.split(/\s+/);
              deviceId = parts[0];
              const modelMatch = line.match(/model:(\S+)/);
              deviceName = modelMatch?.[1] || deviceId;
              platform = 'android';
              break;
            }
          }
        } catch {}
      }
    }

    if (!platform || !deviceId) {
      return c.json({
        error: 'No running device found. Start iOS Simulator or Android Emulator first.'
      }, 400);
    }

    // Bring device to foreground for better testing experience
    try {
      if (platform === 'ios') {
        execSync('osascript -e \'tell application "Simulator" to activate\'', { encoding: 'utf8' });
        console.log('[Focus] iOS Simulator brought to foreground');
      } else if (platform === 'android') {
        execSync('osascript -e \'tell application "qemu-system-aarch64" to activate\' 2>/dev/null || osascript -e \'tell application "Android Emulator" to activate\' 2>/dev/null || true', { encoding: 'utf8' });
        console.log('[Focus] Android Emulator brought to foreground');
      }
    } catch {
      // Silently ignore focus errors
    }

    // Start recording with MaestroRecorder (captures touch events + video)
    const recorder = getMaestroRecorder();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const sessionName = `Mobile Test - ${timestamp}`;
    const initialAppId = getForegroundAppIdForPlatform(platform, deviceId);

    const session = await recorder.startRecording(
      sessionName,
      deviceId,
      deviceName,
      platform,
      initialAppId || undefined
    );

    return c.json({
      success: true,
      sessionId: session.id,
      platform,
      deviceId,
      deviceName,
      appId: session.appId || initialAppId || null,
      captureMode: session.captureMode || 'manual',
      captureModeReason: session.captureModeReason || null,
      message: `Recording ${deviceName} (capturing touch events)...`
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Add tap action during recording (captured from UI click on mirrored display)
app.post('/api/testing/mobile/record/tap', async (c) => {
  try {
    const recorder = getMaestroRecorder();

    if (!recorder.isRecording()) {
      return c.json({ error: 'No active recording session' }, 400);
    }

    const body = await c.req.json();
    const { x, y, description } = body;

    if (x === undefined || y === undefined) {
      return c.json({ error: 'x and y coordinates are required' }, 400);
    }

    // Persist the action before returning to avoid losing taps on immediate stop.
    await recorder.addManualAction('tap', description || `Tap at (${x}, ${y})`, { x, y });

    return c.json({
      success: true,
      message: `Tap recorded at (${x}, ${y})`
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Send tap to device (and optionally record it)
app.post('/api/testing/mobile/device/tap', async (c) => {
  let tapPlatform: 'ios' | 'android' | null = null;
  let tapDeviceId: string | null = null;
  let tapCoords = { x: 0, y: 0 };

  try {
    const recorder = getMaestroRecorder();
    const session = recorder.getSession();
    const body = await c.req.json();
    const { x, y, platform, deviceId, appId } = body || {};
    tapCoords = { x: x ?? 0, y: y ?? 0 };
    tapPlatform = platform || session?.platform || liveStreamPlatform;
    tapDeviceId = deviceId || session?.deviceId || liveStreamDeviceId;

    if (x === undefined || y === undefined) {
      return c.json({ error: 'x and y coordinates are required' }, 400);
    }

    const tapX = Number(x);
    const tapY = Number(y);

    if (!Number.isFinite(tapX) || !Number.isFinite(tapY)) {
      return c.json({ error: 'x and y must be numbers' }, 400);
    }

    if (!tapPlatform) {
      return c.json({ error: 'No target platform available' }, 400);
    }

    if (!tapDeviceId) {
      try {
        if (tapPlatform === 'android' && ADB_PATH) {
          const adbOutput = execSync(`"${ADB_PATH}" devices -l`, { encoding: 'utf8' });
          const lines = adbOutput.split('\n').slice(1);
          for (const line of lines) {
            if (line.includes('device') && !line.includes('offline')) {
              const parts = line.split(/\s+/);
              tapDeviceId = parts[0];
              break;
            }
          }
        }
      } catch {}

      if (tapPlatform === 'ios' && !tapDeviceId) {
        try {
          const simOutput = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
          const simData = JSON.parse(simOutput);
          for (const [, devices] of Object.entries(simData.devices) as any) {
            for (const device of devices) {
              if (device.state === 'Booted') {
                tapDeviceId = device.udid;
                break;
              }
            }
            if (tapDeviceId) break;
          }
        } catch {}
      }
    }

    if (tapPlatform === 'android') {
      tapDeviceId = resolveAndroidDeviceSerial(tapDeviceId) || null;
    }

    if (!tapDeviceId) {
      return c.json({ error: 'No target device found' }, 400);
    }

    if (tapPlatform === 'android') {
      // Android: ADB tap with retry logic and increased timeout
      const adbPath = ADB_PATH || 'adb';
      let attempts = 0;
      const maxAttempts = 2;
      let lastError: Error | null = null;

      while (attempts < maxAttempts) {
        try {
          execSync(`"${adbPath}" -s "${tapDeviceId}" shell input tap ${Math.round(tapX)} ${Math.round(tapY)}`, {
            timeout: 5000,
          });
          lastError = null;
          break;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          attempts++;
          if (attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
      }

      if (lastError) {
        console.error('[ADB TAP FAILED]', { attempts, error: lastError.message, device: tapDeviceId });
        throw lastError;
      }
    } else {
      // iOS: Try idb first (optional optimization), then Maestro
      let tapSuccess = false;
      const isNativeIOSRecording =
        session?.status === 'recording' &&
        session?.platform === 'ios' &&
        session?.captureMode === 'native';

      // Method 1: Try idb if available (optional - faster taps)
      const idbAvailable = await isIdbInstalled();
      if (idbAvailable) {
        tapSuccess = await tapViaIdb(tapDeviceId, tapX, tapY);
        if (tapSuccess) {
          console.log('[iOS TAP] via idb');
        }
      }

      // Method 2: Maestro (primary method)
      if (!tapSuccess) {
        if (isNativeIOSRecording) {
          const reason = 'Portal tap no iOS durante gravacao nativa requer idb. Sem idb, usar maestro test conflita com maestro record.';
          console.warn('[iOS TAP BLOCKED]', {
            reason,
            device: tapDeviceId,
            x: tapX,
            y: tapY,
            captureMode: session?.captureMode,
          });
          return c.json({
            error: 'Portal tap no iOS durante gravacao nativa precisa de idb. Toque direto no Simulator ou instale idb.',
          }, 409);
        }

        const maestroAvailable = await isMaestroInstalled();
        if (!maestroAvailable) {
          return c.json({
            error: 'Maestro CLI not installed. Install with: curl -Ls "https://get.maestro.mobile.dev" | bash',
          }, 424);
        }

        // Acquire lock to prevent concurrent Maestro executions (causes log file conflicts)
        const lock = acquireMaestroTapLock();
        await lock.acquired;

        try {
          const { mkdir, writeFile, rm } = await import('node:fs/promises');
          const { join } = await import('node:path');
          const tempBase = join(tmpdir(), 'discoverylab-maestro-live');
          const flowPath = join(tempBase, `tap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`);
          const outputDir = join(tempBase, `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

          await mkdir(tempBase, { recursive: true });

          // Also ensure Maestro log directory exists to prevent race conditions
          const maestroLogDir = join(homedir(), 'Library', 'Logs', 'maestro');
          await mkdir(maestroLogDir, { recursive: true });

          const flowLines: string[] = [];
          let resolvedAppId = appId || session?.appId;

          // If no appId, try to get it from the foreground app on iOS
          if (!resolvedAppId && tapPlatform === 'ios' && tapDeviceId) {
            resolvedAppId = getIOSForegroundAppId(tapDeviceId);
          }

          // Maestro requires appId - fallback to springboard (always present on iOS)
          const finalAppId = resolvedAppId || 'com.apple.springboard';
          flowLines.push(`appId: ${finalAppId}`, '');
          flowLines.push('---', '- tapOn:', `    point: "${Math.round(tapX)},${Math.round(tapY)}"`);
          await writeFile(flowPath, flowLines.join('\n'));

          const result = await runMaestroTest({
            flowPath,
            device: tapDeviceId,
            timeout: 15000, // Reduced from 30s to 15s
            outputDir,
          });

          await rm(flowPath, { force: true });
          await rm(outputDir, { recursive: true, force: true });

          // Clean up any zombie maestro processes after tap
          await killZombieMaestroProcesses();

          if (!result.success) {
            const errorMessage = result.error || 'Failed to send tap via Maestro';
            const dependencyError = /maestro cli is not installed|java runtime|command not found|not runnable/i.test(errorMessage);
            console.error('[iOS TAP MAESTRO FAILED]', { error: errorMessage, device: tapDeviceId, x: tapX, y: tapY });
            return c.json({ error: errorMessage }, dependencyError ? 424 : 500);
          }
        } finally {
          lock.release();
        }
      }
    }

    let recorded = false;
    if (recorder.isRecording()) {
      await recorder.addManualAction('tap', `Tap at (${Math.round(tapX)}, ${Math.round(tapY)})`, {
        x: Math.round(tapX),
        y: Math.round(tapY),
      });
      recorded = true;
    }

    return c.json({
      success: true,
      platform: tapPlatform,
      deviceId: tapDeviceId,
      recorded,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : '';
    console.error('[TAP ERROR]', {
      message,
      stack,
      x: tapCoords.x,
      y: tapCoords.y,
      platform: tapPlatform,
      deviceId: tapDeviceId
    });
    return c.json({
      error: message,
      platform: tapPlatform,
      device: tapDeviceId
    }, 500);
  }
});

// Add swipe action during recording
app.post('/api/testing/mobile/record/swipe', async (c) => {
  try {
    const recorder = getMaestroRecorder();

    if (!recorder.isRecording()) {
      return c.json({ error: 'No active recording session' }, 400);
    }

    const body = await c.req.json();
    const { startX, startY, endX, endY, description } = body;

    if (startX === undefined || startY === undefined || endX === undefined || endY === undefined) {
      return c.json({ error: 'startX, startY, endX, endY coordinates are required' }, 400);
    }

    // Persist the action before returning to avoid losing gestures on immediate stop.
    await recorder.addManualAction('swipe', description || `Swipe from (${startX}, ${startY}) to (${endX}, ${endY})`, {
      x: startX,
      y: startY,
      endX,
      endY
    });

    return c.json({
      success: true,
      message: `Swipe recorded`
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/mobile/record/stop', async (c) => {
  try {
    const recorder = getMaestroRecorder();

    if (!recorder.isRecording()) {
      return c.json({ error: 'No active recording session' }, 400);
    }

    // Get autoAnalyze setting from request body (default: true)
    let autoAnalyze = true;
    try {
      const body = await c.req.json();
      autoAnalyze = body?.autoAnalyze !== false;
    } catch {
      // No body or invalid JSON, use default
    }

    // Stop recording and get session with generated YAML
    const session = await recorder.stopRecording();

    // Use session ID as project ID for consistency
    const projectId = session.id;
    const { dirname, join } = await import('node:path');
    const { readdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
    const outputDir = dirname(session.flowPath || session.screenshotsDir);

    if (!session.appId && session.deviceId && session.platform) {
      session.appId = getForegroundAppIdForPlatform(session.platform, session.deviceId) || undefined;
    }

    // Find first screenshot for thumbnail
    let thumbnailPath: string | null = null;
    let screenshotCount = 0;
    let screenshotFiles: string[] = [];
    try {
      screenshotFiles = readdirSync(session.screenshotsDir)
        .filter(f => f.endsWith('.png'))
        .sort();
      screenshotCount = screenshotFiles.length;
      if (screenshotFiles.length > 0) {
        thumbnailPath = join(session.screenshotsDir, screenshotFiles[0]);
      }
    } catch {
      // No screenshots found
    }

    const iconCoverPath = session.deviceId && session.platform
      ? await createMobileAppIconCover({
          platform: session.platform,
          deviceId: session.deviceId,
          appId: session.appId,
          outputDir,
          adbPath: ADB_PATH,
        })
      : null;

    if (iconCoverPath) {
      thumbnailPath = iconCoverPath;
    }

    // Track if we'll run background analysis
    let actions = session.actions;
    const willAnalyze = autoAnalyze && screenshotCount >= 1;

    // Generate a better project name
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const actionsCount = actions.length;
    const deviceShort = session.deviceName?.split(' ')[0] || session.platform?.toUpperCase() || 'Mobile';
    const projectName = actionsCount > 0
      ? `${deviceShort} Test - ${actionsCount} actions - ${dateStr}`
      : `${deviceShort} Recording - ${dateStr}`;

    // Ensure YAML file exists
    const flowPath = join(outputDir, 'test.yaml');
    let flowContent = '';
    if (existsSync(flowPath)) {
      try {
        flowContent = readFileSync(flowPath, 'utf-8');
      } catch {}
    }

    const isPlaceholderYaml = flowContent.includes('# Auto-generated Maestro test flow') &&
      flowContent.includes('# Add your test steps here');

    if (actionsCount === 0 && screenshotFiles.length > 0 && (!flowContent || isPlaceholderYaml)) {
      const escapedFiles = screenshotFiles.map(file => file.replace(/"/g, '\\"'));
      const manualYaml = `# Auto-generated Maestro test flow
# Generated by DiscoveryLab (manual capture fallback)
# ${new Date().toISOString()}
# Note: manual mode cannot capture taps automatically

appId: ${session.appId || 'com.example.app # TODO: Set your app ID'}

---

- launchApp

${escapedFiles.map((file, index) => `# Screenshot ${index + 1}\n- takeScreenshot:\n    path: "${file}"\n`).join('\n')}
`;
      writeFileSync(flowPath, manualYaml, 'utf-8');
      session.flowPath = flowPath;
      flowContent = manualYaml;
      console.log(`[MobileRecording] Created screenshot fallback YAML at ${flowPath}`);
    }

    if (!flowContent) {
      const basicYaml = `# Auto-generated Maestro test flow
# Generated by DiscoveryLab
# ${new Date().toISOString()}
# OCR: ${willAnalyze ? 'Analysis running in background' : 'disabled'}

appId: com.example.app # TODO: Set your app ID

---

# Add your test steps here
# - launchApp
# - tapOn:
#     text: "Button"

`;
      writeFileSync(flowPath, basicYaml, 'utf-8');
      session.flowPath = flowPath;
      console.log(`[MobileRecording] Created placeholder YAML at ${flowPath}`);
    }

    // Save project to database using drizzle ORM
    // Status is 'analyzing' if we'll run background OCR, otherwise 'completed'
    const db = getDatabase();
    await db.insert(projects).values({
      id: projectId,
      name: projectName,
      videoPath: outputDir,
      thumbnailPath: thumbnailPath,
      platform: session.platform,
      status: willAnalyze ? 'analyzing' : 'completed',
      frameCount: actionsCount,
      ocrText: null, // Will be filled by background analysis
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Fire and forget: run OCR in background if enabled
    if (willAnalyze) {
      console.log(`[MobileRecording] Starting background OCR analysis for ${screenshotCount} screenshots...`);
      // Don't await - let it run in background
      runOCRInBackgroundWithWatchdog(projectId, session.screenshotsDir, screenshotFiles, 'MobileRecording');
    }

    return c.json({
      success: true,
      projectId,
      name: projectName,
      sessionId: session.id,
      flowPath: session.flowPath,
      flowCode: flowContent,
      videoPath: session.videoPath,
      screenshotsDir: session.screenshotsDir,
      thumbnailPath,
      actionsCount: actionsCount,
      aiAnalysisUsed: willAnalyze, // Renamed but kept for frontend compatibility
      ocrAnalysisUsed: willAnalyze,
      ocrInProgress: willAnalyze, // New flag for frontend polling
      status: willAnalyze ? 'analyzing' : 'completed',
      platform: session.platform,
      deviceName: session.deviceName,
      captureMode: session.captureMode || 'manual',
      captureModeReason: session.captureModeReason || null,
      duration: session.endedAt ? Math.floor((session.endedAt - session.startedAt) / 1000) : 0
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get mobile recording session info
app.get('/api/testing/mobile/record/status', async (c) => {
  const recorder = getMaestroRecorder();
  const session = recorder.getSession();

  if (!session) {
    return c.json({ active: false });
  }

  return c.json({
    active: true,
    sessionId: session.id,
    platform: session.platform,
    deviceName: session.deviceName,
    captureMode: session.captureMode || 'manual',
    captureModeReason: session.captureModeReason || null,
    actionsCount: session.actions.length,
    duration: Math.floor((Date.now() - session.startedAt) / 1000)
  });
});

// Polling endpoint for project analysis status
app.get('/api/projects/:id/analysis-status', async (c) => {
  try {
    const projectId = c.req.param('id');
    const db = getDatabase();
    let result = await db.select({
      id: projects.id,
      status: projects.status,
      ocrText: projects.ocrText,
      aiSummary: projects.aiSummary,
      ocrEngine: projects.ocrEngine,
      ocrConfidence: projects.ocrConfidence,
      updatedAt: projects.updatedAt,
    }).from(projects).where(eq(projects.id, projectId)).limit(1);

    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    let project = result[0];
    if (isAnalyzingProjectStatus(project.status)) {
      await expireStaleAnalyzingProjects([{
        id: project.id,
        status: project.status,
        updatedAt: project.updatedAt,
      }]);
      result = await db.select({
        id: projects.id,
        status: projects.status,
        ocrText: projects.ocrText,
        aiSummary: projects.aiSummary,
        ocrEngine: projects.ocrEngine,
        ocrConfidence: projects.ocrConfidence,
        updatedAt: projects.updatedAt,
      }).from(projects).where(eq(projects.id, projectId)).limit(1);
      if (result.length > 0) {
        project = result[0];
      }
    }

    const statusValue = typeof project.status === 'string' ? project.status : '';
    const analysisProgress = isAnalyzingProjectStatus(statusValue)
      ? getProjectAnalysisProgress(projectId)
      : null;
    return c.json({
      isAnalyzing: isAnalyzingProjectStatus(statusValue),
      status: statusValue,
      hasOCR: !!project.ocrText,
      hasSummary: !!project.aiSummary,
      ocrEngine: project.ocrEngine || null,
      ocrConfidence: project.ocrConfidence ?? null,
      ocrTextLength: project.ocrText?.length || 0,
      aiSummaryLength: project.aiSummary?.length || 0,
      analysisProgress,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Retry background analysis for a project (useful after timeout)
app.post('/api/projects/:id/retry-analysis', async (c) => {
  try {
    const projectId = c.req.param('id');
    const db = getDatabase();

    const result = await db.select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      videoPath: projects.videoPath,
    }).from(projects).where(eq(projects.id, projectId)).limit(1);

    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const project = result[0];
    if (isAnalyzingProjectStatus(project.status)) {
      return c.json({ error: 'Project analysis is already running' }, 409);
    }

    const projectPath = typeof project.videoPath === 'string' ? project.videoPath : '';
    const candidateScreenshotDirs: string[] = [];

    if (projectPath && existsSync(projectPath)) {
      try {
        const projectStats = statSync(projectPath);
        if (projectStats.isDirectory()) {
          candidateScreenshotDirs.push(join(projectPath, 'screenshots'));
          candidateScreenshotDirs.push(projectPath);
        }
      } catch (err) {
        console.warn('[RetryAnalysis] Failed to stat project path:', projectPath, err);
      }
    }

    let screenshotsDir: string | null = null;
    let screenshotFiles: string[] = [];
    for (const candidateDir of candidateScreenshotDirs) {
      if (!existsSync(candidateDir)) continue;
      try {
        const pngs = readdirSync(candidateDir)
          .filter((file) => file.toLowerCase().endsWith('.png'))
          .sort();
        if (pngs.length > 0) {
          screenshotsDir = candidateDir;
          screenshotFiles = pngs;
          break;
        }
      } catch (err) {
        console.warn('[RetryAnalysis] Failed to read screenshot dir:', candidateDir, err);
      }
    }

    await db.update(projects).set({
      status: 'analyzing',
      updatedAt: new Date(),
    }).where(eq(projects.id, projectId));

    broadcastToClients({
      type: 'projectAnalysisUpdated',
      data: { projectId, status: 'analyzing' }
    });

    if (screenshotsDir && screenshotFiles.length > 0) {
      console.log(`[RetryAnalysis] Restarting screenshot analysis for ${projectId} with ${screenshotFiles.length} screenshots`);
      runOCRInBackgroundWithWatchdog(projectId, screenshotsDir, screenshotFiles, 'RetryAnalysis');
      return c.json({
        success: true,
        projectId,
        status: 'analyzing',
        mode: 'screenshots',
        screenshotCount: screenshotFiles.length,
        message: 'App Intelligence analysis restarted'
      });
    }

    if (projectPath && existsSync(projectPath)) {
      try {
        const projectStats = statSync(projectPath);
        if (projectStats.isDirectory()) {
          console.log(`[RetryAnalysis] Restarting directory analysis for ${projectId}`);
          runProjectAnalysisInBackgroundWithWatchdog(projectId, 'RetryAnalysis(directory)');
          return c.json({
            success: true,
            projectId,
            status: 'analyzing',
            mode: 'directory',
            message: 'Project analysis restarted'
          });
        }
      } catch {}
    }

    await db.update(projects).set({
      status: project.status || 'timeout',
      updatedAt: new Date(),
    }).where(eq(projects.id, projectId));

    return c.json({
      error: 'Retry analysis is not supported for this project type yet (missing recording screenshots).'
    }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Re-analyze a mobile recording with AI to detect actions
app.post('/api/testing/mobile/recordings/:id/analyze', async (c) => {
  try {
    const recordingId = c.req.param('id');
    const { readdirSync, writeFileSync, existsSync: fsExistsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const recordingDir = join(PROJECTS_DIR, 'maestro-recordings', recordingId);
    const screenshotsDir = join(recordingDir, 'screenshots');

    if (!fsExistsSync(screenshotsDir)) {
      return c.json({ error: 'Screenshots directory not found' }, 404);
    }

    const screenshotFiles = readdirSync(screenshotsDir)
      .filter(f => f.endsWith('.png'))
      .sort();

    if (screenshotFiles.length < 2) {
      return c.json({ error: 'Not enough screenshots for analysis (need at least 2)' }, 400);
    }

    console.log(`[MobileRecording] Re-analyzing recording ${recordingId} with ${screenshotFiles.length} screenshots...`);

    // Run AI analysis — try Claude CLI vision first, then Ollama vision fallback (if configured)
    const visionProviders = await getActionDetectionVisionProviders();
    const analysisResult = await analyzeScreenshotsForActions(
      screenshotsDir,
      20,
      visionProviders.length > 0 ? visionProviders : undefined
    );

    if (analysisResult.actions.length === 0) {
      return c.json({
        success: true,
        message: 'AI analysis completed but no actions detected',
        actionsCount: 0,
        summary: analysisResult.summary
      });
    }

    // Generate and save Maestro YAML
    const maestroYaml = generateMaestroYaml(
      analysisResult.actions,
      undefined,
      analysisResult.appName,
      analysisResult.actionDetectionProvider
    );

    const flowPath = join(recordingDir, 'test.yaml');
    writeFileSync(flowPath, maestroYaml, 'utf-8');

    console.log(`[MobileRecording] AI detected ${analysisResult.actions.length} actions, YAML saved to ${flowPath}`);

    return c.json({
      success: true,
      message: `AI detected ${analysisResult.actions.length} actions`,
      actionsCount: analysisResult.actions.length,
      actions: analysisResult.actions,
      summary: analysisResult.summary,
      flowPath
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MobileRecording] AI re-analysis failed:', error);
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/playwright/codegen', async (c) => {
  try {
    const { exec } = await import('node:child_process');
    exec('npx playwright codegen', (error) => {
      if (error) console.error('Playwright codegen error:', error);
    });
    return c.json({ success: true, message: 'Playwright Codegen starting...' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// List mobile recordings
app.get('/api/testing/mobile/recordings', async (c) => {
  try {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const recordingsDir = join(PROJECTS_DIR, 'maestro-recordings');

    if (!existsSync(recordingsDir)) {
      return c.json({ recordings: [] });
    }

    const recordings: any[] = [];
    const dirs = readdirSync(recordingsDir);

    for (const dir of dirs) {
      const sessionPath = join(recordingsDir, dir, 'session.json');
      if (existsSync(sessionPath)) {
        try {
          const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
          recordings.push({
            id: session.id,
            name: session.name,
            platform: session.platform,
            deviceName: session.deviceName,
            actionsCount: session.actions?.length || 0,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            flowPath: session.flowPath,
            videoPath: session.videoPath,
            screenshotsDir: session.screenshotsDir
          });
        } catch (e) {
          console.error('Error reading session:', dir, e);
        }
      }
    }

    // Sort by date descending
    recordings.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

    return c.json({ recordings });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get mobile recording details with flow code
app.get('/api/testing/mobile/recordings/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const sessionPath = join(PROJECTS_DIR, 'maestro-recordings', id, 'session.json');
    const flowPath = join(PROJECTS_DIR, 'maestro-recordings', id, 'test.yaml');

    if (!existsSync(sessionPath)) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    let flowCode = '';

    if (existsSync(flowPath)) {
      flowCode = readFileSync(flowPath, 'utf-8');
    }

    return c.json({
      session,
      flowCode
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/mobile/recordings/:id/esvp/validate', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const serverUrl = typeof body?.serverUrl === 'string' ? body.serverUrl.trim() : undefined;
    const requestedNetwork =
      body?.network && typeof body.network === 'object'
        ? body.network
        : body?.network === false ? null : { enabled: true };
    const localProxyOptInEnabled = appLabNetworkProxySettings.localProxyOptInEnabled === true;
    const network = localProxyOptInEnabled ? requestedNetwork : null;
    const captureLogcat = typeof body?.captureLogcat === 'boolean' ? body.captureLogcat : undefined;
    const replay = typeof body?.replay === 'boolean' ? body.replay : undefined;
    const session = await readMobileRecordingSessionData(id);
    const existingNetworkEntries = getStoredRecordingNetworkEntries(session);
    const existingNetworkCapture =
      session.networkCapture && typeof session.networkCapture === 'object'
        ? session.networkCapture
        : null;
    const existingESVP = session.esvp && typeof session.esvp === 'object'
      ? session.esvp as Record<string, unknown>
      : {};
    const existingESVPNetwork =
      existingESVP.network && typeof existingESVP.network === 'object'
        ? existingESVP.network as Record<string, unknown>
        : null;
    const translatedSessionActions = Array.isArray(session.actions) ? session.actions : [];
    const shouldRehydrateActionsFromYaml =
      typeof session.flowPath === 'string' &&
      session.flowPath.trim() &&
      existsSync(session.flowPath) &&
      (
        translatedSessionActions.length === 0 ||
        session.captureMode === 'manual' ||
        translatedSessionActions.some((action: any) => typeof action?.text === 'string' && action.text.includes(' # '))
      );

    if (shouldRehydrateActionsFromYaml) {
      try {
        const yamlContent = readFileSync(session.flowPath, 'utf-8');
        const parsedActions = parseMaestroActionsFromYaml(yamlContent);
        if (parsedActions.length > 0) {
          session.actions = parsedActions;
          await writeMobileRecordingSessionData(id, session);
        }
      } catch {
        // Best effort fallback only.
      }
    }

    const visionProviders = await getActionDetectionVisionProviders();
    const result = await validateMaestroRecordingWithESVP(
      {
        id: String(session.id || id),
        name: String(session.name || `Recording ${id}`),
        platform: session.platform === 'ios' ? 'ios' : 'android',
        deviceId: String(session.deviceId || ''),
        deviceName: typeof session.deviceName === 'string' ? session.deviceName : undefined,
        appId: typeof session.appId === 'string' ? session.appId : undefined,
        actions: Array.isArray(session.actions) ? session.actions : [],
      },
      {
        serverUrl,
        network,
        captureLogcat,
        replay,
        appTraceServerPort: currentServerPort,
        allowAppLabOwnedProxyAutostart: localProxyOptInEnabled && !appLabNetworkProxySettings.emergencyLockEnabled,
        bootstrapScreenshotPath: getFirstRecordingScreenshotPath(session),
        recoveryVisionProvider: visionProviders.length > 0 ? visionProviders : undefined,
      }
    );

    const shouldPersistFreshNetwork = hasMeaningfulESVPNetworkSnapshot({
      networkEntries: result.networkEntries,
      traceKinds: result.traceKinds,
      networkState: result.networkState,
      networkProfileApplied: result.networkProfileApplied,
      managedProxy: result.managedProxy,
      captureProxy: result.captureProxy,
      appTraceCollector: result.appTraceCollector,
    });

    session.esvp = {
      ...existingESVP,
      currentSessionId: result.sourceSessionId || null,
      connectionMode: result.connectionMode,
      serverUrl: result.serverUrl,
      executor: result.executor,
      validation: {
        supported: result.supported,
        reason: result.reason || null,
        sourceSessionId: result.sourceSessionId || null,
        replaySessionId: result.replaySessionId || null,
        translatedActionCount: result.translatedActions.length,
        bootstrap: result.bootstrap || null,
        skippedActions: result.skippedActions,
        recovery: result.recovery || null,
        checkpointComparison: result.checkpointComparison || null,
        replayConsistency: result.replayConsistency || null,
        networkProfileApplied: result.networkProfileApplied || null,
        validatedAt: new Date().toISOString(),
      },
      ...(shouldPersistFreshNetwork
        ? {
            network: {
              ...(existingESVPNetwork || {}),
              sourceSessionId: result.sourceSessionId || existingESVPNetwork?.sourceSessionId || null,
              networkSupported: typeof result.networkState?.supported === 'boolean'
                ? result.networkState.supported
                : existingESVPNetwork?.networkSupported ?? null,
              traceKinds: result.traceKinds,
              traceCount: Number.isFinite(result.networkState?.trace_count)
                ? Number(result.networkState?.trace_count)
                : result.traceKinds.length,
              syncedAt: new Date().toISOString(),
              entryCount: result.networkEntries.length > 0 ? result.networkEntries.length : existingNetworkEntries.length,
              managedProxy: result.managedProxy || null,
              captureProxy: result.captureProxy || null,
              appTraceCollector: result.appTraceCollector || null,
              activeProfile: result.networkState?.active_profile || existingESVPNetwork?.activeProfile || null,
              effectiveProfile: result.networkState?.effective_profile || existingESVPNetwork?.effectiveProfile || null,
              configuredAt: result.networkState?.configured_at || existingESVPNetwork?.configuredAt || null,
              clearedAt: result.networkState?.cleared_at || existingESVPNetwork?.clearedAt || null,
              lastError: result.networkState?.last_error || existingESVPNetwork?.lastError || null,
            },
          }
        : existingESVPNetwork
          ? { network: existingESVPNetwork }
          : {}),
    };

    if (result.networkEntries.length > 0) {
      session.networkEntries = result.networkEntries;
      session.networkCapture = result.networkCapture;
    } else if (!existingNetworkCapture && result.supported) {
      session.networkCapture = result.networkCapture;
    }

    // Auto-sync: if validation collected zero entries but the ESVP session has traces,
    // attempt a deferred sync to catch late-flushed artifacts.
    let autoSynced = false;
    if (
      result.networkEntries.length === 0 &&
      result.supported &&
      result.sourceSessionId &&
      ((result.networkState?.managed_proxy?.entry_count ?? 0) > 0 || (result.networkState?.trace_count ?? 0) > 0)
    ) {
      try {
        const { collectESVPSessionNetworkData } = await import('../core/integrations/esvp-mobile.js');
        const deferred = await collectESVPSessionNetworkData(result.sourceSessionId, serverUrl);
        if (deferred.networkEntries.length > 0) {
          session.networkEntries = deferred.networkEntries;
          session.networkCapture = deferred.networkCapture;
          session.esvp.network = {
            ...((session.esvp && typeof session.esvp === 'object' && session.esvp.network && typeof session.esvp.network === 'object')
              ? session.esvp.network
              : existingESVPNetwork || {}),
            traceKinds: deferred.traceKinds,
            traceCount: Number.isFinite(result.networkState?.trace_count) ? Number(result.networkState?.trace_count) : deferred.traceKinds.length,
            entryCount: deferred.networkEntries.length,
            syncedAt: new Date().toISOString(),
          };
          result.networkEntries = deferred.networkEntries;
          result.networkCapture = deferred.networkCapture;
          result.traceKinds = deferred.traceKinds;
          autoSynced = true;
        }
      } catch {
        // Best effort — ignore deferred sync failures.
      }
    }

    await writeMobileRecordingSessionData(id, session);
    await touchProjectUpdatedAt(id).catch(() => {});

    return c.json({
      success: true,
      autoSyncedNetwork: autoSynced,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/mobile/recordings/:id/esvp/replay', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const session = await readMobileRecordingSessionData(id);
    const esvp = session?.esvp && typeof session.esvp === 'object'
      ? session.esvp as Record<string, unknown>
      : null;
    const requestedServerUrl = typeof body?.serverUrl === 'string' ? body.serverUrl.trim() : undefined;
    const serverUrl = requestedServerUrl || resolveProjectESVPServerUrl(esvp);
    const sourceSessionId = resolveProjectESVPSessionId(esvp);

    if (!sourceSessionId) {
      return c.json({
        error: 'No ESVP source session is attached to this recording yet. Run Validate with ESVP first.',
      }, 400);
    }

    const replayValidation = await validateESVPReplay(sourceSessionId, serverUrl);
    if (!isESVPReplayValidationSupported(replayValidation && typeof replayValidation === 'object' ? replayValidation as Record<string, unknown> : null)) {
      const reason = normalizeESVPReplayValidationReason(
        replayValidation && typeof replayValidation === 'object' ? replayValidation as Record<string, unknown> : null,
        resolveRecordingExecutor(session),
      ) || 'This ESVP session does not support canonical replay.';
      return c.json({
        error: reason,
        sourceSessionId,
        replayValidation,
      }, 409);
    }

    const executor = resolveRecordingExecutor(session);
    const shouldCaptureLogcat = typeof body?.captureLogcat === 'boolean'
      ? body.captureLogcat
      : executor === 'adb';
    const replay = await replayESVPSession(
      sourceSessionId,
      {
        executor,
        deviceId: String(session.deviceId || ''),
        captureLogcat: shouldCaptureLogcat,
        meta: {
          source: 'applab-discovery-project-replay',
          recording_id: String(session.id || id),
          recording_name: String(session.name || `Recording ${id}`),
          recording_platform: session.platform === 'ios' ? 'ios' : 'android',
          recording_device_name: typeof session.deviceName === 'string' ? session.deviceName : null,
        },
      },
      serverUrl
    );
    const replaySessionId = String(replay?.replay_session?.id || replay?.id || '');
    const replayConsistencyEnvelope = replaySessionId
      ? await getESVPReplayConsistency(replaySessionId, serverUrl).catch(() => null)
      : null;
    const replayConsistency = replayConsistencyEnvelope?.replay_consistency || null;

    const existingValidation = esvp?.validation && typeof esvp.validation === 'object'
      ? esvp.validation as Record<string, unknown>
      : {};
    session.esvp = {
      ...(esvp || {}),
      currentSessionId: sourceSessionId,
      serverUrl: resolvePersistedLocalESVPServerUrl(serverUrl, esvp),
      executor,
      validation: {
        ...existingValidation,
        supported: existingValidation.supported !== false,
        sourceSessionId: typeof existingValidation.sourceSessionId === 'string' && existingValidation.sourceSessionId
          ? existingValidation.sourceSessionId
          : sourceSessionId,
        replaySessionId: replaySessionId || null,
        checkpointComparison: replay?.checkpoint_comparison || existingValidation.checkpointComparison || null,
        replayConsistency,
        replayValidation,
        replayedAt: new Date().toISOString(),
      },
    };

    await writeMobileRecordingSessionData(id, session);
    await touchProjectUpdatedAt(id).catch(() => {});

    return c.json({
      success: true,
      sourceSessionId,
      replaySessionId: replaySessionId || null,
      replayValidation,
      replayConsistency,
      checkpointComparison: replay?.checkpoint_comparison || null,
      replay,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/mobile/recordings/:id/esvp/network/start', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const serverUrl = typeof body?.serverUrl === 'string' ? body.serverUrl.trim() : undefined;
    if (appLabNetworkProxySettings.localProxyOptInEnabled !== true) {
      return c.json({
        error: 'App Lab local network capture is disabled. Enable it from the Capture or Testing start card before starting network capture.',
      }, 403);
    }
    const session = await readMobileRecordingSessionData(id);
    const executor = resolveRecordingExecutor(session);
    const appId = normalizeRecordingAppIdForESVP(session?.appId);
    const requestedNetworkProfile = buildAppLabNetworkProfile(
      body?.network && typeof body.network === 'object'
        ? body.network
        : {
            enabled: true,
            mode: 'external-proxy',
            profile: 'applab-standard-capture',
            label: 'App Lab Standard Capture',
          },
      {
        platform: session?.platform,
        deviceId: session?.deviceId,
      }
    ) || buildDefaultESVPNetworkProfile(session);
    const existingNetwork = session?.esvp && typeof session.esvp === 'object' && session.esvp.network && typeof session.esvp.network === 'object'
      ? session.esvp.network
      : null;

    if (existingNetwork?.captureStatus === 'running' && typeof existingNetwork.activeCaptureSessionId === 'string' && existingNetwork.activeCaptureSessionId) {
      return c.json({
        success: true,
        reused: true,
        sessionId: existingNetwork.activeCaptureSessionId,
        managedProxy: existingNetwork.managedProxy || null,
        captureProxy: existingNetwork.captureProxy || null,
        appTraceCollector: existingNetwork.appTraceCollector || null,
        effectiveProfile: existingNetwork.effectiveProfile || null,
      });
    }

    const created = await createESVPSession(
      {
        executor,
        deviceId: String(session.deviceId || ''),
        meta: {
          source: 'applab-discovery-network-capture',
          recording_id: String(session.id || id),
          recording_name: String(session.name || `Recording ${id}`),
          recording_platform: session.platform === 'ios' ? 'ios' : 'android',
          recording_device_name: typeof session.deviceName === 'string' ? session.deviceName : null,
          ...(appId ? { appId, app_id: appId } : {}),
        },
      },
      serverUrl
    );
    const sourceSessionId = String(created?.session?.id || created?.id || '');
    if (!sourceSessionId) {
      throw new Error('Failed to create an ESVP session for network capture.');
    }
    if (!requestedNetworkProfile) {
      return c.json({ error: 'No network profile could be resolved for this recording.' }, 400);
    }
    const requestedCaptureMode = resolveRequestedAppLabCaptureMode(requestedNetworkProfile);
    const appTraceMode = requestedCaptureMode === 'app-http-trace';
    const preparedNetworkProfile = appTraceMode
      ? {
          profile: requestedNetworkProfile,
          captureProxy: null,
          usesExternalProxy: false,
          appLabOwnedProxy: false,
        }
      : await ensureLocalCaptureProxyProfile({
          sessionId: sourceSessionId,
          profile: requestedNetworkProfile,
          platform: session?.platform,
          deviceId: session?.deviceId,
          allowAppLabOwnedProxy: appLabNetworkProxySettings.localProxyOptInEnabled === true && !appLabNetworkProxySettings.emergencyLockEnabled,
          lifecycle: {
            executor,
            deviceId: String(session.deviceId || ''),
            serverUrl,
            captureLogcat: executor === 'adb',
            cleanupMeta: {
              recording_id: String(session.id || id),
              recording_name: String(session.name || `Recording ${id}`),
              recording_platform: session.platform === 'ios' ? 'ios' : 'android',
            },
          },
        });
    const appTraceCollector = appTraceMode
      ? startLocalAppHttpTraceCollector({
          sessionId: sourceSessionId,
          recordingId: String(session.id || id),
          appId,
          platform: session?.platform,
          deviceId: session?.deviceId,
          serverPort: currentServerPort,
        })
      : null;
    const networkResult = preparedNetworkProfile.profile && !appTraceMode
      ? await configureESVPNetwork(
          sourceSessionId,
          preparedNetworkProfile.profile || requestedNetworkProfile,
          serverUrl
        )
      : null;

    if (appId) {
      await runESVPActions(
        sourceSessionId,
        {
          actions: [{ name: 'launch', args: { appId } }],
          finish: false,
          checkpointAfterEach: false,
          captureLogcat: executor === 'adb',
        },
        serverUrl
      ).catch(() => null);
    }

    session.esvp = {
      ...(session.esvp && typeof session.esvp === 'object' ? session.esvp : {}),
      currentSessionId: sourceSessionId,
      connectionMode: typeof session?.esvp?.connectionMode === 'string' ? session.esvp.connectionMode : 'local',
      serverUrl: resolvePersistedLocalESVPServerUrl(
        serverUrl,
        session?.esvp && typeof session.esvp === 'object' ? session.esvp as Record<string, unknown> : null
      ),
      executor,
      network: {
        ...(existingNetwork || {}),
        sourceSessionId,
        activeCaptureSessionId: sourceSessionId,
        captureStatus: 'running',
        captureStartedAt: new Date().toISOString(),
        networkSupported: appTraceMode
          ? true
          : typeof networkResult?.network?.supported === 'boolean'
            ? networkResult.network.supported
            : null,
        entryCount: 0,
        traceCount: Number.isFinite(networkResult?.network?.trace_count)
          ? Number(networkResult.network.trace_count)
          : 0,
        traceKinds: appTraceMode
          ? ['app_http_trace']
          : [],
        managedProxy: networkResult?.network?.managed_proxy || null,
        captureProxy: preparedNetworkProfile.captureProxy || null,
        appTraceCollector: appTraceCollector || null,
        activeProfile: resolvePersistedNetworkProfile(networkResult?.network, null, preparedNetworkProfile.profile),
        effectiveProfile: resolvePersistedNetworkProfile(networkResult?.network, null, preparedNetworkProfile.profile),
        configuredAt: networkResult?.network?.configured_at || new Date().toISOString(),
        clearedAt: null,
        lastError: networkResult?.network?.last_error || null,
      },
    };

    await writeMobileRecordingSessionData(id, session);
    await touchProjectUpdatedAt(id).catch(() => {});

    return c.json({
      success: true,
      sessionId: sourceSessionId,
      network: session.esvp.network,
      managedProxy: session.esvp.network?.managedProxy || null,
      captureProxy: session.esvp.network?.captureProxy || null,
      appTraceCollector: session.esvp.network?.appTraceCollector || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.get('/api/testing/mobile/app-http-trace/bootstrap', async (c) => {
  const appId = typeof c.req.query('appId') === 'string' ? c.req.query('appId') : undefined;
  const recordingId = typeof c.req.query('recordingId') === 'string' ? c.req.query('recordingId') : undefined;
  const bootstrap = getLocalAppHttpTraceBootstrap({ appId, recordingId });
  if (!bootstrap) {
    return c.json({ error: 'No active local app_http_trace collector matched this app.' }, 404);
  }

  return c.json({
    success: true,
    collector: {
      id: bootstrap.id,
      sessionId: bootstrap.sessionId,
      recordingId: bootstrap.recordingId,
      appId: bootstrap.appId,
      active: bootstrap.active,
      host: bootstrap.host,
      port: bootstrap.port,
      bootstrapUrl: bootstrap.bootstrapUrl,
      ingestUrl: bootstrap.ingestUrl,
      entryCount: bootstrap.entryCount,
      traceKind: bootstrap.traceKind,
      source: bootstrap.source,
    },
    bootstrap: bootstrap.bootstrap,
  });
});

app.post('/api/testing/mobile/recordings/:id/esvp/app-http-trace/:collectorId', async (c) => {
  try {
    const { id, collectorId } = c.req.param();
    const collector = resolveLocalAppHttpTraceCollectorById(collectorId);
    if (!collector || collector.recordingId !== id) {
      return c.json({ error: 'Collector not found' }, 404);
    }

    const payload = await c.req.json().catch(() => ({}));
    const authToken = c.req.header('x-applab-trace-token')
      || c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
      || null;
    const accepted = ingestLocalAppHttpTrace({
      collectorId,
      authToken,
      payload,
    });
    if (!accepted.collector) {
      return c.json({ error: 'Collector rejected the trace batch' }, 401);
    }

    return c.json({
      success: true,
      accepted: accepted.accepted,
      collector: accepted.collector,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/mobile/recordings/:id/esvp/network/stop', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const serverUrl = typeof body?.serverUrl === 'string' ? body.serverUrl.trim() : undefined;
    const session = await readMobileRecordingSessionData(id);
    const executor = resolveRecordingExecutor(session);
    const network = session?.esvp && typeof session.esvp === 'object' && session.esvp.network && typeof session.esvp.network === 'object'
      ? session.esvp.network
      : null;
    const sessionId =
      typeof body?.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : typeof network?.activeCaptureSessionId === 'string' && network.activeCaptureSessionId
          ? network.activeCaptureSessionId
          : typeof network?.sourceSessionId === 'string' && network.sourceSessionId
            ? network.sourceSessionId
            : '';

    if (!sessionId) {
      return c.json({ error: 'No active ESVP network capture session was found.' }, 400);
    }

    const appTraceCollector = network?.appTraceCollector && typeof network.appTraceCollector === 'object'
      ? (network.appTraceCollector as LocalAppHttpTraceCollectorState)
      : null;
    const appTraceMode = appTraceCollector?.sessionId === sessionId;
    const proxyFinalization = appTraceMode
      ? null
      : await finalizeLocalCaptureProxySession({
          sourceSessionId: sessionId,
          executor,
          deviceId: String(session.deviceId || ''),
          serverUrl,
          captureLogcat: executor === 'adb',
          clearNetwork: true,
          cleanupMeta: {
            recording_id: String(session.id || id),
            recording_name: String(session.name || `Recording ${id}`),
            recording_platform: session.platform === 'ios' ? 'ios' : 'android',
          },
        });
    const appTraceFinalization = appTraceMode
      ? await finalizeLocalAppHttpTraceCollector({
          sourceSessionId: sessionId,
          serverUrl,
        })
      : null;

    const networkData = await collectESVPSessionNetworkData(sessionId, serverUrl);
    session.networkEntries = networkData.networkEntries;
    session.networkCapture = networkData.networkCapture;
    session.esvp = {
      ...(session.esvp && typeof session.esvp === 'object' ? session.esvp : {}),
      currentSessionId: sessionId,
      network: {
        ...(network || {}),
        sourceSessionId: sessionId,
        activeCaptureSessionId: null,
        captureStatus: 'stopped',
        captureStoppedAt: new Date().toISOString(),
        networkSupported: typeof networkData.networkState?.supported === 'boolean' ? networkData.networkState.supported : null,
        traceKinds: networkData.traceKinds,
        traceCount: Number.isFinite(networkData.networkState?.trace_count)
          ? Number(networkData.networkState?.trace_count)
          : networkData.traceKinds.length,
        entryCount: networkData.networkEntries.length,
        managedProxy: networkData.networkState?.managed_proxy ?? network?.managedProxy ?? null,
        captureProxy: proxyFinalization?.captureProxy || network?.captureProxy || null,
        appTraceCollector: appTraceFinalization?.collector || appTraceCollector || null,
        activeProfile: resolvePersistedNetworkProfile(networkData.networkState, network),
        effectiveProfile: resolvePersistedNetworkProfile(networkData.networkState, network),
        configuredAt: networkData.networkState?.configured_at || null,
        clearedAt: networkData.networkState?.cleared_at || proxyFinalization?.clearedAt || null,
        lastError: networkData.networkState?.last_error || proxyFinalization?.errors?.[0] || appTraceFinalization?.errors?.[0] || null,
        syncedAt: new Date().toISOString(),
      },
    };

    await writeMobileRecordingSessionData(id, session);
    await touchProjectUpdatedAt(id).catch(() => {});

    return c.json({
      success: true,
      sessionId,
      networkEntries: networkData.networkEntries,
      networkCapture: networkData.networkCapture,
      traceKinds: networkData.traceKinds,
      captureProxy: proxyFinalization?.captureProxy || null,
      appTraceCollector: appTraceFinalization?.collector || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/mobile/recordings/:id/esvp/network/trace-attach', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const serverUrl = typeof body?.serverUrl === 'string' ? body.serverUrl.trim() : undefined;
    const payload = body?.payload;
    if (!payload || (typeof payload !== 'object' && !Array.isArray(payload))) {
      return c.json({ error: 'A JSON trace payload is required.' }, 400);
    }

    const session = await readMobileRecordingSessionData(id);
    const executor = resolveRecordingExecutor(session);
    const appId = normalizeRecordingAppIdForESVP(session?.appId);
    const traceKind = typeof body?.traceKind === 'string' && body.traceKind.trim()
      ? body.traceKind.trim()
      : 'http_trace';

    let sessionId =
      typeof body?.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : typeof session?.esvp?.currentSessionId === 'string' && session.esvp.currentSessionId
          ? session.esvp.currentSessionId
          : typeof session?.esvp?.network?.sourceSessionId === 'string' && session.esvp.network.sourceSessionId
            ? session.esvp.network.sourceSessionId
            : '';

    if (!sessionId) {
      const created = await createESVPSession(
        {
          executor,
          deviceId: String(session.deviceId || ''),
          meta: {
            source: 'applab-discovery-external-trace',
            recording_id: String(session.id || id),
            recording_name: String(session.name || `Recording ${id}`),
            ...(appId ? { appId, app_id: appId } : {}),
          },
        },
        serverUrl
      );
      sessionId = String(created?.session?.id || created?.id || '');
    }

    if (!sessionId) {
      throw new Error('Failed to create an ESVP session for the external trace.');
    }

    await attachESVPNetworkTrace(
      sessionId,
      {
        trace_kind: traceKind,
        label: typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : 'external-trace',
        payload,
      },
      serverUrl
    );

    const networkData = await collectESVPSessionNetworkData(sessionId, serverUrl);
    session.networkEntries = networkData.networkEntries;
    session.networkCapture = networkData.networkCapture;
    session.esvp = {
      ...(session.esvp && typeof session.esvp === 'object' ? session.esvp : {}),
      currentSessionId: sessionId,
      executor,
      network: {
        ...(session?.esvp && typeof session.esvp === 'object' && session.esvp.network && typeof session.esvp.network === 'object'
          ? session.esvp.network
          : {}),
        sourceSessionId: sessionId,
        captureStatus: 'attached',
        networkSupported: typeof networkData.networkState?.supported === 'boolean' ? networkData.networkState.supported : null,
        traceKinds: networkData.traceKinds,
        traceCount: Number.isFinite(networkData.networkState?.trace_count)
          ? Number(networkData.networkState?.trace_count)
          : networkData.traceKinds.length,
        entryCount: networkData.networkEntries.length,
        managedProxy: networkData.networkState?.managed_proxy ?? session?.esvp?.network?.managedProxy ?? null,
        captureProxy: session?.esvp?.network?.captureProxy || null,
        appTraceCollector: session?.esvp?.network?.appTraceCollector || null,
        activeProfile: resolvePersistedNetworkProfile(networkData.networkState, session?.esvp?.network || null),
        effectiveProfile: resolvePersistedNetworkProfile(networkData.networkState, session?.esvp?.network || null),
        configuredAt: networkData.networkState?.configured_at || null,
        clearedAt: networkData.networkState?.cleared_at || null,
        lastError: networkData.networkState?.last_error || null,
        syncedAt: new Date().toISOString(),
      },
    };

    await writeMobileRecordingSessionData(id, session);
    await touchProjectUpdatedAt(id).catch(() => {});

    return c.json({
      success: true,
      sessionId,
      networkEntries: networkData.networkEntries,
      networkCapture: networkData.networkCapture,
      traceKinds: networkData.traceKinds,
      appTraceCollector: session.esvp?.network?.appTraceCollector || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/mobile/recordings/:id/esvp/sync-network', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const serverUrl = typeof body?.serverUrl === 'string' ? body.serverUrl.trim() : undefined;
    const session = await readMobileRecordingSessionData(id);
    const existingNetworkEntries = getStoredRecordingNetworkEntries(session);
    const existingNetworkCapture =
      session.networkCapture && typeof session.networkCapture === 'object'
        ? session.networkCapture
        : null;
    const existingESVPNetwork =
      session?.esvp && typeof session.esvp === 'object' && session.esvp.network && typeof session.esvp.network === 'object'
        ? session.esvp.network as Record<string, unknown>
        : null;
    const preferredSessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    const validation = session?.esvp && typeof session.esvp === 'object' ? session.esvp.validation : null;
    const sessionId =
      preferredSessionId ||
      (validation && typeof validation.sourceSessionId === 'string' ? validation.sourceSessionId : '') ||
      (session?.esvp && typeof session.esvp.currentSessionId === 'string' ? session.esvp.currentSessionId : '');

    if (!sessionId) {
      return c.json({ error: 'No attached ESVP session was found for network sync.' }, 400);
    }

    const networkData = await collectESVPSessionNetworkData(sessionId, serverUrl);
    const shouldPersistFreshNetwork = hasMeaningfulESVPNetworkSnapshot({
      networkEntries: networkData.networkEntries,
      traceKinds: networkData.traceKinds,
      networkState: networkData.networkState,
    });
    if (networkData.networkEntries.length > 0) {
      session.networkEntries = networkData.networkEntries;
      session.networkCapture = networkData.networkCapture;
    } else if (!existingNetworkCapture) {
      session.networkCapture = networkData.networkCapture;
    }
    session.esvp = {
      ...(session.esvp && typeof session.esvp === 'object' ? session.esvp : {}),
      ...(shouldPersistFreshNetwork
        ? {
            network: {
              ...(existingESVPNetwork || {}),
              sourceSessionId: sessionId,
              networkSupported: typeof networkData.networkState?.supported === 'boolean'
                ? networkData.networkState.supported
                : existingESVPNetwork?.networkSupported ?? null,
              traceKinds: networkData.traceKinds,
              traceCount: Number.isFinite(networkData.networkState?.trace_count)
                ? Number(networkData.networkState?.trace_count)
                : networkData.traceKinds.length,
              syncedAt: new Date().toISOString(),
              entryCount: networkData.networkEntries.length > 0 ? networkData.networkEntries.length : existingNetworkEntries.length,
              managedProxy: networkData.networkState?.managed_proxy ?? existingESVPNetwork?.managedProxy ?? null,
              captureProxy: existingESVPNetwork?.captureProxy || null,
              appTraceCollector: existingESVPNetwork?.appTraceCollector || null,
              activeProfile: resolvePersistedNetworkProfile(networkData.networkState, existingESVPNetwork),
              effectiveProfile: resolvePersistedNetworkProfile(networkData.networkState, existingESVPNetwork),
              configuredAt: networkData.networkState?.configured_at || existingESVPNetwork?.configuredAt || null,
              clearedAt: networkData.networkState?.cleared_at || existingESVPNetwork?.clearedAt || null,
              lastError: networkData.networkState?.last_error || existingESVPNetwork?.lastError || null,
            },
          }
        : existingESVPNetwork
          ? { network: existingESVPNetwork }
          : {}),
    };

    await writeMobileRecordingSessionData(id, session);
    await touchProjectUpdatedAt(id).catch(() => {});

    return c.json({
      success: true,
      sessionId,
      networkEntries: networkData.networkEntries.length > 0 ? networkData.networkEntries : existingNetworkEntries,
      networkCapture: networkData.networkEntries.length > 0 ? networkData.networkCapture : (existingNetworkCapture || networkData.networkCapture),
      traceKinds: networkData.traceKinds,
      appTraceCollector: session.esvp?.network?.appTraceCollector || null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Save edited flow code
app.put('/api/testing/mobile/recordings/:id/flow', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const { flowCode } = body;
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const flowPath = join(PROJECTS_DIR, 'maestro-recordings', id, 'test.yaml');

    writeFileSync(flowPath, flowCode, 'utf-8');

    return c.json({ success: true });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Delete mobile recording
app.delete('/api/testing/mobile/recordings/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { rmSync } = await import('node:fs');
    const { join } = await import('node:path');

    const recordingDir = join(PROJECTS_DIR, 'maestro-recordings', id);

    if (!existsSync(recordingDir)) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    // Delete the recording directory
    rmSync(recordingDir, { recursive: true, force: true });

    // Also delete associated project from database (same ID is used)
    const db = getDatabase();
    await db.delete(projects).where(eq(projects.id, id));
    await db.delete(frames).where(eq(frames.projectId, id));
    await deleteTestVariablesForOwner('mobile-recording', id);
    await deleteTestVariablesForOwner('project', id);

    console.log(`[Delete] Removed mobile recording and project: ${id}`);

    return c.json({ success: true });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get mobile replay run status (for UI polling)
app.get('/api/testing/mobile/replays/:runId', async (c) => {
  try {
    const runId = String(c.req.param('runId') || '').trim();
    if (!runId) return c.json({ error: 'Run ID is required' }, 400);
    pruneMobileReplayRuns();
    const run = mobileReplayRuns.get(runId);
    if (!run) return c.json({ error: 'Replay run not found' }, 404);
    const now = Date.now();
    return c.json({
      ...run,
      elapsedMs: (run.finishedAt ?? now) - run.createdAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Stop a running mobile replay (best-effort: kills local Maestro processes)
app.post('/api/testing/mobile/replays/:runId/stop', async (c) => {
  try {
    const runId = String(c.req.param('runId') || '').trim();
    if (!runId) return c.json({ error: 'Run ID is required' }, 400);
    pruneMobileReplayRuns();
    const run = mobileReplayRuns.get(runId);
    if (!run) return c.json({ error: 'Replay run not found' }, 404);

    if (run.status !== 'running') {
      return c.json({
        success: false,
        error: `Run is already ${run.status}`,
        run,
      }, 409);
    }

    const now = Date.now();
    run.status = 'canceled';
    run.updatedAt = now;
    run.finishedAt = now;
    run.durationMs = now - run.createdAt;
    run.error = 'Run canceled by user';
    run.output = run.output || 'Run canceled by user';
    mobileReplayRuns.set(runId, run);

    try {
      await killZombieMaestroProcesses();
    } catch {}

    return c.json({ success: true, run });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Replay mobile recording with Maestro
app.post('/api/testing/mobile/recordings/:id/replay', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const requestedDeviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
    const requestedDeviceName = typeof body?.deviceName === 'string' ? body.deviceName.trim() : '';
    const requestedDevicePlatform = body?.devicePlatform === 'ios' || body?.devicePlatform === 'android'
      ? body.devicePlatform
      : undefined;
    const skipDeviceValidation = body?.skipDeviceValidation === true;
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const flowPath = join(PROJECTS_DIR, 'maestro-recordings', id, 'test.yaml');

    if (!existsSync(flowPath)) {
      return c.json({ error: 'Flow file not found' }, 404);
    }

    const flowCode = readFileSync(flowPath, 'utf-8');
    const resolvedVars = await resolveExecutionVariablesForScript({
      ownerType: 'mobile-recording',
      ownerId: id,
      platform: 'mobile',
      code: flowCode,
    });

    if (resolvedVars.missingKeys.length > 0) {
      return c.json({
        error: 'Missing required test variables',
        missingKeys: resolvedVars.missingKeys,
        placeholders: resolvedVars.placeholders,
        usedKeys: resolvedVars.usedKeys,
      }, 400);
    }

    let targetDeviceId: string | undefined;
    let targetDeviceName: string | undefined;
    let targetDevicePlatform: 'ios' | 'android' | undefined;
    let deviceSelectionSource: 'auto' | 'validated' | 'trusted-client' = 'auto';
    if (requestedDeviceId) {
      if (skipDeviceValidation && requestedDevicePlatform) {
        targetDeviceId = requestedDeviceId;
        targetDeviceName = requestedDeviceName || requestedDeviceId;
        targetDevicePlatform = requestedDevicePlatform;
        deviceSelectionSource = 'trusted-client';
      } else {
        const devices = await listMaestroDevices();
        const match = devices.find((device) => device.id === requestedDeviceId);
        if (!match) {
          return c.json({
            error: 'Selected device is not currently available',
            deviceId: requestedDeviceId,
            availableDevices: devices,
          }, 400);
        }
        targetDeviceId = match.id;
        targetDeviceName = match.name;
        targetDevicePlatform = match.platform;
        deviceSelectionSource = 'validated';
      }
    }
    // Use UDID/serial when available (iOS + Android). This is the most stable identifier
    // and avoids Maestro mismatches with shortened simulator names in some environments.
    const maestroDeviceArg = targetDeviceId || targetDeviceName;

    const runId = `mrun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();
    mobileReplayRuns.set(runId, {
      runId,
      recordingId: id,
      status: 'running',
      flowPath,
      usedKeys: resolvedVars.usedKeys,
      deviceId: targetDeviceId || null,
      deviceName: targetDeviceName || null,
      devicePlatform: targetDevicePlatform || null,
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
      durationMs: null,
      error: null,
      output: null,
    });
    pruneMobileReplayRuns();

    void runMaestroTest({
      flowPath,
      device: maestroDeviceArg,
      env: resolvedVars.envMap,
      timeout: 300000,
    }).then((result) => {
      const now = Date.now();
      const existingRun = mobileReplayRuns.get(runId);
      if (existingRun) {
        const wasCanceled = existingRun.status === 'canceled';
        if (!wasCanceled) {
          existingRun.status = result.success ? 'completed' : 'failed';
          existingRun.error = result.success ? null : (result.error || result.output || 'Maestro test failed');
        }
        existingRun.updatedAt = now;
        existingRun.finishedAt = existingRun.finishedAt ?? now;
        existingRun.durationMs = typeof result.duration === 'number' ? result.duration : now - existingRun.createdAt;
        existingRun.output = typeof result.output === 'string' ? result.output.slice(-12000) : null;
        mobileReplayRuns.set(runId, existingRun);
      }
      if (!result.success) {
        console.error('[Maestro Replay] Failed:', result.error || result.output || 'unknown error');
      } else {
        console.log('[Maestro Replay] Completed:', {
          flowPath,
          duration: result.duration,
          usedKeys: resolvedVars.usedKeys,
          deviceId: targetDeviceId,
          maestroDeviceArg,
        });
      }
    }).catch((runError) => {
      const now = Date.now();
      const existingRun = mobileReplayRuns.get(runId);
      if (existingRun) {
        const wasCanceled = existingRun.status === 'canceled';
        if (!wasCanceled) {
          existingRun.status = 'failed';
          existingRun.error = runError instanceof Error ? runError.message : String(runError);
        }
        existingRun.updatedAt = now;
        existingRun.finishedAt = existingRun.finishedAt ?? now;
        existingRun.durationMs = now - existingRun.createdAt;
        existingRun.output = existingRun.error;
        mobileReplayRuns.set(runId, existingRun);
      }
      console.error('[Maestro Replay] Unexpected error:', runError);
    });

    return c.json({
      success: true,
      message: 'Maestro test started',
      flowPath,
      usedKeys: resolvedVars.usedKeys,
      envTest: resolvedVars.envTestText,
      runId,
      runStatus: 'running',
      deviceId: targetDeviceId || null,
      deviceName: targetDeviceName || null,
      devicePlatform: targetDevicePlatform || null,
      maestroDeviceArg: maestroDeviceArg || null,
      deviceSelectionSource,
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// AUTO-CAPTURE API - Automatic screenshot capture during test execution
// ============================================================================

// State for auto-capture
let autoCaptureInterval: NodeJS.Timeout | null = null;
let autoCaptureRecordingId: string | null = null;
let autoCaptureScreenshotCount = 0;

// Start auto-capture for a test run
app.post('/api/testing/mobile/auto-capture/start', async (c) => {
  try {
    const { recordingId, platform } = await c.req.json();
    const { join } = await import('node:path');
    const { mkdirSync, existsSync: fsExistsSync, writeFileSync } = await import('node:fs');

    if (!recordingId) {
      return c.json({ error: 'recordingId required' }, 400);
    }

    // Stop any existing auto-capture
    if (autoCaptureInterval) {
      clearInterval(autoCaptureInterval);
      autoCaptureInterval = null;
    }

    autoCaptureRecordingId = recordingId;
    autoCaptureScreenshotCount = 0;

    // Ensure screenshots directory exists
    const screenshotsDir = join(PROJECTS_DIR, 'maestro-recordings', recordingId, 'screenshots');
    if (!fsExistsSync(screenshotsDir)) {
      mkdirSync(screenshotsDir, { recursive: true });
    }

    // Capture screenshots every 2 seconds during test execution
    const { promisify } = await import('node:util');
    const execCaptureAsync = promisify(exec);

    autoCaptureInterval = setInterval(async () => {
      try {
        const screenshotPath = join(screenshotsDir, `auto_${Date.now()}_${autoCaptureScreenshotCount}.png`);
        autoCaptureScreenshotCount++;

        if (platform === 'ios') {
          await execCaptureAsync(`xcrun simctl io booted screenshot "${screenshotPath}"`, { timeout: 5000 });
        } else {
          const adbPath = ADB_PATH || 'adb';
          // For Android, capture to device then pull
          await execCaptureAsync(`"${adbPath}" shell screencap -p /sdcard/auto_capture.png && "${adbPath}" pull /sdcard/auto_capture.png "${screenshotPath}"`, { timeout: 5000 });
        }

        console.log(`[AutoCapture] Screenshot ${autoCaptureScreenshotCount}: ${screenshotPath}`);
      } catch (err) {
        console.log('[AutoCapture] Screenshot capture failed:', err);
      }
    }, 2000);

    // Auto-stop after 60 seconds max
    setTimeout(() => {
      if (autoCaptureInterval && autoCaptureRecordingId === recordingId) {
        clearInterval(autoCaptureInterval);
        autoCaptureInterval = null;
        console.log(`[AutoCapture] Auto-stopped after 60s for ${recordingId}`);
      }
    }, 60000);

    return c.json({
      success: true,
      message: 'Auto-capture started',
      recordingId,
      screenshotsDir
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Stop auto-capture
app.post('/api/testing/mobile/auto-capture/stop', async (c) => {
  try {
    const { recordingId } = await c.req.json();
    const { join } = await import('node:path');
    const { readdirSync, existsSync: fsExistsSync } = await import('node:fs');

    if (autoCaptureInterval) {
      clearInterval(autoCaptureInterval);
      autoCaptureInterval = null;
    }

    const stoppedId = autoCaptureRecordingId;
    const screenshotsCaptured = autoCaptureScreenshotCount;
    autoCaptureRecordingId = null;
    autoCaptureScreenshotCount = 0;

    // Count actual screenshots saved
    let savedScreenshots = 0;
    if (stoppedId) {
      const screenshotsDir = join(PROJECTS_DIR, 'maestro-recordings', stoppedId, 'screenshots');
      if (fsExistsSync(screenshotsDir)) {
        savedScreenshots = readdirSync(screenshotsDir).filter(f => f.endsWith('.png')).length;
      }
    }

    console.log(`[AutoCapture] Stopped for ${stoppedId || recordingId}, ${savedScreenshots} screenshots saved`);

    return c.json({
      success: true,
      message: 'Auto-capture stopped',
      recordingId: stoppedId || recordingId,
      screenshotsCaptured,
      savedScreenshots
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// MOBILE CHAT API - AI-powered device navigation
// ============================================================================

// Simple LLM provider interface
interface LLMProvider {
  name: string;
  sendMessage: (prompt: string) => Promise<string>;
}

const CLAUDE_CLI_TIMEOUT_MS = 90_000;
const MOBILE_CHAT_LLM_TIMEOUT_MS = 45_000;
let claudeCliAvailableCache: boolean | null = null;

function getConfiguredClaudeCliModel(): string {
  const model = llmSettings.claudeCliModel || process.env.CLAUDE_CLI_MODEL || 'haiku';
  return typeof model === 'string' && model.trim() ? model.trim() : 'haiku';
}

function isClaudeCliAvailable(): boolean {
  if (claudeCliAvailableCache === true) {
    return claudeCliAvailableCache;
  }
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 3000 });
    claudeCliAvailableCache = true;
    return true;
  } catch {
    // Don't cache negative results - PATH and auth can change at runtime
    claudeCliAvailableCache = null;
    return false;
  }
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function runClaudeCliWithArgs(
  prompt: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tempDir = await mkdtemp(join(tmpdir(), 'claude-cli-'));
  const promptPath = join(tempDir, 'prompt.txt');
  const stdoutPath = join(tempDir, 'stdout.txt');
  const stderrPath = join(tempDir, 'stderr.txt');

  await writeFile(promptPath, prompt, 'utf8');

  const quotedArgs = args.map(arg => shellQuote(arg)).join(' ');
  const shellScript = [
    'set -euo pipefail',
    `prompt=$(cat ${shellQuote(promptPath)})`,
    `claude ${quotedArgs} "$prompt" > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}`
  ].join('\n');

  let didTimeout = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  const child = spawn('bash', ['-lc', shellScript], {
    stdio: 'inherit',
    env: { ...process.env },
  });

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        didTimeout = true;
        try {
          child.kill('SIGTERM');
        } catch {}
      }, timeoutMs);

      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }

    const [stdoutTextRaw, stderrTextRaw] = await Promise.all([
      readFile(stdoutPath, 'utf8').catch(() => ''),
      readFile(stderrPath, 'utf8').catch(() => ''),
    ]);
    return {
      stdout: stdoutTextRaw.trim(),
      stderr: stderrTextRaw.trim(),
      exitCode,
      timedOut: didTimeout,
    };
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

async function runClaudeCli(prompt: string): Promise<string> {
  const claudeCliModel = getConfiguredClaudeCliModel();
  const args = [
    '-p',
    '--model',
    claudeCliModel,
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
  ];

  const result = await runClaudeCliWithArgs(prompt, args, CLAUDE_CLI_TIMEOUT_MS);

  if (result.timedOut) {
    throw new Error(`Claude CLI timeout (${Math.round(CLAUDE_CLI_TIMEOUT_MS / 1000)}s).`);
  }

  if (result.stderr) {
    const truncated = result.stderr.length > 400 ? `${result.stderr.slice(0, 400)}...` : result.stderr;
    console.log('[Claude CLI stderr]', truncated);
  }

  if (result.exitCode !== 0 && !result.stdout) {
    const detail = result.stderr || `exit code ${result.exitCode ?? 'unknown'}`;
    const truncated = detail.length > 400 ? `${detail.slice(0, 400)}...` : detail;
    throw new Error(`Claude CLI error: ${truncated}`);
  }

  return result.stdout || result.stderr;
}

// Helper functions to create individual LLM providers
function createAnthropicProvider(): LLMProvider | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;
  const anthropicModel = llmSettings.anthropicModel || 'claude-sonnet-4-6';
  return {
    name: `anthropic-api (${anthropicModel})`,
    sendMessage: async (prompt: string) => {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await response.json() as { content?: Array<{ text?: string }> };
      return data.content?.[0]?.text || '';
    }
  };
}

function createOpenAIProvider(): LLMProvider | null {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return null;
  const openaiModel = llmSettings.openaiModel || 'gpt-5.2';
  return {
    name: `openai-api (${openaiModel})`,
    sendMessage: async (prompt: string) => {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
          model: openaiModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024
        })
      });
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content || '';
    }
  };
}

function createClaudeCliProvider(): LLMProvider | null {
  if (!isClaudeCliAvailable()) return null;
  return {
    name: 'claude-cli (local)',
    sendMessage: runClaudeCli,
  };
}

const CLAUDE_CLI_VISION_TIMEOUT_MS = 120_000;

/**
 * Run Claude CLI with Read tool enabled so it can view image files.
 * Uses --allowedTools to permit only the Read tool.
 */
async function runClaudeCliVision(prompt: string, imagePaths: string[]): Promise<string> {
  const claudeCliModel = getConfiguredClaudeCliModel();
  // Build a prompt that instructs Claude to read and analyze the screenshot files
  const fileList = imagePaths.map(p => `  - ${p}`).join('\n');
  const fullPrompt = `Read and analyze these screenshot image files in order, then follow the instructions below.

Screenshot files (read each one):
${fileList}

Instructions:
${prompt}`;

  const args = [
    '-p',
    '--model',
    claudeCliModel,
    '--allowedTools', 'Read',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
  ];

  const result = await runClaudeCliWithArgs(fullPrompt, args, CLAUDE_CLI_VISION_TIMEOUT_MS);

  if (result.timedOut) {
    throw new Error(`Claude CLI vision timeout (${Math.round(CLAUDE_CLI_VISION_TIMEOUT_MS / 1000)}s).`);
  }

  if (result.stderr) {
    const truncated = result.stderr.length > 400 ? `${result.stderr.slice(0, 400)}...` : result.stderr;
    console.log('[Claude CLI Vision stderr]', truncated);
  }

  if (result.exitCode !== 0 && !result.stdout) {
    const detail = result.stderr || `exit code ${result.exitCode ?? 'unknown'}`;
    const truncated = detail.length > 400 ? `${detail.slice(0, 400)}...` : detail;
    throw new Error(`Claude CLI vision error: ${truncated}`);
  }

  return result.stdout || result.stderr;
}

/**
 * Create a vision-capable provider for AI action detection using Claude CLI.
 */
function createClaudeCliVisionProvider(): ActionDetectorProvider | null {
  if (!isClaudeCliAvailable()) return null;
  const claudeCliModel = getConfiguredClaudeCliModel();
  return {
    name: `claude-cli (vision, ${claudeCliModel})`,
    sendMessageWithImages: runClaudeCliVision,
  };
}

const OLLAMA_TAGS_TIMEOUT_MS = 3_000;
const OLLAMA_GENERATE_TIMEOUT_MS = 120_000;
const OLLAMA_VISION_GENERATE_TIMEOUT_MS = 180_000;
const DEFAULT_OLLAMA_TEXT_MODEL = 'qwen2.5-coder:7b';
const DEFAULT_OLLAMA_VISION_MODEL = 'qwen2.5vl:7b';

type OllamaModelInfo = {
  name: string;
  size?: number;
  modified_at?: string;
};

type OllamaStatusSnapshot = {
  running: boolean;
  ollamaUrl: string;
  selectedModel: string;
  selectedModelAvailable: boolean;
  models: OllamaModelInfo[];
  error?: string;
};

function normalizeOllamaUrl(input: string | undefined | null): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return 'http://localhost:11434';
  return raw.replace(/\/+$/, '');
}

function normalizeOllamaModelName(input: string | undefined | null): string {
  const raw = typeof input === 'string' ? input.trim().toLowerCase() : '';
  return raw;
}

function getConfiguredOllamaTextModel(): string {
  const model = (llmSettings.ollamaModel || DEFAULT_OLLAMA_TEXT_MODEL).trim();
  return model || DEFAULT_OLLAMA_TEXT_MODEL;
}

function getConfiguredOllamaVisionModel(): string {
  const model = (llmSettings.ollamaVisionModel || DEFAULT_OLLAMA_VISION_MODEL).trim();
  return model || DEFAULT_OLLAMA_VISION_MODEL;
}

function matchesOllamaModel(installedName: string, selectedModel: string): boolean {
  const installed = normalizeOllamaModelName(installedName);
  const selected = normalizeOllamaModelName(selectedModel);
  if (!installed || !selected) return false;
  if (installed === selected) return true;
  const installedBase = installed.split(':')[0];
  const selectedBase = selected.split(':')[0];
  return installedBase === selectedBase;
}

async function fetchOllamaStatusSnapshot(
  requestedUrl?: string,
  requestedModel?: string,
  timeoutMs = OLLAMA_TAGS_TIMEOUT_MS
): Promise<OllamaStatusSnapshot> {
  const ollamaUrl = normalizeOllamaUrl(requestedUrl || llmSettings.ollamaUrl);
  const selectedModel = (requestedModel || getConfiguredOllamaTextModel()).trim() || DEFAULT_OLLAMA_TEXT_MODEL;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        running: false,
        ollamaUrl,
        selectedModel,
        selectedModelAvailable: false,
        models: [],
        error: `Ollama not responding (HTTP ${response.status})`,
      };
    }

    const data = await response.json().catch(() => ({} as { models?: OllamaModelInfo[] })) as { models?: OllamaModelInfo[] };
    const models = Array.isArray(data.models) ? data.models : [];
    const selectedModelAvailable = models.some((m) => typeof m?.name === 'string' && matchesOllamaModel(m.name, selectedModel));

    return {
      running: true,
      ollamaUrl,
      selectedModel,
      selectedModelAvailable,
      models,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ollama not available';
    const isAbort = error instanceof Error && error.name === 'AbortError';
    return {
      running: false,
      ollamaUrl,
      selectedModel,
      selectedModelAvailable: false,
      models: [],
      error: isAbort
        ? `Ollama timeout after ${Math.round(timeoutMs / 1000)}s`
        : message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function createOllamaProvider(): Promise<LLMProvider | null> {
  try {
    const snapshot = await fetchOllamaStatusSnapshot(undefined, getConfiguredOllamaTextModel());
    if (!snapshot.running || snapshot.models.length === 0 || !snapshot.selectedModelAvailable) {
      return null;
    }

    const ollamaUrl = snapshot.ollamaUrl;
    const ollamaModel = snapshot.selectedModel;

    return {
      name: `ollama (${ollamaModel})`,
      sendMessage: async (prompt: string) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), OLLAMA_GENERATE_TIMEOUT_MS);

        try {
          const resp = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: ollamaModel,
              prompt,
              stream: false
            })
          });

          const rawText = await resp.text();
          let data: { response?: string; error?: string } = {};
          try {
            data = rawText ? JSON.parse(rawText) as { response?: string; error?: string } : {};
          } catch {
            data = {};
          }

          if (!resp.ok) {
            const detail = data.error || rawText || `HTTP ${resp.status}`;
            throw new Error(`Ollama generate failed (${resp.status}): ${String(detail).slice(0, 300)}`);
          }

          if (typeof data.error === 'string' && data.error.trim()) {
            throw new Error(`Ollama generate error: ${data.error}`);
          }

          if (typeof data.response !== 'string') {
            throw new Error('Ollama generate returned invalid response payload');
          }

          return data.response;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Ollama generate timeout (${Math.round(OLLAMA_GENERATE_TIMEOUT_MS / 1000)}s).`);
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }
      }
    };
  } catch {
    return null;
  }
}

function isLikelyVisionCapableOllamaModel(modelName: string): boolean {
  const normalized = normalizeOllamaModelName(modelName);
  if (!normalized) return false;
  return /(vision|vl\b|llava|bakllava|moondream|gemma3|minicpm-v|qwen2\.5vl|qwen2-vl)/.test(normalized);
}

async function createOllamaVisionProvider(): Promise<ActionDetectorProvider | null> {
  try {
    const visionModel = getConfiguredOllamaVisionModel();
    const snapshot = await fetchOllamaStatusSnapshot(undefined, visionModel);
    if (!snapshot.running || snapshot.models.length === 0 || !snapshot.selectedModelAvailable) {
      return null;
    }

    const ollamaUrl = snapshot.ollamaUrl;
    const ollamaModel = snapshot.selectedModel;

    if (!isLikelyVisionCapableOllamaModel(ollamaModel)) {
      console.warn(`[Ollama Vision] Selected model "${ollamaModel}" may not support vision; continuing because it is user-configured.`);
    }

    return {
      name: `ollama-vision (${ollamaModel})`,
      sendMessageWithImages: async (prompt: string, imagePaths: string[]) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), OLLAMA_VISION_GENERATE_TIMEOUT_MS);

        try {
          const images = imagePaths.map((imagePath) => readFileSync(imagePath).toString('base64'));
          const resp = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              model: ollamaModel,
              prompt,
              images,
              format: 'json',
              stream: false,
              options: {
                temperature: 0
              }
            })
          });

          const rawText = await resp.text();
          let data: { response?: string; error?: string } = {};
          try {
            data = rawText ? JSON.parse(rawText) as { response?: string; error?: string } : {};
          } catch {}

          if (!resp.ok) {
            const detail = data.error || rawText || `HTTP ${resp.status}`;
            throw new Error(`Ollama vision generate failed (${resp.status}): ${String(detail).slice(0, 400)}`);
          }
          if (typeof data.error === 'string' && data.error.trim()) {
            throw new Error(`Ollama vision generate error: ${data.error}`);
          }
          if (typeof data.response !== 'string' || !data.response.trim()) {
            throw new Error('Ollama vision generate returned empty response');
          }

          return data.response;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`Ollama vision timeout (${Math.round(OLLAMA_VISION_GENERATE_TIMEOUT_MS / 1000)}s).`);
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }
      }
    };
  } catch {
    return null;
  }
}

async function getActionDetectionVisionProviders(): Promise<ActionDetectorProvider[]> {
  const providers: ActionDetectorProvider[] = [];
  const preferOllamaVision = llmSettings.preferOllamaVisionForActionDetection === true;
  const ollamaVision = await createOllamaVisionProvider();
  const claudeCliVision = createClaudeCliVisionProvider();

  if (preferOllamaVision) {
    if (ollamaVision) providers.push(ollamaVision);
    if (claudeCliVision) providers.push(claudeCliVision);
  } else {
    if (claudeCliVision) providers.push(claudeCliVision);
    if (ollamaVision) providers.push(ollamaVision);
  }

  if (providers.length > 0) {
    console.log(`[AIActionDetector] Vision provider fallback order: ${providers.map(p => p.name).join(' -> ')}`);
  }

  return providers;
}

// Get configured LLM provider (prioritize preferred provider, then fallback to priority order)
async function getLLMProvider(): Promise<LLMProvider | null> {
  try {
    const preferred = llmSettings.preferredProvider;

    // If a preferred provider is set (not 'auto'), try it first
    if (preferred && preferred !== 'auto') {
      let provider: LLMProvider | null = null;
      switch (preferred) {
        case 'anthropic': provider = createAnthropicProvider(); break;
        case 'openai': provider = createOpenAIProvider(); break;
        case 'claude-cli': provider = createClaudeCliProvider(); break;
        case 'ollama': provider = await createOllamaProvider(); break;
      }
      if (provider) return provider;
      // Preferred not available, fall through to auto order
    }

    // Auto priority order: Anthropic → OpenAI → Ollama → Claude CLI
    const anthropic = createAnthropicProvider();
    if (anthropic) return anthropic;

    const openai = createOpenAIProvider();
    if (openai) return openai;

    const ollama = await createOllamaProvider();
    if (ollama) return ollama;

    const claudeCli = createClaudeCliProvider();
    if (claudeCli) return claudeCli;

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// BACKGROUND OCR & APP INTELLIGENCE ANALYSIS
// ============================================================================

type AppIntelligenceContext = 'mobile' | 'web';

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function buildAppIntelligencePrompt(context: AppIntelligenceContext, ocrText: string): string {
  const truncatedText = ocrText.slice(0, 8000);

  if (context === 'web') {
    return `Analyze the following OCR text extracted from web application screenshots/pages. Provide a structured analysis in Markdown format focused on QA and product review.

OCR TEXT:
${truncatedText}

Please provide your analysis in the following format:

## Page / App Overview
Brief 2-3 sentence description of what this web experience appears to be.

## Key UI Elements
- List important buttons, labels, forms, tables, menus, and navigation items
- Focus on actionable and testable elements

## Likely User Flow
1. Describe the apparent user journey through the pages
2. Number each step clearly

## Content Summary
| Category | Examples |
|----------|----------|
| Navigation | menus, tabs, breadcrumbs |
| Actions | primary buttons and CTAs |
| Forms & Inputs | fields, filters, search |
| Data & Views | tables, cards, lists, charts |

## QA Observations
- Potential edge cases
- Areas that deserve deeper testing

Keep your analysis concise and actionable for QA testing purposes.`;
  }

  return `Analyze the following OCR text extracted from mobile app screenshots. Provide a structured analysis in Markdown format.

OCR TEXT:
${truncatedText}

Please provide your analysis in the following format:

## App Overview
Brief 2-3 sentence description of what this app appears to be.

## UI Elements Found
- List key buttons, labels, and navigation items
- Focus on actionable elements

## User Flow
1. Describe the apparent user journey
2. Number each step

## Content Summary
| Category | Examples |
|----------|----------|
| Labels | key labels found |
| Actions | buttons/actions available |
| Navigation | menu items, tabs |

## Observations
- Any notable UX patterns
- Potential areas of interest for testing

Keep your analysis concise and actionable for QA testing purposes.`;
}

// Generate App Intelligence summary using LLM with markdown formatting
async function generateAppIntelligenceSummary(
  provider: LLMProvider,
  ocrText: string,
  context: AppIntelligenceContext
): Promise<{ summary: string; ok: boolean; providerName: string; error?: string }> {
  const prompt = buildAppIntelligencePrompt(context, ocrText);
  const providerName = provider?.name || 'unknown-provider';

  try {
    const response = await provider.sendMessage(prompt);
    const normalized = typeof response === 'string' ? response.trim() : '';
    if (!normalized) {
      const errorMessage = 'Provider returned empty response';
      console.error(`[AppIntelligence] ${context} summary generation failed via ${providerName}: ${errorMessage}`);
      return {
        summary: `Summary generation failed (${providerName})`,
        ok: false,
        providerName,
        error: errorMessage,
      };
    }
    return {
      summary: normalized,
      ok: true,
      providerName,
    };
  } catch (error) {
    const errorMessage = formatErrorMessage(error);
    console.error(`[AppIntelligence] ${context} summary generation failed via ${providerName}: ${errorMessage}`, error);
    return {
      summary: `Summary generation failed (${providerName})`,
      ok: false,
      providerName,
      error: errorMessage,
    };
  }
}

// Background OCR processing - runs asynchronously after recording stops
async function runOCRInBackground(
  projectId: string,
  screenshotsDir: string,
  screenshotFiles: string[]
): Promise<void> {
  console.log(`[BackgroundOCR] Starting analysis for project ${projectId} with ${screenshotFiles.length} screenshots`);

  const broadcastProgress = (
    step: string,
    status: AnalysisStepStatus,
    detail?: string,
    error?: string,
    completedUnits?: number | null,
    totalUnits?: number | null
  ) => {
    setProjectAnalysisProgress({
      projectId,
      flow: 'mobile',
      step,
      status,
      detail,
      error,
      completedUnits,
      totalUnits,
    });
  };

  try {
    const { recognizeTextBatch } = await import('../core/analyze/ocr.js');
    const { join } = await import('node:path');

    // Step 1: OCR
    broadcastProgress('ocr', 'running', `Processing 0/${screenshotFiles.length} screenshots...`, undefined, 0, screenshotFiles.length);

    const fullPaths = screenshotFiles.map(f => join(screenshotsDir, f));
    const ocrResult = await recognizeTextBatch(
      fullPaths,
      { recognitionLevel: 'accurate' },
      (progress) => {
        broadcastProgress(
          'ocr',
          'running',
          `Processing ${progress.current}/${progress.total} screenshots...`,
          undefined,
          progress.current,
          progress.total
        );
      }
    );

    let ocrText = '';
    let aiSummary = '';

    const ocrEngines = new Set<string>();
    const ocrConfidences: number[] = [];
    for (const result of ocrResult.results || []) {
      if (result.ocr?.engine) {
        ocrEngines.add(result.ocr.engine);
      }
      if (typeof result.ocr?.confidence === 'number') {
        ocrConfidences.push(result.ocr.confidence);
      }
    }

    const ocrEngine = ocrEngines.has('vision')
      ? 'vision'
      : ocrEngines.has('tesseract')
        ? 'tesseract'
        : null;
    const ocrConfidence = ocrConfidences.length > 0
      ? ocrConfidences.reduce((sum, value) => sum + value, 0) / ocrConfidences.length
      : null;

    if (ocrResult.success && ocrResult.totalText) {
      ocrText = ocrResult.totalText;
      console.log(`[BackgroundOCR] Extracted ${ocrText.length} characters from ${fullPaths.length} screenshots`);
      broadcastProgress('ocr', 'done', `Extracted ${ocrText.length} characters`, undefined, fullPaths.length, fullPaths.length);

      // Step 2: AI Summary
      broadcastProgress('summary', 'running', 'Connecting to LLM provider...');
      const provider = await getLLMProvider();
      if (provider) {
        console.log(`[BackgroundOCR] Generating App Intelligence summary with ${provider.name}...`);
        broadcastProgress('summary', 'running', `Using ${provider.name}...`);
        const summaryResult = await generateAppIntelligenceSummary(provider, ocrText, 'mobile');
        aiSummary = summaryResult.summary;
        if (summaryResult.ok) {
          console.log(`[BackgroundOCR] Generated ${aiSummary.length} character summary`);
          broadcastProgress('summary', 'done', `Generated ${aiSummary.length} character summary`);
        } else {
          const detail = summaryResult.error
            ? `${summaryResult.providerName}: ${summaryResult.error}`
            : `Provider failed: ${summaryResult.providerName}`;
          console.warn(`[BackgroundOCR] App Intelligence summary failed via ${summaryResult.providerName}: ${summaryResult.error || 'unknown error'}`);
          broadcastProgress('summary', 'failed', 'Summary generation failed', detail);
        }
      } else {
        const words = ocrText.split(/\s+/).filter(w => w.length > 2);
        const uniqueWords = [...new Set(words.map(w => w.toLowerCase()))];
        const topWords = uniqueWords.slice(0, 20).join(', ');
        aiSummary = `Analyzed ${fullPaths.length} screenshots. Found ${words.length} words.\n\n**Key terms:** ${topWords || 'none detected'}\n\n*Note: Configure ANTHROPIC_API_KEY or OPENAI_API_KEY for enhanced AI analysis.*`;
        broadcastProgress('summary', 'done', 'No LLM provider — used word frequency fallback');
      }
    } else {
      aiSummary = `Analyzed ${fullPaths.length} screenshots. No text detected via OCR.`;
      console.log('[BackgroundOCR] No text found in screenshots');
      broadcastProgress('ocr', 'done', 'No text detected', undefined, fullPaths.length, fullPaths.length);
      broadcastProgress('summary', 'skipped', 'Skipped — no text to analyze');
    }

    // Step 3: AI Action Detection
    let detectedActionsCount = 0;
    if (screenshotFiles.length >= 2) {
      try {
        broadcastProgress('actions', 'running', 'Detecting user actions from screenshots...');
        const visionProviders = await getActionDetectionVisionProviders();
        const analysisResult = await analyzeScreenshotsForActions(
          screenshotsDir,
          20,
          visionProviders.length > 0 ? visionProviders : undefined
        );

        if (analysisResult.actions.length > 0) {
          const maestroYaml = generateMaestroYaml(
            analysisResult.actions,
            undefined,
            analysisResult.appName,
            analysisResult.actionDetectionProvider
          );

          // Write YAML to test.yaml in the recording directory (parent of screenshots)
          const { writeFileSync } = await import('node:fs');
          const recordingDir = join(screenshotsDir, '..');
          const flowPath = join(recordingDir, 'test.yaml');
          writeFileSync(flowPath, maestroYaml, 'utf-8');

          detectedActionsCount = analysisResult.actions.length;
          console.log(`[BackgroundOCR] AI detected ${detectedActionsCount} actions, YAML saved to ${flowPath}`);
          broadcastProgress('actions', 'done', `Detected ${detectedActionsCount} actions`);
        } else {
          const actionDetectionFailed = typeof analysisResult.summary === 'string'
            && analysisResult.summary.startsWith('AI analysis failed:');
          console.log('[BackgroundOCR] AI action detection returned 0 actions, keeping fallback YAML');
          if (actionDetectionFailed) {
            broadcastProgress('actions', 'failed', 'Action detection failed — kept fallback YAML', analysisResult.summary);
          } else {
            broadcastProgress('actions', 'done', 'No actions detected — kept fallback YAML');
          }
        }
      } catch (actionError) {
        console.warn('[BackgroundOCR] AI action detection failed, keeping fallback YAML:', actionError);
        broadcastProgress('actions', 'skipped', 'Action detection failed — kept fallback YAML');
      }
    } else {
      broadcastProgress('actions', 'skipped', 'Not enough screenshots for action detection');
    }

    const recordingDir = join(screenshotsDir, '..');
    let iconCoverPath: string | null = null;
    try {
      const sessionPath = join(recordingDir, 'session.json');
      if (existsSync(sessionPath)) {
        const sessionData = JSON.parse(readFileSync(sessionPath, 'utf8'));
        if (
          (sessionData?.platform === 'ios' || sessionData?.platform === 'android')
          && typeof sessionData?.deviceId === 'string'
        ) {
          iconCoverPath = await createMobileAppIconCover({
            platform: sessionData.platform,
            deviceId: sessionData.deviceId,
            appId: typeof sessionData.appId === 'string' ? sessionData.appId : null,
            outputDir: recordingDir,
            adbPath: ADB_PATH,
          });
        }
      }
    } catch (iconError) {
      console.warn('[BackgroundOCR] Mobile icon cover generation failed:', iconError);
    }

    // Step 4: Save
    broadcastProgress('save', 'running', 'Saving results to database...');

    const db = getDatabase();
    // Auto-generate marketing title from raw project name
    const [currentProject] = await db.select({ name: projects.name, tags: projects.tags }).from(projects).where(eq(projects.id, projectId)).limit(1);
    const autoMarketingTitle = currentProject ? (cleanProjectTitle(currentProject.name) || currentProject.name) : undefined;

    // Auto-generate contextual tags from AI summary for knowledge search
    let autoTags: string[] = [];
    if (aiSummary) {
      const tagKeywords = new Set<string>();
      // Extract screen/flow names from summary
      const flowSteps = aiSummary.match(/^\d+\.\s+(.+)$/gm) || [];
      for (const step of flowSteps.slice(0, 5)) {
        const clean = step.replace(/^\d+\.\s+/, '').toLowerCase();
        // Extract key nouns: "Opens login screen" → "login"
        const words = clean.split(/\s+/).filter(w => w.length > 3 && !['user', 'taps', 'opens', 'clicks', 'enters', 'scrolls', 'navigates', 'views', 'sees', 'goes', 'back', 'into', 'with', 'from', 'screen', 'page'].includes(w));
        words.forEach(w => tagKeywords.add(w));
      }
      // Extract from headings
      const headingTerms = aiSummary.match(/## .+/g) || [];
      for (const h of headingTerms) {
        const words = h.replace(/^## /, '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
        words.forEach(w => tagKeywords.add(w));
      }
      autoTags = [...tagKeywords].slice(0, 10);
    }

    // Merge with existing tags
    let mergedTags: string[] = autoTags;
    if (currentProject?.tags) {
      try {
        const existing = JSON.parse(currentProject.tags) as string[];
        const combined = new Set([...existing, ...autoTags]);
        mergedTags = [...combined];
      } catch { /* use auto only */ }
    }

    await db.update(projects).set({
      status: 'analyzed',
      ocrText: ocrText || null,
      ocrEngine,
      ocrConfidence,
      aiSummary,
      frameCount: detectedActionsCount > 0 ? detectedActionsCount : undefined,
      ...(iconCoverPath ? { thumbnailPath: iconCoverPath } : {}),
      ...(autoMarketingTitle ? { marketingTitle: autoMarketingTitle } : {}),
      ...(mergedTags.length > 0 ? { tags: JSON.stringify(mergedTags) } : {}),
      updatedAt: new Date()
    }).where(eq(projects.id, projectId));

    broadcastProgress('save', 'done', 'Analysis complete');

    console.log(`[BackgroundOCR] Analysis complete for project ${projectId}`);
    setProjectAnalysisProgress({
      projectId,
      flow: 'mobile',
      step: 'done',
      status: 'done',
      detail: 'Analysis complete',
      completedUnits: 1,
      totalUnits: 1,
    });
    broadcastToClients({
      type: 'projectAnalysisUpdated',
      data: { projectId, status: 'analyzed' }
    });

    // Pre-generate smart annotations in background if machine is idle
    scheduleSmartAnnotationPregen(projectId);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[BackgroundOCR] Analysis failed for project ${projectId}:`, error);

    broadcastProgress('error', 'failed', undefined, errorMsg);

    // Update project status to indicate failure
    const db = getDatabase();
    await db.update(projects).set({
      status: 'analyzed',
      aiSummary: `Analysis failed: ${errorMsg}`,
      ocrEngine: null,
      ocrConfidence: null,
      updatedAt: new Date()
    }).where(eq(projects.id, projectId));

    broadcastToClients({
      type: 'projectAnalysisUpdated',
      data: { projectId, status: 'analyzed' }
    });
  }
}

type MobileChatCommand = { type: string; description: string; params: Record<string, unknown> };

// Parse Maestro commands from LLM response
function parseMaestroCommands(response: string): MobileChatCommand[] {
  const commands: MobileChatCommand[] = [];

  // Look for YAML-like commands in the response
  const commandPatterns = [
    { regex: /tap(?:On)?\s*(?:on\s+)?["']([^"']+)["']/gi, type: 'tapOn', paramKey: 'text' },
    { regex: /click\s*(?:on\s+)?["']([^"']+)["']/gi, type: 'tapOn', paramKey: 'text' },
    { regex: /type\s*["']([^"']+)["']/gi, type: 'inputText', paramKey: 'text' },
    { regex: /input\s*["']([^"']+)["']/gi, type: 'inputText', paramKey: 'text' },
    { regex: /swipe\s*(up|down|left|right)/gi, type: 'swipe', paramKey: 'direction' },
    { regex: /scroll\s*(up|down)/gi, type: 'scroll', paramKey: 'direction' },
    { regex: /assert\s*(?:visible\s+)?["']([^"']+)["']/gi, type: 'assertVisible', paramKey: 'text' },
    { regex: /wait\s*(\d+)/gi, type: 'wait', paramKey: 'seconds' },
    { regex: /launch\s*(?:app)?\s*["']?([a-zA-Z.]+)["']?/gi, type: 'launchApp', paramKey: 'appId' },
  ];

  for (const pattern of commandPatterns) {
    let match;
    while ((match = pattern.regex.exec(response)) !== null) {
      commands.push({
        type: pattern.type,
        description: `${pattern.type}: ${match[1]}`,
        params: { [pattern.paramKey]: match[1] }
      });
    }
  }

  return commands;
}

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function sanitizeChatHistory(
  history: unknown,
  limit = 6,
  maxCharsPerMessage = 400
): Array<{ role: string; content: string }> {
  if (!Array.isArray(history)) return [];
  const recent = history
    .filter((item): item is { role: string; content: string } => {
      return typeof item?.role === 'string' && typeof item?.content === 'string';
    })
    .slice(-limit);

  return recent.map(item => ({
    role: item.role,
    content: truncateForPrompt(item.content, maxCharsPerMessage),
  }));
}

function tryParseClaudeJsonOutput(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {}

  const candidates = trimmed.split('\n').map(line => line.trim()).filter(Boolean).reverse();
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }

  return null;
}

function looksLikeClaudeCliError(output: string): boolean {
  const lowered = output.toLowerCase();
  return (
    lowered.includes('error_during_execution') ||
    lowered.includes('permission_denials') ||
    lowered.includes('enoent') ||
    lowered.includes('no such file or directory') ||
    lowered.includes('traceback') ||
    lowered.includes('claude cli timeout') ||
    lowered.includes('command failed: claude') ||
    lowered.includes('failed to run claude')
  );
}

function sanitizeChatCommands(commands: MobileChatCommand[]): MobileChatCommand[] {
  return commands.filter(cmd => {
    switch (cmd.type) {
      case 'tapOn':
      case 'assertVisible': {
        const value = typeof cmd.params.text === 'string' ? cmd.params.text.trim() : '';
        if (!value) return false;
        cmd.params.text = value;
        return true;
      }
      case 'inputText': {
        const value = typeof cmd.params.text === 'string' ? cmd.params.text.trim() : '';
        if (!value) return false;
        const safeValue = redactSensitiveTestInput(value, {
          actionType: 'inputText',
          description: cmd.description,
        });
        cmd.params.text = safeValue;
        if (typeof cmd.description === 'string' && cmd.description) {
          cmd.description = redactQuotedStringsInText(cmd.description, {
            actionType: 'inputText',
            description: cmd.description,
          });
          if (safeValue !== value && cmd.description.includes(value)) {
            cmd.description = cmd.description.split(value).join(safeValue);
          }
        }
        return true;
      }
      case 'swipe':
      case 'scroll': {
        const direction = typeof cmd.params.direction === 'string' ? cmd.params.direction.trim() : '';
        if (!direction) return false;
        cmd.params.direction = direction;
        return true;
      }
      case 'wait': {
        const seconds = Number.parseFloat(String(cmd.params.seconds || 0));
        if (!Number.isFinite(seconds) || seconds <= 0) return false;
        cmd.params.seconds = seconds;
        return true;
      }
      case 'launchApp':
        return true;
      default:
        return false;
    }
  });
}

function normalizeStructuredCommand(input: unknown): MobileChatCommand | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : null;
  if (!type) return null;

  const params = obj.params && typeof obj.params === 'object'
    ? (obj.params as Record<string, unknown>)
    : {};
  const description = typeof obj.description === 'string' && obj.description.trim().length > 0
    ? obj.description
    : `${type}`;

  return { type, params, description };
}

function detectSimpleCommandsFromMessage(message: string): { response: string; commands: MobileChatCommand[] } | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const greetingMatch = /^(oi|olá|ola|hello|hi|eai|e aí|bom dia|boa tarde|boa noite)\b/i;
  if (greetingMatch.test(trimmed)) {
    return {
      response: 'Hi! Tell me what action you want to test in the app (e.g., "tap on Create Project").',
      commands: []
    };
  }

  // If the user describes a multi-step flow, defer to the LLM.
  const complexityMarkers = /\b(depois|then|em seguida|and|ap[oó]s|apos|seguinte)\b/i;
  if (complexityMarkers.test(trimmed) || trimmed.includes('\n')) {
    return null;
  }

  const quotedTapMatch = trimmed.match(
    /(?:tap|click|clique|toque|tocar|pressione|aperte)\s+(?:no|na|em)?\s*(?:bot[aã]o|button)?\s*["“”']([^"“”']+)["“”']/i
  );
  if (quotedTapMatch?.[1]) {
    const target = quotedTapMatch[1].trim();
    if (target) {
      return {
        response: `Vou tocar em "${target}".`,
        commands: [{ type: 'tapOn', description: `tapOn: ${target}`, params: { text: target } }],
      };
    }
  }

  const unquotedTapMatch = trimmed.match(
    /(?:tap|click|clique|toque|tocar|pressione|aperte)\s+(?:no|na|em)?\s*(?:bot[aã]o|button)?\s+([^\n.,;:]{1,60})/i
  );
  if (unquotedTapMatch?.[1]) {
    const target = unquotedTapMatch[1].trim();
    if (target) {
      return {
        response: `Vou tocar em "${target}".`,
        commands: [{ type: 'tapOn', description: `tapOn: ${target}`, params: { text: target } }],
      };
    }
  }

  const inputMatch = trimmed.match(/(?:digite|type|input|escreva|preencha)\s+["“”']([^"“”']+)["“”']/i);
  if (inputMatch?.[1]) {
    const text = inputMatch[1].trim();
    if (text) {
      return {
        response: `Vou digitar "${text}".`,
        commands: [{ type: 'inputText', description: `inputText: ${text}`, params: { text } }],
      };
    }
  }

  const swipeMatch = trimmed.match(/(?:swipe|deslize|arraste)\s+(up|down|left|right|cima|baixo|esquerda|direita)/i);
  if (swipeMatch?.[1]) {
    const directionMap: Record<string, string> = {
      cima: 'up',
      baixo: 'down',
      esquerda: 'left',
      direita: 'right',
      up: 'up',
      down: 'down',
      left: 'left',
      right: 'right',
    };
    const directionKey = swipeMatch[1].toLowerCase();
    const direction = directionMap[directionKey];
    if (direction) {
      return {
        response: `Vou deslizar para ${direction}.`,
        commands: [{ type: 'swipe', description: `swipe: ${direction}`, params: { direction } }],
      };
    }
  }

  const scrollMatch = trimmed.match(/(?:scroll|role)\s+(up|down|cima|baixo)/i);
  if (scrollMatch?.[1]) {
    const normalized = scrollMatch[1].toLowerCase();
    const direction = normalized === 'up' || normalized.startsWith('c') ? 'up' : 'down';
    return {
      response: `Vou rolar para ${direction}.`,
      commands: [{ type: 'scroll', description: `scroll: ${direction}`, params: { direction } }],
    };
  }

  const waitMatch = trimmed.match(/(?:wait|espere|aguarde)\s*(\d+(?:[.,]\d+)?)?/i);
  if (waitMatch) {
    const seconds = waitMatch[1] ? Number.parseFloat(waitMatch[1].replace(',', '.')) : 1;
    if (!Number.isNaN(seconds) && seconds > 0) {
      return {
        response: `Vou aguardar ${seconds} segundo(s).`,
        commands: [{ type: 'wait', description: `wait: ${seconds}`, params: { seconds } }],
      };
    }
  }

  return null;
}

async function runClaudeCliMobileChat(
  message: string,
  platform: MobilePlatform | null,
  history: Array<{ role: string; content: string }>
): Promise<{ responseText: string; commands: MobileChatCommand[]; rawOutput: string; model: string }> {
  const claudeCliModel = getConfiguredClaudeCliModel();

  const mobileChatSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['response', 'commands'],
    properties: {
      response: { type: 'string' },
      commands: {
        type: 'array',
        items: {
          type: 'object',
          required: ['type', 'params'],
          additionalProperties: true,
          properties: {
            type: {
              type: 'string',
              enum: ['tapOn', 'inputText', 'swipe', 'scroll', 'assertVisible', 'wait', 'launchApp']
            },
            description: { type: 'string' },
            params: { type: 'object' }
          }
        }
      }
    }
  } as const;

  const systemPrompt = [
    'You are a mobile testing agent focused on Maestro.',
    'Respond quickly with few steps (max 4).',
    'Use only simple and direct actions.',
    'For simple commands, assume the element exists and generate the steps.',
    'Avoid asking for clarification; only do so if there\'s no clear action.',
    'Don\'t claim you already executed or succeeded; describe what you will do.',
    'Follow the JSON schema strictly.',
  ].join(' ');

  const historyText = history.length > 0
    ? history.map(item => `${item.role}: ${item.content}`).join('\n')
    : '';
  const platformLabel = platform ? platform.toUpperCase() : 'MOBILE';

  const promptParts = [
    `Platform: ${platformLabel}`,
    historyText ? `Recent history:\n${historyText}` : '',
    `User request: ${truncateForPrompt(message, 800)}`,
  ].filter(Boolean);
  const prompt = promptParts.join('\n\n');

  const args = [
    '-p',
    '--model',
    claudeCliModel,
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(mobileChatSchema),
    '--system-prompt',
    systemPrompt,
  ];

  const result = await runClaudeCliWithArgs(prompt, args, MOBILE_CHAT_LLM_TIMEOUT_MS);
  if (result.timedOut) {
    throw new Error(`Claude CLI timeout (${Math.round(MOBILE_CHAT_LLM_TIMEOUT_MS / 1000)}s).`);
  }

  const rawOutput = (result.stdout && result.stdout.trim().length > 0)
    ? result.stdout
    : result.stderr || '';

  if (looksLikeClaudeCliError(rawOutput)) {
    return {
      responseText: 'Couldn\'t access Claude CLI now. Try again or describe a simple step.',
      commands: [],
      rawOutput,
      model: claudeCliModel,
    };
  }

  const envelope = tryParseClaudeJsonOutput(rawOutput);
  const structured = envelope?.structured_output as Record<string, unknown> | undefined;

  let responseText = structured && typeof structured.response === 'string'
    ? structured.response.trim()
    : '';

  const structuredCommands = structured?.commands;
  const commands = Array.isArray(structuredCommands)
    ? structuredCommands.map(normalizeStructuredCommand).filter((cmd): cmd is MobileChatCommand => !!cmd)
    : [];

  if (!responseText) {
    responseText = truncateForPrompt(rawOutput || 'Ok.', 1200);
  }

  const fallbackCommands = commands.length > 0 ? commands : parseMaestroCommands(responseText);
  return {
    responseText,
    commands: sanitizeChatCommands(fallbackCommands),
    rawOutput,
    model: claudeCliModel,
  };
}

// Generate Maestro YAML from chat commands
function generateChatMaestroYaml(commands: Array<{ type: string; params: Record<string, unknown> }>, appId?: string): string {
  const escapeYaml = (value: string) => value.replace(/"/g, '\\"');
  const lines: string[] = [];

  const launchCommandAppId = commands.find(cmd => cmd.type === 'launchApp')?.params?.appId;
  const resolvedAppId = appId || (typeof launchCommandAppId === 'string' ? launchCommandAppId : undefined);

  if (resolvedAppId) {
    lines.push(`appId: ${resolvedAppId}`);
  }
  lines.push('---');

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'launchApp':
        if (resolvedAppId) {
          lines.push('- launchApp');
        } else if (typeof cmd.params.appId === 'string') {
          lines.push(`- launchApp: "${escapeYaml(cmd.params.appId)}"`);
        } else {
          lines.push('- launchApp');
        }
        break;
      case 'tapOn':
        lines.push('- tapOn:');
        lines.push(`    text: "${escapeYaml(String(cmd.params.text))}"`);
        break;
      case 'inputText':
        const safeInputText = redactSensitiveTestInput(String(cmd.params.text), {
          actionType: 'inputText',
        });
        lines.push('- inputText:');
        lines.push(`    text: "${escapeYaml(safeInputText)}"`);
        break;
      case 'swipe':
      case 'scroll':
        const dir = String(cmd.params.direction).toLowerCase();
        if (dir === 'up') lines.push('- scroll');
        else if (dir === 'down') lines.push('- scrollUntilVisible:\n    element: ".*"\n    direction: "DOWN"');
        else lines.push(`- swipe:\n    direction: "${dir.toUpperCase()}"`);
        break;
      case 'assertVisible':
        lines.push('- assertVisible:');
        lines.push(`    text: "${escapeYaml(String(cmd.params.text))}"`);
        break;
      case 'wait':
        const seconds = Math.max(1, parseInt(String(cmd.params.seconds || 3), 10) || 3);
        lines.push(`- extendedWaitUntil:\n    visible: ".*"\n    timeout: ${seconds * 1000}`);
        break;
    }
  }

  return lines.join('\n');
}

type MobilePlatform = 'ios' | 'android';

function normalizeMobilePlatform(value: unknown): MobilePlatform | null {
  return value === 'ios' || value === 'android' ? value : null;
}

function extractAppIdFromCommands(commands: Array<{ type: string; params: Record<string, unknown> }>): string | undefined {
  const launchAppId = commands.find(cmd => cmd.type === 'launchApp')?.params?.appId;
  return typeof launchAppId === 'string' && launchAppId.trim().length > 0 ? launchAppId.trim() : undefined;
}

async function resolveDeviceNameForChat(deviceId: string, platform: MobilePlatform): Promise<string> {
  if (!deviceId) return platform;

  if (platform === 'ios') {
    try {
      const simOutput = execSync('xcrun simctl list devices -j', { encoding: 'utf8', timeout: 4000 });
      const simData = JSON.parse(simOutput) as { devices?: Record<string, Array<{ udid: string; name: string }>> };
      const runtimes = Object.values(simData.devices || {});
      for (const devices of runtimes) {
        const match = devices.find(device => device.udid === deviceId);
        if (match?.name) {
          return match.name;
        }
      }
    } catch (error) {
      console.warn('[MobileChat] Failed to resolve iOS device name:', error);
    }
    return deviceId;
  }

  if (ADB_PATH) {
    try {
      const adbOutput = execSync(`"${ADB_PATH}" devices -l`, { encoding: 'utf8', timeout: 4000 });
      const matchLine = adbOutput
        .split('\n')
        .find(line => line.trim().startsWith(deviceId));
      if (matchLine) {
        const modelMatch = matchLine.match(/model:(\S+)/);
        return modelMatch?.[1]?.replace(/_/g, ' ') || deviceId;
      }
    } catch (error) {
      console.warn('[MobileChat] Failed to resolve Android device name:', error);
    }
  }

  return deviceId;
}

async function ensureChatRecordingSession(
  deviceId: string,
  platform: MobilePlatform,
  appId?: string
): Promise<MaestroRecordingSession | null> {
  const recorder = getMaestroRecorder();
  const existing = recorder.getSession();

  if (existing?.status === 'recording') {
    if (existing.deviceId === deviceId && existing.platform === platform) {
      if (appId && !existing.appId) {
        existing.appId = appId;
      }
      console.log('[MobileChat] Reusing active recording session:', existing.id);
      return existing;
    }
    try {
      await recorder.stopRecording();
    } catch (error) {
      console.warn('[MobileChat] Failed to stop previous recording session:', error);
    }
  }

  const deviceName = await resolveDeviceNameForChat(deviceId, platform);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sessionName = `Mobile Chat - ${timestamp}`;

  try {
    const session = await recorder.startRecording(
      sessionName,
      deviceId,
      deviceName,
      platform,
      appId,
      { preferNativeRecord: false }
    );
    console.log('[MobileChat] Chat recording started:', session.id);
    return session;
  } catch (error) {
    console.error('[MobileChat] Failed to start chat recording session:', error);
    return null;
  }
}

async function recordChatCommands(
  commands: Array<{ type: string; params: Record<string, unknown> }>,
  session: MaestroRecordingSession | null
): Promise<void> {
  if (!session || session.status !== 'recording' || commands.length === 0) {
    return;
  }

  const recorder = getMaestroRecorder();

  for (const cmd of commands) {
    try {
      switch (cmd.type) {
        case 'launchApp': {
          const appId = typeof cmd.params.appId === 'string' ? cmd.params.appId : session.appId;
          if (appId && !session.appId) {
            session.appId = appId;
          }
          await recorder.addManualAction('launch', appId ? `Launch app ${appId}` : 'Launch app', {
            appId,
            text: appId,
          });
          break;
        }
        case 'tapOn': {
          const text = typeof cmd.params.text === 'string' ? cmd.params.text : String(cmd.params.text ?? '');
          if (text) {
            await recorder.addManualAction('tap', `Tap on "${text}"`, { text });
          }
          break;
        }
        case 'inputText': {
          const text = typeof cmd.params.text === 'string' ? cmd.params.text : String(cmd.params.text ?? '');
          if (text) {
            await recorder.addManualAction('input', `Input "${text}"`, { text });
          }
          break;
        }
        case 'swipe': {
          const direction = typeof cmd.params.direction === 'string'
            ? cmd.params.direction.toLowerCase()
            : 'up';
          await recorder.addManualAction('swipe', `Swipe ${direction}`, { direction });
          break;
        }
        case 'scroll': {
          const direction = typeof cmd.params.direction === 'string'
            ? cmd.params.direction.toLowerCase()
            : 'down';
          await recorder.addManualAction('scroll', `Scroll ${direction}`, { direction });
          break;
        }
        case 'assertVisible': {
          const text = typeof cmd.params.text === 'string' ? cmd.params.text : String(cmd.params.text ?? '');
          if (text) {
            await recorder.addManualAction('assert', `Assert visible "${text}"`, { text });
          }
          break;
        }
        case 'wait': {
          const seconds = Math.max(1, parseInt(String(cmd.params.seconds || 3), 10) || 3);
          await recorder.addManualAction('wait', `Wait ${seconds}s`, { seconds });
          break;
        }
        default:
          break;
      }
    } catch (error) {
      console.warn('[MobileChat] Failed to record command:', cmd, error);
    }
  }
}

app.post('/api/mobile-chat/message', async (c) => {
  try {
    const body = await c.req.json();
    const { message, deviceId, platform, history } = body;

    if (!message) {
      return c.json({ error: 'Message is required' }, 400);
    }

    const recorder = getMaestroRecorder();
    const resolvedPlatformForPrompt =
      normalizeMobilePlatform(platform) || recorder.getSession()?.platform || liveStreamPlatform || null;
    const sanitizedHistory = sanitizeChatHistory(history);
    const simpleDetection = detectSimpleCommandsFromMessage(message);

    let llmResponse = '';
    let commands: MobileChatCommand[] = [];
    let llmModelUsed: string | undefined;
    let providerName = 'rule-based';

    const llmStart = Date.now();
    if (simpleDetection) {
      llmResponse = simpleDetection.response;
      commands = simpleDetection.commands;
      llmModelUsed = 'rule-based';
    } else {
      const provider = await getLLMProvider();
      if (!provider) {
        return c.json({
          error: 'No LLM provider available. Configure Claude CLI, ANTHROPIC_API_KEY, OPENAI_API_KEY, or run Ollama locally.',
          response: '⚠️ Chat not available\n\nTo use chat, configure one of these options in Settings:\n\n• **Local Claude CLI (default)** - verify `claude` is installed and authenticated (`claude login`)\n• **ANTHROPIC_API_KEY** - faster\n• **OPENAI_API_KEY** - alternative\n• **Local Ollama** - free (requires installation)'
        }, 424);
      }

      providerName = provider.name;

      if (provider.name.startsWith('claude-cli')) {
        const structured = await runClaudeCliMobileChat(message, resolvedPlatformForPrompt, sanitizedHistory);
        llmResponse = structured.responseText;
        commands = structured.commands;
        llmModelUsed = structured.model;
      } else {
        const systemContext = `You are a mobile testing assistant. The user wants to test a mobile app on ${resolvedPlatformForPrompt || 'a device'}.
Your job is to understand what the user wants to do and respond with:
1. A brief confirmation of what you'll do
2. The specific UI actions needed (tap on "X", type "Y", etc.)

When describing actions, use these exact formats that I can parse:
- tap "Button Text" or click "Menu Item"
- type "some text" or input "search query"
- swipe up/down/left/right
- scroll up/down
- assert visible "Expected Text"
- wait 3 (seconds)
- launch app "com.example.app"

Keep responses concise and action-oriented.`;

        const conversationContext = sanitizedHistory.length > 0
          ? '\n\nPrevious conversation:\n' + sanitizedHistory.map(m => `${m.role}: ${m.content}`).join('\n')
          : '';
        const prompt = `${systemContext}${conversationContext}\n\nUser: ${truncateForPrompt(message, 800)}`;

        llmResponse = await provider.sendMessage(prompt);
        commands = parseMaestroCommands(llmResponse);
      }
    }
    const llmDurationMs = Date.now() - llmStart;
    console.log(
      `[MobileChat] ${providerName}${llmModelUsed ? ` (${llmModelUsed})` : ''} in ${llmDurationMs}ms, commands=${commands.length}`
    );

    commands = sanitizeChatCommands(commands);
    if (!llmResponse && commands.length === 0) {
      llmResponse = 'Describe the step you want to execute in the app, for example: "tap on Create Project".';
    }

    const resolvedDeviceId = deviceId || recorder.getSession()?.deviceId || liveStreamDeviceId || undefined;
    const resolvedPlatform = resolvedPlatformForPrompt;
    const commandsAppId = extractAppIdFromCommands(commands);
    let resolvedAppId = commandsAppId || recorder.getSession()?.appId;

    if (!resolvedAppId && resolvedDeviceId && resolvedPlatform === 'ios') {
      resolvedAppId = getIOSForegroundAppId(resolvedDeviceId) || 'com.apple.springboard';
    } else if (!resolvedAppId && resolvedDeviceId && resolvedPlatform === 'android') {
      resolvedAppId = getAndroidForegroundAppId(resolvedDeviceId) || undefined;
    }

    if (resolvedAppId) {
      console.log(`[MobileChat] Resolved appId: ${resolvedAppId}`);
    }

    let recordingSession: MaestroRecordingSession | null = null;
    if (commands.length > 0 && resolvedDeviceId && resolvedPlatform) {
      recordingSession = await ensureChatRecordingSession(resolvedDeviceId, resolvedPlatform, resolvedAppId);
      if (resolvedAppId && recordingSession && !recordingSession.appId) {
        recordingSession.appId = resolvedAppId;
      }
      await recordChatCommands(commands, recordingSession);
    } else if (commands.length > 0 && recorder.getSession()?.status === 'recording') {
      recordingSession = recorder.getSession();
      if (resolvedAppId && recordingSession && !recordingSession.appId) {
        recordingSession.appId = resolvedAppId;
      }
      await recordChatCommands(commands, recordingSession);
    }

    const deviceForExecution = resolvedDeviceId || recordingSession?.deviceId;
    let appIdForFlow = recordingSession?.appId || resolvedAppId;

    if (!appIdForFlow && resolvedPlatform === 'ios') {
      appIdForFlow = 'com.apple.springboard';
    }

    // Execute commands if we have a device
    let executedActions: Array<{ type: string; description: string }> = commands.map(cmd => ({
      type: cmd.type,
      description: cmd.description,
    }));
    let executionStarted = false;
    const executionTimeoutMs = 15000;

    if (commands.length > 0 && (!deviceForExecution || !resolvedPlatform)) {
      llmResponse = llmResponse
        ? `${llmResponse}\n\n⚠️ No active device found to execute. Start the simulator/emulator and try again.`
        : '⚠️ No active device found to execute. Start the simulator/emulator and try again.';
    }

    if (commands.length > 0 && deviceForExecution) {
      executionStarted = true;

      // Generate and execute Maestro flow without blocking the chat response
      const flowYaml = generateChatMaestroYaml(commands, appIdForFlow);
      const { writeFile, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const flowPath = join(
        PROJECTS_DIR,
        `temp-chat-flow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yaml`
      );

      await writeFile(flowPath, flowYaml);

      const runStartedAt = Date.now();
      void runMaestroTest({
        flowPath,
        device: deviceForExecution,
        timeout: executionTimeoutMs,
      })
        .then(result => {
          const runDurationMs = Date.now() - runStartedAt;
          if (!result.success) {
            console.warn(`[MobileChat] Maestro finished with error in ${runDurationMs}ms:`, result.error);
            const errorMessage = result.error || 'Maestro execution failed';
            const errorShort = errorMessage.length > 320 ? `${errorMessage.slice(0, 320)}...` : errorMessage;
            broadcastToClients({
              type: 'mobileChatExecutionResult',
              data: {
                success: false,
                durationMs: runDurationMs,
                deviceId: deviceForExecution,
                appId: appIdForFlow || null,
                error: errorShort,
              }
            });
            return;
          }
          console.log(`[MobileChat] Maestro finished in ${runDurationMs}ms`);
          broadcastToClients({
            type: 'mobileChatExecutionResult',
            data: {
              success: true,
              durationMs: runDurationMs,
              deviceId: deviceForExecution,
              appId: appIdForFlow || null,
            }
          });
        })
        .catch(execError => {
          console.error('[MobileChat] Maestro execution error:', execError);
          const errorMessage = execError instanceof Error ? execError.message : String(execError);
          const errorShort = errorMessage.length > 320 ? `${errorMessage.slice(0, 320)}...` : errorMessage;
          broadcastToClients({
            type: 'mobileChatExecutionResult',
            data: {
              success: false,
              durationMs: Date.now() - runStartedAt,
              deviceId: deviceForExecution,
              appId: appIdForFlow || null,
              error: errorShort,
            }
          });
        })
        .finally(async () => {
          try {
            await rm(flowPath, { force: true });
          } catch (cleanupError) {
            console.warn('[MobileChat] Failed to clean up temp flow:', cleanupError);
          }
          // Force a fresh live-stream frame after Maestro run so the UI updates quickly
          void captureAndBroadcastScreen();
        });
    }

    const activeSession = recorder.getSession();

    return c.json({
      response: llmResponse,
      actions: executedActions,
      provider: providerName,
      commandsDetected: commands.length,
      executionStarted,
      executionTimeoutMs,
      llmDurationMs,
      llmModelUsed,
      recordingSessionId: activeSession?.id,
      recordingActive: recorder.isRecording(),
      recordingDeviceName: activeSession?.deviceName,
      recordingAppId: activeSession?.appId,
      recordingFlowPath: activeSession?.flowPath
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MOBILE CHAT ERROR]', error);
    return c.json({ error: message }, 500);
  }
});

// Get available LLM providers status
app.get('/api/mobile-chat/providers', async (c) => {
  const providers: Array<{ key: string; name: string; available: boolean; configured: boolean }> = [];

  // Check Anthropic API
  providers.push({
    key: 'anthropic',
    name: 'Anthropic API',
    available: !!process.env.ANTHROPIC_API_KEY,
    configured: !!process.env.ANTHROPIC_API_KEY
  });

  // Check OpenAI API
  providers.push({
    key: 'openai',
    name: 'OpenAI API',
    available: !!process.env.OPENAI_API_KEY,
    configured: !!process.env.OPENAI_API_KEY
  });

  const claudeAvailable = isClaudeCliAvailable();
  providers.push({
    key: 'claude-cli',
    name: 'Claude CLI (local)',
    available: claudeAvailable,
    configured: claudeAvailable
  });

  // Check Ollama
  try {
    const snapshot = await fetchOllamaStatusSnapshot();
    providers.push({
      key: 'ollama',
      name: 'Ollama',
      available: snapshot.running,
      configured: snapshot.running && snapshot.selectedModelAvailable
    });
  } catch {
    providers.push({ key: 'ollama', name: 'Ollama', available: false, configured: false });
  }

  return c.json({ providers, preferredProvider: llmSettings.preferredProvider || 'auto' });
});

// ============================================================================
// SETUP API
// ============================================================================
app.get('/api/setup/status', async (c) => {
  try {
    const { setupStatusTool } = await import('../mcp/tools/setup.js');
    const result = await setupStatusTool.handler({});
    const data = JSON.parse(result.content[0].text!);
    const idbInstalled = await isIdbInstalled().catch(() => false);
    return c.json({ ...data, idbInstalled });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// DATA DIRECTORY INFO
// ============================================================================
app.get('/api/info', async (c) => {
  return c.json({
    version: APP_VERSION,
    dataDir: DATA_DIR,
  });
});

// ============================================================================
// NETWORK PROXY SAFETY SETTINGS API
// ============================================================================

type AppLabNetworkProxySettings = {
  emergencyLockEnabled: boolean;
  localProxyOptInEnabled: boolean;
};

const DEFAULT_APP_LAB_NETWORK_PROXY_SETTINGS: AppLabNetworkProxySettings = {
  emergencyLockEnabled: false,
  localProxyOptInEnabled: false,
};

let appLabNetworkProxySettings: AppLabNetworkProxySettings = {
  ...DEFAULT_APP_LAB_NETWORK_PROXY_SETTINGS,
};

function sanitizeAppLabNetworkProxySettings(value: unknown): AppLabNetworkProxySettings {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    emergencyLockEnabled: record.emergencyLockEnabled === true,
    localProxyOptInEnabled: record.localProxyOptInEnabled === true,
  };
}

function getAppLabNetworkProxySettingsPath(): string {
  return join(DATA_DIR, 'network-proxy-settings.json');
}

function resolveAppLabNetworkProxyTimeoutMs(): number | null {
  const raw = typeof process.env.DISCOVERYLAB_NETWORK_PROXY_MAX_DURATION_MS === 'string'
    ? process.env.DISCOVERYLAB_NETWORK_PROXY_MAX_DURATION_MS.trim()
    : '';
  if (!raw) return 15 * 60 * 1000;
  const durationMs = Number(raw);
  if (!Number.isFinite(durationMs)) return 15 * 60 * 1000;
  if (durationMs <= 0) return null;
  return Math.max(30000, Math.min(24 * 60 * 60 * 1000, Math.round(durationMs)));
}

function buildAppLabNetworkProxySettingsPayload(extra: Record<string, unknown> = {}) {
  const activeProxies = listLocalCaptureProxyStates();
  return {
    ...appLabNetworkProxySettings,
    autoDisableOnServerShutdown: true,
    autoDisableTimeoutMs: resolveAppLabNetworkProxyTimeoutMs(),
    activeProxyCount: activeProxies.filter((proxy) => proxy.active).length,
    activeProxies,
    ...extra,
  };
}

function persistAppLabNetworkProxySettings() {
  writeFileSync(getAppLabNetworkProxySettingsPath(), JSON.stringify(appLabNetworkProxySettings, null, 2));
}

(async () => {
  try {
    const settingsPath = getAppLabNetworkProxySettingsPath();
    if (existsSync(settingsPath)) {
      appLabNetworkProxySettings = {
        ...DEFAULT_APP_LAB_NETWORK_PROXY_SETTINGS,
        ...sanitizeAppLabNetworkProxySettings(JSON.parse(readFileSync(settingsPath, 'utf8'))),
      };
      console.log('[Network Proxy Settings] Loaded from file');
    }
  } catch {
    console.log('[Network Proxy Settings] No saved settings found');
  }
})();

app.get('/api/settings/network-proxy', async (c) => {
  return c.json(buildAppLabNetworkProxySettingsPayload());
});

app.put('/api/settings/network-proxy', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    appLabNetworkProxySettings = {
      ...appLabNetworkProxySettings,
      ...sanitizeAppLabNetworkProxySettings(body),
    };
    persistAppLabNetworkProxySettings();

    const finalization = (appLabNetworkProxySettings.emergencyLockEnabled || appLabNetworkProxySettings.localProxyOptInEnabled !== true)
      ? await finalizeAllLocalCaptureProxySessions({ reason: 'settings-safety-toggle' })
      : null;

    return c.json(buildAppLabNetworkProxySettingsPayload({
      success: true,
      finalization,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/settings/network-proxy/emergency-stop', async (c) => {
  try {
    const finalization = await finalizeAllLocalCaptureProxySessions({ reason: 'manual-emergency-stop' });
    return c.json(buildAppLabNetworkProxySettingsPayload({
      success: true,
      finalization,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// LLM SETTINGS API
// ============================================================================

// In-memory storage for LLM settings (persisted to file)
let llmSettings: {
  anthropicApiKey?: string;
  anthropicModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  ollamaVisionModel?: string;
  preferOllamaVisionForActionDetection?: boolean;
  claudeCliModel?: string;
  preferredProvider?: 'anthropic' | 'openai' | 'claude-cli' | 'ollama' | 'auto';
} = {};

// Load LLM settings from file on startup
(async () => {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const settingsPath = join(DATA_DIR, 'llm-settings.json');
    if (existsSync(settingsPath)) {
      llmSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      // Set env vars from saved settings
      if (llmSettings.anthropicApiKey) process.env.ANTHROPIC_API_KEY = llmSettings.anthropicApiKey;
      if (llmSettings.openaiApiKey) process.env.OPENAI_API_KEY = llmSettings.openaiApiKey;
      console.log('[LLM Settings] Loaded from file');
    }
  } catch (e) {
    console.log('[LLM Settings] No saved settings found');
  }
})();

// Get LLM settings
app.get('/api/settings/llm', async (c) => {
  // Return masked API keys for display
  return c.json({
    anthropicApiKey: llmSettings.anthropicApiKey ? '••••••••' + llmSettings.anthropicApiKey.slice(-4) : '',
    anthropicModel: llmSettings.anthropicModel || 'claude-sonnet-4-6',
    openaiApiKey: llmSettings.openaiApiKey ? '••••••••' + llmSettings.openaiApiKey.slice(-4) : '',
    openaiModel: llmSettings.openaiModel || 'gpt-5.2',
    ollamaUrl: llmSettings.ollamaUrl || 'http://localhost:11434',
    ollamaModel: getConfiguredOllamaTextModel(),
    ollamaVisionModel: getConfiguredOllamaVisionModel(),
    preferOllamaVisionForActionDetection: llmSettings.preferOllamaVisionForActionDetection === true,
    claudeCliModel: llmSettings.claudeCliModel || process.env.CLAUDE_CLI_MODEL || 'haiku',
    preferredProvider: llmSettings.preferredProvider || 'auto'
  });
});

// Save LLM settings
app.put('/api/settings/llm', async (c) => {
  try {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const body = await c.req.json();

    // Only update if new value is provided (not masked)
    if (body.anthropicApiKey && !body.anthropicApiKey.startsWith('••')) {
      llmSettings.anthropicApiKey = body.anthropicApiKey;
      process.env.ANTHROPIC_API_KEY = body.anthropicApiKey;
    }
    if (body.anthropicModel) {
      llmSettings.anthropicModel = body.anthropicModel;
    }
    if (body.openaiApiKey && !body.openaiApiKey.startsWith('••')) {
      llmSettings.openaiApiKey = body.openaiApiKey;
      process.env.OPENAI_API_KEY = body.openaiApiKey;
    }
    if (body.openaiModel) {
      llmSettings.openaiModel = body.openaiModel;
    }
    if (body.ollamaUrl) {
      llmSettings.ollamaUrl = body.ollamaUrl;
    }
    if (body.ollamaModel) {
      llmSettings.ollamaModel = body.ollamaModel;
    }
    if (body.ollamaVisionModel) {
      llmSettings.ollamaVisionModel = body.ollamaVisionModel;
    }
    if (body.preferOllamaVisionForActionDetection !== undefined) {
      llmSettings.preferOllamaVisionForActionDetection = !!body.preferOllamaVisionForActionDetection;
    }
    if (body.claudeCliModel) {
      llmSettings.claudeCliModel = body.claudeCliModel;
    }
    if (body.preferredProvider !== undefined) {
      llmSettings.preferredProvider = body.preferredProvider;
    }

    // Persist to file
    const settingsPath = join(DATA_DIR, 'llm-settings.json');
    writeFileSync(settingsPath, JSON.stringify(llmSettings, null, 2));

    return c.json({ success: true, message: 'LLM settings saved' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// JIRA SETTINGS API
// ============================================================================

// In-memory storage for Jira settings (persisted to file)
let jiraSettings: {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
} = {};

// Load Jira settings from file on startup
(async () => {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const settingsPath = join(DATA_DIR, 'jira-settings.json');
    if (existsSync(settingsPath)) {
      jiraSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      // Sync to env vars so existing code picks them up
      if (jiraSettings.baseUrl) process.env.JIRA_BASE_URL = jiraSettings.baseUrl;
      if (jiraSettings.email) process.env.JIRA_EMAIL = jiraSettings.email;
      if (jiraSettings.apiToken) process.env.JIRA_API_TOKEN = jiraSettings.apiToken;
      console.log('[Jira Settings] Loaded from file');
    }
  } catch (e) {
    console.log('[Jira Settings] No saved settings found');
  }
})();

// Get Jira settings (masked)
app.get('/api/settings/jira', async (c) => {
  return c.json({
    baseUrl: jiraSettings.baseUrl || '',
    email: jiraSettings.email || '',
    apiToken: jiraSettings.apiToken ? '••••••••' + jiraSettings.apiToken.slice(-4) : '',
    configured: !!(jiraSettings.baseUrl && jiraSettings.email && jiraSettings.apiToken)
  });
});

// Save Jira settings
app.put('/api/settings/jira', async (c) => {
  try {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const body = await c.req.json();

    // Only update if new value is provided (not masked)
    if (body.baseUrl !== undefined) {
      jiraSettings.baseUrl = body.baseUrl;
      if (body.baseUrl) process.env.JIRA_BASE_URL = body.baseUrl;
    }
    if (body.email !== undefined) {
      jiraSettings.email = body.email;
      if (body.email) process.env.JIRA_EMAIL = body.email;
    }
    if (body.apiToken && !body.apiToken.startsWith('••')) {
      jiraSettings.apiToken = body.apiToken;
      process.env.JIRA_API_TOKEN = body.apiToken;
    }

    // Persist to file
    const settingsPath = join(DATA_DIR, 'jira-settings.json');
    writeFileSync(settingsPath, JSON.stringify(jiraSettings, null, 2));

    return c.json({ success: true, message: 'Jira settings saved' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// NOTION SETTINGS & PAGE PICKER
// ============================================================================

let notionSettings: {
  apiToken?: string;
  lastParentPageId?: string;
  lastParentPageTitle?: string;
} = {};

// Load Notion settings from file on startup
(async () => {
  try {
    const settingsPath = join(DATA_DIR, 'notion-settings.json');
    if (existsSync(settingsPath)) {
      notionSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      console.log('[Notion Settings] Loaded from file');
    }
  } catch (e) {
    console.log('[Notion Settings] No saved settings found');
  }
})();

app.get('/api/settings/notion', async (c) => {
  return c.json({
    configured: !!notionSettings.apiToken,
    apiToken: notionSettings.apiToken ? '••••' + notionSettings.apiToken.slice(-4) : '',
    lastParentPageId: notionSettings.lastParentPageId || '',
    lastParentPageTitle: notionSettings.lastParentPageTitle || '',
  });
});

app.put('/api/settings/notion', async (c) => {
  try {
    const body = await c.req.json();

    if (body.apiToken && !body.apiToken.startsWith('••')) {
      notionSettings.apiToken = body.apiToken;
    }
    if (body.lastParentPageId !== undefined) {
      notionSettings.lastParentPageId = body.lastParentPageId;
      notionSettings.lastParentPageTitle = body.lastParentPageTitle || '';
    }

    const settingsPath = join(DATA_DIR, 'notion-settings.json');
    writeFileSync(settingsPath, JSON.stringify(notionSettings, null, 2));

    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Search Notion pages (for page picker)
app.get('/api/notion/search', async (c) => {
  try {
    const query = c.req.query('q') || '';
    const token = notionSettings.apiToken;

    if (!token) {
      return c.json({ error: 'Notion API token not configured. Go to Settings to add it.' }, 400);
    }

    const response = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 20,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      if (response.status === 401) {
        return c.json({ error: 'Invalid Notion API token. Check your integration token in Settings.' }, 401);
      }
      return c.json({ error: `Notion API error: ${response.status}` }, 500);
    }

    const data = await response.json() as { results: Array<{ id: string; properties?: Record<string, any>; icon?: any; url?: string }> };

    const pages = (data.results || []).map((page: any) => {
      // Extract title from properties
      let title = 'Untitled';
      if (page.properties?.title?.title) {
        title = page.properties.title.title.map((t: any) => t.plain_text).join('') || 'Untitled';
      } else if (page.properties?.Name?.title) {
        title = page.properties.Name.title.map((t: any) => t.plain_text).join('') || 'Untitled';
      } else {
        // Try to find any property with type "title"
        for (const prop of Object.values(page.properties || {})) {
          if ((prop as any)?.type === 'title' && (prop as any)?.title) {
            title = (prop as any).title.map((t: any) => t.plain_text).join('') || 'Untitled';
            break;
          }
        }
      }

      return {
        id: page.id,
        title,
        icon: page.icon?.emoji || null,
        url: page.url || `https://www.notion.so/${page.id.replace(/-/g, '')}`,
      };
    });

    return c.json({ success: true, pages });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Check Notion connection status
app.get('/api/notion/status', async (c) => {
  const token = notionSettings.apiToken;
  if (!token) {
    return c.json({ connected: false, method: 'none' });
  }

  try {
    const response = await fetch('https://api.notion.com/v1/users/me', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
      },
    });

    if (response.ok) {
      const user = await response.json() as { name?: string; type?: string };
      return c.json({
        connected: true,
        method: 'api',
        name: (user as any).name || 'Integration',
        type: (user as any).type || 'bot',
      });
    }

    return c.json({ connected: false, method: 'api', error: 'Invalid token' });
  } catch {
    return c.json({ connected: false, method: 'api', error: 'Connection failed' });
  }
});

// Get Ollama status and available models
app.get('/api/ollama/status', async (c) => {
  const requestedUrl = c.req.query('url');
  const requestedTextModel = c.req.query('textModel') || c.req.query('model');
  const requestedVisionModel = c.req.query('visionModel');
  const selectedTextModel = (requestedTextModel || getConfiguredOllamaTextModel()).trim() || DEFAULT_OLLAMA_TEXT_MODEL;
  const selectedVisionModel = (requestedVisionModel || getConfiguredOllamaVisionModel()).trim() || DEFAULT_OLLAMA_VISION_MODEL;

  try {
    const snapshot = await fetchOllamaStatusSnapshot(requestedUrl, selectedTextModel, OLLAMA_TAGS_TIMEOUT_MS);
    const visionModelAvailable = (snapshot.models || []).some((m) => typeof m?.name === 'string' && matchesOllamaModel(m.name, selectedVisionModel));
    const visionModelLooksCapable = isLikelyVisionCapableOllamaModel(selectedVisionModel);
    if (!snapshot.running) {
      return c.json({
        running: false,
        models: [],
        currentModel: snapshot.selectedModel,
        selectedModelAvailable: false,
        currentTextModel: selectedTextModel,
        selectedTextModelAvailable: false,
        currentVisionModel: selectedVisionModel,
        selectedVisionModelAvailable: false,
        selectedVisionModelLooksCapable: visionModelLooksCapable,
        recommendedTextModel: DEFAULT_OLLAMA_TEXT_MODEL,
        recommendedVisionModel: DEFAULT_OLLAMA_VISION_MODEL,
        ollamaUrl: snapshot.ollamaUrl,
        error: snapshot.error || 'Ollama not responding'
      });
    }

    const models = (snapshot.models || []).map(m => ({
      name: m.name,
      size: typeof m.size === 'number' ? m.size : 0,
      modified: m.modified_at || ''
    }));

    return c.json({
      running: true,
      models,
      currentModel: snapshot.selectedModel,
      selectedModelAvailable: snapshot.selectedModelAvailable,
      currentTextModel: selectedTextModel,
      selectedTextModelAvailable: snapshot.selectedModelAvailable,
      currentVisionModel: selectedVisionModel,
      selectedVisionModelAvailable: visionModelAvailable,
      selectedVisionModelLooksCapable: visionModelLooksCapable,
      recommendedTextModel: DEFAULT_OLLAMA_TEXT_MODEL,
      recommendedVisionModel: DEFAULT_OLLAMA_VISION_MODEL,
      ollamaUrl: snapshot.ollamaUrl
    });
  } catch (error) {
    // Ollama not running or not installed
    return c.json({
      running: false,
      models: [],
      currentModel: selectedTextModel,
      selectedModelAvailable: false,
      currentTextModel: selectedTextModel,
      selectedTextModelAvailable: false,
      currentVisionModel: selectedVisionModel,
      selectedVisionModelAvailable: false,
      selectedVisionModelLooksCapable: isLikelyVisionCapableOllamaModel(selectedVisionModel),
      recommendedTextModel: DEFAULT_OLLAMA_TEXT_MODEL,
      recommendedVisionModel: DEFAULT_OLLAMA_VISION_MODEL,
      ollamaUrl: normalizeOllamaUrl(requestedUrl || llmSettings.ollamaUrl),
      error: error instanceof Error ? error.message : 'Ollama not available'
    });
  }
});

// ============================================================================
// TEST VARIABLES API (script/project execution variables)
// ============================================================================

app.get('/api/test-variables/:ownerType/:ownerId', async (c) => {
  try {
    const ownerType = normalizeTestVariableOwnerType(c.req.param('ownerType'));
    const ownerId = String(c.req.param('ownerId') || '').trim();
    if (!ownerType || !ownerId) {
      return c.json({ error: 'Invalid owner type or owner id' }, 400);
    }

    const variables = await getTestVariablesForOwner(ownerType, ownerId);
    const code = c.req.query('code');
    const platformQuery = c.req.query('platform');
    const platform = platformQuery === 'mobile' || platformQuery === 'web' ? platformQuery : null;

    if (typeof code === 'string' && platform) {
      const resolved = await resolveExecutionVariablesForScript({
        ownerType,
        ownerId,
        platform,
        code,
      });
      return c.json({
        variables,
        envTest: renderDotEnvTest(variables),
        placeholders: resolved.placeholders,
        usedKeys: resolved.usedKeys,
        missingKeys: resolved.missingKeys,
      });
    }

    return c.json({
      variables,
      envTest: renderDotEnvTest(variables),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.put('/api/test-variables/:ownerType/:ownerId', async (c) => {
  try {
    const ownerType = normalizeTestVariableOwnerType(c.req.param('ownerType'));
    const ownerId = String(c.req.param('ownerId') || '').trim();
    if (!ownerType || !ownerId) {
      return c.json({ error: 'Invalid owner type or owner id' }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    let variablesInput: unknown = body?.variables;
    if (!Array.isArray(variablesInput) && typeof body?.envTestText === 'string') {
      const parsed = parseDotEnvTest(body.envTestText);
      const secretKeys = new Set(
        Array.isArray(body?.secretKeys)
          ? body.secretKeys
              .map((value: unknown) => normalizeTestVariableKey(value))
              .filter((value: string | null): value is string => !!value)
          : []
      );
      variablesInput = parsed.map((item) => ({
        key: item.key,
        value: item.value,
        platform: item.platform || 'both',
        notes: item.notes || null,
        isSecret: secretKeys.has(item.key),
      }));
    }

    const variables = await saveTestVariablesForOwner(ownerType, ownerId, variablesInput);

    return c.json({
      success: true,
      variables,
      envTest: renderDotEnvTest(variables),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// PLAYWRIGHT RECORDER API
// ============================================================================

import { getRecorder, type RecordingSession, type RecordingAction } from '../core/testing/playwrightRecorder.js';
import { WebSocketServer, WebSocket } from 'ws';

// Store connected WebSocket clients
const wsClients = new Set<WebSocket>();

// Start a new recording
app.post('/api/recorder/start', async (c) => {
  try {
    const body = await c.req.json();
    const { name, url, resolution, captureResolution, viewportMode, viewportResolution } = body;

    if (!name || !url) {
      return c.json({ error: 'Name and URL are required' }, 400);
    }

    // Backward compatibility: legacy `resolution` maps to capture resolution.
    const captureResolutionKey: string | undefined = captureResolution || resolution;
    const viewportModeFinal: 'auto' | 'fixed' = viewportMode === 'fixed' ? 'fixed' : 'auto';
    const viewportResolutionKey: string | undefined = viewportResolution || captureResolutionKey;

    const recorder = getRecorder();

    // Setup event listeners for WebSocket broadcast
    recorder.on('action', (action: RecordingAction) => {
      broadcastToClients({
        type: 'action',
        data: action,
      });
    });

    recorder.on('screenshot', (path: string, actionId: string) => {
      broadcastToClients({
        type: 'screenshot',
        data: { path, actionId },
      });
    });

    recorder.on('status', (status: string) => {
      broadcastToClients({
        type: 'status',
        data: { status },
      });
    });

    const session = await recorder.startRecording(name, url, {
      resolution: captureResolutionKey,
      captureResolution: captureResolutionKey,
      viewportMode: viewportModeFinal,
      viewportResolution: viewportModeFinal === 'fixed' ? viewportResolutionKey : undefined,
    });

    // Helpful for debugging when the UI appears zoomed or fixed-size
    console.log('[Recorder] start:', {
      name,
      url,
      requestedCaptureResolution: captureResolutionKey,
      viewportMode: viewportModeFinal,
      requestedViewportResolution: viewportResolutionKey,
      viewport: session.viewport,
      captureResolution: session.captureResolution,
      deviceScaleFactor: session.deviceScaleFactor,
    });

    return c.json({
      success: true,
      session: {
        id: session.id,
        name: session.name,
        url: session.url,
        status: session.status,
        screenshotsDir: session.screenshotsDir,
        viewport: session.viewport,
        viewportMode: session.viewportMode,
        captureResolution: session.captureResolution,
        deviceScaleFactor: session.deviceScaleFactor,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Stop recording
app.post('/api/recorder/stop', async (c) => {
  try {
    const recorder = getRecorder();
    const session = await recorder.stopRecording();

    // Broadcast stop event
    broadcastToClients({
      type: 'stopped',
      data: session,
    });

    // Auto-create project from recording
    let projectId: string | null = null;
    let ocrInProgress = false;

    try {
      const { readFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');

      const recordingId = session?.id;
      if (recordingId) {
        const recordingDir = join(homedir(), '.discoverylab', 'recordings', recordingId);
        const sessionPath = join(recordingDir, 'session.json');

        if (existsSync(sessionPath)) {
          const sessionData = JSON.parse(readFileSync(sessionPath, 'utf8'));
          const sessionName = sessionData?.name || sessionData?.session?.name || `Recording ${recordingId}`;
          const recordingUrl = getRecordingSessionFinalUrl(sessionData);
          const faviconCoverPath = await createWebFaviconCover({
            pageUrl: recordingUrl,
            outputDir: recordingDir,
          });

          const sqlite = getSqlite();
          projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const now = Date.now();

          sqlite.prepare(`
            INSERT INTO projects (id, name, video_path, platform, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(projectId, sessionName, recordingDir, 'web', 'ready', now, now);

          // Copy screenshots to project frames directory
          const framesDir = join(DATA_DIR, 'projects', projectId, 'frames');
          mkdirSync(framesDir, { recursive: true });

          const screenshotsDir = join(recordingDir, 'screenshots');
          let thumbnailPath: string | null = null;
          let frameCount = 0;
          const screenshotFiles: string[] = [];

          if (existsSync(screenshotsDir)) {
            const screenshots = readdirSync(screenshotsDir).filter(f => f.endsWith('.png')).sort();
            frameCount = screenshots.length;
            screenshotFiles.push(...screenshots);

            screenshots.forEach((file, index) => {
              const src = join(screenshotsDir, file);
              const dest = join(framesDir, `frame_${(index + 1).toString().padStart(4, '0')}.png`);
              copyFileSync(src, dest);

              if (index === 0) {
                thumbnailPath = dest;
              }

              const frameId = `frame_${projectId}_${(index + 1).toString().padStart(4, '0')}`;
              sqlite.prepare(`
                INSERT INTO frames (id, project_id, frame_number, timestamp, image_path, is_key_frame, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `).run(frameId, projectId, index + 1, index * 1.0, dest, index === 0 ? 1 : 0, now);
            });

            sqlite.prepare(`
              UPDATE projects SET thumbnail_path = ?, frame_count = ?, updated_at = ? WHERE id = ?
            `).run(faviconCoverPath || thumbnailPath, frameCount, now, projectId);
          }

          if (faviconCoverPath && !thumbnailPath) {
            sqlite.prepare(`
              UPDATE projects SET thumbnail_path = ?, updated_at = ? WHERE id = ?
            `).run(faviconCoverPath, now, projectId);
          }

          // Trigger OCR if we have screenshots
          if (frameCount > 0) {
            sqlite.prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE id = ?`).run('analyzing', Date.now(), projectId);
            ocrInProgress = true;
            // Fire-and-forget OCR
            runOCRInBackgroundWithWatchdog(projectId, screenshotsDir, screenshotFiles, 'RecorderStop');
          } else {
            sqlite.prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE id = ?`).run('completed', Date.now(), projectId);
          }

          console.log(`[RecorderStop] Auto-created project ${projectId} with ${frameCount} frames`);
        }
      }
    } catch (autoSaveError) {
      console.error('[RecorderStop] Auto-save project failed:', autoSaveError);
      // Non-fatal: recording was still saved, just project creation failed
    }

    return c.json({
      success: true,
      session,
      projectId,
      ocrInProgress,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Pause recording
app.post('/api/recorder/pause', async (c) => {
  try {
    const recorder = getRecorder();
    recorder.pause();
    return c.json({ success: true, status: 'paused' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Resume recording
app.post('/api/recorder/resume', async (c) => {
  try {
    const recorder = getRecorder();
    recorder.resume();
    return c.json({ success: true, status: 'recording' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get current session
app.get('/api/recorder/session', async (c) => {
  try {
    const recorder = getRecorder();
    const session = recorder.getSession();

    if (!session) {
      return c.json({ session: null });
    }

    return c.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Take manual screenshot
app.post('/api/recorder/screenshot', async (c) => {
  try {
    const recorder = getRecorder();
    const path = await recorder.captureScreenshot();

    if (!path) {
      return c.json({ error: 'No active recording' }, 400);
    }

    return c.json({ success: true, path });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// List all recordings
app.get('/api/recorder/recordings', async (c) => {
  try {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingsDir = join(homedir(), '.discoverylab', 'recordings');

    if (!existsSync(recordingsDir)) {
      return c.json({ recordings: [] });
    }

    const recordings = readdirSync(recordingsDir)
      .filter(dir => dir.startsWith('rec_'))
      .map(dir => {
        const sessionPath = join(recordingsDir, dir, 'session.json');
        if (existsSync(sessionPath)) {
          try {
            const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
            return session;
          } catch {
            return null;
          }
        }
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => b.startedAt - a.startedAt);

    return c.json({ recordings });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get recording by ID
app.get('/api/recorder/recordings/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { readFileSync, existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingDir = join(homedir(), '.discoverylab', 'recordings', id);
    const sessionPath = join(recordingDir, 'session.json');

    if (!existsSync(sessionPath)) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    const session = JSON.parse(readFileSync(sessionPath, 'utf8'));

    // Get list of screenshots
    const screenshotsDir = join(recordingDir, 'screenshots');
    const screenshots = existsSync(screenshotsDir)
      ? readdirSync(screenshotsDir).filter(f => f.endsWith('.png'))
      : [];

    // Get spec file content
    const specPath = join(recordingDir, 'test.spec.ts');
    const specContent = existsSync(specPath)
      ? readFileSync(specPath, 'utf8')
      : null;

    return c.json({
      session,
      screenshots,
      specCode: specContent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Save edited Playwright spec code
app.put('/api/recorder/recordings/:id/spec', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const specCode = typeof body?.specCode === 'string' ? body.specCode : '';
    const { writeFileSync, existsSync: fsExistsSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingDir = join(homedir(), '.discoverylab', 'recordings', id);
    if (!fsExistsSync(recordingDir)) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    const specPath = join(recordingDir, 'test.spec.ts');
    mkdirSync(recordingDir, { recursive: true });
    writeFileSync(specPath, specCode, 'utf8');

    const placeholders = parseScriptPlaceholders(specCode);
    return c.json({ success: true, specPath, placeholders });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Run a recorded Playwright spec with project/script test variables
app.post('/api/recorder/recordings/:id/run', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const headless = body?.headless !== false ? true : false;
    const timeout = Number.isFinite(Number(body?.timeout)) ? Number(body.timeout) : undefined;
    const browser = body?.browser === 'firefox' || body?.browser === 'webkit' || body?.browser === 'chromium'
      ? body.browser
      : undefined;
    const { readFileSync, existsSync: fsExistsSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingDir = join(homedir(), '.discoverylab', 'recordings', id);
    const specPath = join(recordingDir, 'test.spec.ts');
    if (!fsExistsSync(recordingDir) || !fsExistsSync(specPath)) {
      return c.json({ error: 'Recording spec not found' }, 404);
    }

    const specCode = readFileSync(specPath, 'utf8');
    const resolved = await resolveExecutionVariablesForScript({
      ownerType: 'web-recording',
      ownerId: id,
      platform: 'web',
      code: specCode,
    });
    const applied = applyPlaywrightScriptPlaceholderValues(specCode, resolved.envMap);

    if (applied.missingKeys.length > 0) {
      return c.json({
        error: 'Missing required test variables',
        placeholders: applied.placeholders,
        usedKeys: applied.usedKeys,
        missingKeys: applied.missingKeys,
        envTest: resolved.envTestText,
      }, 400);
    }

    const runtimeDir = join(recordingDir, '.runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const runStamp = Date.now();
    const runtimeSpecPath = join(runtimeDir, `test.runtime.${runStamp}.spec.ts`);
    const runtimeEnvPath = join(runtimeDir, `.env.test.${runStamp}`);
    writeFileSync(runtimeSpecPath, applied.code, 'utf8');
    writeFileSync(runtimeEnvPath, resolved.envTestText || '', 'utf8');

    const result = await runPlaywrightTest({
      testPath: runtimeSpecPath,
      workers: 1,
      retries: 0,
      env: resolved.envMap,
      config: {
        browser,
        headless,
        timeout,
        video: body?.video === 'on' || body?.video === 'retain-on-failure' ? body.video : 'retain-on-failure',
        screenshot: body?.screenshot === 'on' || body?.screenshot === 'only-on-failure' ? body.screenshot : 'only-on-failure',
        trace: body?.trace === 'on' || body?.trace === 'retain-on-failure' ? body.trace : 'retain-on-failure',
      },
      outputDir: join(recordingDir, 'playwright-runs', String(runStamp)),
      reporter: 'json',
    });

    return c.json({
      success: result.success,
      result,
      placeholders: applied.placeholders,
      usedKeys: applied.usedKeys,
      missingKeys: applied.missingKeys,
      runtimeSpecPath,
      runtimeEnvPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Delete recording by ID
app.delete('/api/recorder/recordings/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { rmSync, existsSync: fsExistsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingDir = join(homedir(), '.discoverylab', 'recordings', id);

    if (!fsExistsSync(recordingDir)) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    // Delete the recording directory
    rmSync(recordingDir, { recursive: true, force: true });

    // Also delete associated project from database
    const db = getDatabase();
    await db.delete(frames).where(eq(frames.projectId, id));
    await db.delete(projects).where(eq(projects.id, id));
    await deleteTestVariablesForOwner('web-recording', id);
    await deleteTestVariablesForOwner('project', id);

    // Delete project directory if it exists
    const projectDir = join(PROJECTS_DIR, id);
    if (fsExistsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }

    console.log(`[Delete] Removed web recording and project: ${id}`);

    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Delete all recordings (web and mobile)
app.delete('/api/recorder/recordings', async (c) => {
  try {
    const { rmSync, existsSync: fsExistsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const deletedIds: string[] = [];

    // Delete web recordings
    const recordingsDir = join(homedir(), '.discoverylab', 'recordings');
    if (fsExistsSync(recordingsDir)) {
      const dirs = readdirSync(recordingsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const dir of dirs) {
        rmSync(join(recordingsDir, dir), { recursive: true, force: true });
        deletedIds.push(dir);
      }
    }

    // Delete mobile recordings
    const mobileRecordingsDir = join(PROJECTS_DIR, 'maestro-recordings');
    if (fsExistsSync(mobileRecordingsDir)) {
      const dirs = readdirSync(mobileRecordingsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const dir of dirs) {
        rmSync(join(mobileRecordingsDir, dir), { recursive: true, force: true });
        deletedIds.push(dir);
      }
    }

    // Delete associated projects from database
    if (deletedIds.length > 0) {
      const db = getDatabase();
      for (const id of deletedIds) {
        await db.delete(frames).where(eq(frames.projectId, id));
        await db.delete(projects).where(eq(projects.id, id));
        await deleteTestVariablesForOwner('web-recording', id);
        await deleteTestVariablesForOwner('mobile-recording', id);
        await deleteTestVariablesForOwner('project', id);

        // Also delete project directory if it exists
        const projectDir = join(PROJECTS_DIR, id);
        if (fsExistsSync(projectDir)) {
          rmSync(projectDir, { recursive: true, force: true });
        }
      }
    }

    console.log(`[Delete] Removed ${deletedIds.length} recordings and associated projects`);

    return c.json({ success: true, deleted: deletedIds.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Serve recording screenshots by sessionId
app.get('/api/recorder/screenshots/:sessionId/:filename', async (c) => {
  try {
    const { sessionId, filename } = c.req.param();
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const filePath = join(homedir(), '.discoverylab', 'recordings', sessionId, 'screenshots', filename);

    if (!existsSync(filePath)) {
      return c.json({ error: 'Screenshot not found' }, 404);
    }

    const buffer = readFileSync(filePath);
    return new Response(buffer, {
      headers: { 'Content-Type': 'image/png' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Serve screenshot by filename (searches all recordings)
app.get('/api/recorder/screenshot/:filename', async (c) => {
  try {
    const { filename } = c.req.param();
    const { readFileSync, existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingsDir = join(homedir(), '.discoverylab', 'recordings');

    if (!existsSync(recordingsDir)) {
      return c.json({ error: 'No recordings directory' }, 404);
    }

    // Search through all recording directories for the screenshot
    const sessions = readdirSync(recordingsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const sessionId of sessions) {
      const filePath = join(recordingsDir, sessionId, 'screenshots', filename);
      if (existsSync(filePath)) {
        const buffer = readFileSync(filePath);
        return new Response(buffer, {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }
    }

    return c.json({ error: 'Screenshot not found' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Create project from recording
app.post('/api/recorder/recordings/:id/create-project', async (c) => {
  try {
    const { id } = c.req.param();
    const { readFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } = await import('node:fs');
    const { join, basename } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingDir = join(homedir(), '.discoverylab', 'recordings', id);
    const sessionPath = join(recordingDir, 'session.json');

    if (!existsSync(sessionPath)) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    const sessionData = JSON.parse(readFileSync(sessionPath, 'utf8'));
    const sessionName = sessionData?.name || sessionData?.session?.name || `Recording ${id}`;
    const recordingUrl = getRecordingSessionFinalUrl(sessionData);
    const faviconCoverPath = await createWebFaviconCover({
      pageUrl: recordingUrl,
      outputDir: recordingDir,
    });

    // Create project in database
    const sqlite = getSqlite();
    const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    sqlite.prepare(`
      INSERT INTO projects (id, name, video_path, platform, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      sessionName,
      recordingDir,
      'web',
      'ready',
      now,
      now
    );

    // Copy screenshots to project frames directory
    const framesDir = join(DATA_DIR, 'projects', projectId, 'frames');
    mkdirSync(framesDir, { recursive: true });

    const screenshotsDir = join(recordingDir, 'screenshots');
    let thumbnailPath: string | null = null;
    let frameCount = 0;

    if (existsSync(screenshotsDir)) {
      const screenshots = readdirSync(screenshotsDir).filter(f => f.endsWith('.png')).sort();
      frameCount = screenshots.length;

      screenshots.forEach((file, index) => {
        const src = join(screenshotsDir, file);
        const dest = join(framesDir, `frame_${(index + 1).toString().padStart(4, '0')}.png`);
        copyFileSync(src, dest);

        // Use first screenshot as thumbnail
        if (index === 0) {
          thumbnailPath = dest;
        }

        // Insert frame record
        const frameId = `frame_${projectId}_${(index + 1).toString().padStart(4, '0')}`;
        sqlite.prepare(`
          INSERT INTO frames (id, project_id, frame_number, timestamp, image_path, is_key_frame, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          frameId,
          projectId,
          index + 1,
          index * 1.0, // timestamp placeholder
          dest,
          index === 0 ? 1 : 0, // first frame is key frame
          now
        );
      });

      // Update project with thumbnail and frame count
      sqlite.prepare(`
        UPDATE projects SET thumbnail_path = ?, frame_count = ?, updated_at = ? WHERE id = ?
      `).run(faviconCoverPath || thumbnailPath, frameCount, now, projectId);
    }

    if (faviconCoverPath && !thumbnailPath) {
      sqlite.prepare(`
        UPDATE projects SET thumbnail_path = ?, updated_at = ? WHERE id = ?
      `).run(faviconCoverPath, now, projectId);
    }

    // Trigger OCR analysis if we have screenshots
    let ocrInProgress = false;
    if (frameCount > 0 && existsSync(screenshotsDir)) {
      const screenshotFiles = readdirSync(screenshotsDir).filter(f => f.endsWith('.png')).sort();
      if (screenshotFiles.length > 0) {
        sqlite.prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE id = ?`).run('analyzing', Date.now(), projectId);
        ocrInProgress = true;
        runOCRInBackgroundWithWatchdog(projectId, screenshotsDir, screenshotFiles, 'CreateProject');
      }
    }

    return c.json({
      success: true,
      projectId,
      frameCount,
      ocrInProgress,
      message: 'Project created from recording',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Broadcast message to all WebSocket clients
function broadcastToClients(message: any): void {
  const data = JSON.stringify(message);
  wsClients.forEach(client => {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    } catch (err) {
      console.error('[WebSocket] Failed to send to client, removing:', err);
      wsClients.delete(client);
    }
  });
}

// ============================================================================
// LIVE SCREEN STREAMING
// ============================================================================

let liveStreamInterval: NodeJS.Timeout | null = null;
let liveStreamPlatform: 'ios' | 'android' | null = null;
let liveStreamDeviceId: string | null = null;
let liveStreamInteractiveMode: boolean = false; // When true, tap events have visual feedback

// Maestro tap mutex - prevents concurrent Maestro executions that cause log file conflicts
let maestroTapLock: Promise<void> = Promise.resolve();
function acquireMaestroTapLock(): { release: () => void; acquired: Promise<void> } {
  let release: () => void = () => {};
  const acquired = new Promise<void>((resolve) => {
    maestroTapLock = maestroTapLock.then(() => {
      resolve();
      return new Promise<void>((r) => { release = r; });
    });
  });
  return { release, acquired };
}

async function captureAndBroadcastScreen(): Promise<void> {
  if (!liveStreamPlatform) return;

  try {
    let base64Image: string;

    if (liveStreamPlatform === 'ios') {
      // iOS: capture to stdout as PNG
      const target = liveStreamDeviceId || 'booted';
      const buffer = execSync(`xcrun simctl io "${target}" screenshot --type=png --display=internal -`, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 3000,
      });
      base64Image = buffer.toString('base64');
    } else {
      // Android: capture to stdout
      const deviceArg = liveStreamDeviceId ? `-s ${liveStreamDeviceId}` : '';
      const adbPath = ADB_PATH || 'adb';
      const buffer = execSync(`"${adbPath}" ${deviceArg} exec-out screencap -p`, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 3000,
      });
      base64Image = buffer.toString('base64');
    }

    broadcastToClients({
      type: 'liveFrame',
      data: {
        image: base64Image,
        platform: liveStreamPlatform,
        timestamp: Date.now(),
      },
    });
  } catch (error) {
    // Silently ignore capture errors (device might be busy)
  }
}

/**
 * Get the bundle ID of the foreground app on iOS Simulator
 */
function getIOSForegroundAppId(deviceId: string): string | null {
  try {
    // Try to infer the frontmost app from all UIKitApplication entries.
    const output = execSync(
      `xcrun simctl spawn "${deviceId}" launchctl list 2>/dev/null | grep UIKitApplication`,
      { encoding: 'utf8', timeout: 3000 }
    );
    const matches = [...output.matchAll(/UIKitApplication:([^\[\s]+)/g)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => !!value);

    for (const bundleId of matches) {
      if (!isIgnoredMobileAppId(bundleId)) {
        return bundleId;
      }
    }

    return matches[0] || null;
  } catch {
    return null;
  }
}

/**
 * Get the package name of the foreground app on Android
 */
function getAndroidForegroundAppId(deviceId: string): string | null {
  if (!ADB_PATH) return null;
  try {
    const adbPath = ADB_PATH || 'adb';
    const output = execSync(
      `"${adbPath}" -s "${deviceId}" shell dumpsys window windows 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp" | head -1`,
      { encoding: 'utf8', timeout: 3000 }
    );

    // Example outputs:
    // mCurrentFocus=Window{... u0 com.example/.MainActivity}
    // mFocusedApp=AppWindowToken{... ActivityRecord{... com.example/.MainActivity}}
    const match = output.match(/([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.]+/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function getForegroundAppIdForPlatform(platform: 'ios' | 'android', deviceId: string): string | null {
  const detected = platform === 'ios'
    ? getIOSForegroundAppId(deviceId)
    : getAndroidForegroundAppId(deviceId);

  return isIgnoredMobileAppId(detected) ? null : detected;
}

/**
 * Bring the device emulator/simulator to foreground for faster testing
 */
async function bringDeviceToForeground(platform: 'ios' | 'android'): Promise<void> {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    if (platform === 'ios') {
      // Bring iOS Simulator to front using AppleScript
      await execAsync('osascript -e \'tell application "Simulator" to activate\'');
      console.log('[Focus] iOS Simulator brought to foreground');
    } else if (platform === 'android') {
      // For Android, try to focus the emulator window
      // First try using AppleScript on macOS
      try {
        await execAsync('osascript -e \'tell application "qemu-system-aarch64" to activate\' 2>/dev/null || osascript -e \'tell application "qemu-system-x86_64" to activate\' 2>/dev/null || true');
        console.log('[Focus] Android Emulator brought to foreground');
      } catch {
        // Fallback: try generic "Android Emulator" or "Emulator" app names
        try {
          await execAsync('osascript -e \'tell application "Android Emulator" to activate\' 2>/dev/null || true');
        } catch {
          // Silently ignore if we can't focus Android emulator
        }
      }
    }
  } catch (error) {
    // Silently ignore focus errors - not critical
    console.log(`[Focus] Could not bring ${platform} to foreground:`, error);
  }
}

function startLiveStream(platform: 'ios' | 'android', deviceId?: string): void {
  stopLiveStream(); // Stop any existing stream

  liveStreamPlatform = platform;
  liveStreamDeviceId = deviceId || null;

  // Note: Emulator stays in background during live stream
  // Foreground is only brought during screenshot capture

  // Wake/unlock Android screen to avoid black frames
  if (platform === 'android' && liveStreamDeviceId) {
    try {
      const adbPath = ADB_PATH || 'adb';
      execSync(`"${adbPath}" -s "${liveStreamDeviceId}" shell input keyevent 224`, { timeout: 2000 });
      execSync(`"${adbPath}" -s "${liveStreamDeviceId}" shell input keyevent 82`, { timeout: 2000 });
    } catch {}
  }

  // Capture at ~2 FPS (every 500ms) - balanced between smoothness and CPU usage
  liveStreamInterval = setInterval(captureAndBroadcastScreen, 500);

  broadcastToClients({
    type: 'liveStreamStarted',
    data: { platform, deviceId },
  });

  console.log(`[LiveStream] Started for ${platform}${deviceId ? ` (${deviceId})` : ''}`);
}

function stopLiveStream(): void {
  if (liveStreamInterval) {
    clearInterval(liveStreamInterval);
    liveStreamInterval = null;
  }
  liveStreamPlatform = null;
  liveStreamDeviceId = null;

  broadcastToClients({
    type: 'liveStreamStopped',
    data: {},
  });
}

// Start live stream endpoint
app.post('/api/live-stream/start', async (c) => {
  try {
    const body = await c.req.json();
    let { platform, deviceId } = body;

    if (!platform || !['ios', 'android'].includes(platform)) {
      return c.json({ error: 'Invalid platform. Must be "ios" or "android"' }, 400);
    }

    if (platform === 'android' && deviceId) {
      const resolvedSerial = resolveAndroidDeviceSerial(String(deviceId));
      if (!resolvedSerial) {
        return c.json({ error: `Android device "${deviceId}" not found` }, 400);
      }
      deviceId = resolvedSerial;
    }

    if (platform === 'android' && !deviceId) {
      try {
        const adbPath = ADB_PATH || 'adb';
        const adbOutput = execSync(`"${adbPath}" devices -l`, { encoding: 'utf8' });
        const lines = adbOutput.split('\n').slice(1);
        for (const line of lines) {
          if (line.includes('device') && !line.includes('offline')) {
            const parts = line.split(/\s+/);
            deviceId = parts[0];
            break;
          }
        }
      } catch {}
    }

    if (platform === 'ios' && !deviceId) {
      try {
        const simOutput = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
        const simData = JSON.parse(simOutput);
        for (const [, devices] of Object.entries(simData.devices) as any) {
          for (const device of devices) {
            if (device.state === 'Booted') {
              deviceId = device.udid;
              break;
            }
          }
          if (deviceId) break;
        }
      } catch {}
    }

    if (platform === 'android' && !deviceId) {
      return c.json({ error: 'No Android device connected' }, 400);
    }

    if (platform === 'ios' && !deviceId) {
      return c.json({ error: 'No iOS simulator booted' }, 400);
    }

    startLiveStream(platform, deviceId);

    return c.json({ success: true, message: 'Live stream started' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Stop live stream endpoint
app.post('/api/live-stream/stop', async (c) => {
  stopLiveStream();
  liveStreamInteractiveMode = false;
  return c.json({ success: true, message: 'Live stream stopped' });
});

// Toggle interactive mode for live stream (enables tap feedback)
app.post('/api/live-stream/interactive', async (c) => {
  try {
    const body = await c.req.json();
    const { enable } = body;

    liveStreamInteractiveMode = Boolean(enable);

    // Broadcast mode change to clients
    broadcastToClients({
      type: 'interactiveModeChanged',
      data: {
        enabled: liveStreamInteractiveMode,
        platform: liveStreamPlatform,
        deviceId: liveStreamDeviceId
      }
    });

    return c.json({
      success: true,
      interactiveMode: liveStreamInteractiveMode,
      message: liveStreamInteractiveMode ? 'Interactive mode enabled - taps will have visual feedback' : 'Interactive mode disabled'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get live stream status
app.get('/api/live-stream/status', async (c) => {
  const recorder = getMaestroRecorder();
  const isRecording = recorder.isRecording();

  return c.json({
    active: liveStreamPlatform !== null,
    platform: liveStreamPlatform,
    deviceId: liveStreamDeviceId,
    interactiveMode: liveStreamInteractiveMode,
    recording: isRecording,
    mode: isRecording ? 'recording' : (liveStreamInteractiveMode ? 'interactive' : 'view')
  });
});

// ============================================================================
// REMOTION TEMPLATES
// ============================================================================

// Get template status
app.get('/api/templates/status', async (c) => {
  const installed = isTemplatesInstalled();
  const templates = getAvailableTemplates();
  return c.json({
    available: installed,
    templates: templates.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      resolution: `${t.width}x${t.height}`,
      fps: t.fps,
    })),
  });
});

// Assemble template props for a project
app.post('/api/templates/props', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, templateId } = body;

    if (!projectId || !templateId) {
      return c.json({ error: 'projectId and templateId are required' }, 400);
    }

    const db = getDatabase();
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const templateState = getTemplateProjectState(project);
    if (!templateState) {
      return c.json({ error: 'Project has no video to render' }, 400);
    }

    return c.json(templateState);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get all captured network routes for route checklist
app.get('/api/projects/:id/network-routes', async (c) => {
  try {
    const id = c.req.param('id');
    const db = getDatabase();
    const project = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const networkEntries = loadProjectNetworkData(project);
    if (!networkEntries || networkEntries.length === 0) {
      return c.json({ routes: [] });
    }

    // Group by METHOD + normalized route label.
    const groups = new Map<string, any[]>();
    for (const entry of networkEntries) {
      const routeLabel = resolveNetworkRouteLabel(entry);
      const method = (entry.method || 'GET').toUpperCase();
      const key = `${method} ${routeLabel}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(entry);
    }

    // Load current terminalTabs to mark selected
    const editedContent = loadEditedTemplateContent(id);
    const currentLabels = new Set((editedContent?.terminalTabs || []).map((t: any) => t.label));

    // Sort by count desc
    const routes = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([key, entries]) => {
        const [method, ...routeParts] = key.split(' ');
        const route = routeParts.join(' ');
        return {
          label: key,
          method,
          route,
          count: entries.length,
          selected: currentLabels.has(key),
          content: JSON.stringify(
            entries.slice(0, 5).map((e: any) => ({
              status: e.status,
              durationMs: e.durationMs,
              url: resolveNetworkDisplayUrl(e),
            })),
            null,
            2
          ),
        };
      });

    return c.json({ routes });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Update editable terminal content for a project
app.put('/api/projects/:id/template-content', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const { title, titleLines, terminalTabs, showcaseMode, deviceMockup } = body;

    const db = getDatabase();
    const project = db.select().from(projects).where(eq(projects.id, id)).get();
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const defaultTitle = sanitizeTemplateTitle(
      extractFirstSentence(project.aiSummary || project.name || 'App Recording'),
      'App Recording'
    );
    const sanitizedTitle = sanitizeTemplateTitle(title, defaultTitle);
    const sanitizedTitleLines = sanitizeTemplateTitleLines(titleLines, sanitizedTitle);
    const sanitizedTerminalTabs = sanitizeTemplateTerminalTabs(terminalTabs);
    const sanitizedShowcaseMode = showcaseMode === 'artistic' || showcaseMode === 'terminal'
      ? showcaseMode
      : undefined;
    const platform = (project.platform === 'ios' || project.platform === 'android' || project.platform === 'web')
      ? project.platform
      : 'web';
    const availableAndroidMockups = listAndroidDeviceMockupIds();
    const sanitizedDeviceMockup = platform === 'android'
      ? resolveAndroidDeviceMockup(deviceMockup, availableAndroidMockups)
      : undefined;
    const savedContent = {
      title: sanitizedTitle,
      titleLines: sanitizedTitleLines,
      terminalTabs: sanitizedTerminalTabs,
      showcaseMode: sanitizedShowcaseMode,
      deviceMockup: sanitizedDeviceMockup,
      updatedAt: new Date().toISOString(),
    };

    const { writeFileSync, mkdirSync } = await import('node:fs');
    const projectDir = join(PROJECTS_DIR, id);
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }
    const contentPath = join(projectDir, 'template-content.json');
    writeFileSync(contentPath, JSON.stringify(savedContent));

    return c.json({ success: true, message: 'Template content saved', content: savedContent });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Start template render
app.post('/api/templates/render', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, templateId } = body;

    if (!projectId || !templateId) {
      return c.json({ error: 'projectId and templateId are required' }, 400);
    }

    if (!isTemplatesInstalled()) {
      return c.json({ error: 'Templates not installed' }, 400);
    }

    const db = getDatabase();
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const templateState = getTemplateProjectState(project);
    if (!templateState) {
      return c.json({ error: 'Project has no video to render' }, 400);
    }
    if (!templateState.eligibility.templatesAllowed) {
      return c.json({ error: templateState.eligibility.reason || `Templates are limited to videos up to ${TEMPLATE_MAX_DURATION_SECONDS} seconds.` }, 400);
    }

    const { props } = templateState;

    // Check if a cached render exists (skip re-render if no changes)
    const forceRender = body.force === true;
    if (!forceRender) {
      const cached = getCachedRender(projectId, templateId as TemplateId);
      if (cached && existsSync(cached)) {
        return c.json({
          jobId: 'cached',
          status: 'completed',
          outputPath: cached,
          downloadUrl: `/api/file?path=${encodeURIComponent(cached)}&download=true`,
          previewUrl: `/api/file?path=${encodeURIComponent(cached)}`,
          cached: true,
        });
      }
    }

    const job = await startRender(projectId, templateId as TemplateId, props, (progress) => {
      broadcastToClients({
        type: 'templateRenderProgress',
        data: { projectId, templateId, progress },
      });
    });

    // Broadcast completion when done
    const checkCompletion = setInterval(() => {
      const currentJob = getRenderJob(job.id);
      if (currentJob && (currentJob.status === 'done' || currentJob.status === 'error')) {
        clearInterval(checkCompletion);
        broadcastToClients({
          type: 'templateRenderComplete',
          data: {
            projectId,
            templateId,
            status: currentJob.status,
            outputPath: currentJob.outputPath,
            error: currentJob.error,
          },
        });
      }
    }, 1000);

    return c.json({ jobId: job.id, status: job.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get render job status
app.get('/api/templates/render/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const job = getRenderJob(jobId);
  if (!job) {
    return c.json({ error: 'Render job not found' }, 404);
  }
  return c.json({
    status: job.status,
    progress: job.progress,
    outputPath: job.outputPath,
    error: job.error,
  });
});

// Serve template bundle static files (for @remotion/player iframe)
app.get('/api/templates/player/*', async (c) => {
  const bundlePath = getBundlePath();
  if (!bundlePath) {
    return c.json({ error: 'Templates not installed' }, 404);
  }

  const requestedPath = c.req.path.replace('/api/templates/player/', '');
  const filePath = join(bundlePath, requestedPath || 'index.html');

  if (!existsSync(filePath)) {
    return c.json({ error: 'File not found' }, 404);
  }

  const content = readFileSync(filePath);
  const ext = filePath.split('.').pop()?.toLowerCase();
  const contentTypes: Record<string, string> = {
    html: 'text/html',
    js: 'application/javascript',
    css: 'text/css',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    svg: 'image/svg+xml',
    woff2: 'font/woff2',
    woff: 'font/woff',
    mp4: 'video/mp4',
  };
  const contentType = contentTypes[ext || ''] || 'application/octet-stream';

  return new Response(content, {
    headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' },
  });
});

// Template preference (favorite template)
app.put('/api/settings/template-preference', async (c) => {
  try {
    const body = await c.req.json();
    const { favoriteTemplate } = body;

    const db = getDatabase();
    const sqlite = getSqlite();

    // Use settings table for template preference
    sqlite.exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('favoriteTemplate', '${favoriteTemplate || ''}')`);

    return c.json({ success: true, favoriteTemplate });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.get('/api/settings/template-preference', async (c) => {
  try {
    const sqlite = getSqlite();
    const row = sqlite.prepare(`SELECT value FROM settings WHERE key = 'favoriteTemplate'`).get() as any;
    return c.json({
      favoriteTemplate: row?.value || null,
    });
  } catch {
    return c.json({ favoriteTemplate: null });
  }
});

/**
 * Assemble TemplateProps from a project record
 */
function assembleTemplateProps(project: any): TemplateProps | null {
  const resolvedVideoPath = resolveTemplateVideoPath(project);
  if (!resolvedVideoPath) {
    return null;
  }

  const defaultTitle = sanitizeTemplateTitle(
    extractFirstSentence(project.aiSummary || project.name || 'App Recording'),
    'App Recording'
  );
  const subtitle = project.name || undefined;

  // Try to load edited template content first
  const editedContent = loadEditedTemplateContent(project.id);
  const availableAndroidMockups = listAndroidDeviceMockupIds();

  let title = defaultTitle;
  let titleLines: string[] | undefined;
  let terminalTabs: TerminalTab[] = [];
  let hasNetworkData = false;
  let showcaseMode: 'artistic' | 'terminal' | undefined;
  let deviceMockup: string | undefined;

  if (editedContent) {
    title = sanitizeTemplateTitle(editedContent.title || defaultTitle, defaultTitle);
    titleLines = sanitizeTemplateTitleLines(editedContent.titleLines, title);
    terminalTabs = sanitizeTemplateTerminalTabs(editedContent.terminalTabs);
    hasNetworkData = terminalTabs.length > 0;
    showcaseMode = editedContent.showcaseMode;
  } else {
    // Try to load network data from session.json
    const networkEntries = loadProjectNetworkData(project);

    if (networkEntries && networkEntries.length > 0) {
      hasNetworkData = true;
      terminalTabs = groupNetworkIntoTabs(networkEntries);
    }
    // No fallback — if no network data, terminalTabs stays empty
  }

  // Determine platform
  const platform = (project.platform === 'ios' || project.platform === 'android' || project.platform === 'web')
    ? project.platform
    : 'web';
  if (platform === 'android') {
    deviceMockup = resolveAndroidDeviceMockup(editedContent?.deviceMockup, availableAndroidMockups);
  }
  if (!titleLines && (!showcaseMode || showcaseMode === 'artistic') && !hasNetworkData) {
    titleLines = splitTemplateTitleIntoLines(title);
  }

  const videoDuration = getActualTemplateVideoDuration(project, resolvedVideoPath);

  // Use full HTTP URL so Remotion's headless browser can fetch the video
  const videoUrl = `http://localhost:${currentServerPort}/api/file?path=${encodeURIComponent(resolvedVideoPath)}`;

  return {
    videoUrl,
    videoDuration,
    platform,
    title,
    titleLines,
    subtitle,
    terminalTabs,
    hasNetworkData,
    showcaseMode,
    deviceMockup,
  };
}

type EditedTemplateContent = {
  title?: string;
  titleLines?: string[];
  terminalTabs?: TerminalTab[];
  showcaseMode?: 'artistic' | 'terminal';
  deviceMockup?: string;
};

type TemplateEligibility = {
  templatesAllowed: boolean;
  maxTemplateDurationSeconds: number;
  actualDurationSeconds: number;
  reason?: string;
};

const TEMPLATE_MAX_DURATION_SECONDS = 60;
const DEFAULT_ANDROID_DEVICE_MOCKUP = 'mockup-android-galaxy.png';
const ANDROID_DEVICE_MOCKUP_FALLBACKS = [
  DEFAULT_ANDROID_DEVICE_MOCKUP,
  'mockup-android-google-pixel-9-pro.png',
];

function getTemplateProjectState(project: any): {
  props: TemplateProps;
  eligibility: TemplateEligibility;
  androidDeviceMockups: Array<{ id: string; label: string }>;
  defaultAndroidDeviceMockup: string;
} | null {
  const props = assembleTemplateProps(project);
  if (!props) {
    return null;
  }
  const eligibility = buildTemplateEligibility(props.videoDuration);
  const androidDeviceMockups = listAndroidDeviceMockupIds().map((id) => ({
    id,
    label: formatAndroidDeviceMockupLabel(id),
  }));
  return {
    props,
    eligibility,
    androidDeviceMockups,
    defaultAndroidDeviceMockup: resolveAndroidDeviceMockup(undefined, androidDeviceMockups.map((option) => option.id)),
  };
}

function extractFirstSentence(text: string): string {
  if (!text) return 'App Recording';
  // Match first sentence ending with . ! or ?
  const match = text.match(/^[^.!?]*[.!?]/);
  if (match) return match[0].trim();
  // If no sentence terminator, take first 80 chars
  return text.substring(0, 80).trim();
}

function resolveTemplateVideoPath(project: any): string | null {
  const resolvedVideoPath = resolveVideoPath(project.videoPath);
  if (!resolvedVideoPath || !existsSync(resolvedVideoPath)) {
    return null;
  }

  try {
    if (statSync(resolvedVideoPath).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  return resolvedVideoPath;
}

function getActualTemplateVideoDuration(project: any, resolvedVideoPath: string): number {
  const probedDuration = probeVideoDurationSeconds(resolvedVideoPath);
  if (probedDuration && probedDuration > 0) {
    return probedDuration;
  }
  const projectDuration = Number(project?.duration);
  if (Number.isFinite(projectDuration) && projectDuration > 0) {
    return projectDuration;
  }
  return 0;
}

function probeVideoDurationSeconds(filePath: string): number | null {
  try {
    if (!existsSync(filePath)) return null;
    const output = execSync(
      `ffprobe -v quiet -print_format json -show_format "${filePath}"`,
      { encoding: 'utf-8', timeout: 10_000 }
    );
    const data = JSON.parse(output);
    const duration = parseFloat(data?.format?.duration || '0');
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

function buildTemplateEligibility(actualDurationSeconds: number): TemplateEligibility {
  const templatesAllowed = isTemplateDurationAllowed(actualDurationSeconds);
  return {
    templatesAllowed,
    maxTemplateDurationSeconds: TEMPLATE_MAX_DURATION_SECONDS,
    actualDurationSeconds,
    reason: templatesAllowed || actualDurationSeconds <= 0
      ? undefined
      : `Templates are limited to videos up to ${TEMPLATE_MAX_DURATION_SECONDS} seconds. This recording is ${formatTemplateDuration(actualDurationSeconds)}.`,
  };
}

function isTemplateDurationAllowed(actualDurationSeconds: number): boolean {
  if (!Number.isFinite(actualDurationSeconds) || actualDurationSeconds <= 0) {
    return true;
  }
  return Math.round(actualDurationSeconds * 1000) <= TEMPLATE_MAX_DURATION_SECONDS * 1000;
}

function formatTemplateDuration(actualDurationSeconds: number): string {
  if (!Number.isFinite(actualDurationSeconds) || actualDurationSeconds <= 0) {
    return 'unknown duration';
  }
  const totalSeconds = Math.max(1, Math.round(actualDurationSeconds));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${totalSeconds}s`;
}

function sanitizeTemplateTitle(value: unknown, fallback = 'App Recording'): string {
  const normalized = normalizeTemplateTitle(value);
  if (normalized) return normalized;
  const safeFallback = normalizeTemplateTitle(fallback);
  return safeFallback || 'App Recording';
}

function normalizeTemplateTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const withoutMarkdown = value
    .replace(/[#*_`~>\-[\]{}()<>\\/|]+/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutMarkdown) return '';

  const limitedWords = withoutMarkdown.split(' ').filter(Boolean).slice(0, 7).join(' ');
  if (!limitedWords) return '';
  if (limitedWords.length <= 48) return limitedWords;
  const truncated = limitedWords.slice(0, 48).trim();
  return truncated.replace(/\s+\S*$/, '').trim() || truncated;
}

function sanitizeTemplateTitleLines(value: unknown, fallbackTitle: string): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const cleaned = value
    .map((line) => sanitizeTemplateTitle(line, ''))
    .filter(Boolean)
    .slice(0, 4);
  if (cleaned.length > 0) {
    return cleaned;
  }
  return splitTemplateTitleIntoLines(fallbackTitle);
}

function splitTemplateTitleIntoLines(title: string): string[] | undefined {
  const words = title.split(' ').filter(Boolean);
  if (words.length === 0) return undefined;
  if (words.length <= 2) return [title];
  const lines: string[] = [];
  for (let index = 0; index < words.length && lines.length < 4; index += 2) {
    lines.push(words.slice(index, index + 2).join(' '));
  }
  return lines;
}

function sanitizeTemplateTerminalTabs(value: unknown): TerminalTab[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tab): TerminalTab | null => {
      if (!tab || typeof tab !== 'object') return null;
      const record = tab as Record<string, unknown>;
      const label = typeof record.label === 'string' ? record.label.trim() : '';
      const methodFromLabel = label.split(' ')[0] || 'GET';
      const routeFromLabel = label.split(' ').slice(1).join(' ') || '/';
      const method = typeof record.method === 'string' && record.method.trim()
        ? record.method.trim().toUpperCase()
        : methodFromLabel.toUpperCase();
      const route = typeof record.route === 'string' && record.route.trim()
        ? record.route.trim()
        : routeFromLabel;
      const content = typeof record.content === 'string' ? record.content : '';
      if (!label && !content.trim()) return null;
      return {
        label: label || `${method} ${route}`.trim(),
        method: method || 'GET',
        route: route || '/',
        content,
      };
    })
    .filter((tab): tab is TerminalTab => !!tab);
}

function listAndroidDeviceMockupIds(): string[] {
  const bundlePath = getBundlePath();
  if (!bundlePath) {
    return [...ANDROID_DEVICE_MOCKUP_FALLBACKS];
  }
  const publicDir = join(bundlePath, 'public');
  if (!existsSync(publicDir)) {
    return [...ANDROID_DEVICE_MOCKUP_FALLBACKS];
  }
  const files = readdirSync(publicDir)
    .filter((file) => /^mockup-android.*\.png$/i.test(file));
  const unique = new Set<string>(files.length > 0 ? files : ANDROID_DEVICE_MOCKUP_FALLBACKS);
  return [...unique].sort((left, right) => {
    const leftIndex = ANDROID_DEVICE_MOCKUP_FALLBACKS.indexOf(left);
    const rightIndex = ANDROID_DEVICE_MOCKUP_FALLBACKS.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    }
    return left.localeCompare(right);
  });
}

function resolveAndroidDeviceMockup(requested: unknown, available: string[]): string {
  const candidate = typeof requested === 'string' ? requested.trim() : '';
  if (candidate && available.includes(candidate)) {
    return candidate;
  }
  for (const fallback of ANDROID_DEVICE_MOCKUP_FALLBACKS) {
    if (available.includes(fallback)) {
      return fallback;
    }
  }
  return available[0] || DEFAULT_ANDROID_DEVICE_MOCKUP;
}

function formatAndroidDeviceMockupLabel(filename: string): string {
  const base = filename.replace(/^mockup-android-?/i, '').replace(/\.png$/i, '');
  if (!base) return 'Android';
  return base
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isTunnelLikeNetworkEntry(entry: Partial<CapturedNetworkEntry> | null | undefined): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const method = typeof entry.method === 'string' ? entry.method.toUpperCase() : '';
  const resourceType = typeof (entry as any).resourceType === 'string'
    ? String((entry as any).resourceType).toLowerCase()
    : '';
  return method === 'CONNECT' || resourceType === 'connect_tunnel';
}

function resolveNetworkDisplayUrl(entry: Partial<CapturedNetworkEntry> | null | undefined): string {
  if (!entry || typeof entry !== 'object') return '/';

  const rawUrl = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return rawUrl;
    }
  }

  const origin = typeof entry.origin === 'string' ? entry.origin.trim() : '';
  const pathname = typeof entry.pathname === 'string' && entry.pathname.trim()
    ? entry.pathname.trim()
    : '/';
  return `${origin}${pathname}` || pathname || '/';
}

function resolveNetworkRouteLabel(entry: Partial<CapturedNetworkEntry> | null | undefined): string {
  if (!entry || typeof entry !== 'object') return '/';

  if (isTunnelLikeNetworkEntry(entry)) {
    const hostname = typeof entry.hostname === 'string' ? entry.hostname.trim() : '';
    if (hostname) return hostname;

    const displayUrl = resolveNetworkDisplayUrl(entry);
    try {
      const parsed = new URL(displayUrl);
      if (parsed.hostname) return parsed.hostname;
    } catch {
      // Fall through to the raw display URL below.
    }
    if (displayUrl) return displayUrl;
  }

  const pathname = typeof entry.pathname === 'string' ? entry.pathname.trim() : '';
  if (pathname) return pathname;

  const rawUrl = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (rawUrl) {
    try {
      return new URL(rawUrl).pathname || '/';
    } catch {
      return rawUrl;
    }
  }

  return '/';
}

const MOBILE_SYSTEM_BACKGROUND_HOST_PATTERNS = [
  /(^|\.)icloud\.com$/i,
  /^gdmf\.apple\.com$/i,
  /^configuration\.ls\.apple\.com$/i,
  /^xp\.apple\.com$/i,
  /(^|\.)sandbox\.itunes\.apple\.com$/i,
  /(^|\.)sandbox\.apple\.com$/i,
  /(^|\.)mzstatic\.com$/i,
];

const MOBILE_DEVELOPER_BACKGROUND_HOST_PATTERNS = [
  /^main\.vscode-cdn\.net$/i,
  /^default\.exp-tas\.com$/i,
  /(^|\.)chatgpt\.com$/i,
  /(^|\.)openai\.com$/i,
  /(^|\.)figma\.com$/i,
  /(^|\.)modal\.com$/i,
];

function getNetworkEntryUserAgent(entry: Partial<CapturedNetworkEntry> | null | undefined): string {
  if (!entry || typeof entry !== 'object') return '';
  const requestHeaders = entry.requestHeaders && typeof entry.requestHeaders === 'object'
    ? entry.requestHeaders
    : null;
  const userAgent = (requestHeaders as Record<string, string | undefined> | null)?.['user-agent']
    || (requestHeaders as Record<string, string | undefined> | null)?.['User-Agent'];
  return typeof userAgent === 'string' ? userAgent : '';
}

function isDesktopNetworkUserAgent(userAgent: string): boolean {
  if (/\b(electron|code\/|vscode|xcode|exp-tas)\b/i.test(userAgent)) return true;
  const hasDesktopOs = /\b(Macintosh|Windows NT|X11; Linux)\b/i.test(userAgent);
  const hasDesktopBrowser = /\b(Chrome\/|CriOS\/|Firefox\/|Safari\/)\b/i.test(userAgent);
  return hasDesktopOs && hasDesktopBrowser;
}

function isMobileFocusedNetworkCapture(session: any): boolean {
  if (!session || (session.platform !== 'ios' && session.platform !== 'android')) return false;
  const network = session.esvp && typeof session.esvp === 'object' && session.esvp.network && typeof session.esvp.network === 'object'
    ? session.esvp.network
    : null;
  const captureMode = typeof network?.captureProxy?.captureMode === 'string'
    ? network.captureProxy.captureMode
    : typeof network?.effectiveProfile?.capture?.mode === 'string'
      ? network.effectiveProfile.capture.mode
      : typeof network?.activeProfile?.capture?.mode === 'string'
        ? network.activeProfile.capture.mode
        : '';
  return captureMode === 'external-proxy' || captureMode === 'external-mitm' || captureMode === 'app-http-trace';
}

function filterFocusedMobileNetworkEntries(entries: CapturedNetworkEntry[]): CapturedNetworkEntry[] {
  const decryptedHosts = new Set(
    entries
      .filter((entry) => !isTunnelLikeNetworkEntry(entry))
      .map((entry) => String(entry.hostname || '').trim().toLowerCase())
      .filter(Boolean)
  );

  return entries.filter((entry) => {
    const hostname = String(entry.hostname || '').trim().toLowerCase();
    const userAgent = getNetworkEntryUserAgent(entry);
    const failureText = String(entry.failureText || '').trim().toLowerCase();

    if (MOBILE_DEVELOPER_BACKGROUND_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) return false;
    if (MOBILE_SYSTEM_BACKGROUND_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) return false;
    if (isDesktopNetworkUserAgent(userAgent)) return false;

    if (isTunnelLikeNetworkEntry(entry)) {
      if (hostname && decryptedHosts.has(hostname)) return false;
      if (failureText.includes('certificateunknown') || failureText.includes('tls handshake eof')) return false;
    }

    return true;
  });
}

function groupNetworkIntoTabs(entries: CapturedNetworkEntry[]): TerminalTab[] {
  const groups = new Map<string, CapturedNetworkEntry[]>();

  for (const entry of entries) {
    // Build route key from method + normalized route label.
    const routeLabel = resolveNetworkRouteLabel(entry);
    const method = (entry.method || 'GET').toUpperCase();
    const key = `${method} ${routeLabel}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(entry);
  }

  // Sort by count descending, take top 8
  const sorted = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8);

  return sorted.map(([key, groupEntries]) => {
    const [method, ...routeParts] = key.split(' ');
    const route = routeParts.join(' ');
    const maxContentChars = 300;
    const fullContent = JSON.stringify(
      groupEntries.map((e) => ({
        status: e.status,
        durationMs: e.durationMs,
        responseSize: (e as any).responseSize || undefined,
        url: resolveNetworkDisplayUrl(e),
      })),
      null,
      2
    );
    // Truncate content to fit within typewriter timing
    const content = fullContent.length > maxContentChars
      ? fullContent.slice(0, maxContentChars) + '\n  ...\n]'
      : fullContent;
    return { label: key, method, route, content };
  });
}

function loadEditedTemplateContent(projectId: string): EditedTemplateContent | null {
  const contentPath = join(PROJECTS_DIR, projectId, 'template-content.json');
  if (!existsSync(contentPath)) return null;
  try {
    const raw = readFileSync(contentPath, 'utf-8');
    const data = JSON.parse(raw);
    return {
      title: data.title,
      titleLines: data.titleLines,
      terminalTabs: data.terminalTabs,
      showcaseMode: data.showcaseMode,
      deviceMockup: data.deviceMockup,
    };
  } catch {
    return null;
  }
}

function loadProjectNetworkData(project: any): CapturedNetworkEntry[] | null {
  // Source 1: session.json networkEntries for recordings with either legacy directory videoPath
  // or a direct file path.
  const recordingDir = resolveRecordingBaseDir(project.videoPath);
  if (recordingDir) {
    const sessionPath = join(recordingDir, 'session.json');
    if (existsSync(sessionPath)) {
      try {
        const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
        if (session.networkEntries && Array.isArray(session.networkEntries) && session.networkEntries.length > 0) {
          return isMobileFocusedNetworkCapture(session)
            ? filterFocusedMobileNetworkEntries(session.networkEntries)
            : session.networkEntries;
        }
      } catch { /* ignore */ }
    }
  }

  // Source 2: ESVP network data (if available as JSON string in project)
  try {
    if ((project as any).esvpData) {
      const esvpData = typeof (project as any).esvpData === 'string'
        ? JSON.parse((project as any).esvpData)
        : (project as any).esvpData;
      if (esvpData?.network && Array.isArray(esvpData.network) && esvpData.network.length > 0) {
        return esvpData.network;
      }
    }
  } catch { /* ignore */ }

  return null;
}

// ============================================================================
// SERVER START
// ============================================================================
let serverInstance: any = null;
let wss: WebSocketServer | null = null;
let currentServerPort: number = 3847;

export function getServerPort(): number {
  return currentServerPort;
}

export async function startServer(port: number = 3847): Promise<void> {
  currentServerPort = port;
  // Initialize database
  getDatabase();

  return new Promise((resolve) => {
    serverInstance = serve({
      fetch: app.fetch,
      port,
    }, () => {
      // Setup WebSocket server on a different port
      wss = new WebSocketServer({ port: port + 1 });

      wss.on('connection', (ws) => {
        wsClients.add(ws);
        console.log('WebSocket client connected');

        ws.on('close', () => {
          wsClients.delete(ws);
          console.log('WebSocket client disconnected');

          // Auto-stop live stream when all clients disconnect
          if (wsClients.size === 0 && liveStreamInterval) {
            console.log('[LiveStream] All clients disconnected, auto-stopping live stream');
            stopLiveStream();
          }
        });

        // Send current recorder status on connect
        const recorder = getRecorder();
        const session = recorder.getSession();
        if (session) {
          ws.send(JSON.stringify({
            type: 'session',
            data: session,
          }));
        }
      });

      resolve();
    });
  });
}

export function stopServer(): void {
  // Stop live stream and auto-capture intervals before closing
  stopLiveStream();
  if (autoCaptureInterval) {
    clearInterval(autoCaptureInterval);
    autoCaptureInterval = null;
  }

  if (wss) {
    wss.close();
    wss = null;
  }
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
}

export { app };
