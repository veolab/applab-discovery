import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { APP_VERSION } from '../appVersion.js';
import { DATA_DIR } from '../../db/index.js';
import {
  captureDeviceCheckpoint,
  clearDeviceNetwork,
  collectExecutorDebugArtifact,
  configureDeviceNetwork,
  listDevicesForExecutor,
  networkCapabilitiesForExecutor,
  resolveDefaultDeviceId,
  runDeviceActionFlow,
  type LocalESVPAction,
  type LocalESVPExecutor,
  type LocalExecutionContext,
  type LocalPreflightConfig,
} from './esvp-local-device.js';
import { ESVPManagedProxyManager } from './esvp-managed-proxy.js';

const execFileAsync = promisify(execFile);

export const LOCAL_ESVP_SERVER_URL = 'applab://local-esvp';
const LOCAL_RUNTIME_ROOT = join(DATA_DIR, 'esvp-local');
const LOCAL_RUNS_ROOT = join(LOCAL_RUNTIME_ROOT, 'runs');

type LocalSessionRecord = {
  id: string;
  executorName: LocalESVPExecutor;
  context: LocalExecutionContext & {
    target: string | null;
    runDir: string;
  };
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'finished' | 'failed' | 'interrupted';
  error: string | null;
  recovered: boolean;
  meta: Record<string, unknown>;
  runDir: string;
  transcriptPath: string;
  transcriptPathRelative: string;
  manifestPath: string;
  manifestPathRelative: string;
  transcript: Array<Record<string, any>>;
  actionCount: number;
  checkpointCount: number;
  artifactCount: number;
  network: Record<string, any>;
};

type CreateSessionInput = {
  executor: LocalESVPExecutor;
  deviceId?: string;
  meta?: Record<string, unknown>;
  crash_clip?: Record<string, unknown>;
  sessionId?: string;
};

let runtimePromise: Promise<AppLabESVPLocalRuntime> | null = null;
let cleanupRegistered = false;

export async function getAppLabESVPLocalRuntime(): Promise<AppLabESVPLocalRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const runtime = new AppLabESVPLocalRuntime();
      await runtime.init();
      runtime.registerCleanupHooks();
      return runtime;
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

