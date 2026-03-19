/**
 * DiscoveryLab ESVP Tools
 *
 * Open-source client tools for the public ESVP contract.
 * These tools only call the documented HTTP interface and do not embed
 * any private Entropy Lab runtime logic.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { MCPTool } from '../server.js';
import { createJsonResult, createErrorResult } from '../server.js';
import {
  attachESVPNetworkTrace,
  captureESVPCheckpoint,
  clearESVPNetwork,
  configureESVPNetwork,
  createESVPSession,
  getESVPArtifactContent,
  finishESVPSession,
  getESVPConnection,
  getESVPHealth,
  getESVPReplayConsistency,
  getESVPSession,
  getESVPSessionNetwork,
  getESVPTranscript,
  inspectESVPSession,
  listESVPArtifacts,
  listESVPDevices,
  listESVPSessions,
  replayESVPSession,
  runESVPActions,
  runESVPPreflight,
  validateESVPReplay,
  type ESVPAction,
  type ESVPExecutor,
  type ESVPPreflightConfig,
} from '../../core/integrations/esvp.js';
import { buildAppLabNetworkProfile } from '../../core/integrations/esvp-network-profile.js';
import { listAllEmulators } from '../../core/capture/emulator.js';

const jsonObjectSchema = z.record(z.string(), z.any());

const actionSchema = z.object({
  name: z.string().min(1).describe('ESVP action name'),
  args: jsonObjectSchema.optional().describe('Action arguments'),
  checkpointAfter: z.boolean().optional(),
  checkpointLabel: z.string().optional(),
});

const crashClipSchema = z.object({
  enabled: z.boolean().optional(),
  pre_seconds: z.number().optional(),
  post_seconds: z.number().optional(),
  chunk_seconds: z.number().optional(),
});

const proxySchema = z.object({
  host: z.string(),
  port: z.number(),
  protocol: z.string().optional(),
  bypass: z.array(z.string()).optional(),
});

function resolveDefaultDeviceId(executor: ESVPExecutor): string | undefined {
  if (executor === 'fake') return undefined;

  const wantedPlatform = executor === 'ios-sim' || executor === 'maestro-ios' ? 'ios' : 'android';
  const booted = listAllEmulators().find(
    (device) => device.platform === wantedPlatform && device.state === 'booted'
  );
  return booted?.id;
}

function executorToPlatform(executor?: string): 'ios' | 'android' | undefined {
  if (executor === 'ios-sim' || executor === 'maestro-ios') return 'ios';
  if (executor === 'adb') return 'android';
  return undefined;
}

async function makeBaseResult(serverUrl?: string): Promise<{ serverUrl: string; connectionMode: 'remote' | 'local' }> {
  const connection = await getESVPConnection(serverUrl);
  return {
    serverUrl: connection.serverUrl,
    connectionMode: connection.mode,
  };
}

function normalizeActions(actions: Array<z.infer<typeof actionSchema>>): ESVPAction[] {
  return actions.map((action) => ({
    name: action.name,
    ...(action.args ? { args: action.args } : {}),
    ...(action.checkpointAfter !== undefined ? { checkpointAfter: action.checkpointAfter } : {}),
    ...(action.checkpointLabel ? { checkpointLabel: action.checkpointLabel } : {}),
  }));
}

async function resolveTracePayload(params: { payload?: unknown; traceFilePath?: string }): Promise<unknown> {
  if (params.payload !== undefined) return params.payload;
  if (!params.traceFilePath) {
    throw new Error('payload ou traceFilePath é obrigatório');
  }

  const absPath = params.traceFilePath.startsWith('/')
    ? params.traceFilePath
    : resolve(process.cwd(), params.traceFilePath);
  const raw = await readFile(absPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export const esvpStatusTool: MCPTool = {
  name: 'dlab.esvp.status',
  description: 'Check if an ESVP control-plane is reachable and return its health payload.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
  }),
  handler: async (params) => {
    try {
      const health = await getESVPHealth(params.serverUrl);
      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        health,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpDevicesTool: MCPTool = {
  name: 'dlab.esvp.devices',
  description: 'List ESVP-visible ADB devices and/or iOS Simulators from the public control-plane.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    platform: z.enum(['adb', 'ios-sim', 'maestro-ios', 'all']).optional().describe('Which device family to query'),
  }),
  handler: async (params) => {
    try {
      const devices = await listESVPDevices(params.platform || 'all', params.serverUrl);
      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        devices,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpSessionsListTool: MCPTool = {
  name: 'dlab.esvp.sessions.list',
  description: 'List public ESVP sessions from the configured server.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
  }),
  handler: async (params) => {
    try {
      const sessions = await listESVPSessions(params.serverUrl);
      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...sessions,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpSessionCreateTool: MCPTool = {
  name: 'dlab.esvp.session.create',
  description: 'Create an ESVP session using the public contract. Auto-selects a booted emulator/simulator when possible. Use withNetwork to auto-configure the default App Lab external-proxy profile.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    executor: z.enum(['fake', 'adb', 'ios-sim', 'maestro-ios']).describe('Public ESVP executor'),
    deviceId: z.string().optional().describe('Device ID. Optional for fake and for booted local emulators/simulators'),
    meta: jsonObjectSchema.optional().describe('Session metadata'),
    crashClip: crashClipSchema.optional().describe('Optional crash clip config'),
    withNetwork: z.boolean().optional().describe('Auto-configure the default App Lab external-proxy profile after creating the session'),
  }),
  handler: async (params) => {
    try {
      const resolvedDeviceId = params.deviceId || resolveDefaultDeviceId(params.executor);
      const response = await createESVPSession(
        {
          executor: params.executor,
          ...(resolvedDeviceId ? { deviceId: resolvedDeviceId } : {}),
          meta: {
            source: 'applab-discovery',
            ...(params.meta || {}),
          },
          ...(params.crashClip
            ? {
                crash_clip: params.crashClip,
              }
            : {}),
        },
        params.serverUrl
      );

      let networkConfigured = null;
      if (params.withNetwork) {
        const sessionId = String(response?.session?.id || response?.id || '');
        if (sessionId) {
          networkConfigured = await configureESVPNetwork(
            sessionId,
            buildAppLabNetworkProfile(
              {
                enabled: true,
                mode: 'external-proxy',
                profile: 'applab-standard-capture',
                label: 'App Lab Standard Capture',
              },
              {
                platform: executorToPlatform(params.executor),
                deviceId: resolvedDeviceId,
              }
            ) || {},
            params.serverUrl
          ).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
        }
      }

      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        autoSelectedDeviceId: resolvedDeviceId || null,
        ...response,
        ...(networkConfigured ? { networkConfigured } : {}),
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpSessionInspectTool: MCPTool = {
  name: 'dlab.esvp.session.inspect',
  description: 'Inspect an ESVP session and optionally include transcript and artifacts.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
    includeTranscript: z.boolean().optional(),
    includeArtifacts: z.boolean().optional(),
  }),
  handler: async (params) => {
    try {
      const inspection = await inspectESVPSession(
        params.sessionId,
        {
          includeTranscript: params.includeTranscript === true,
          includeArtifacts: params.includeArtifacts === true,
        },
        params.serverUrl
      );

      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...inspection,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpSessionTranscriptTool: MCPTool = {
  name: 'dlab.esvp.session.transcript',
  description: 'Fetch the canonical public transcript for an ESVP session.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
  }),
  handler: async (params) => {
    try {
      const transcript = await getESVPTranscript(params.sessionId, params.serverUrl);
      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        sessionId: params.sessionId,
        transcript: transcript?.events || [],
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpSessionArtifactsListTool: MCPTool = {
  name: 'dlab.esvp.session.artifacts.list',
  description: 'List public artifacts for an ESVP session.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
  }),
  handler: async (params) => {
    try {
      const result = await listESVPArtifacts(params.sessionId, params.serverUrl);
      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        sessionId: params.sessionId,
        artifacts: result?.artifacts || [],
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpSessionArtifactGetTool: MCPTool = {
  name: 'dlab.esvp.session.artifact.get',
  description: 'Fetch the contents of a public ESVP artifact.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
    artifactPath: z.string().describe('Artifact relative path returned by artifacts.list'),
  }),
  handler: async (params) => {
    try {
      const content = await getESVPArtifactContent(params.sessionId, params.artifactPath, params.serverUrl);
      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        sessionId: params.sessionId,
        artifactPath: params.artifactPath,
        content,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpSessionActionsTool: MCPTool = {
  name: 'dlab.esvp.session.actions',
  description: 'Run public ESVP actions in an existing session. Use withNetwork to auto-configure the default App Lab external-proxy profile if not already active.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
    actions: z.array(actionSchema).min(1).describe('Public ESVP actions'),
    finish: z.boolean().optional().describe('Finish the session after running the actions'),
    captureLogcat: z.boolean().optional().describe('Capture logcat on finish when supported'),
    checkpointAfterEach: z.boolean().optional().describe('Enable checkpointAfter for every action'),
    withNetwork: z.boolean().optional().describe('Auto-configure the default App Lab external-proxy profile before running actions if not already configured'),
  }),
  handler: async (params) => {
    try {
      let networkConfigured = null;
      if (params.withNetwork) {
        const networkState = await getESVPSessionNetwork(params.sessionId, params.serverUrl).catch(() => null);
        const hasActiveProfile = networkState?.network?.active_profile || networkState?.network?.effective_profile;
        if (!hasActiveProfile) {
          networkConfigured = await configureESVPNetwork(
            params.sessionId,
            buildAppLabNetworkProfile(
              {
                enabled: true,
                mode: 'external-proxy',
                profile: 'applab-standard-capture',
                label: 'App Lab Standard Capture',
              },
              {
                platform: executorToPlatform(typeof networkState?.session?.executor === 'string' ? networkState.session.executor : undefined),
                deviceId: typeof networkState?.session?.device_id === 'string' ? networkState.session.device_id : undefined,
              }
            ) || {},
            params.serverUrl
          ).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
        }
      }

      const result = await runESVPActions(
        params.sessionId,
        {
          actions: normalizeActions(params.actions),
          finish: params.finish === true,
          captureLogcat: params.captureLogcat,
          checkpointAfterEach: params.checkpointAfterEach,
        },
        params.serverUrl
      );

      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...(networkConfigured ? { networkConfigured } : {}),
        ...result,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpSessionCheckpointTool: MCPTool = {
  name: 'dlab.esvp.session.checkpoint',
  description: 'Capture a public ESVP checkpoint for an existing session.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
    label: z.string().optional().describe('Optional checkpoint label'),
  }),
  handler: async (params) => {
    try {
      const result = await captureESVPCheckpoint(
        params.sessionId,
        {
          ...(params.label ? { label: params.label } : {}),
        },
        params.serverUrl
      );

      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...result,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpSessionFinishTool: MCPTool = {
  name: 'dlab.esvp.session.finish',
  description: 'Finish an ESVP session.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
    captureLogcat: z.boolean().optional().describe('Capture logcat on finish when supported'),
  }),
  handler: async (params) => {
    try {
      const result = await finishESVPSession(
        params.sessionId,
        {
          captureLogcat: params.captureLogcat,
        },
        params.serverUrl
      );

      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...result,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpReplayRunTool: MCPTool = {
  name: 'dlab.esvp.replay.run',
  description: 'Replay an ESVP session to a new session using the public replay endpoint.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('Base ESVP session ID'),
    executor: z.enum(['fake', 'adb', 'ios-sim', 'maestro-ios']).optional().describe('Replay executor'),
    deviceId: z.string().optional().describe('Replay device ID'),
    captureLogcat: z.boolean().optional(),
    meta: jsonObjectSchema.optional(),
  }),
  handler: async (params) => {
    try {
      const result = await replayESVPSession(
        params.sessionId,
        {
          executor: params.executor,
          deviceId: params.deviceId,
          captureLogcat: params.captureLogcat,
          meta: {
            source: 'applab-discovery',
            ...(params.meta || {}),
          },
        },
        params.serverUrl
      );

      const consistency =
        result?.replay_session?.id
          ? await getESVPReplayConsistency(result.replay_session.id, params.serverUrl).catch(() => null)
          : null;

      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...result,
        replayConsistency: consistency?.replay_consistency || null,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpNetworkConfigureTool: MCPTool = {
  name: 'dlab.esvp.network.configure',
  description: 'Configure an ESVP network profile through the public network contract.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
    profile: z.string().optional(),
    label: z.string().optional(),
    connectivity: z.enum(['online', 'offline', 'reset']).optional(),
    proxy: proxySchema.optional(),
    faults: jsonObjectSchema.optional(),
    capture: jsonObjectSchema.optional(),
    clear: z.boolean().optional().describe('Clear the active network profile instead of applying one'),
  }),
  handler: async (params) => {
    try {
      if (params.clear === true) {
        const cleared = await clearESVPNetwork(params.sessionId, params.serverUrl);
        return createJsonResult({
          ...(await makeBaseResult(params.serverUrl)),
          ...cleared,
        });
      }

      const result = await configureESVPNetwork(
        params.sessionId,
        {
          ...(params.profile ? { profile: params.profile } : {}),
          ...(params.label ? { label: params.label } : {}),
          ...(params.connectivity ? { connectivity: params.connectivity } : {}),
          ...(params.proxy ? { proxy: params.proxy } : {}),
          ...(params.faults ? { faults: params.faults } : {}),
          ...(params.capture ? { capture: params.capture } : {}),
        },
        params.serverUrl
      );

      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...result,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpSessionNetworkTool: MCPTool = {
  name: 'dlab.esvp.session.network',
  description: 'Read the public network state for an ESVP session.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
  }),
  handler: async (params) => {
    try {
      const result = await getESVPSessionNetwork(params.sessionId, params.serverUrl);
      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...result,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpNetworkTraceAttachTool: MCPTool = {
  name: 'dlab.esvp.network.trace.attach',
  description: 'Attach a network trace artifact to an ESVP session using the public contract.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
    traceKind: z.string().describe('Trace kind, e.g. http_trace or har'),
    label: z.string().optional(),
    source: z.string().optional(),
    requestId: z.string().optional(),
    method: z.string().optional(),
    url: z.string().optional(),
    statusCode: z.number().optional(),
    format: z.string().optional(),
    payload: z.any().optional().describe('Trace payload object/string'),
    traceFilePath: z.string().optional().describe('Optional local file path to JSON/text trace payload'),
  }),
  handler: async (params) => {
    try {
      const payload = await resolveTracePayload({
        payload: params.payload,
        traceFilePath: params.traceFilePath,
      });

      const result = await attachESVPNetworkTrace(
        params.sessionId,
        {
          trace_kind: params.traceKind,
          ...(params.label ? { label: params.label } : {}),
          ...(params.source ? { source: params.source } : {}),
          ...(params.requestId ? { request_id: params.requestId } : {}),
          ...(params.method ? { method: params.method } : {}),
          ...(params.url ? { url: params.url } : {}),
          ...(params.statusCode !== undefined ? { status_code: params.statusCode } : {}),
          ...(params.format ? { format: params.format } : {}),
          payload,
        },
        params.serverUrl
      );

      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...result,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpSessionGetTool: MCPTool = {
  name: 'dlab.esvp.session.get',
  description: 'Get the latest public summary for an ESVP session.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
  }),
  handler: async (params) => {
    try {
      const result = await getESVPSession(params.sessionId, params.serverUrl);
      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...result,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpReplayValidateTool: MCPTool = {
  name: 'dlab.esvp.replay.validate',
  description: 'Validate whether an ESVP session supports canonical replay and inspect the result.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
  }),
  handler: async (params) => {
    try {
      const result = await validateESVPReplay(params.sessionId, params.serverUrl);
      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...result,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

const preflightRuleSchema = z.object({
  kind: z.enum(['permission', 'dismiss_dialog', 'wait_for_stable', 'clear_data', 'set_setting']).describe('Preflight rule kind'),
  permission: z.string().optional().describe('Android permission (for kind=permission)'),
  action: z.enum(['grant', 'revoke']).optional().describe('Permission action (for kind=permission)'),
  selector: z.string().optional().describe('Selector to find and dismiss (for kind=dismiss_dialog)'),
  timeout_ms: z.number().optional().describe('Timeout in ms (for kind=wait_for_stable/dismiss_dialog)'),
  poll_ms: z.number().optional().describe('Poll interval in ms (for kind=wait_for_stable)'),
  namespace: z.string().optional().describe('Settings namespace: system|secure|global (for kind=set_setting)'),
  key: z.string().optional().describe('Setting key (for kind=set_setting)'),
  value: z.string().optional().describe('Setting value (for kind=set_setting)'),
});

export const esvpSessionPreflightTool: MCPTool = {
  name: 'dlab.esvp.session.preflight',
  description: 'Run preflight/bootstrap rules on an ESVP session before executing actions. Supports permission grants, dialog dismissal, wait for stable UI, clear data, and system settings.',
  inputSchema: z.object({
    serverUrl: z.string().url().optional().describe('ESVP control-plane base URL'),
    sessionId: z.string().describe('ESVP session ID'),
    policy: z.string().optional().describe('Preflight policy name (e.g. fresh_install)'),
    appId: z.string().optional().describe('Target app ID (e.g. com.example.app)'),
    rules: z.array(preflightRuleSchema).optional().describe('Preflight rules to execute'),
  }),
  handler: async (params) => {
    try {
      const config: ESVPPreflightConfig = {
        ...(params.policy ? { policy: params.policy } : {}),
        ...(params.appId ? { appId: params.appId } : {}),
        ...(params.rules ? { rules: params.rules as ESVPPreflightConfig['rules'] } : {}),
      };
      const result = await runESVPPreflight(params.sessionId, config, params.serverUrl);
      return createJsonResult({
        ...(await makeBaseResult(params.serverUrl)),
        ...result,
      });
    } catch (error) {
      return createErrorResult(error instanceof Error ? error.message : String(error));
    }
  },
};

export const esvpTools: MCPTool[] = [
  esvpStatusTool,
  esvpDevicesTool,
  esvpSessionsListTool,
  esvpSessionCreateTool,
  esvpSessionGetTool,
  esvpSessionInspectTool,
  esvpSessionTranscriptTool,
  esvpSessionArtifactsListTool,
  esvpSessionArtifactGetTool,
  esvpSessionActionsTool,
  esvpSessionCheckpointTool,
  esvpSessionFinishTool,
  esvpSessionPreflightTool,
  esvpReplayRunTool,
  esvpReplayValidateTool,
  esvpSessionNetworkTool,
  esvpNetworkConfigureTool,
  esvpNetworkTraceAttachTool,
];
