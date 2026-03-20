import { networkInterfaces } from 'node:os';
import {
  attachESVPNetworkTrace,
  clearESVPNetwork,
  createESVPSession,
  finishESVPSession,
  type ESVPExecutor,
} from './esvp.js';
import {
  drainHostRuntimeCaptureSession,
  type HostRuntimeMitmState,
  panicStopHostRuntime,
  shutdownHostRuntime,
  startHostRuntimeCaptureSession,
} from './esvp-host-runtime.js';

type MobilePlatform = 'ios' | 'android';

type ProxyProfile = Record<string, unknown> | null;
type LocalCaptureProxyLifecycleConfig = {
  executor?: ESVPExecutor | string | null;
  deviceId?: string | null;
  serverUrl?: string;
  captureLogcat?: boolean;
  cleanupMeta?: Record<string, unknown>;
  maxDurationMs?: number | null;
};

export type LocalCaptureProxyState = {
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
  mitm?: HostRuntimeMitmState | null;
};

type TracePayload = {
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

export type LocalCaptureProxyFinalizationResult = {
  captureProxy: LocalCaptureProxyState | null;
  traceAttached: boolean;
  cleanupSessionId: string | null;
  clearResult: Record<string, unknown> | null;
  clearedAt: string | null;
  finishResult: Record<string, unknown> | null;
  errors: string[];
};

type ActiveProxyRecord = {
  sessionId: string;
  captureProxy: LocalCaptureProxyState;
  lifecycle: LocalCaptureProxyLifecycleConfig | null;
};

const activeProxies = new Map<string, ActiveProxyRecord>();
const finalizationsInFlight = new Map<string, Promise<LocalCaptureProxyFinalizationResult>>();
let cleanupRegistered = false;

export async function ensureLocalCaptureProxyProfile(input: {
  sessionId: string;
  profile: ProxyProfile;
  platform?: MobilePlatform | string | null;
  deviceId?: string | null;
  lifecycle?: LocalCaptureProxyLifecycleConfig | null;
  allowAppLabOwnedProxy?: boolean;
}): Promise<{
  profile: ProxyProfile;
  captureProxy: LocalCaptureProxyState | null;
  usesExternalProxy: boolean;
  appLabOwnedProxy: boolean;
}> {
  const profile = cloneProfile(input.profile);
  if (!profile) {
    return {
      profile,
      captureProxy: null,
      usesExternalProxy: false,
      appLabOwnedProxy: false,
    };
  }

  const captureMode = String((profile.capture as Record<string, unknown> | undefined)?.mode || '')
    .trim()
    .toLowerCase();
  const usesExternalProxy = captureMode === 'external-proxy';
  if (!usesExternalProxy) {
    return {
      profile,
      captureProxy: null,
      usesExternalProxy,
      appLabOwnedProxy: false,
    };
  }

  if (hasExplicitProxy(profile)) {
    return {
      profile,
      captureProxy: null,
      usesExternalProxy,
      appLabOwnedProxy: false,
    };
  }

  if (input.allowAppLabOwnedProxy === false) {
    throw new Error(
      'App Lab proxy emergency lock is enabled. Unlock it in Settings or provide an explicit external proxy host/port.'
    );
  }

  const proxy = await startLocalCaptureProxy({
    sessionId: input.sessionId,
    platform: input.platform,
    deviceId: input.deviceId,
    captureMode: resolveAppLabCaptureMode(profile),
    lifecycle: input.lifecycle || null,
  });
  profile.proxy = {
    host: proxy.host,
    port: proxy.port,
    protocol: 'http',
  };

  return {
    profile,
    captureProxy: proxy,
    usesExternalProxy,
    appLabOwnedProxy: true,
  };
}

export async function stopLocalCaptureProxy(sessionId: string): Promise<{
  captureProxy: LocalCaptureProxyState | null;
  trace: TracePayload | null;
}> {
  const existing = activeProxies.get(sessionId) || null;
  if (!existing) {
    return {
      captureProxy: null,
      trace: null,
    };
  }

  activeProxies.delete(sessionId);
  const drained = await drainHostRuntimeCaptureSession(sessionId).catch(() => null);
  return {
    captureProxy: normalizeCaptureProxyState(drained?.captureProxy, existing.captureProxy, false),
    trace: normalizeTracePayload(drained?.trace || null),
  };
}

export function listLocalCaptureProxyStates(): LocalCaptureProxyState[] {
  return [...activeProxies.values()].map((record) => normalizeCaptureProxyState(record.captureProxy, null, true)).filter(Boolean) as LocalCaptureProxyState[];
}

export async function finalizeAllLocalCaptureProxySessions(input: {
  reason?: string;
} = {}): Promise<{
  total: number;
  finalized: number;
  results: Array<{
    sessionId: string;
    result: LocalCaptureProxyFinalizationResult;
  }>;
}> {
  const sessionIds = [...activeProxies.keys()];
  const reason = normalizeOptionalString(input.reason) || 'manual-emergency-stop';
  const results = await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        return {
          sessionId,
          result: await finalizeLocalCaptureProxySession({
            sourceSessionId: sessionId,
            ...(activeProxies.get(sessionId)?.lifecycle || {}),
            clearNetwork: true,
            cleanupMeta: {
              ...(activeProxies.get(sessionId)?.lifecycle?.cleanupMeta || {}),
              finalize_reason: reason,
            },
          }),
        };
      } catch (error) {
        return {
          sessionId,
          result: {
            captureProxy: normalizeCaptureProxyState(activeProxies.get(sessionId)?.captureProxy || null, null, false),
            traceAttached: false,
            cleanupSessionId: null,
            clearResult: null,
            clearedAt: null,
            finishResult: null,
            errors: [safeErrorMessage(error)],
          } satisfies LocalCaptureProxyFinalizationResult,
        };
      }
    })
  );
  return {
    total: sessionIds.length,
    finalized: results.length,
    results,
  };
}

