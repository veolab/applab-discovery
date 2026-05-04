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
import {
  parsePcapToHarLikeTrace,
  startPhysicalCapture,
  stopPhysicalCapture,
  type PhysicalCaptureHandle,
  type PhysicalPlatform,
} from './physical-capture.js';

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
  captureMode: 'external-proxy' | 'external-mitm' | 'external-capture';
  source: 'applab-external-proxy' | 'applab-external-mitm' | 'applab-external-capture';
  mitm?: HostRuntimeMitmState | null;
};

type TracePayload = {
  trace_kind: 'http_trace';
  label: string;
  format: 'json';
  source: 'applab-external-proxy' | 'applab-external-mitm' | 'applab-external-capture';
  payload: {
    session_id: string;
    proxy_id: string;
    generated_at: string;
    entries: Array<Record<string, unknown>>;
    warning?: string;
    pcap_bytes?: number;
    platform?: string;
    device_id?: string;
  };
  artifactMeta: {
    capture_mode: 'external-proxy' | 'external-mitm' | 'external-capture';
    proxy_id: string;
    entry_count: number;
    warning?: string;
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
const activePhysicalCaptures = new Map<string, PhysicalCaptureHandle>();
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

  const requestedMode = String((profile.capture as Record<string, unknown> | undefined)?.mode || '')
    .trim()
    .toLowerCase();
  let captureMode = requestedMode;

  // Auto-downgrade gate: physical devices CANNOT do external-proxy or
  // external-mitm reliably (no system-cert install path, often pinned). Force
  // external-capture (rvictl iOS / PCAPdroid Android) and surface a hint via
  // the returned profile so callers can log the decision.
  const physicalPlatformDetected = resolvePhysicalPlatform(input.platform, input.deviceId);
  let modeDowngradedFrom: string | null = null;
  if (
    physicalPlatformDetected &&
    (captureMode === 'external-proxy' || captureMode === 'external-mitm')
  ) {
    modeDowngradedFrom = captureMode;
    captureMode = 'external-capture';
    // Stamp the resolved mode back so downstream code sees the canonical value.
    if (profile.capture && typeof profile.capture === 'object') {
      (profile.capture as Record<string, unknown>).mode = 'external-capture';
      (profile.capture as Record<string, unknown>).applabMode = 'external-capture';
      (profile.capture as Record<string, unknown>).downgradedFrom = modeDowngradedFrom;
    }
  }

  const isExternalCapture = captureMode === 'external-capture';
  const usesExternalProxy = captureMode === 'external-proxy' || isExternalCapture;
  if (!usesExternalProxy) {
    return {
      profile,
      captureProxy: null,
      usesExternalProxy,
      appLabOwnedProxy: false,
    };
  }

  // external-capture does not use a proxy URL on the device — the host runtime
  // session is registered without a listener and capture is performed via
  // rvictl/PCAPdroid. Skip the explicit-proxy short-circuit for that mode.
  if (!isExternalCapture && hasExplicitProxy(profile)) {
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
    captureMode: isExternalCapture ? 'external-capture' : resolveAppLabCaptureMode(profile),
    lifecycle: input.lifecycle || null,
  });
  if (modeDowngradedFrom && proxy) {
    (proxy as Record<string, unknown>).downgradedFrom = modeDowngradedFrom;
    (proxy as Record<string, unknown>).downgradeReason =
      'physical device cannot install system cert; using rvictl/PCAPdroid no-decrypt capture';
  }
  // external-capture has no proxy URL — leave profile.proxy untouched so the
  // device makes direct connections (we observe via rvictl/PCAPdroid instead).
  if (!isExternalCapture && proxy.port !== null) {
    profile.proxy = {
      host: proxy.host,
      port: proxy.port,
      protocol: 'http',
    };
  }

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

  // Physical capture path: stop the rvictl/PCAPdroid handle, parse pcap, build trace.
  const physicalHandle = activePhysicalCaptures.get(sessionId) || null;
  if (physicalHandle) {
    activePhysicalCaptures.delete(sessionId);
    return finalizePhysicalCapture(sessionId, existing.captureProxy, physicalHandle);
  }

  const drained = await drainHostRuntimeCaptureSession(sessionId).catch(() => null);
  return {
    captureProxy: normalizeCaptureProxyState(drained?.captureProxy, existing.captureProxy, false),
    trace: normalizeTracePayload(drained?.trace || null),
  };
}

