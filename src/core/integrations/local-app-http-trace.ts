import { randomBytes, randomUUID } from 'node:crypto';
import { attachESVPNetworkTrace } from './esvp.js';
import { inferAppLabExternalProxyHost } from './esvp-network-profile.js';

type MobilePlatform = 'ios' | 'android';

type ActiveCollectorRecord = {
  state: LocalAppHttpTraceCollectorState;
  token: string;
  entries: Array<Record<string, unknown>>;
  createdAt: number;
};

export type LocalAppHttpTraceCollectorState = {
  id: string;
  sessionId: string;
  recordingId: string;
  appId: string | null;
  platform: MobilePlatform | null;
  deviceId: string | null;
  active: boolean;
  host: string;
  port: number;
  bootstrapPath: string;
  bootstrapUrl: string;
  ingestPath: string;
  ingestUrl: string;
  startedAt: string;
  entryCount: number;
  maxBodyCaptureBytes: number;
  source: 'applab-local-app-http-trace';
  traceKind: 'app_http_trace';
};

export type LocalAppHttpTraceBootstrapConfig = {
  traceKind: 'app_http_trace';
  source: 'applab-local-app-http-trace';
  sessionId: string;
  recordingId: string;
  appId: string | null;
  ingestUrl: string;
  ingestPath: string;
  authHeader: 'x-applab-trace-token';
  token: string;
  maxBodyCaptureBytes: number;
};

export type LocalAppHttpTraceFinalizationResult = {
  collector: LocalAppHttpTraceCollectorState | null;
  traceAttached: boolean;
  errors: string[];
};

const activeCollectorsBySession = new Map<string, ActiveCollectorRecord>();
const activeCollectorsById = new Map<string, string>();

export function startLocalAppHttpTraceCollector(input: {
  sessionId: string;
  recordingId: string;
  appId?: string | null;
  platform?: MobilePlatform | string | null;
  deviceId?: string | null;
  serverPort: number;
  maxBodyCaptureBytes?: number;
}): LocalAppHttpTraceCollectorState {
  const existing = activeCollectorsBySession.get(input.sessionId);
  if (existing) {
    return existing.state;
  }

  const collectorId = randomUUID();
  const host = inferAppLabExternalProxyHost({
    platform: input.platform,
    deviceId: input.deviceId,
    explicitHost: null,
  }) || '127.0.0.1';
  const ingestPath = `/api/testing/mobile/recordings/${encodeURIComponent(input.recordingId)}/esvp/app-http-trace/${encodeURIComponent(collectorId)}`;
  const bootstrapPath = `/api/testing/mobile/app-http-trace/bootstrap?appId=${encodeURIComponent(String(input.appId || ''))}&recordingId=${encodeURIComponent(input.recordingId)}`;
  const startedAt = new Date().toISOString();
  const state: LocalAppHttpTraceCollectorState = {
    id: collectorId,
    sessionId: input.sessionId,
    recordingId: input.recordingId,
    appId: normalizeOptionalString(input.appId),
    platform: normalizePlatform(input.platform),
    deviceId: normalizeOptionalString(input.deviceId),
    active: true,
    host,
    port: input.serverPort,
    bootstrapPath,
    bootstrapUrl: `http://${host}:${input.serverPort}${bootstrapPath}`,
    ingestPath,
    ingestUrl: `http://${host}:${input.serverPort}${ingestPath}`,
    startedAt,
    entryCount: 0,
    maxBodyCaptureBytes: normalizePositiveNumber(input.maxBodyCaptureBytes) || 16384,
    source: 'applab-local-app-http-trace',
    traceKind: 'app_http_trace',
  };

  activeCollectorsBySession.set(input.sessionId, {
    state,
    token: randomBytes(18).toString('hex'),
    entries: [],
    createdAt: Date.now(),
  });
  activeCollectorsById.set(state.id, input.sessionId);
  return state;
}

export function getLocalAppHttpTraceCollector(sessionId: string): LocalAppHttpTraceCollectorState | null {
  return activeCollectorsBySession.get(sessionId)?.state || null;
}

export function resolveLocalAppHttpTraceCollectorById(collectorId: string): LocalAppHttpTraceCollectorState | null {
  const sessionId = activeCollectorsById.get(collectorId);
  if (!sessionId) return null;
  return activeCollectorsBySession.get(sessionId)?.state || null;
}