export async function finalizeLocalCaptureProxySession(input: {
  sourceSessionId: string;
  executor?: ESVPExecutor | string | null;
  deviceId?: string | null;
  serverUrl?: string;
  captureLogcat?: boolean;
  clearNetwork?: boolean;
  cleanupMeta?: Record<string, unknown>;
}): Promise<LocalCaptureProxyFinalizationResult> {
  const existing = finalizationsInFlight.get(input.sourceSessionId);
  if (existing) return existing;

  const promise = finalizeLocalCaptureProxySessionInternal(input).finally(() => {
    finalizationsInFlight.delete(input.sourceSessionId);
  });
  finalizationsInFlight.set(input.sourceSessionId, promise);
  return promise;
}

async function finalizeLocalCaptureProxySessionInternal(input: {
  sourceSessionId: string;
  executor?: ESVPExecutor | string | null;
  deviceId?: string | null;
  serverUrl?: string;
  captureLogcat?: boolean;
  clearNetwork?: boolean;
  cleanupMeta?: Record<string, unknown>;
}): Promise<LocalCaptureProxyFinalizationResult> {
  const errors: string[] = [];
  let clearResult: Record<string, unknown> | null = null;
  let cleanupSessionId: string | null = null;
  let clearedAt: string | null = null;

  if (input.clearNetwork !== false) {
    try {
      clearResult = await clearESVPNetwork(input.sourceSessionId, input.serverUrl);
      clearedAt = new Date().toISOString();
    } catch (error) {
      errors.push(safeErrorMessage(error));
      const cleanup = await runFallbackNetworkCleanupSession({
        executor: input.executor,
        deviceId: input.deviceId,
        sourceSessionId: input.sourceSessionId,
        serverUrl: input.serverUrl,
        cleanupMeta: input.cleanupMeta,
      });
      cleanupSessionId = cleanup.cleanupSessionId;
      if (cleanup.clearResult) {
        clearResult = cleanup.clearResult;
        clearedAt = new Date().toISOString();
        errors.length = 0;
      }
      if (cleanup.errors.length > 0) {
        errors.splice(0, errors.length, ...cleanup.errors);
      }
    }
  }

  const stopped = await stopLocalCaptureProxy(input.sourceSessionId).catch((error) => {
    errors.push(safeErrorMessage(error));
    return {
      captureProxy: null,
      trace: null,
    };
  });

  let traceAttached = false;
  if (stopped.trace) {
    try {
      await attachESVPNetworkTrace(input.sourceSessionId, stopped.trace, input.serverUrl);
      traceAttached = true;
    } catch (error) {
      errors.push(safeErrorMessage(error));
    }
  }

  const finishResult = await finishESVPSession(
    input.sourceSessionId,
    {
      captureLogcat: input.captureLogcat,
    },
    input.serverUrl
  ).catch((error) => {
    errors.push(safeErrorMessage(error));
    return null;
  });

  return {
    captureProxy: stopped.captureProxy,
    traceAttached,
    cleanupSessionId,
    clearResult,
    clearedAt,
    finishResult: isObjectRecord(finishResult) ? finishResult : null,
    errors,
  };
}