async function finalizePhysicalCapture(
  sessionId: string,
  fallbackState: LocalCaptureProxyState,
  handle: PhysicalCaptureHandle
): Promise<{ captureProxy: LocalCaptureProxyState | null; trace: TracePayload | null }> {
  let pcapPath = handle.pcapPath;
  let bytesCaptured = 0;
  try {
    const stopped = await stopPhysicalCapture(handle);
    pcapPath = stopped.pcapPath;
    bytesCaptured = stopped.bytesCaptured;
  } catch {
    bytesCaptured = 0;
  }

  let entries: Array<Record<string, unknown>> = [];
  let parseWarning: string | null = null;
  if (bytesCaptured > 0) {
    try {
      const parsed = await parsePcapToHarLikeTrace(pcapPath, {
        source: handle.platform === 'ios' ? 'rvictl-pcap' : 'pcapdroid-pcap',
      });
      entries = parsed.entries as unknown as Array<Record<string, unknown>>;
    } catch {
      entries = [];
    }
  }

  // Empty pcap diagnosis — most common causes per platform:
  if (bytesCaptured === 0 || (entries.length === 0 && bytesCaptured < 200)) {
    if (handle.platform === 'android') {
      parseWarning =
        'PCAPdroid wrote ~no traffic. Most likely causes: (1) VPN consent not granted on the device — open PCAPdroid manually once and accept the VPN prompt; (2) PCAPdroid not actively capturing — verify it shows "Recording" status; (3) device used cellular while you expected Wi-Fi.';
    } else if (handle.platform === 'ios') {
      parseWarning =
        'rvictl/tcpdump captured no packets. Most likely causes: (1) iPhone was locked or screen off — rvictl mirrors only when the device is awake; (2) BPF perms missing (run `sudo chown $USER /dev/bpf*`); (3) HTTP/3-only traffic with no TCP fallback.';
    }
  }

  const finalState: LocalCaptureProxyState = {
    ...fallbackState,
    active: false,
    entryCount: entries.length,
  };
  const proxyId = finalState.id || `physical-${sessionId}`;
  const trace: TracePayload = {
    trace_kind: 'http_trace',
    label: 'applab-external-capture',
    format: 'json',
    source: 'applab-external-capture',
    payload: {
      session_id: sessionId,
      proxy_id: proxyId,
      generated_at: new Date().toISOString(),
      entries,
      ...(parseWarning ? { warning: parseWarning } : {}),
      pcap_bytes: bytesCaptured,
      platform: handle.platform,
      device_id: handle.deviceId,
    },
    artifactMeta: {
      capture_mode: 'external-capture',
      proxy_id: proxyId,
      entry_count: entries.length,
      ...(parseWarning ? { warning: parseWarning } : {}),
    },
  };
  return { captureProxy: finalState, trace };
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
  captureMode?: 'external-proxy' | 'external-mitm' | 'external-capture';
  lifecycle?: LocalCaptureProxyLifecycleConfig | null;
}): Promise<LocalCaptureProxyState> {
  const existing = activeProxies.get(input.sessionId);
  if (existing) return existing.captureProxy;

  const captureMode = input.captureMode || 'external-proxy';
  const physicalPlatform = resolvePhysicalPlatform(input.platform, input.deviceId);

  // Physical device path: capture happens out-of-band (rvictl on iOS,
  // PCAPdroid on Android) — the host runtime session is registered without
  // a proxy listener so callers can attach a pcap-derived trace on stop.
  if (captureMode === 'external-capture' && physicalPlatform) {
    return startPhysicalCaptureProxy({
      ...input,
      captureMode: 'external-capture',
      physicalPlatform,
    });
  }

  const advertiseHost = resolveAdvertiseHost(input);
  const bindHost = resolveBindHost(advertiseHost);
  const maxDurationMs = input.lifecycle?.maxDurationMs ?? readProxyMaxDurationMs();
  const started = await startHostRuntimeCaptureSession({
    sessionId: input.sessionId,
    advertiseHost,
    bindHost,
    captureMode,
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

async function startPhysicalCaptureProxy(input: {
  sessionId: string;
  platform?: MobilePlatform | string | null;
  deviceId?: string | null;
  captureMode: 'external-capture';
  physicalPlatform: PhysicalPlatform;
  lifecycle?: LocalCaptureProxyLifecycleConfig | null;
}): Promise<LocalCaptureProxyState> {
  const deviceId = normalizeOptionalString(input.deviceId);
  if (!deviceId) {
    throw new Error('external-capture requires a deviceId (iOS UDID or adb id).');
  }
  const handle = await startPhysicalCapture({
    sessionId: input.sessionId,
    platform: input.physicalPlatform,
    deviceId,
  });
  activePhysicalCaptures.set(input.sessionId, handle);

  const captureProxy: LocalCaptureProxyState = {
    id: `physical-${input.physicalPlatform}-${Date.now()}`,
    sessionId: input.sessionId,
    active: true,
    bindHost: '',
    host: '',
    port: null,
    url: null,
    startedAt: handle.startedAt,
    entryCount: 0,
    captureMode: 'external-capture',
    source: 'applab-external-capture',
    mitm: null,
  };

  activeProxies.set(input.sessionId, {
    sessionId: input.sessionId,
    captureProxy,
    lifecycle: input.lifecycle || null,
  });
  registerCleanup();
  return captureProxy;
}

function resolvePhysicalPlatform(
  platform: MobilePlatform | string | null | undefined,
  deviceId: string | null | undefined
): PhysicalPlatform | null {
  const normalized = String(platform || '').trim().toLowerCase();
  const id = String(deviceId || '').trim();
  if (normalized === 'ios') return 'ios';
  if (normalized === 'android' && id && !id.startsWith('emulator-')) return 'android';
  return null;
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
  const fallbackMode = fallback?.captureMode;
  const recordMode = normalizeOptionalString(record?.captureMode);
  const isExternalCapture = recordMode === 'external-capture' || fallbackMode === 'external-capture';
  const host = normalizeOptionalString(record?.host) || fallback?.host || null;
  const port = Number(record?.port ?? fallback?.port ?? NaN);
  // For external-capture there is no proxy host:port — the state is valid even
  // without those fields. Synthesize a minimal state from the fallback.
  if (isExternalCapture) {
    return {
      id: normalizeOptionalString(record?.id) || fallback?.id || `physical-${Math.random().toString(36).slice(2, 10)}`,
      sessionId: normalizeOptionalString(record?.sessionId) || fallback?.sessionId || '',
      active,
      bindHost: normalizeOptionalString(record?.bindHost) || fallback?.bindHost || '',
      host: host || '',
      port: null,
      url: null,
      startedAt: normalizeOptionalString(record?.startedAt) || fallback?.startedAt || new Date().toISOString(),
      entryCount: clampInt(record?.entryCount ?? fallback?.entryCount ?? 0, 0, Number.MAX_SAFE_INTEGER, 0),
      captureMode: 'external-capture',
      source: 'applab-external-capture',
      mitm: null,
    };
  }
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
    captureMode: recordMode === 'external-mitm' || fallbackMode === 'external-mitm'
      ? 'external-mitm'
      : 'external-proxy',
    source: normalizeOptionalString(record?.source) === 'applab-external-mitm' || fallback?.source === 'applab-external-mitm'
      ? 'applab-external-mitm'
      : 'applab-external-proxy',
    mitm: normalizeMitmState(record?.mitm, fallback?.mitm || null),
  };
}

function resolveAppLabCaptureMode(
  profile: Record<string, unknown>
): 'external-proxy' | 'external-mitm' | 'external-capture' {
  const capture = profile.capture;
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return 'external-proxy';
  const applabMode = String((capture as Record<string, unknown>).applabMode || '').trim().toLowerCase();
  if (applabMode === 'external-mitm') return 'external-mitm';
  if (applabMode === 'external-capture') return 'external-capture';
  return 'external-proxy';
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
