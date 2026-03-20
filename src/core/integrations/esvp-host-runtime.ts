import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type RuntimeCaptureProxyState = {
  id: string;
  sessionId: string;
  active: boolean;
  bindHost: string;
  host: string;
  port: number | null;
  url: string | null;
  startedAt: string | null;
  entryCount: number;
  captureMode: 'external-proxy' | 'external-mitm';
  source: 'applab-external-proxy' | 'applab-external-mitm';
};

type RuntimeTracePayload = {
  trace_kind: 'http_trace';
  label: string;
  format: 'json';
  source: 'applab-external-proxy' | 'applab-external-mitm';
  payload: {
    session_id: string;
    proxy_id: string;
    generated_at: string;
    entries: Array<Record<string, unknown>>;
  };
  artifactMeta: {
    capture_mode: 'external-proxy' | 'external-mitm';
    proxy_id: string;
    entry_count: number;
  };
};

export type HostRuntimeMitmState = {
  enabled: boolean;
  rootCertPath?: string | null;
  platform?: string | null;
  deviceId?: string | null;
  certificateInstalled?: boolean;
  certificateInstallMethod?: string | null;
  warnings?: string[];
  errors?: string[];
};

type RuntimeHealthResponse = {
  ok: boolean;
  service: string;
  version: string;
  apiVersion: string;
  platform: string;
  arch: string;
  activeSessions: number;
  watchdog?: Record<string, unknown> | null;
};

type RuntimeLaunchCommand =
  | { kind: 'binary'; command: string; args: string[] }
  | { kind: 'cargo'; command: 'cargo'; args: string[] };

type RuntimeProcessState = {
  child: ChildProcess;
  command: RuntimeLaunchCommand;
  token: string;
  baseUrl: string;
  port: number;
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, '../../..');

export type HostRuntimeStartSessionInput = {
  sessionId: string;
  advertiseHost: string;
  bindHost: string;
  captureMode?: 'external-proxy' | 'external-mitm';
  maxDurationMs?: number | null;
  maxBodyCaptureBytes?: number;
  meta?: Record<string, unknown> | null;
};

export type HostRuntimeDrainResponse = {
  sessionId: string;
  captureProxy: RuntimeCaptureProxyState | null;
  trace: RuntimeTracePayload | null;
};

type HostRuntimeStartResponse = {
  sessionId: string;
  runtimeSessionId: string;
  captureProxy: RuntimeCaptureProxyState;
  mitm?: HostRuntimeMitmState | null;
};

type HostRuntimeSessionsResponse = {
  sessions: RuntimeCaptureProxyState[];
};

let runtimeState: RuntimeProcessState | null = null;
let runtimeStartPromise: Promise<RuntimeProcessState> | null = null;

export async function ensureHostRuntimeHealth(): Promise<RuntimeHealthResponse> {
  const runtime = await ensureRuntimeProcess();
  return runtimeRequest<RuntimeHealthResponse>(runtime, '/health', { method: 'GET' });
}

export async function startHostRuntimeCaptureSession(
  input: HostRuntimeStartSessionInput
): Promise<HostRuntimeStartResponse> {
  const runtime = await ensureRuntimeProcess();
  return runtimeRequest<HostRuntimeStartResponse>(runtime, '/sessions/start', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: input.sessionId,
      advertiseHost: input.advertiseHost,
      bindHost: input.bindHost,
      captureMode: input.captureMode || 'external-proxy',
      maxDurationMs: input.maxDurationMs ?? null,
      maxBodyCaptureBytes: input.maxBodyCaptureBytes ?? 16384,
      meta: input.meta || null,
    }),
  });
}

export async function drainHostRuntimeCaptureSession(sessionId: string): Promise<HostRuntimeDrainResponse> {
  const runtime = getRunningRuntimeProcess();
  if (!runtime) {
    throw new Error('ESVP host runtime is not running.');
  }
  return runtimeRequest<HostRuntimeDrainResponse>(runtime, `/sessions/${encodeURIComponent(sessionId)}/drain`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'manual-stop' }),
  });
}