function cloneProfile(profile: ProxyProfile): ProxyProfile {
  if (!profile || typeof profile !== 'object') return profile;
  return JSON.parse(JSON.stringify(profile));
}

function hasExplicitProxy(profile: Record<string, unknown>): boolean {
  const proxy = profile.proxy;
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) return false;
  const normalizedProxy = proxy as Record<string, unknown>;
  const host = typeof normalizedProxy.host === 'string' ? normalizedProxy.host.trim() : '';
  const port = Number(normalizedProxy.port);
  return Boolean(host) && Number.isFinite(port) && port > 0;
}

async function startLocalCaptureProxy(input: {
  sessionId: string;
  platform?: MobilePlatform | string | null;
  deviceId?: string | null;
  captureMode?: 'external-proxy' | 'external-mitm';
  lifecycle?: LocalCaptureProxyLifecycleConfig | null;
}): Promise<LocalCaptureProxyState> {
  const existing = activeProxies.get(input.sessionId);
  if (existing) return existing.captureProxy;

  const advertiseHost = resolveAdvertiseHost(input);
  const bindHost = resolveBindHost(advertiseHost);
  const maxDurationMs = input.lifecycle?.maxDurationMs ?? readProxyMaxDurationMs();
  const started = await startHostRuntimeCaptureSession({
    sessionId: input.sessionId,
    advertiseHost,
    bindHost,
    captureMode: input.captureMode || 'external-proxy',
    maxDurationMs,
    maxBodyCaptureBytes: 16384,
    meta: {
      platform: normalizeOptionalString(input.platform) || null,
      deviceId: normalizeOptionalString(input.deviceId) || null,
      source: 'applab-discovery',
    },
  });
  const captureProxy = normalizeCaptureProxyState(started.captureProxy, null, true);
  if (!captureProxy) {
    throw new Error('Host runtime did not return a capture proxy state.');
  }
  captureProxy.mitm = normalizeMitmState(started.mitm || null, null);

  activeProxies.set(input.sessionId, {
    sessionId: input.sessionId,
    captureProxy,
    lifecycle: input.lifecycle || null,
  });
  registerCleanup();
  return captureProxy;
}

function resolveAdvertiseHost(input: {
  platform?: MobilePlatform | string | null;
  deviceId?: string | null;
}): string {
  const explicit = normalizeOptionalString(process.env.DISCOVERYLAB_NETWORK_PROXY_HOST);
  if (explicit) return explicit;

  const platform = String(input.platform || '').trim().toLowerCase();
  if (platform === 'ios') return '127.0.0.1';

  if (platform === 'android') {
    const deviceId = String(input.deviceId || '').trim();
    if (deviceId.startsWith('emulator-')) return '10.0.2.2';
    return inferLanIpAddress() || '127.0.0.1';
  }

  return '127.0.0.1';
}

