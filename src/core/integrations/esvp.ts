/**
 * ESVP Public Client
 *
 * Thin HTTP adapter for the public ESVP contract.
 * This client intentionally depends only on the open contract and does not
 * embed any private Entropy Lab implementation details.
 *
 * Connection modes:
 * - remote: explicit serverUrl or ESVP_BASE_URL
 * - local: embedded OSS runtime via @entropylab/esvp-local or DISCOVERYLAB_ESVP_LOCAL_MODULE
 */

import { resolveESVPConnection, type ESVPResolvedConnection } from './esvp-local.js';

export type ESVPExecutor = 'fake' | 'adb' | 'ios-sim' | 'maestro-ios';

export interface ESVPArtifactSummary {
  t?: number;
  kind?: string;
  path?: string;
  sha256?: string;
  bytes?: number;
  meta?: Record<string, unknown> | null;
  abs_path?: string | null;
  [key: string]: unknown;
}

export interface ESVPManagedProxyState {
  id?: string | null;
  active?: boolean;
  bind_host?: string | null;
  host?: string | null;
  port?: number | null;
  url?: string | null;
  started_at?: string | null;
  entry_count?: number | null;
  capture_mode?: string | null;
  [key: string]: unknown;
}

export interface ESVPSessionNetworkState {
  supported?: boolean;
  capabilities?: Record<string, unknown> | null;
  active_profile?: Record<string, unknown> | null;
  effective_profile?: Record<string, unknown> | null;
  managed_proxy?: ESVPManagedProxyState | null;
  configured_at?: string | null;
  cleared_at?: string | null;
  trace_count?: number;
  trace_kinds?: string[];
  last_result?: Record<string, unknown> | null;
  last_error?: string | null;
  [key: string]: unknown;
}

export interface ESVPCreateSessionInput {
  executor: ESVPExecutor;
  deviceId?: string;
  meta?: Record<string, unknown>;
  crash_clip?: {
    enabled?: boolean;
    pre_seconds?: number;
    post_seconds?: number;
    chunk_seconds?: number;
  };
}

export interface ESVPAction {
  name: string;
  args?: Record<string, unknown>;
  checkpointAfter?: boolean;
  checkpointLabel?: string;
}