class AppLabESVPLocalRuntime {
  private readonly rootDir = LOCAL_RUNS_ROOT;
  private readonly sessions = new Map<string, LocalSessionRecord>();
  private readonly managedProxyManager = new ESVPManagedProxyManager();

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await this.loadPersistedSessions();
  }

  registerCleanupHooks(): void {
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    const cleanup = async () => {
      await this.cleanupTransientSystemState().catch(() => undefined);
    };
    process.once('beforeExit', () => {
      void cleanup();
    });
    process.once('SIGINT', () => {
      void cleanup().finally(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
      void cleanup().finally(() => process.exit(0));
    });
  }

  async getHealth(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      service: 'applab-esvp-local',
      version: APP_VERSION,
      auth: { enabled: false },
      limits: {
        max_body_bytes: 10 * 1024 * 1024,
      },
      managed_proxy: {
        bind_host: '127.0.0.1',
        advertise_host: null,
      },
    };
  }

  listSessions(): Record<string, unknown>[] {
    return [...this.sessions.values()]
      .map((session) => this.publicSession(session))
      .sort((a, b) => String((b.created_at as string) || '').localeCompare(String((a.created_at as string) || '')));
  }

  async createSession(input: CreateSessionInput): Promise<Record<string, unknown>> {
    const executorName = normalizeExecutor(input.executor);
    const sessionId = input.sessionId || randomId('sess');
    if (this.sessions.has(sessionId)) {
      throw new Error(`session_id already exists: ${sessionId}`);
    }

    const runDir = resolve(this.rootDir, sessionId);
    await mkdir(runDir, { recursive: true });

    const resolvedDeviceId = input.deviceId || (await resolveDefaultDeviceId(executorName));
    const meta = sanitizeMeta({
      ...(input.meta || {}),
      ...(input.crash_clip ? { crash_clip: input.crash_clip } : {}),
    });
    const transcript = [
      {
        t: 0,
        type: 'session_started',
        session_id: sessionId,
        target: targetForExecutor(executorName),
        meta: {
          executor: executorName,
          ...meta,
          ...(resolvedDeviceId ? { deviceId: resolvedDeviceId } : {}),
        },
      },
    ];

    const session: LocalSessionRecord = {
      id: sessionId,
      executorName,
      context: {
        deviceId: resolvedDeviceId || null,
        target: targetForExecutor(executorName),
        runDir,
        appId: resolveMetaAppId(meta),
        preflightConfig: null,
        networkProfile: null,
        lastRunOutput: null,
        lastFlowPath: null,
        lastRunFailed: false,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'running',
      error: null,
      recovered: false,
      meta,
      runDir,
      transcriptPath: resolve(runDir, 'transcript.jsonl'),
      transcriptPathRelative: relativeRunsPath(this.rootDir, runDir, 'transcript.jsonl'),
      manifestPath: resolve(runDir, 'session.json'),
      manifestPathRelative: relativeRunsPath(this.rootDir, runDir, 'session.json'),
      transcript,
      actionCount: 0,
      checkpointCount: 0,
      artifactCount: 0,
      network: createInitialNetworkState(executorName),
    };

    this.sessions.set(sessionId, session);
    await this.persistSessionState(session);
    return this.publicSession(session);
  }

  getSession(sessionId: string): Record<string, unknown> {
    return this.publicSession(this.requireSession(sessionId));
  }

  getTranscript(sessionId: string): { session_id: string; status: string; transcript_path: string; events: Array<Record<string, any>> } {
    const session = this.requireSession(sessionId);
    return {
      session_id: session.id,
      status: session.status,
      transcript_path: session.transcriptPathRelative,
      events: session.transcript,
    };
  }

  listArtifacts(sessionId: string): Array<Record<string, unknown>> {
    const session = this.requireSession(sessionId);
    return session.transcript
      .filter((event) => event.type === 'artifact')
      .map((event) => ({
        t: event.t,
        kind: event.kind,
        path: event.path,
        sha256: event.sha256,
        bytes: event.bytes,
        meta: event.meta || null,
        abs_path: resolve(session.runDir, event.path),
      }));
  }

  async getArtifactContent(sessionId: string, artifactPath: string): Promise<any> {
    const resolved = this.resolveSessionArtifactPath(sessionId, artifactPath);
    const ext = extname(resolved.absPath).toLowerCase();
    const data = await readFile(resolved.absPath);
    if (ext === '.json' || ext === '.har' || ext.endsWith('.json')) {
      try {
        return JSON.parse(data.toString('utf8'));
      } catch {
        return data.toString('utf8');
      }
    }
    if (ext === '.txt' || ext === '.log' || ext === '.jsonl' || ext === '.xml' || ext === '.yaml' || ext === '.yml') {
      return data.toString('utf8');
    }
    return {
      encoding: 'base64',
      bytes: data.length,
      content_base64: data.toString('base64'),
      path: resolved.path,
    };
  }

  async runPreflight(sessionId: string, preflightConfig: LocalPreflightConfig): Promise<Record<string, unknown>> {
    const session = this.requireMutableSession(sessionId);
    if (!preflightConfig || typeof preflightConfig !== 'object') {
      throw new Error('Invalid preflight config');
    }

    session.context.preflightConfig = sanitizeMeta(preflightConfig) as LocalPreflightConfig;
    const appId = typeof preflightConfig.appId === 'string' ? preflightConfig.appId.trim() : '';
    if (appId) {
      session.context.appId = appId;
      session.meta = {
        ...session.meta,
        appId,
        app_id: appId,
      };
    }

    const results = Array.isArray(preflightConfig.rules)
      ? preflightConfig.rules.map((rule) => ({
          kind: String(rule?.kind || 'unknown'),
          status: 'applied',
          optional: rule?.optional === true,
        }))
      : [];

    const event = {
      t: lastEventTime(session.transcript) + 1,
      type: 'preflight',
      policy: preflightConfig.policy || 'default',
      appId: appId || session.context.appId || null,
      results,
    };
    appendSessionEvents(session, [event]);
    await this.persistSessionState(session);

    return {
      session: this.publicSession(session),
      appended_events: [event],
      results,
    };
  }

  async runActions(
    sessionId: string,
    actions: LocalESVPAction[],
    options: {
      finish?: boolean;
      captureLogcat?: boolean;
      checkpointAfterEach?: boolean;
    } = {}
  ): Promise<Record<string, unknown>> {
    const session = this.requireMutableSession(sessionId);
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error('actions must be a non-empty array');
    }

    const normalizedActions = actions.map((action) => ({
      name: String(action?.name || ''),
      args: action?.args && typeof action.args === 'object' ? action.args : {},
      checkpointAfter: typeof action?.checkpointAfter === 'boolean' ? action.checkpointAfter : options.checkpointAfterEach === true,
      checkpointLabel: typeof action?.checkpointLabel === 'string' ? action.checkpointLabel : undefined,
    }));

    if (session.executorName === 'fake') {
      return this.runFakeActions(session, normalizedActions, options);
    }

    const deviceId = session.context.deviceId || (await resolveDefaultDeviceId(session.executorName));
    if (!deviceId) {
      throw new Error(`No connected device was found for executor ${session.executorName}.`);
    }
    session.context.deviceId = deviceId;

    const result = await runDeviceActionFlow({
      executor: session.executorName,
      deviceId,
      runDir: session.runDir,
      sessionId: session.id,
      meta: session.meta,
      preflightConfig: session.context.preflightConfig || null,
      actions: normalizedActions,
    });
    session.context.lastRunOutput = result.output;
    session.context.lastFlowPath = result.flowPath;
    session.context.lastRunFailed = !result.success;
    session.context.appId = result.appId;
    session.meta = {
      ...session.meta,
      ...(result.appId ? { appId: result.appId, app_id: result.appId } : {}),
    };

    const appended: Array<Record<string, any>> = [];
    let eventClock = lastEventTime(session.transcript);
    for (let index = 0; index < result.executedActionCount; index += 1) {
      const action = normalizedActions[index];
      eventClock += 1;
      const actionEvent = {
        t: eventClock,
        type: 'action',
        name: action.name,
        args: sanitizeMeta(action.args || {}),
      };
      appended.push(actionEvent);

      const checkpoint = result.checkpoints.find((candidate) => candidate.actionIndex === index) || null;
      if (checkpoint) {
        const artifactEvent = await this.persistBinaryArtifact(session, {
          t: eventClock + 1,
          kind: 'screenshot',
          path: checkpoint.relativePath,
          absPath: checkpoint.absPath,
          bytes: checkpoint.bytes,
          sha256: checkpoint.sha256,
          meta: {
            label: checkpoint.label,
            source: 'applab-esvp-local',
          },
        });
        eventClock += 1;
        appended.push(artifactEvent);
        const checkpointEvent = {
          t: eventClock + 1,
          type: 'checkpoint',
          label: checkpoint.label,
          screen_hash: checkpoint.sha256,
          ui_hash: checkpoint.sha256,
          state_hash: null,
        };
        eventClock += 1;
        appended.push(checkpointEvent);
      }
    }

    appendSessionEvents(session, appended);

    if (!result.success) {
      const debugArtifact = await collectExecutorDebugArtifact({
        executor: session.executorName,
        context: session.context,
      });
      const failureEvents: Array<Record<string, any>> = [];
      if (debugArtifact) {
        const artifact = await this.persistTextArtifact(session, {
          t: lastEventTime(session.transcript) + 1,
          kind: debugArtifact.kind,
          path: `logs/${String(Date.now())}-${debugArtifact.kind}.${debugArtifact.extension}`,
          content: debugArtifact.content,
          meta: {
            source: 'applab-esvp-local',
          },
        });
        failureEvents.push(artifact);
      }
      session.status = 'failed';
      session.error = result.error || 'ESVP local device run failed';
      const finishEvent = {
        t: lastEventTime(session.transcript) + failureEvents.length + 1,
        type: 'session_finished',
        status: 'failed',
        error: session.error,
      };
      appendSessionEvents(session, [...failureEvents, finishEvent]);
      await this.persistSessionState(session);
      return {
        session: this.publicSession(session),
        appended_events: [...appended, ...failureEvents, finishEvent],
        failed: true,
      };
    }

    if (options.finish === true) {
      const finishResult = await this.finishSessionInternal(session, options);
      return {
        session: this.publicSession(session),
        appended_events: [...appended, ...finishResult.events],
        failed: false,
      };
    }

    await this.persistSessionState(session);
    return {
      session: this.publicSession(session),
      appended_events: appended,
      failed: false,
    };
  }

  async finishSession(sessionId: string, options: { captureLogcat?: boolean } = {}): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId);
    if (session.status === 'finished' || session.status === 'failed') {
      return this.publicSession(session);
    }
    this.assertSessionMutable(session);
    await this.finishSessionInternal(session, options);
    return this.publicSession(session);
  }

  async captureCheckpoint(sessionId: string, label?: string): Promise<Record<string, unknown>> {
    const session = this.requireMutableSession(sessionId);
    const checkpointLabel = normalizeCheckpointLabelInput(label) || `checkpoint:${session.checkpointCount + 1}`;

    if (session.executorName === 'fake') {
      const hash = createHash('sha256').update(`${session.id}:${checkpointLabel}:${session.checkpointCount + 1}`).digest('hex');
      const event = {
        t: lastEventTime(session.transcript) + 1,
        type: 'checkpoint',
        label: checkpointLabel,
        screen_hash: hash,
        ui_hash: hash,
        state_hash: null,
      };
      appendSessionEvents(session, [event]);
      await this.persistSessionState(session);
      return event;
    }

    const deviceId = session.context.deviceId || (await resolveDefaultDeviceId(session.executorName));
    if (!deviceId) {
      throw new Error(`No connected device was found for executor ${session.executorName}.`);
    }
    session.context.deviceId = deviceId;
    const relativePath = `checkpoints/${String(session.checkpointCount + 1).padStart(3, '0')}-${slugify(checkpointLabel)}.png`;
    const absPath = join(session.runDir, relativePath);
    const capture = await captureDeviceCheckpoint({
      executor: session.executorName,
      deviceId,
      targetPath: absPath,
    });
    if (!capture.success) {
      throw new Error(capture.error || 'Failed to capture local ESVP checkpoint screenshot');
    }

    const contents = await readFile(absPath);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    const t = lastEventTime(session.transcript) + 1;
    const artifactEvent = await this.persistBinaryArtifact(session, {
      t,
      kind: 'screenshot',
      path: relativePath,
      absPath,
      bytes: contents.length,
      sha256,
      meta: {
        label: checkpointLabel,
        source: 'applab-esvp-local',
      },
    });
    const checkpointEvent = {
      t: t + 1,
      type: 'checkpoint',
      label: checkpointLabel,
      screen_hash: sha256,
      ui_hash: sha256,
      state_hash: null,
    };
    appendSessionEvents(session, [artifactEvent, checkpointEvent]);
    await this.persistSessionState(session);
    return checkpointEvent;
  }

  getSessionNetwork(sessionId: string): Record<string, unknown> {
    const session = this.requireSession(sessionId);
    return {
      session: this.publicSession(session),
      network: this.buildPublicNetwork(session),
    };
  }

  async configureSessionNetwork(sessionId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const session = this.requireMutableSession(sessionId);
    const profile = normalizeNetworkProfileInput(input);
    const previousProxyArtifacts = await this.releaseManagedProxyArtifacts(session, {
      reason: 'reconfigure',
    });
    const managedProxyResult = await this.prepareManagedProxy(session, profile);
    const effectiveProfile = managedProxyResult?.effectiveProfile || profile;
    const result = await configureDeviceNetwork(session.executorName, session.context, effectiveProfile);
    const actionEvent = {
      t: lastEventTime(session.transcript) + 1,
      type: 'action',
      name: 'network.configure',
      args: profile,
    };
    const artifactEvent = await this.persistJsonArtifact(session, {
      t: actionEvent.t + 1 + previousProxyArtifacts.length,
      kind: 'network_profile',
      path: buildNetworkArtifactPath(session, 'network_profile', {
        label: profile.label || 'network-profile',
        format: 'json',
      }),
      payload: {
        profile,
        effective_profile: effectiveProfile,
        managed_proxy: managedProxyResult?.proxy || null,
        result,
      },
      meta: {
        label: profile.label || 'network-profile',
        profile_name: profile.profile || null,
      },
    });

    appendSessionEvents(session, [actionEvent, ...previousProxyArtifacts, artifactEvent]);
    session.network = {
      ...session.network,
      supported: true,
      capabilities: mergeNetworkCapabilities(result.capabilities, managedProxyResult?.capabilities, session.network?.capabilities),
      active_profile: profile,
      effective_profile: effectiveProfile,
      managed_proxy: managedProxyResult?.proxy || null,
      configured_at: nowIso(),
      last_result: sanitizeNetworkResult({
        ...result,
        managed_proxy: managedProxyResult?.proxy || null,
      }),
      last_error: (result as any)?.error || null,
    };
    await this.persistSessionState(session);

    return {
      session: this.publicSession(session),
      network: this.buildPublicNetwork(session),
      applied: result,
      profile_artifact: summarizeArtifactEvent(artifactEvent),
    };
  }

  async clearSessionNetwork(sessionId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const session = this.requireMutableSession(sessionId);
    const result = await clearDeviceNetwork(session.executorName, session.context);
    const proxyArtifacts = await this.releaseManagedProxyArtifacts(session, {
      reason: 'network-clear',
    });
    const actionEvent = {
      t: lastEventTime(session.transcript) + 1,
      type: 'action',
      name: 'network.clear',
      args: sanitizeMeta(input || {}),
    };
    const artifactEvent = await this.persistJsonArtifact(session, {
      t: actionEvent.t + 1 + proxyArtifacts.length,
      kind: 'network_profile',
      path: buildNetworkArtifactPath(session, 'network_profile', {
        label: 'network-clear',
        format: 'json',
      }),
      payload: {
        cleared: true,
        result,
      },
      meta: {
        cleared: true,
      },
    });

    appendSessionEvents(session, [actionEvent, ...proxyArtifacts, artifactEvent]);
    session.network = {
      ...session.network,
      active_profile: null,
      effective_profile: null,
      managed_proxy: null,
      cleared_at: nowIso(),
      last_result: sanitizeNetworkResult(result),
      last_error: null,
    };
    await this.persistSessionState(session);

    return {
      session: this.publicSession(session),
      network: this.buildPublicNetwork(session),
      cleared: result,
      profile_artifact: summarizeArtifactEvent(artifactEvent),
    };
  }

  async attachSessionNetworkTrace(sessionId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId);
    const trace = normalizeNetworkTraceInput(input);
    const artifactEvent = await this.persistArtifactPayload(session, {
      t: hasFinished(session.transcript) ? lastEventTimeBeforeFinish(session.transcript) : lastEventTime(session.transcript) + 1,
      kind: 'network_trace',
      path: buildNetworkArtifactPath(session, 'network_trace', {
        label: trace.label || trace.trace_kind,
        format: trace.format,
        traceKind: trace.trace_kind,
      }),
      payload: trace.payload,
      format: trace.format,
      meta: {
        ...(trace.label ? { label: trace.label } : {}),
        trace_kind: trace.trace_kind,
        source: trace.source,
        request_id: trace.request_id,
        url: trace.url,
        method: trace.method,
        status_code: trace.status_code,
      },
    });

    if (hasFinished(session.transcript)) {
      insertEventsBeforeSessionFinished(session.transcript, [artifactEvent]);
      recountEvents(session, [artifactEvent]);
      session.updatedAt = nowIso();
    } else {
      appendSessionEvents(session, [artifactEvent]);
    }

    const traceKinds = new Set(session.network?.trace_kinds || []);
    traceKinds.add(trace.trace_kind);
    session.network = {
      ...session.network,
      trace_count: Number(session.network?.trace_count || 0) + 1,
      trace_kinds: [...traceKinds],
    };
    await this.persistSessionState(session);

    return {
      session: this.publicSession(session),
      network: this.buildPublicNetwork(session),
      attached_trace: summarizeArtifactEvent(artifactEvent),
    };
  }

  validateSessionReplay(sessionId: string): Record<string, unknown> {
    const session = this.requireSession(sessionId);
    if (!hasFinished(session.transcript)) {
      return {
        ok: false,
        supported: false,
        reason: 'session must be finished before replay validation',
        session: this.publicSession(session),
      };
    }

    const extracted = extractReplayActionsFromTranscript(session.transcript);
    if (!extracted.actions.length) {
      return {
        ok: false,
        supported: false,
        reason: 'transcript does not contain replayable actions',
        session: this.publicSession(session),
      };
    }

    return {
      ok: true,
      supported: true,
      reason: null,
      session: this.publicSession(session),
      extraction: extracted,
    };
  }

  analyzeReplayConsistency(sessionId: string): Record<string, unknown> {
    const session = this.requireSession(sessionId);
    const transcript = session.transcript || [];
    const actions = transcript.filter((event) => event.type === 'action');
    const checkpoints = transcript.filter((event) => event.type === 'checkpoint');
    const artifacts = transcript.filter((event) => event.type === 'artifact');
    const failure = transcript.find((event) => event.type === 'session_finished' && event.status === 'failed') || null;

    const tapActions = actions.filter((action) => action.name === 'tap');
    const selectorTapCount = tapActions.filter((action) => action.args && typeof action.args.selector === 'string').length;
    const coordinateTapCount = tapActions.filter((action) => action.args && typeof action.args.x === 'number' && typeof action.args.y === 'number').length;
    const waitCount = actions.filter((action) => action.name === 'wait').length;
    const waitForCount = actions.filter((action) => action.name === 'waitFor').length;
    const artifactsByKind = artifacts.reduce<Record<string, number>>((acc, event) => {
      acc[event.kind] = (acc[event.kind] || 0) + 1;
      return acc;
    }, {});

    const recommendations: string[] = [];
    let score = 100;
    if (actions.length === 0) {
      score -= 40;
      recommendations.push('record actions in the transcript to strengthen replay quality');
    }
    if (checkpoints.length === 0) {
      score -= 25;
      recommendations.push('add regular checkpoints for replay comparison');
    }
    if (coordinateTapCount > 0) {
      score -= Math.min(20, coordinateTapCount * 4);
      recommendations.push('prefer selectors instead of fixed coordinates');
    }
    if (waitCount > waitForCount && waitCount >= 2) {
      score -= Math.min(15, waitCount * 2);
      recommendations.push('replace fixed waits with waitFor(selector) style waits when possible');
    }
    if (!artifactsByKind.screenshot) {
      score -= 10;
      recommendations.push('capture screenshots at critical checkpoints');
    }
    if (failure && session.executorName === 'adb' && !artifactsByKind.logcat) {
      score -= 15;
      recommendations.push('capture logcat on Android failures');
    }
    if (failure && (session.executorName === 'ios-sim' || session.executorName === 'maestro-ios') && !artifactsByKind.debug_asset) {
      score -= 10;
      recommendations.push('persist Maestro debug output on iOS failures');
    }
    score = Math.max(0, Math.min(100, score));
    const verdict = score >= 85 ? 'strong' : score >= 65 ? 'moderate' : 'weak';

    return {
      session: this.publicSession(session),
      replay_consistency: {
        version: 1,
        objective: 'replay_consistency',
        score,
        verdict,
        deterministic_validation: this.validateSessionReplay(sessionId),
        metrics: {
          action_count: actions.length,
          checkpoint_count: checkpoints.length,
          artifact_count: artifacts.length,
          tap_selector_count: selectorTapCount,
          tap_coordinate_count: coordinateTapCount,
          wait_count: waitCount,
          wait_for_count: waitForCount,
          artifacts_by_kind: artifactsByKind,
        },
        recommendations: [...new Set(recommendations)],
      },
    };
  }

  async replaySessionToNewSession(
    sessionId: string,
    options: {
      executor?: LocalESVPExecutor;
      deviceId?: string;
      captureLogcat?: boolean;
      meta?: Record<string, unknown>;
    } = {}
  ): Promise<Record<string, unknown>> {
    const original = this.requireSession(sessionId);
    if (!hasFinished(original.transcript)) {
      throw new Error('finish the original session before replaying it');
    }

    const extracted = extractReplayActionsFromTranscript(original.transcript);
    if (!extracted.actions.length) {
      throw new Error('transcript does not contain replayable actions');
    }

    const replayExecutor = normalizeExecutor(options.executor || original.executorName || 'fake');
    const replaySession = await this.createSession({
      executor: replayExecutor,
      deviceId: options.deviceId || original.context.deviceId || undefined,
      meta: {
        source: 'replay-run',
        replay_of: original.id,
        ...(resolveMetaAppId(original.meta) ? { appId: resolveMetaAppId(original.meta), app_id: resolveMetaAppId(original.meta) } : {}),
        ...(options.meta ? sanitizeMeta(options.meta) : {}),
      },
    });
    const replaySessionId = String(replaySession.id || '');
    if (!replaySessionId) {
      throw new Error('Failed to create replay session');
    }

    if (original.context.preflightConfig) {
      await this.runPreflight(replaySessionId, original.context.preflightConfig).catch(() => undefined);
    }

    const run = await this.runActions(replaySessionId, extracted.actions as LocalESVPAction[], {
      finish: true,
      captureLogcat: options.captureLogcat !== false,
      checkpointAfterEach: false,
    });

    const replayTranscriptPayload = this.getTranscript(replaySessionId);
    const comparison = compareCheckpointSequences({
      expectedTranscript: original.transcript,
      actualTranscript: replayTranscriptPayload.events,
      strategy: comparisonStrategyForExecutors(original.executorName, replayExecutor),
    });

    return {
      original_session: this.publicSession(original),
      replay_session: this.getSession(replaySessionId),
      extraction: extracted,
      run_summary: {
        failed: run.failed,
        appended_events: Array.isArray(run.appended_events) ? run.appended_events.length : 0,
        session: run.session,
      },
      checkpoint_comparison: comparison,
    };
  }

  async cleanupTransientSystemState(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.status !== 'running') continue;
      await clearDeviceNetwork(session.executorName, session.context).catch(() => undefined);
      await this.managedProxyManager.releaseSessionProxy(session.id, { reason: 'process-exit' }).catch(() => undefined);
    }
  }

  private async runFakeActions(
    session: LocalSessionRecord,
    actions: LocalESVPAction[],
    options: { finish?: boolean }
  ): Promise<Record<string, unknown>> {
    const appended: Array<Record<string, any>> = [];
    for (const action of actions) {
      const actionEvent = {
        t: lastEventTime(session.transcript) + appended.length + 1,
        type: 'action',
        name: action.name,
        args: sanitizeMeta(action.args || {}),
      };
      appended.push(actionEvent);
      if (action.checkpointAfter) {
        const hash = createHash('sha256')
          .update(`${session.id}:${action.name}:${JSON.stringify(action.args || {})}:${action.checkpointLabel || ''}`)
          .digest('hex');
        appended.push({
          t: actionEvent.t + 1,
          type: 'checkpoint',
          label: action.checkpointLabel || null,
          screen_hash: hash,
          ui_hash: hash,
          state_hash: hash,
        });
      }
    }

    appendSessionEvents(session, appended);
    if (options.finish === true) {
      const finishResult = await this.finishSessionInternal(session, {});
      return {
        session: this.publicSession(session),
        appended_events: [...appended, ...finishResult.events],
        failed: false,
      };
    }
    await this.persistSessionState(session);
    return {
      session: this.publicSession(session),
      appended_events: appended,
      failed: false,
    };
  }

  private buildPublicNetwork(session: LocalSessionRecord): Record<string, unknown> {
    return {
      ...(session.network || {}),
      capabilities: session.network?.capabilities || networkCapabilitiesForExecutor(session.executorName),
    };
  }

  private publicSession(session: LocalSessionRecord): Record<string, unknown> {
    const lastEvent = session.transcript[session.transcript.length - 1];
    return {
      id: session.id,
      executor: session.executorName,
      status: session.status,
      error: session.error,
      recovered: session.recovered === true,
      mutable: session.status === 'running',
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      target: session.context?.target || null,
      device_id: session.context?.deviceId || null,
      meta: session.meta || {},
      run_dir: session.runDir,
      transcript_path: session.transcriptPath,
      transcript_path_relative: session.transcriptPathRelative,
      manifest_path: session.manifestPath,
      manifest_path_relative: session.manifestPathRelative,
      action_count: session.actionCount,
      checkpoint_count: session.checkpointCount,
      artifact_count: session.artifactCount,
      event_count: session.transcript.length,
      last_event_type: lastEvent?.type || null,
      last_event_t: lastEvent?.t ?? 0,
      network: this.buildPublicNetwork(session),
    };
  }

  private requireSession(sessionId: string): LocalSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }
    return session;
  }

  private requireMutableSession(sessionId: string): LocalSessionRecord {
    const session = this.requireSession(sessionId);
    this.assertSessionMutable(session);
    return session;
  }

  private assertSessionMutable(session: LocalSessionRecord): void {
    if (session.status !== 'running') {
      throw new Error(`session ${session.id} is not running (status=${session.status})`);
    }
  }

  private async finishSessionInternal(
    session: LocalSessionRecord,
    options: { captureLogcat?: boolean } = {}
  ): Promise<{ session: Record<string, unknown>; events: Array<Record<string, any>> }> {
    const finishEvents: Array<Record<string, any>> = [];
    const proxyArtifacts = await this.releaseManagedProxyArtifacts(session, {
      reason: 'session-finish',
    });
    if (proxyArtifacts.length) {
      appendSessionEvents(session, proxyArtifacts);
      finishEvents.push(...proxyArtifacts);
    }

    if (options.captureLogcat !== false) {
      const debugArtifact = await collectExecutorDebugArtifact({
        executor: session.executorName,
        context: session.context,
      });
      if (debugArtifact) {
        const artifact = await this.persistTextArtifact(session, {
          t: lastEventTime(session.transcript) + 1,
          kind: debugArtifact.kind,
          path: `logs/${String(Date.now())}-${debugArtifact.kind}.${debugArtifact.extension}`,
          content: debugArtifact.content,
          meta: {
            source: 'applab-esvp-local',
          },
        });
        appendSessionEvents(session, [artifact]);
        finishEvents.push(artifact);
      }
    }

    session.status = 'finished';
    session.error = null;
    session.network = {
      ...session.network,
      managed_proxy: null,
    };
    const sessionFinishedEvent = {
      t: lastEventTime(session.transcript) + 1,
      type: 'session_finished',
      status: 'ok',
    };
    appendSessionEvents(session, [sessionFinishedEvent]);
    finishEvents.push(sessionFinishedEvent);
    await this.persistSessionState(session);

    return {
      session: this.publicSession(session),
      events: finishEvents,
    };
  }

  private async persistSessionState(session: LocalSessionRecord): Promise<void> {
    await writeTranscriptFile(session.transcriptPath, session.transcript);
    const manifest = {
      session: this.publicSession(session),
      meta: session.meta || {},
      persisted_at: nowIso(),
      context: {
        deviceId: session.context.deviceId || null,
        appId: session.context.appId || null,
        preflightConfig: session.context.preflightConfig || null,
      },
    };
    await writeFile(session.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  private async prepareManagedProxy(
    session: LocalSessionRecord,
    profile: Record<string, any>
  ): Promise<{
    managed: boolean;
    proxy: Record<string, unknown>;
    capabilities: Record<string, unknown>;
    effectiveProfile: Record<string, unknown>;
  } | null> {
    if (!this.managedProxyManager.shouldManageProfile(profile)) {
      return null;
    }
    return this.managedProxyManager.configureSessionProxy({
      sessionId: session.id,
      session,
      profile,
    });
  }

  private async releaseManagedProxyArtifacts(
    session: LocalSessionRecord,
    options: { reason?: string } = {}
  ): Promise<Array<Record<string, any>>> {
    const release = await this.managedProxyManager.releaseSessionProxy(session.id, options);
    if (!release.managed || !Array.isArray(release.traces) || release.traces.length === 0) {
      return [];
    }

    const events: Array<Record<string, any>> = [];
    for (const trace of release.traces) {
      const artifactEvent = await this.persistArtifactPayload(session, {
        t: hasFinished(session.transcript) ? lastEventTimeBeforeFinish(session.transcript) : lastEventTime(session.transcript) + 1 + events.length,
        kind: 'network_trace',
        path: buildNetworkArtifactPath(session, 'network_trace', {
          label: trace.label || trace.trace_kind,
          format: trace.format,
          traceKind: trace.trace_kind,
        }),
        payload: trace.payload,
        format: trace.format,
        meta: {
          ...(trace.artifactMeta || {}),
          source: trace.source || 'esvp-managed-proxy',
          trace_kind: trace.trace_kind || 'http_trace',
        },
      });
      events.push(artifactEvent);
    }

    if (events.length) {
      const traceKinds = new Set(session.network?.trace_kinds || []);
      for (const trace of release.traces) {
        if (trace.trace_kind) traceKinds.add(String(trace.trace_kind));
      }
      session.network = {
        ...session.network,
        trace_count: Number(session.network?.trace_count || 0) + events.length,
        trace_kinds: [...traceKinds],
        managed_proxy: null,
      };
    }

    return events;
  }

  private async loadPersistedSessions(): Promise<void> {
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = resolve(this.rootDir, entry.name);
      const transcriptPath = resolve(runDir, 'transcript.jsonl');
      const transcriptInfo = await stat(transcriptPath).catch(() => null);
      if (!transcriptInfo?.isFile()) continue;

      try {
        const transcript = await readTranscriptFile(transcriptPath);
        const manifest = await readJsonFile(resolve(runDir, 'session.json'));
        const session = this.recoverSessionFromDisk({
          runDir,
          transcriptPath,
          transcript,
          manifest,
          transcriptInfo,
        });
        this.sessions.set(session.id, session);
      } catch {
        // Ignore corrupted sessions during bootstrap.
      }
    }
  }

  private recoverSessionFromDisk(input: {
    runDir: string;
    transcriptPath: string;
    transcript: Array<Record<string, any>>;
    manifest: any;
    transcriptInfo: { birthtime?: Date; mtime?: Date };
  }): LocalSessionRecord {
    const firstEvent = input.transcript.find((event) => event.type === 'session_started') || {};
    const finishEvent = [...input.transcript].reverse().find((event) => event.type === 'session_finished') || null;
    const manifestSession = input.manifest?.session || {};
    const executorName = normalizeExecutor(
      manifestSession.executor || firstEvent?.meta?.executor || firstEvent?.meta?.executor_name || 'fake'
    );
    const id = String(manifestSession.id || firstEvent.session_id || basename(input.runDir));
    const target = manifestSession.target || firstEvent.target || targetForExecutor(executorName) || null;
    const deviceId = manifestSession.device_id || firstEvent?.meta?.deviceId || firstEvent?.meta?.device_id || null;
    const meta = sanitizeMeta(manifestSession.meta || input.manifest?.meta || firstEvent?.meta || {});
    const status = finishEvent ? (finishEvent.status === 'failed' ? 'failed' : 'finished') : 'running';
    const error =
      status === 'failed'
        ? finishEvent?.error || manifestSession.error || 'session failed'
        : null;

    return {
      id,
      executorName,
      context: {
        deviceId: deviceId || null,
        target,
        runDir: input.runDir,
        appId: resolveMetaAppId(meta),
        preflightConfig: input.manifest?.context?.preflightConfig || null,
        networkProfile: null,
        lastRunOutput: null,
        lastFlowPath: null,
        lastRunFailed: status === 'failed',
      },
      createdAt:
        manifestSession.created_at ||
        input.transcriptInfo.birthtime?.toISOString?.() ||
        input.transcriptInfo.mtime?.toISOString?.() ||
        nowIso(),
      updatedAt:
        manifestSession.updated_at ||
        input.transcriptInfo.mtime?.toISOString?.() ||
        nowIso(),
      status,
      error,
      recovered: true,
      meta,
      runDir: input.runDir,
      transcriptPath: input.transcriptPath,
      transcriptPathRelative: relativeRunsPath(this.rootDir, input.runDir, 'transcript.jsonl'),
      manifestPath: resolve(input.runDir, 'session.json'),
      manifestPathRelative: relativeRunsPath(this.rootDir, input.runDir, 'session.json'),
      transcript: input.transcript,
      actionCount: input.transcript.filter((event) => event.type === 'action').length,
      checkpointCount: input.transcript.filter((event) => event.type === 'checkpoint').length,
      artifactCount: input.transcript.filter((event) => event.type === 'artifact').length,
      network: recoverNetworkState({
        transcript: input.transcript,
        manifestNetwork: manifestSession.network,
        capabilities: networkCapabilitiesForExecutor(executorName),
      }),
    };
  }

  private resolveSessionArtifactPath(sessionId: string, artifactPath: string): { sessionId: string; runDir: string; path: string; absPath: string } {
    const session = this.requireSession(sessionId);
    const normalized = normalizeArtifactRelativePath(artifactPath);
    const absPath = resolve(session.runDir, normalized);
    const root = session.runDir.endsWith(sep) ? session.runDir : `${session.runDir}${sep}`;
    if (!absPath.startsWith(root)) {
      throw new Error('artifact path is outside the session run_dir');
    }
    return {
      sessionId: session.id,
      runDir: session.runDir,
      path: normalized,
      absPath,
    };
  }

  private async persistBinaryArtifact(
    session: LocalSessionRecord,
    input: {
      t: number;
      kind: string;
      path: string;
      absPath: string;
      bytes: number;
      sha256: string;
      meta?: Record<string, unknown>;
    }
  ): Promise<Record<string, any>> {
    return {
      t: input.t,
      type: 'artifact',
      kind: input.kind,
      path: input.path,
      sha256: input.sha256,
      bytes: input.bytes,
      meta: input.meta || null,
    };
  }

  private async persistTextArtifact(
    session: LocalSessionRecord,
    input: {
      t: number;
      kind: string;
      path: string;
      content: string;
      meta?: Record<string, unknown>;
    }
  ): Promise<Record<string, any>> {
    const absPath = resolve(session.runDir, input.path);
    await mkdir(dirnameSafe(absPath), { recursive: true });
    const payload = Buffer.from(String(input.content), 'utf8');
    await writeFile(absPath, payload);
    const sha256 = createHash('sha256').update(payload).digest('hex');
    return {
      t: input.t,
      type: 'artifact',
      kind: input.kind,
      path: input.path,
      sha256,
      bytes: payload.length,
      meta: input.meta || null,
    };
  }

  private async persistJsonArtifact(
    session: LocalSessionRecord,
    input: {
      t: number;
      kind: string;
      path: string;
      payload: unknown;
      meta?: Record<string, unknown>;
    }
  ): Promise<Record<string, any>> {
    return this.persistArtifactPayload(session, {
      ...input,
      format: 'json',
    });
  }

  private async persistArtifactPayload(
    session: LocalSessionRecord,
    input: {
      t: number;
      kind: string;
      path: string;
      payload: unknown;
      format?: string;
      meta?: Record<string, unknown>;
    }
  ): Promise<Record<string, any>> {
    const absPath = resolve(session.runDir, input.path);
    await mkdir(dirnameSafe(absPath), { recursive: true });
    const content = serializeArtifactPayload(input.payload, input.format);
    await writeFile(absPath, content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    return {
      t: input.t,
      type: 'artifact',
      kind: input.kind,
      path: input.path,
      sha256,
      bytes: content.length,
      meta: input.meta || null,
    };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeExecutor(value: unknown): LocalESVPExecutor {
  const raw = String(value || 'fake').trim() as LocalESVPExecutor;
  if (raw === 'fake' || raw === 'adb' || raw === 'ios-sim' || raw === 'maestro-ios') {
    return raw;
  }
  throw new Error(`Unknown ESVP executor: ${value}`);
}

function targetForExecutor(executor: LocalESVPExecutor): string {
  if (executor === 'adb') return 'android';
  if (executor === 'ios-sim' || executor === 'maestro-ios') return 'ios';
  return 'fake';
}

function resolveMetaAppId(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;
  if (typeof meta.appId === 'string' && meta.appId.trim()) return meta.appId.trim();
  if (typeof meta.app_id === 'string' && meta.app_id.trim()) return meta.app_id.trim();
  return null;
}

async function readJsonFile(filePath: string): Promise<any> {
  const text = await readFile(filePath, 'utf8').catch(() => null);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeTranscriptFile(filePath: string, transcript: Array<Record<string, any>>): Promise<void> {
  const lines = transcript.map((event) => JSON.stringify(event)).join('\n');
  await writeFile(filePath, `${lines}${lines ? '\n' : ''}`, 'utf8');
}

async function readTranscriptFile(filePath: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(filePath, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function createInitialNetworkState(executor: LocalESVPExecutor): Record<string, any> {
  return {
    supported: true,
    capabilities: networkCapabilitiesForExecutor(executor),
    active_profile: null,
    effective_profile: null,
    managed_proxy: null,
    configured_at: null,
    cleared_at: null,
    last_result: null,
    last_error: null,
    trace_count: 0,
    trace_kinds: [],
  };
}

function recoverNetworkState(input: {
  transcript: Array<Record<string, any>>;
  manifestNetwork: Record<string, any> | null | undefined;
  capabilities: Record<string, unknown>;
}): Record<string, any> {
  if (input.manifestNetwork && typeof input.manifestNetwork === 'object') {
    const managedProxyWasPersisted = Boolean(
      input.manifestNetwork.managed_proxy ||
      input.manifestNetwork.managedProxy ||
      String(input.manifestNetwork.effective_profile?.capture?.mode || '').trim().toLowerCase() === 'esvp-managed-proxy'
    );
    const activeProfile = input.manifestNetwork.active_profile || input.manifestNetwork.activeProfile || null;
    return {
      ...input.manifestNetwork,
      capabilities: input.manifestNetwork.capabilities || input.capabilities || null,
      ...(managedProxyWasPersisted
        ? {
            effective_profile: activeProfile,
            effectiveProfile: activeProfile,
            managed_proxy: null,
            managedProxy: null,
            last_error:
              (typeof input.manifestNetwork.last_error === 'string' && input.manifestNetwork.last_error) ||
              'managed proxy was released when the previous App Lab process exited',
            lastError:
              (typeof input.manifestNetwork.lastError === 'string' && input.manifestNetwork.lastError) ||
              'managed proxy was released when the previous App Lab process exited',
          }
        : {}),
    };
  }

  const networkArtifacts = (input.transcript || []).filter((event) => event.type === 'artifact' && String(event.kind || '').startsWith('network_'));
  const traceKinds = new Set<string>();
  for (const event of networkArtifacts) {
    if (event.kind === 'network_trace' && event.meta?.trace_kind) {
      traceKinds.add(String(event.meta.trace_kind));
    }
  }
  return {
    supported: networkArtifacts.length > 0 || Boolean(input.capabilities),
    capabilities: input.capabilities || null,
    active_profile: null,
    effective_profile: null,
    managed_proxy: null,
    configured_at: null,
    cleared_at: null,
    last_result: null,
    last_error: null,
    trace_count: networkArtifacts.filter((event) => event.kind === 'network_trace').length,
    trace_kinds: [...traceKinds],
  };
}

function summarizeArtifactEvent(event: Record<string, any>): Record<string, unknown> {
  return {
    kind: event.kind,
    path: event.path,
    meta: event.meta || null,
  };
}

function recountEvents(session: LocalSessionRecord, events: Array<Record<string, any>>): void {
  for (const event of events) {
    if (event.type === 'action') session.actionCount += 1;
    if (event.type === 'checkpoint') session.checkpointCount += 1;
    if (event.type === 'artifact') session.artifactCount += 1;
  }
}

function appendSessionEvents(session: LocalSessionRecord, events: Array<Record<string, any>>): void {
  if (!Array.isArray(events) || events.length === 0) return;
  session.transcript.push(...events);
  recountEvents(session, events);
  session.updatedAt = nowIso();
}

function extractReplayActionsFromTranscript(transcript: Array<Record<string, any>>): {
  action_count: number;
  skipped_action_count: number;
  actions: Array<Record<string, any>>;
  skipped_actions: Array<Record<string, any>>;
} {
  const actions: Array<Record<string, any>> = [];
  const skipped_actions: Array<Record<string, any>> = [];
  let pendingReplayActionIndex = -1;

  for (const event of transcript || []) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'action') {
      const name = String(event.name || '');
      if (!isReplayableTranscriptAction(name)) {
        skipped_actions.push({
          name,
          reason: 'non_replayable_action',
        });
        pendingReplayActionIndex = -1;
        continue;
      }
      actions.push({
        name,
        args: sanitizeReplayActionArgs(event.args),
        checkpointAfter: false,
      });
      pendingReplayActionIndex = actions.length - 1;
      continue;
    }

    if (event.type === 'checkpoint' && pendingReplayActionIndex >= 0) {
      const action = actions[pendingReplayActionIndex];
      action.checkpointAfter = true;
      if (event.label) action.checkpointLabel = event.label;
      pendingReplayActionIndex = -1;
      continue;
    }

    if (event.type === 'session_finished') {
      break;
    }
  }

  return {
    action_count: actions.length,
    skipped_action_count: skipped_actions.length,
    actions,
    skipped_actions,
  };
}

function sanitizeReplayActionArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (String(key).startsWith('_')) continue;
    out[key] = value;
  }
  return out;
}

function isReplayableTranscriptAction(name: string): boolean {
  if (!name) return false;
  if (String(name).startsWith('monitor.')) return false;
  if (String(name).startsWith('network.')) return false;
  return true;
}

function comparisonStrategyForExecutors(originalExecutor: LocalESVPExecutor, replayExecutor: LocalESVPExecutor): 'adb_ui_primary' | 'ios_step_parity' | 'strict_visual' {
  if (originalExecutor === 'adb' || replayExecutor === 'adb') {
    return 'adb_ui_primary';
  }
  if (
    originalExecutor === 'maestro-ios' ||
    replayExecutor === 'maestro-ios' ||
    originalExecutor === 'ios-sim' ||
    replayExecutor === 'ios-sim'
  ) {
    return 'ios_step_parity';
  }
  return 'strict_visual';
}

function compareCheckpointSequences(input: {
  expectedTranscript: Array<Record<string, any>>;
  actualTranscript: Array<Record<string, any>>;
  strategy?: 'adb_ui_primary' | 'ios_step_parity' | 'strict_visual';
}): Record<string, unknown> {
  const expected = (input.expectedTranscript || []).filter((event) => event.type === 'checkpoint');
  const actual = (input.actualTranscript || []).filter((event) => event.type === 'checkpoint');
  const maxLen = Math.max(expected.length, actual.length);
  const comparisons: Array<Record<string, any>> = [];
  let matchedMain = 0;
  let matchedLabel = 0;
  let matchedUi = 0;
  let matchedScreen = 0;
  let matchedState = 0;
  const strategy = input.strategy || 'strict_visual';

  for (let index = 0; index < maxLen; index += 1) {
    const exp = expected[index] || null;
    const act = actual[index] || null;
    const row: Record<string, any> = {
      index,
      expected: exp
        ? {
            t: exp.t ?? null,
            label: exp.label || null,
            ui_hash: exp.ui_hash,
            screen_hash: exp.screen_hash,
            state_hash: exp.state_hash || null,
          }
        : null,
      actual: act
        ? {
            t: act.t ?? null,
            label: act.label || null,
            ui_hash: act.ui_hash,
            screen_hash: act.screen_hash,
            state_hash: act.state_hash || null,
          }
        : null,
      ui_hash_match: Boolean(exp && act && exp.ui_hash === act.ui_hash),
      screen_hash_match: Boolean(exp && act && exp.screen_hash === act.screen_hash),
      state_hash_match: Boolean(exp && act && exp.state_hash && act.state_hash && exp.state_hash === act.state_hash),
      label_match: Boolean(exp && act && exp.label && act.label && normalizeCheckpointLabel(exp.label) === normalizeCheckpointLabel(act.label)),
    };
    row.strict_match = Boolean(row.ui_hash_match && row.screen_hash_match);
    row.main_match =
      strategy === 'adb_ui_primary'
        ? Boolean(row.ui_hash_match)
        : strategy === 'ios_step_parity'
          ? Boolean(row.label_match || row.strict_match)
          : Boolean(row.strict_match);
    if (row.label_match) matchedLabel += 1;
    if (row.ui_hash_match) matchedUi += 1;
    if (row.screen_hash_match) matchedScreen += 1;
    if (row.state_hash_match) matchedState += 1;
    if (row.main_match) matchedMain += 1;
    comparisons.push(row);
  }

  const expectedCount = expected.length;
  const mainRate = expectedCount > 0 ? matchedMain / expectedCount : 0;
  const verdict =
    expectedCount === 0 ? 'no_checkpoints' : mainRate >= 0.8 ? 'pass' : mainRate >= 0.5 ? 'partial' : 'fail';

  return {
    strategy,
    expected_checkpoint_count: expected.length,
    actual_checkpoint_count: actual.length,
    matched_main_count: matchedMain,
    matched_label_count: matchedLabel,
    matched_ui_count: matchedUi,
    matched_screen_count: matchedScreen,
    matched_state_count: matchedState,
    main_match_rate: Number(mainRate.toFixed(3)),
    label_match_rate: Number((expectedCount > 0 ? matchedLabel / expectedCount : 0).toFixed(3)),
    ui_match_rate: Number((expectedCount > 0 ? matchedUi / expectedCount : 0).toFixed(3)),
    screen_match_rate: Number((expectedCount > 0 ? matchedScreen / expectedCount : 0).toFixed(3)),
    state_match_rate: Number((expectedCount > 0 ? matchedState / expectedCount : 0).toFixed(3)),
    strict_match_rate: Number((expectedCount > 0 ? comparisons.filter((row) => row.strict_match).length / expectedCount : 0).toFixed(3)),
    verdict,
    divergences: comparisons.filter((row) => !row.main_match).slice(0, 20),
    comparisons: comparisons.slice(0, 50),
  };
}

function normalizeCheckpointLabel(label: unknown): string {
  return String(label || '')
    .trim()
    .toLowerCase();
}

function normalizeCheckpointLabelInput(label: unknown): string | null {
  const normalized = String(label || '').trim();
  return normalized || null;
}

function hasFinished(transcript: Array<Record<string, any>>): boolean {
  return transcript.some((event) => event.type === 'session_finished');
}

function lastEventTime(transcript: Array<Record<string, any>>): number {
  return transcript.length ? Number(transcript[transcript.length - 1].t || 0) : 0;
}

function lastEventTimeBeforeFinish(transcript: Array<Record<string, any>>): number {
  const finishIdx = transcript.findIndex((event) => event.type === 'session_finished');
  if (finishIdx <= 0) return 0;
  return Number(transcript[finishIdx - 1]?.t || 0);
}

function insertEventsBeforeSessionFinished(transcript: Array<Record<string, any>>, events: Array<Record<string, any>>): void {
  if (!Array.isArray(events) || events.length === 0) return;
  const finishIdx = transcript.findIndex((event) => event.type === 'session_finished');
  if (finishIdx < 0) {
    transcript.push(...events);
    return;
  }
  transcript.splice(finishIdx, 0, ...events);
}

function relativeRunsPath(rootDir: string, runDir: string, filename: string): string {
  if (!runDir.startsWith(rootDir)) return resolve(runDir, filename);
  return `runs/${runDir.slice(rootDir.length + 1)}/${filename}`;
}

function normalizeArtifactRelativePath(input: unknown): string {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('artifact path is empty');
  const segments = raw
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean);
  const normalized = segments.join('/');
  if (!normalized) throw new Error('invalid artifact path');
  if (segments.some((segment) => segment === '..')) {
    throw new Error('invalid artifact path');
  }
  return normalized;
}

function normalizeNetworkProfileInput(input: any): Record<string, any> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('network profile must be an object');
  }
  const proxyInput = input.proxy && typeof input.proxy === 'object' ? input.proxy : null;
  const faultsInput = input.faults && typeof input.faults === 'object' ? input.faults : null;
  const captureInput = input.capture && typeof input.capture === 'object' ? input.capture : null;
  return {
    profile: input.profile ? String(input.profile) : null,
    label: input.label ? String(input.label) : null,
    connectivity: normalizeNetworkConnectivity(input.connectivity),
    proxy: proxyInput
      ? {
          host: proxyInput.host ? String(proxyInput.host) : null,
          port: proxyInput.port != null ? Number(proxyInput.port) : null,
          protocol: proxyInput.protocol ? String(proxyInput.protocol) : 'http',
          bypass: Array.isArray(proxyInput.bypass) ? proxyInput.bypass.map((value: unknown) => String(value)) : [],
          bind_host: proxyInput.bind_host ? String(proxyInput.bind_host) : proxyInput.bindHost ? String(proxyInput.bindHost) : null,
          advertise_host: proxyInput.advertise_host ? String(proxyInput.advertise_host) : proxyInput.advertiseHost ? String(proxyInput.advertiseHost) : null,
        }
      : null,
    faults: faultsInput
      ? {
          delay_ms: numberOrNull(faultsInput.delay_ms ?? faultsInput.delayMs),
          timeout: faultsInput.timeout === true,
          offline_partial: faultsInput.offline_partial === true || faultsInput.offlinePartial === true,
          status_code: numberOrNull(faultsInput.status_code ?? faultsInput.statusCode),
          body_patch: faultsInput.body_patch ?? faultsInput.bodyPatch ?? null,
        }
      : null,
    capture: captureInput
      ? {
          enabled: captureInput.enabled !== false,
          mode: captureInput.mode ? String(captureInput.mode) : null,
        }
      : null,
  };
}

