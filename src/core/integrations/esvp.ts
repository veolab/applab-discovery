/**
 * ESVP Public Client
 *
 * Thin adapter for the public ESVP contract, backed by the in-process
 * App Lab local runtime. App Lab no longer routes ESVP traffic to an external
 * localhost sidecar or remote control-plane.
 */

import {
  assertLocalOnlyESVPConfig,
  resolveESVPConnection,
  type ESVPResolvedConnection,
} from './esvp-local.js';
import {
  listDevicesForExecutor,
  type LocalESVPAction,
} from './esvp-local-device.js';
import {
  getAppLabESVPLocalRuntime,
  LOCAL_ESVP_SERVER_URL,
} from './esvp-local-runtime.js';

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

type RuntimeHandle = Awaited<ReturnType<typeof getAppLabESVPLocalRuntime>>;

async function getRuntime(serverUrl?: string): Promise<RuntimeHandle> {
  await resolveESVPConnection(serverUrl);
  return getAppLabESVPLocalRuntime();
}

function normalizeActionList(actions: ESVPAction[]): LocalESVPAction[] {
  return actions.map((action) => {
    const normalized: LocalESVPAction = {
      name: String(action?.name || ''),
      args: action?.args && typeof action.args === 'object' ? action.args : {},
    };
    if (typeof action?.checkpointAfter === 'boolean') {
      normalized.checkpointAfter = action.checkpointAfter;
    }
    if (typeof action?.checkpointLabel === 'string') {
      normalized.checkpointLabel = action.checkpointLabel;
    }
    return normalized;
  });
}

async function listDevicesEnvelope(executor: Exclude<ESVPExecutor, 'fake'>): Promise<{ devices: any[] }> {
  return {
    devices: await listDevicesForExecutor(executor),
  };
}

export function getESVPBaseUrl(serverUrl?: string): string {
  assertLocalOnlyESVPConfig(serverUrl);
  return LOCAL_ESVP_SERVER_URL;
}

export async function resolveESVPBaseUrl(serverUrl?: string): Promise<string> {
  const connection = await resolveESVPConnection(serverUrl);
  return connection.serverUrl;
}

export async function getESVPConnection(serverUrl?: string): Promise<ESVPResolvedConnection> {
  return resolveESVPConnection(serverUrl);
}

export async function getESVPHealth(serverUrl?: string): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return runtime.getHealth();
}

export async function listESVPSessions(serverUrl?: string): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return {
    sessions: runtime.listSessions(),
  };
}

export async function createESVPSession(input: ESVPCreateSessionInput, serverUrl?: string): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return {
    session: await runtime.createSession(input),
  };
}

export async function getESVPSession(sessionId: string, serverUrl?: string): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return {
    session: runtime.getSession(sessionId),
  };
}

export async function getESVPTranscript(sessionId: string, serverUrl?: string): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return runtime.getTranscript(sessionId);
}

export async function listESVPArtifacts(sessionId: string, serverUrl?: string): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return {
    artifacts: runtime.listArtifacts(sessionId),
  };
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
  const runtime = await getRuntime(serverUrl);
  return runtime.runActions(sessionId, normalizeActionList(input.actions), {
    finish: input.finish === true,
    captureLogcat: input.captureLogcat === true,
    checkpointAfterEach: input.checkpointAfterEach === true,
  });
}

export async function finishESVPSession(
  sessionId: string,
  input: {
    captureLogcat?: boolean;
  } = {},
  serverUrl?: string
): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return {
    session: await runtime.finishSession(sessionId, input),
  };
}

export async function runESVPPreflight(
  sessionId: string,
  config: ESVPPreflightConfig,
  serverUrl?: string
): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return runtime.runPreflight(sessionId, config);
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
    input.includeTranscript === true ? getESVPTranscript(sessionId, serverUrl) : Promise.resolve(null),
    input.includeArtifacts === true ? listESVPArtifacts(sessionId, serverUrl) : Promise.resolve(null),
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
  const runtime = await getRuntime(serverUrl);
  return runtime.getArtifactContent(sessionId, artifactPath);
}

export async function getESVPSessionNetwork(sessionId: string, serverUrl?: string): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return runtime.getSessionNetwork(sessionId);
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
  const runtime = await getRuntime(serverUrl);
  return runtime.replaySessionToNewSession(sessionId, input);
}

export async function getESVPReplayConsistency(sessionId: string, serverUrl?: string): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return runtime.analyzeReplayConsistency(sessionId);
}

export async function validateESVPReplay(sessionId: string, serverUrl?: string): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  const result = runtime.validateSessionReplay(sessionId);
  return {
    http_status: result?.supported === false || result?.ok === false ? 409 : 200,
    ...result,
  };
}

export async function captureESVPCheckpoint(
  sessionId: string,
  input: {
    label?: string;
  } = {},
  serverUrl?: string
): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return runtime.captureCheckpoint(sessionId, input.label);
}

export async function configureESVPNetwork(
  sessionId: string,
  input: Record<string, unknown>,
  serverUrl?: string
): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return runtime.configureSessionNetwork(sessionId, input);
}

export async function clearESVPNetwork(sessionId: string, serverUrl?: string): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return runtime.clearSessionNetwork(sessionId, {});
}

export async function attachESVPNetworkTrace(
  sessionId: string,
  input: Record<string, unknown>,
  serverUrl?: string
): Promise<any> {
  const runtime = await getRuntime(serverUrl);
  return runtime.attachSessionNetworkTrace(sessionId, input);
}

export async function listESVPDevices(
  platform: 'adb' | 'ios-sim' | 'maestro-ios' | 'all' = 'all',
  serverUrl?: string
): Promise<any> {
  await getRuntime(serverUrl);

  if (platform === 'adb') {
    return listDevicesEnvelope('adb');
  }

  if (platform === 'ios-sim') {
    return listDevicesEnvelope('ios-sim');
  }

  if (platform === 'maestro-ios') {
    return listDevicesEnvelope('maestro-ios');
  }

  const [adb, iosSim, maestroIos] = await Promise.all([
    listDevicesEnvelope('adb').catch((error) => ({ error: error instanceof Error ? error.message : String(error), devices: [] })),
    listDevicesEnvelope('ios-sim').catch((error) => ({ error: error instanceof Error ? error.message : String(error), devices: [] })),
    listDevicesEnvelope('maestro-ios').catch((error) => ({ error: error instanceof Error ? error.message : String(error), devices: [] })),
  ]);

  return {
    adb,
    iosSim,
    maestroIos,
  };
}