interface ESVPSessionEnvelope {
  session?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ESVPTranscriptEnvelope {
  events?: unknown[];
}

interface ESVPArtifactsEnvelope {
  artifacts?: ESVPArtifactSummary[];
}

const DEFAULT_ESVP_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_ESVP_REQUEST_TIMEOUT_MS = 20_000;
const LONG_RUNNING_ESVP_REQUEST_TIMEOUT_MS = 120_000;

function normalizeBaseUrl(serverUrl?: string): string {
  const raw = (serverUrl || process.env.ESVP_BASE_URL || DEFAULT_ESVP_BASE_URL).trim();
  return raw.replace(/\/+$/, '');
}

async function resolveBaseUrl(serverUrl?: string): Promise<ESVPResolvedConnection> {
  return resolveESVPConnection(serverUrl);
}

async function readJsonSafe(response: Response): Promise<any> {
  const text = await response.text();
  if (!text.trim()) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function readResponseContent(response: Response): Promise<any> {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const text = await response.text();
  if (!text.trim()) return null;

  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function esvpRequest<T>(
  path: string,
  init: RequestInit = {},
  serverUrl?: string,
  timeoutMs = DEFAULT_ESVP_REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const connection = await resolveBaseUrl(serverUrl);
    const response = await fetch(`${connection.serverUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });

    const payload = await readJsonSafe(response);

    if (!response.ok) {
      const message =
        payload?.error ||
        payload?.message ||
        `ESVP request failed (${response.status} ${response.statusText})`;
      throw new Error(message);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`ESVP request timed out after ${timeoutMs}ms: ${path}`);
    }
    if (error instanceof TypeError) {
      throw new Error(`ESVP connection failed: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function getESVPBaseUrl(serverUrl?: string): string {
  return normalizeBaseUrl(serverUrl);
}

export async function resolveESVPBaseUrl(serverUrl?: string): Promise<string> {
  const connection = await resolveBaseUrl(serverUrl);
  return connection.serverUrl;
}

export async function getESVPConnection(serverUrl?: string): Promise<ESVPResolvedConnection> {
  return resolveBaseUrl(serverUrl);
}

export async function getESVPHealth(serverUrl?: string): Promise<any> {
  return esvpRequest('/health', { method: 'GET' }, serverUrl);
}

export async function listESVPSessions(serverUrl?: string): Promise<any> {
  return esvpRequest('/sessions', { method: 'GET' }, serverUrl);
}

export async function createESVPSession(input: ESVPCreateSessionInput, serverUrl?: string): Promise<any> {
  return esvpRequest(
    '/sessions',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    serverUrl
  );
}

export async function getESVPSession(sessionId: string, serverUrl?: string): Promise<any> {
  return esvpRequest<ESVPSessionEnvelope>(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' }, serverUrl);
}

export async function getESVPTranscript(sessionId: string, serverUrl?: string): Promise<any> {
  return esvpRequest<ESVPTranscriptEnvelope>(
    `/sessions/${encodeURIComponent(sessionId)}/transcript`,
    { method: 'GET' },
    serverUrl
  );
}

export async function listESVPArtifacts(sessionId: string, serverUrl?: string): Promise<any> {
  return esvpRequest<ESVPArtifactsEnvelope>(
    `/sessions/${encodeURIComponent(sessionId)}/artifacts`,
    { method: 'GET' },
    serverUrl
  );
}

export async function runESVPActions(
  sessionId: string,
  input: {
    actions: ESVPAction[];
    finish?: boolean;
    captureLogcat?: boolean;
    checkpointAfterEach?: boolean;
  },
  serverUrl?: string
): Promise<any> {
  return esvpRequest(
    `/sessions/${encodeURIComponent(sessionId)}/actions`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    serverUrl,
    LONG_RUNNING_ESVP_REQUEST_TIMEOUT_MS
  );
}

export async function finishESVPSession(
  sessionId: string,
  input: {
    captureLogcat?: boolean;
  } = {},
  serverUrl?: string
): Promise<any> {
  return esvpRequest(
    `/sessions/${encodeURIComponent(sessionId)}/finish`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    serverUrl
  );
}

export interface ESVPPreflightRule {
  kind: 'permission' | 'dismiss_dialog' | 'wait_for_stable' | 'clear_data' | 'set_setting';
  [key: string]: unknown;
}

export interface ESVPPreflightConfig {
  policy?: string;
  appId?: string;
  rules?: ESVPPreflightRule[];
  [key: string]: unknown;
}

export async function runESVPPreflight(
  sessionId: string,
  config: ESVPPreflightConfig,
  serverUrl?: string
): Promise<any> {
  return esvpRequest(
    `/sessions/${encodeURIComponent(sessionId)}/preflight`,
    { method: 'POST', body: JSON.stringify(config) },
    serverUrl,
    LONG_RUNNING_ESVP_REQUEST_TIMEOUT_MS
  );
}

export async function inspectESVPSession(
  sessionId: string,
  input: {
    includeTranscript?: boolean;
    includeArtifacts?: boolean;
  } = {},
  serverUrl?: string
): Promise<any> {
  const [session, transcript, artifacts] = await Promise.all([
    getESVPSession(sessionId, serverUrl),
    input.includeTranscript === true
      ? esvpRequest<ESVPTranscriptEnvelope>(
          `/sessions/${encodeURIComponent(sessionId)}/transcript`,
          { method: 'GET' },
          serverUrl
        )
      : Promise.resolve(null),
    input.includeArtifacts === true
      ? esvpRequest<ESVPArtifactsEnvelope>(
          `/sessions/${encodeURIComponent(sessionId)}/artifacts`,
          { method: 'GET' },
          serverUrl
        )
      : Promise.resolve(null),
  ]);

  return {
    session: session?.session || session,
    transcript: transcript?.events || null,
    artifacts: artifacts?.artifacts || null,
  };
}

export async function getESVPArtifactContent(
  sessionId: string,
  artifactPath: string,
  serverUrl?: string
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const connection = await resolveBaseUrl(serverUrl);
    const response = await fetch(
      `${connection.serverUrl}/sessions/${encodeURIComponent(sessionId)}/artifacts/${artifactPath
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')}`,
      {
        method: 'GET',
        signal: controller.signal,
      }
    );

    const payload = await readResponseContent(response);
    if (!response.ok) {
      const message =
        (payload && typeof payload === 'object' ? payload.error || payload.message : null) ||
        `ESVP artifact request failed (${response.status} ${response.statusText})`;
      throw new Error(String(message));
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getESVPSessionNetwork(sessionId: string, serverUrl?: string): Promise<any> {
  return esvpRequest(`/sessions/${encodeURIComponent(sessionId)}/network`, { method: 'GET' }, serverUrl);
}

export async function replayESVPSession(
  sessionId: string,
  input: {
    executor?: ESVPExecutor;
    deviceId?: string;
    captureLogcat?: boolean;
    meta?: Record<string, unknown>;
  } = {},
  serverUrl?: string
): Promise<any> {
  return esvpRequest(
    `/sessions/${encodeURIComponent(sessionId)}/replay-run`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    serverUrl,
    LONG_RUNNING_ESVP_REQUEST_TIMEOUT_MS
  );
}

export async function getESVPReplayConsistency(sessionId: string, serverUrl?: string): Promise<any> {
  return esvpRequest(`/sessions/${encodeURIComponent(sessionId)}/replay-consistency`, { method: 'GET' }, serverUrl);
}

export async function validateESVPReplay(sessionId: string, serverUrl?: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LONG_RUNNING_ESVP_REQUEST_TIMEOUT_MS);

  try {
    const connection = await resolveBaseUrl(serverUrl);
    const response = await fetch(`${connection.serverUrl}/sessions/${encodeURIComponent(sessionId)}/replay-validate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    const payload = await readJsonSafe(response);

    if (!response.ok && ![409, 422].includes(response.status)) {
      const message =
        payload?.error ||
        payload?.message ||
        `ESVP replay validation failed (${response.status} ${response.statusText})`;
      throw new Error(message);
    }

    return {
      http_status: response.status,
      ...(payload && typeof payload === 'object' ? payload : { payload }),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function captureESVPCheckpoint(
  sessionId: string,
  input: {
    label?: string;
  } = {},
  serverUrl?: string
): Promise<any> {
  return esvpRequest(
    `/sessions/${encodeURIComponent(sessionId)}/checkpoint`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    serverUrl
  );
}

export async function configureESVPNetwork(
  sessionId: string,
  input: Record<string, unknown>,
  serverUrl?: string
): Promise<any> {
  return esvpRequest(
    `/sessions/${encodeURIComponent(sessionId)}/network/profile`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    serverUrl
  );
}

export async function clearESVPNetwork(sessionId: string, serverUrl?: string): Promise<any> {
  return esvpRequest(
    `/sessions/${encodeURIComponent(sessionId)}/network/clear`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
    serverUrl
  );
}

export async function attachESVPNetworkTrace(
  sessionId: string,
  input: Record<string, unknown>,
  serverUrl?: string
): Promise<any> {
  return esvpRequest(
    `/sessions/${encodeURIComponent(sessionId)}/network/trace`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
    serverUrl
  );
}

export async function listESVPDevices(
  platform: 'adb' | 'ios-sim' | 'maestro-ios' | 'all' = 'all',
  serverUrl?: string
): Promise<any> {
  if (platform === 'adb') {
    return esvpRequest('/devices/adb', { method: 'GET' }, serverUrl);
  }

  if (platform === 'ios-sim') {
    return esvpRequest('/devices/ios-sim', { method: 'GET' }, serverUrl);
  }

  if (platform === 'maestro-ios') {
    return esvpRequest('/devices/maestro-ios', { method: 'GET' }, serverUrl);
  }

  const [adb, iosSim, maestroIos] = await Promise.all([
    esvpRequest('/devices/adb', { method: 'GET' }, serverUrl).catch((error) => ({ error: error instanceof Error ? error.message : String(error), devices: [] })),
    esvpRequest('/devices/ios-sim', { method: 'GET' }, serverUrl).catch((error) => ({ error: error instanceof Error ? error.message : String(error), devices: [] })),
    esvpRequest('/devices/maestro-ios', { method: 'GET' }, serverUrl).catch((error) => ({ error: error instanceof Error ? error.message : String(error), devices: [] })),
  ]);

  return {
    adb,
    iosSim,
    maestroIos,
  };
}