function normalizeNetworkConnectivity(value: unknown): 'offline' | 'online' | 'reset' | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'offline' || raw === 'online' || raw === 'reset') return raw;
  throw new Error(`invalid network connectivity: ${value}`);
}

function normalizeNetworkTraceInput(input: any): {
  trace_kind: string;
  label: string | null;
  format: string;
  payload: unknown;
  source: string | null;
  request_id: string | null;
  url: string | null;
  method: string | null;
  status_code: number | null;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('network trace must be an object');
  }

  const traceKind = String(input.trace_kind || input.kind || 'http_trace').trim();
  if (!traceKind) throw new Error('network trace.trace_kind is required');
  const payload = input.payload ?? input.trace ?? input.content;
  if (payload == null) throw new Error('network trace.payload is required');

  return {
    trace_kind: traceKind,
    label: input.label ? String(input.label) : null,
    format: inferNetworkTraceFormat(input.format, payload, traceKind),
    payload,
    source: input.source ? String(input.source) : null,
    request_id: input.request_id ? String(input.request_id) : null,
    url: input.url ? String(input.url) : null,
    method: input.method ? String(input.method) : null,
    status_code: input.status_code != null ? Number(input.status_code) : null,
  };
}

function inferNetworkTraceFormat(explicitFormat: unknown, payload: unknown, traceKind: string): string {
  if (explicitFormat) return String(explicitFormat);
  if (traceKind === 'har') return 'har';
  if (typeof payload === 'string') return 'text';
  return 'json';
}