export function getLocalAppHttpTraceBootstrap(input: {
  appId?: string | null;
  recordingId?: string | null;
}): (LocalAppHttpTraceCollectorState & { bootstrap: LocalAppHttpTraceBootstrapConfig }) | null {
  const appId = normalizeOptionalString(input.appId);
  const recordingId = normalizeOptionalString(input.recordingId);
  let bestMatch: ActiveCollectorRecord | null = null;

  for (const record of activeCollectorsBySession.values()) {
    if (!record.state.active) continue;
    if (appId && record.state.appId === appId) {
      if (!bestMatch || record.createdAt > bestMatch.createdAt) bestMatch = record;
      continue;
    }
    if (!appId && recordingId && record.state.recordingId === recordingId) {
      if (!bestMatch || record.createdAt > bestMatch.createdAt) bestMatch = record;
    }
  }

  if (!bestMatch) return null;
  return {
    ...bestMatch.state,
    bootstrap: buildBootstrapConfig(bestMatch),
  };
}

export function ingestLocalAppHttpTrace(input: {
  collectorId: string;
  authToken?: string | null;
  payload: unknown;
}): {
  collector: LocalAppHttpTraceCollectorState | null;
  accepted: number;
} {
  const sessionId = activeCollectorsById.get(input.collectorId);
  if (!sessionId) {
    return {
      collector: null,
      accepted: 0,
    };
  }

  const record = activeCollectorsBySession.get(sessionId);
  if (!record || !record.state.active) {
    return {
      collector: null,
      accepted: 0,
    };
  }

  if (record.token !== String(input.authToken || '').trim()) {
    return {
      collector: null,
      accepted: 0,
    };
  }

  const entries = extractEntries(input.payload);
  if (entries.length > 0) {
    record.entries.push(...entries);
    record.state = {
      ...record.state,
      entryCount: record.entries.length,
    };
  }

  activeCollectorsBySession.set(sessionId, record);
  return {
    collector: record.state,
    accepted: entries.length,
  };
}

export async function finalizeLocalAppHttpTraceCollector(input: {
  sourceSessionId: string;
  serverUrl?: string;
}): Promise<LocalAppHttpTraceFinalizationResult> {
  const record = activeCollectorsBySession.get(input.sourceSessionId);
  if (!record) {
    return {
      collector: null,
      traceAttached: false,
      errors: [],
    };
  }

  activeCollectorsBySession.delete(input.sourceSessionId);
  activeCollectorsById.delete(record.state.id);

  const finalState: LocalAppHttpTraceCollectorState = {
    ...record.state,
    active: false,
    entryCount: record.entries.length,
  };

  if (record.entries.length === 0) {
    return {
      collector: finalState,
      traceAttached: false,
      errors: [],
    };
  }

  try {
    await attachESVPNetworkTrace(
      input.sourceSessionId,
      {
        trace_kind: 'app_http_trace',
        label: 'App Lab Local App HTTP Trace',
        format: 'json',
        source: finalState.source,
        payload: {
          session_id: input.sourceSessionId,
          collector_id: finalState.id,
          generated_at: new Date().toISOString(),
          entries: record.entries,
        },
        artifactMeta: {
          trace_kind: 'app_http_trace',
          collector_id: finalState.id,
          entry_count: record.entries.length,
          source: finalState.source,
        },
      },
      input.serverUrl
    );

    return {
      collector: finalState,
      traceAttached: true,
      errors: [],
    };
  } catch (error) {
    return {
      collector: finalState,
      traceAttached: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function buildBootstrapConfig(record: ActiveCollectorRecord): LocalAppHttpTraceBootstrapConfig {
  return {
    traceKind: 'app_http_trace',
    source: 'applab-local-app-http-trace',
    sessionId: record.state.sessionId,
    recordingId: record.state.recordingId,
    appId: record.state.appId,
    ingestUrl: record.state.ingestUrl,
    ingestPath: record.state.ingestPath,
    authHeader: 'x-applab-trace-token',
    token: record.token,
    maxBodyCaptureBytes: record.state.maxBodyCaptureBytes,
  };
}

function extractEntries(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(isObject);
  }
  if (!isObject(payload)) {
    return [];
  }

  const nestedCandidates = [
    payload,
    isObject(payload.payload) ? payload.payload : null,
    isObject(payload.data) ? payload.data : null,
    isObject(payload.trace) ? payload.trace : null,
    isObject(payload.result) ? payload.result : null,
  ].filter(Boolean) as Array<Record<string, unknown>>;

  for (const candidate of nestedCandidates) {
    for (const key of ['entries', 'events', 'requests', 'items']) {
      if (Array.isArray(candidate[key])) {
        return (candidate[key] as unknown[]).filter(isObject);
      }
    }
  }

  return [payload];
}

function normalizePositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizePlatform(value: unknown): MobilePlatform | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'ios' || normalized === 'android') return normalized;
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