export async function stopHostRuntimeCaptureSession(sessionId: string): Promise<any> {
  const runtime = getRunningRuntimeProcess();
  if (!runtime) {
    throw new Error('ESVP host runtime is not running.');
  }
  return runtimeRequest(runtime, `/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'manual-stop' }),
  });
}

export async function listHostRuntimeCaptureSessions(): Promise<RuntimeCaptureProxyState[]> {
  const runtime = getRunningRuntimeProcess();
  if (!runtime) return [];
  const response = await runtimeRequest<HostRuntimeSessionsResponse>(runtime, '/sessions', { method: 'GET' });
  return Array.isArray(response?.sessions) ? response.sessions : [];
}

export async function panicStopHostRuntime(reason = 'manual-emergency-stop'): Promise<any> {
  const runtime = getRunningRuntimeProcess();
  if (!runtime) {
    return {
      stopped: 0,
      sessions: [],
    };
  }
  return runtimeRequest(runtime, '/panic-stop', {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function shutdownHostRuntime(): Promise<void> {
  const runtime = runtimeState;
  runtimeState = null;
  runtimeStartPromise = null;
  if (!runtime) return;

  try {
    runtime.child.stdin?.end();
  } catch {
    // ignore
  }

  try {
    const exited = await waitForChildExit(runtime.child, 750);
    if (exited) return;
  } catch {
    // ignore
  }

  try {
    runtime.child.kill('SIGTERM');
  } catch {
    // ignore
  }
}

async function ensureRuntimeProcess(): Promise<RuntimeProcessState> {
  if (isRuntimeProcessAlive(runtimeState)) {
    return runtimeState;
  }
  if (runtimeStartPromise) return runtimeStartPromise;

  runtimeStartPromise = startRuntimeProcess().finally(() => {
    runtimeStartPromise = null;
  });
  runtimeState = await runtimeStartPromise;
  return runtimeState;
}

async function startRuntimeProcess(): Promise<RuntimeProcessState> {
  const port = await findFreePort();
  const token = randomToken();
  const launch = resolveRuntimeLaunchCommand();
  const args = [
    ...launch.args,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--token',
    token,
  ];

  const child = spawn(launch.command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  const state: RuntimeProcessState = {
    child,
    command: launch,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
  };

  child.stdout?.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) console.log(`[esvp-host-runtime] ${text}`);
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) console.error(`[esvp-host-runtime] ${text}`);
  });
  child.once('exit', () => {
    if (runtimeState?.child === child) {
      runtimeState = null;
    }
  });
  child.once('error', () => {
    if (runtimeState?.child === child) {
      runtimeState = null;
    }
  });

  try {
    await waitForRuntimeHealth(state);
  } catch (error) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    throw error;
  }
  return state;
}

function resolveRuntimeLaunchCommand(): RuntimeLaunchCommand {
  const binary = resolveBundledOrBuiltRuntimeBinary();
  if (binary) {
    return {
      kind: 'binary',
      command: binary,
      args: [],
    };
  }

  for (const root of resolveProjectRoots()) {
    const manifestPath = join(root, 'runtime', 'Cargo.toml');
    if (existsSync(manifestPath)) {
      return {
        kind: 'cargo',
        command: 'cargo',
        args: ['run', '--quiet', '--release', '--manifest-path', manifestPath, '-p', 'esvp-host-runtime', '--'],
      };
    }
  }

  throw new Error(
    'ESVP host runtime was not found. Build the Rust runtime or set DISCOVERYLAB_ESVP_HOST_RUNTIME_BIN.'
  );
}

function resolveBundledOrBuiltRuntimeBinary(): string | null {
  const explicit = normalizeOptionalString(process.env.DISCOVERYLAB_ESVP_HOST_RUNTIME_BIN);
  if (explicit && existsSync(explicit)) return explicit;

  const target = resolveTargetTriple();
  const binaryName = process.platform === 'win32' ? 'esvp-host-runtime.exe' : 'esvp-host-runtime';
  const rustTarget = resolveRustTargetTriple(target);
  const candidates = [
    join(homedir(), '.discoverylab', 'runtime', 'esvp-host-runtime', target, binaryName),
    ...resolveProjectRoots().flatMap((root) => [
      join(root, 'dist', 'runtime', 'esvp-host-runtime', target, binaryName),
      join(root, 'runtime', 'esvp-host-runtime', target, binaryName),
      join(root, 'runtime', 'target', rustTarget, 'release', binaryName),
      join(root, 'runtime', 'target', 'release', binaryName),
    ]),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveTargetTriple(): string {
  const platform = process.platform;
  const arch = normalizeTargetArch(process.arch);
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  throw new Error(`Unsupported platform/arch for ESVP host runtime: ${platform}/${arch}`);
}

function resolveRustTargetTriple(target: string): string {
  const mapping: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc',
  };
  const resolved = mapping[target];
  if (!resolved) {
    throw new Error(`Unsupported Rust target for ESVP host runtime: ${target}`);
  }
  return resolved;
}

async function waitForRuntimeHealth(runtime: RuntimeProcessState): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (runtime.child.exitCode != null) {
      throw new Error(`ESVP host runtime exited before becoming healthy (code ${runtime.child.exitCode}).`);
    }
    try {
      await runtimeRequest(runtime, '/health', { method: 'GET' }, 1500);
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`ESVP host runtime failed health checks: ${safeErrorMessage(lastError)}`);
}

async function runtimeRequest<T>(
  runtime: RuntimeProcessState,
  path: string,
  init: RequestInit,
  timeoutMs = 5000
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${runtime.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text.trim() ? tryParseJson(text) : null;
    if (!response.ok) {
      const message =
        (payload && typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).error || (payload as Record<string, unknown>).message
          : null) || `Host runtime request failed (${response.status})`;
      throw new Error(String(message));
    }
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`ESVP host runtime request timed out after ${timeoutMs}ms: ${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? Number(address.port) : NaN;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Number.isFinite(port) || port <= 0) {
          reject(new Error('Failed to allocate a free port for the ESVP host runtime.'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function randomToken(): string {
  return `rt_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function resolveProjectRoots(): string[] {
  return [...new Set([PROJECT_ROOT, process.cwd()])];
}

function normalizeTargetArch(arch: NodeJS.Architecture): NodeJS.Architecture {
  if (arch === 'x64') return 'x64';
  return arch;
}

function getRunningRuntimeProcess(): RuntimeProcessState | null {
  return isRuntimeProcessAlive(runtimeState) ? runtimeState : null;
}

function isRuntimeProcessAlive(runtime: RuntimeProcessState | null): runtime is RuntimeProcessState {
  return Boolean(runtime && runtime.child.exitCode == null && !runtime.child.killed);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const onError = () => {
      cleanup();
      resolve(true);
    };

    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