function buildNetworkArtifactPath(
  session: LocalSessionRecord,
  kind: string,
  options: { label?: string; format?: string; traceKind?: string } = {}
): string {
  const existingCount = (session.transcript || []).filter((event) => event.type === 'artifact' && String(event.kind || '').startsWith('network_')).length;
  const seq = String(existingCount + 1).padStart(3, '0');
  const safeBase = slugify(options.label || options.traceKind || kind);
  const ext = networkArtifactExt(kind, options.format, options.traceKind);
  return `network/${seq}-${kind}-${safeBase}${ext}`;
}

function networkArtifactExt(kind: string, format?: string, traceKind?: string): string {
  if (kind === 'network_trace' && traceKind === 'har') return '.har.json';
  if (format === 'json' || format === 'har') return '.json';
  if (format === 'txt' || format === 'text') return '.txt';
  return '.json';
}

function serializeArtifactPayload(payload: unknown, format?: string): Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  if (format === 'json' || format === 'har' || !format) {
    return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
  return Buffer.from(String(payload), 'utf8');
}

function sanitizeMeta<T = Record<string, unknown>>(meta: unknown): T {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {} as T;
  return JSON.parse(JSON.stringify(meta)) as T;
}

function sanitizeNetworkResult(result: unknown): any {
  if (!result || typeof result !== 'object') return result ?? null;
  return JSON.parse(JSON.stringify(result));
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function slugify(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'artifact';
}

function mergeNetworkCapabilities(...caps: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> | null {
  const normalized = caps.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'));
  if (!normalized.length) return null;
  return Object.assign({}, ...normalized);
}

function dirnameSafe(pathLike: string): string {
  const index = pathLike.lastIndexOf('/');
  return index >= 0 ? pathLike.slice(0, index) : '.';
}