function resolveBindHost(advertiseHost: string): string {
  const explicit = normalizeOptionalString(process.env.DISCOVERYLAB_NETWORK_PROXY_BIND_HOST);
  if (explicit) return explicit;
  if (advertiseHost === '127.0.0.1' || advertiseHost === '10.0.2.2') return '127.0.0.1';
  return '0.0.0.0';
}

function inferLanIpAddress(): string | null {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      if (entry.family === 'IPv4') return entry.address;
    }
  }
  return null;
}

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = async (reason: string) => {
    const sessionIds = [...activeProxies.keys()];
    await Promise.allSettled(
      sessionIds.map((sessionId) => {
        const lifecycle = activeProxies.get(sessionId)?.lifecycle || null;
        if (lifecycle) {
          return finalizeLocalCaptureProxySession({
            sourceSessionId: sessionId,
            executor: lifecycle.executor,
            deviceId: lifecycle.deviceId,
            serverUrl: lifecycle.serverUrl,
            captureLogcat: lifecycle.captureLogcat,
            clearNetwork: true,
            cleanupMeta: {
              ...(lifecycle.cleanupMeta || {}),
              finalize_reason: reason,
            },
          });
        }
        return stopLocalCaptureProxy(sessionId).catch(() => null);
      })
    );
    activeProxies.clear();
    await panicStopHostRuntime(reason).catch(() => null);
    await shutdownHostRuntime().catch(() => null);
  };

  process.once('beforeExit', () => {
    void cleanup('process-exit');
  });
  process.once('SIGINT', () => {
    void cleanup('sigint').finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void cleanup('sigterm').finally(() => process.exit(0));
  });
}

function normalizeCaptureProxyState(
  value: unknown,
  fallback: LocalCaptureProxyState | null,
  active: boolean
): LocalCaptureProxyState | null {
  const record = isObjectRecord(value) ? value : null;
  const host = normalizeOptionalString(record?.host) || fallback?.host || null;
  const port = Number(record?.port ?? fallback?.port ?? NaN);
  if (!host || !Number.isFinite(port) || port <= 0) {
    return fallback
      ? {
          ...fallback,
          active,
          port: Number.isFinite(fallback.port) ? fallback.port : null,
        }
      : null;
  }
  return {
    id: normalizeOptionalString(record?.id) || fallback?.id || `runtime-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: normalizeOptionalString(record?.sessionId) || fallback?.sessionId || '',
    active,
    bindHost: normalizeOptionalString(record?.bindHost) || fallback?.bindHost || host,
    host,
    port,
    url: normalizeOptionalString(record?.url) || fallback?.url || `http://${host}:${port}`,
    startedAt: normalizeOptionalString(record?.startedAt) || fallback?.startedAt || new Date().toISOString(),
    entryCount: clampInt(record?.entryCount ?? fallback?.entryCount ?? 0, 0, Number.MAX_SAFE_INTEGER, 0),
    captureMode: normalizeOptionalString(record?.captureMode) === 'external-mitm' || fallback?.captureMode === 'external-mitm'
      ? 'external-mitm'
      : 'external-proxy',
    source: normalizeOptionalString(record?.source) === 'applab-external-mitm' || fallback?.source === 'applab-external-mitm'
      ? 'applab-external-mitm'
      : 'applab-external-proxy',
    mitm: normalizeMitmState(record?.mitm, fallback?.mitm || null),
  };
}

function resolveAppLabCaptureMode(profile: Record<string, unknown>): 'external-proxy' | 'external-mitm' {
  const capture = profile.capture;
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return 'external-proxy';
  const applabMode = String((capture as Record<string, unknown>).applabMode || '').trim().toLowerCase();
  return applabMode === 'external-mitm' ? 'external-mitm' : 'external-proxy';
}

function normalizeTracePayload(value: unknown): TracePayload | null {
  if (!isObjectRecord(value)) return null;
  return value as TracePayload;
}

function normalizeMitmState(
  value: unknown,
  fallback: HostRuntimeMitmState | null
): HostRuntimeMitmState | null {
  const record = isObjectRecord(value) ? value : null;
  if (!record) return fallback || null;
  return {
    enabled: record.enabled === true || fallback?.enabled === true,
    rootCertPath: normalizeOptionalString(record.rootCertPath) || fallback?.rootCertPath || null,
    platform: normalizeOptionalString(record.platform) || fallback?.platform || null,
    deviceId: normalizeOptionalString(record.deviceId) || fallback?.deviceId || null,
    certificateInstalled: typeof record.certificateInstalled === 'boolean'
      ? record.certificateInstalled
      : fallback?.certificateInstalled,
    certificateInstallMethod: normalizeOptionalString(record.certificateInstallMethod) || fallback?.certificateInstallMethod || null,
    warnings: Array.isArray(record.warnings)
      ? record.warnings.map((item) => String(item)).filter(Boolean)
      : fallback?.warnings || [],
    errors: Array.isArray(record.errors)
      ? record.errors.map((item) => String(item)).filter(Boolean)
      : fallback?.errors || [],
  };
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function readProxyMaxDurationMs(): number | null {
  const raw = normalizeOptionalString(process.env.DISCOVERYLAB_NETWORK_PROXY_MAX_DURATION_MS);
  if (raw == null) return 15 * 60 * 1000;
  const durationMs = Number(raw);
  if (!Number.isFinite(durationMs)) return 15 * 60 * 1000;
  if (durationMs <= 0) return null;
  return clampInt(durationMs, 30000, 24 * 60 * 60 * 1000, 15 * 60 * 1000);
}

async function runFallbackNetworkCleanupSession(input: {
  executor?: ESVPExecutor | string | null;
  deviceId?: string | null;
  sourceSessionId: string;
  serverUrl?: string;
  cleanupMeta?: Record<string, unknown>;
}): Promise<{
  cleanupSessionId: string | null;
  clearResult: Record<string, unknown> | null;
  errors: string[];
}> {
  const errors: string[] = [];
  const deviceId = normalizeOptionalString(input.deviceId);
  const executor = normalizeOptionalExecutor(input.executor);
  if (!deviceId || !executor) {
    return {
      cleanupSessionId: null,
      clearResult: null,
      errors,
    };
  }

  let cleanupSessionId: string | null = null;
  try {
    const created = await createESVPSession(
      {
        executor,
        deviceId,
        meta: {
          source: 'applab-discovery-network-cleanup',
          cleanup_for_session_id: input.sourceSessionId,
          ...(input.cleanupMeta || {}),
        },
      },
      input.serverUrl
    );
    cleanupSessionId = normalizeOptionalString(created?.session?.id || created?.id);
    if (!cleanupSessionId) {
      throw new Error('Failed to create a cleanup ESVP session.');
    }

    const cleared = await clearESVPNetwork(cleanupSessionId, input.serverUrl);
    await finishESVPSession(cleanupSessionId, { captureLogcat: false }, input.serverUrl).catch(() => null);
    return {
      cleanupSessionId,
      clearResult: isObjectRecord(cleared) ? cleared : null,
      errors,
    };
  } catch (error) {
    errors.push(safeErrorMessage(error));
    if (cleanupSessionId) {
      await finishESVPSession(cleanupSessionId, { captureLogcat: false }, input.serverUrl).catch(() => null);
    }
    return {
      cleanupSessionId,
      clearResult: null,
      errors,
    };
  }
}

function normalizeOptionalExecutor(value: unknown): ESVPExecutor | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  if (normalized === 'adb' || normalized === 'ios-sim' || normalized === 'maestro-ios' || normalized === 'fake') {
    return normalized;
  }
  return null;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObjectRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
