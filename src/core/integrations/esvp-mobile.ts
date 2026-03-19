import type { CapturedNetworkEntry, NetworkCaptureMeta } from '../testing/networkCapture.js';
import type { MaestroRecordingAction } from '../testing/maestro.js';
import { recognizeText } from '../analyze/ocr.js';
import {
  selectVisibleActionFromScreenshot,
  type ActionDetectorProvider,
} from '../analyze/aiActionDetector.js';
import {
  configureESVPNetwork,
  createESVPSession,
  getESVPArtifactContent,
  getESVPConnection,
  getESVPReplayConsistency,
  getESVPSessionNetwork,
  inspectESVPSession,
  replayESVPSession,
  runESVPActions,
  type ESVPAction,
  type ESVPArtifactSummary,
  type ESVPManagedProxyState,
  type ESVPSessionNetworkState,
} from './esvp.js';
import {
  buildAppLabNetworkProfile,
} from './esvp-network-profile.js';
import {
  ensureLocalCaptureProxyProfile,
  finalizeLocalCaptureProxySession,
  type LocalCaptureProxyState,
} from './local-network-proxy.js';

type MobilePlatform = 'ios' | 'android';

export interface MaestroRecordingLike {
  id: string;
  name: string;
  platform: MobilePlatform;
  deviceId: string;
  deviceName?: string;
  appId?: string;
  actions: MaestroRecordingAction[];
}

export interface ESVPMobileValidationResult {
  supported: boolean;
  reason?: string | null;
  connectionMode: 'local' | 'remote';
  serverUrl: string;
  executor: 'adb' | 'maestro-ios' | 'ios-sim';
  translatedActions: ESVPAction[];
  skippedActions: Array<{ actionId: string; type: string; reason: string }>;
  sourceSessionId?: string | null;
  replaySessionId?: string | null;
  runSummary?: unknown;
  checkpointComparison?: unknown;
  replayConsistency?: unknown;
  networkEntries: CapturedNetworkEntry[];
  networkCapture: NetworkCaptureMeta & Record<string, unknown>;
  traceKinds: string[];
  networkState?: ESVPSessionNetworkState | null;
  managedProxy?: ESVPManagedProxyState | null;
  captureProxy?: LocalCaptureProxyState | null;
  networkProfileApplied?: Record<string, unknown> | null;
  bootstrap?: {
    applied: boolean;
    launchInserted: boolean;
    initialAnchorLabel?: string | null;
    actionCount: number;
    screenshotPath?: string | null;
  } | null;
  recovery?: {
    applied: boolean;
    strategy: string;
    initialSourceSessionId?: string | null;
    finalSourceSessionId?: string | null;
    prunedActionCount?: number;
    resumedFromActionIndex?: number;
    matchedActionIndex?: number;
    matchedActionLabel?: string | null;
    checkpointScreenshotPath?: string | null;
    visibleTextPreview?: string | null;
  } | null;
}

export interface ESVPMobileNetworkProfileInput {
  enabled?: boolean;
  mode?: 'managed-proxy' | 'external-proxy';
  profile?: string;
  label?: string;
  connectivity?: 'online' | 'offline' | 'reset';
  proxy?: Record<string, unknown>;
  capture?: Record<string, unknown>;
  faults?: Record<string, unknown>;
}

export interface ESVPMobileValidationOptions {
  serverUrl?: string;
  network?: ESVPMobileNetworkProfileInput | null;
  captureLogcat?: boolean;
  replay?: boolean;
  bootstrapScreenshotPath?: string;
  recoveryVisionProvider?: ActionDetectorProvider | ActionDetectorProvider[];
  allowAppLabOwnedProxyAutostart?: boolean;
}

export function createMobileNetworkCaptureMeta(input?: Partial<NetworkCaptureMeta> & Record<string, unknown>) {
  const resourceTypes = Array.isArray(input?.resourceTypes) && input.resourceTypes.length > 0
    ? input.resourceTypes.map((value) => String(value))
    : ['mobile-http-trace'];
  return {
    truncated: input?.truncated === true,
    maxEntries: Number.isFinite(input?.maxEntries) ? Number(input?.maxEntries) : 1200,
    resourceTypes,
    ...input,
  } as NetworkCaptureMeta & Record<string, unknown>;
}

export interface ESVPNetworkDiagnostic {
  status: 'no_session' | 'not_supported' | 'not_configured' | 'has_traces_need_sync' | 'proxy_no_traffic' | 'synced' | 'unknown';
  message: string;
  detail?: string;
  traceCount?: number;
  entryCount?: number;
}

export function diagnoseESVPNetworkState(opts: {
  sourceSessionId?: string | null;
  networkSupported?: boolean | null;
  configuredAt?: string | null;
  managedProxy?: { entry_count?: number; bind_host?: string; port?: number } | null;
  captureMode?: string | null;
  traceCount?: number | null;
  entryCount?: number;
  syncedAt?: string | null;
  executor?: string | null;
}): ESVPNetworkDiagnostic {
  if (!opts.sourceSessionId) {
    return {
      status: 'no_session',
      message: 'No ESVP session attached to this project.',
    };
  }

  if (opts.networkSupported === false) {
    const executorLabel = opts.executor === 'maestro-ios' ? 'iOS (Maestro)' : opts.executor || 'this executor';
    return {
      status: 'not_supported',
      message: `Network capture not supported for ${executorLabel}. Use external proxy or attach HAR manually.`,
    };
  }

  if (!opts.configuredAt) {
    return {
      status: 'not_configured',
      message: 'Network profile was never configured for this session. Network capture requires configuring a profile before running actions.',
    };
  }

  const proxyEntryCount = opts.managedProxy?.entry_count ?? 0;
  const traceCount = opts.traceCount ?? 0;

  if ((proxyEntryCount > 0 || traceCount > 0) && (!opts.entryCount || opts.entryCount === 0)) {
    const count = proxyEntryCount || traceCount;
    return {
      status: 'has_traces_need_sync',
      message: `ESVP session has ${count} captured request${count !== 1 ? 's' : ''}. Click 'Sync Network Trace' to pull them.`,
      traceCount: count,
    };
  }

  if (proxyEntryCount === 0 && traceCount === 0 && (!opts.entryCount || opts.entryCount === 0)) {
    return {
      status: 'proxy_no_traffic',
      message: opts.captureMode === 'external-proxy'
        ? 'External proxy capture is configured but no network_trace has been attached yet.'
        : 'Managed proxy was active but captured zero requests. The device may not have routed traffic through the proxy.',
      detail: opts.captureMode === 'external-proxy'
        ? undefined
        : opts.managedProxy
          ? `Proxy bound to ${opts.managedProxy.bind_host || '?'}:${opts.managedProxy.port || '?'}`
          : undefined,
    };
  }

  if (opts.entryCount && opts.entryCount > 0) {
    return {
      status: 'synced',
      message: `${opts.entryCount} network entries synced.`,
      entryCount: opts.entryCount,
    };
  }

  return {
    status: 'unknown',
    message: 'Unable to determine network capture state.',
  };
}

export async function collectESVPSessionNetworkData(
  sessionId: string,
  serverUrl?: string
): Promise<{
  networkEntries: CapturedNetworkEntry[];
  networkCapture: NetworkCaptureMeta & Record<string, unknown>;
  traceKinds: string[];
  networkState: ESVPSessionNetworkState | null;
}> {
  const inspection = await inspectESVPSession(
    sessionId,
    {
      includeArtifacts: true,
      includeTranscript: false,
    },
    serverUrl
  );
  const artifacts = Array.isArray(inspection?.artifacts) ? (inspection.artifacts as ESVPArtifactSummary[]) : [];
  const networkState = await getESVPSessionNetwork(sessionId, serverUrl).catch(() => null);
  const publicNetworkState = isObject(networkState?.network)
    ? (networkState.network as ESVPSessionNetworkState)
    : null;
  const normalized = await normalizeESVPNetworkArtifacts(sessionId, artifacts, serverUrl);
  const traceKinds = Array.isArray(publicNetworkState?.trace_kinds)
    ? publicNetworkState.trace_kinds.map((value: unknown) => String(value))
    : normalized.traceKinds;
  const networkCapture = createMobileNetworkCaptureMeta({
    ...normalized.networkCapture,
    traceKinds,
    source: 'esvp-mobile',
    sessionId,
    managedProxy: publicNetworkState?.managed_proxy || null,
    effectiveProfile: publicNetworkState?.effective_profile || null,
  });

  return {
    networkEntries: normalized.networkEntries,
    networkCapture,
    traceKinds,
    networkState: publicNetworkState,
  };
}

export async function validateMaestroRecordingWithESVP(
  recording: MaestroRecordingLike,
  optionsOrServerUrl?: string | ESVPMobileValidationOptions
): Promise<ESVPMobileValidationResult> {
  const options = normalizeValidationOptions(optionsOrServerUrl);
  const executor = recording.platform === 'android' ? 'adb' : 'maestro-ios';
  const connection = await getESVPConnection(options.serverUrl);
  const normalizedAppId = normalizeRecordingAppId(recording.appId);
  const bootstrap = await buildRecordingBootstrapActions(recording, {
    appId: normalizedAppId,
    screenshotPath: options.bootstrapScreenshotPath,
  });
  const effectiveRecordingActions = [...bootstrap.actions, ...(recording.actions || [])];
  const translated = translateMaestroActionsToESVP(effectiveRecordingActions, { appId: normalizedAppId });
  const shouldCaptureLogcat = resolveCaptureLogcat(executor, options.captureLogcat);
  const requestedNetworkProfile = normalizeRequestedNetworkProfile(options.network, {
    platform: recording.platform,
    deviceId: recording.deviceId,
  });

  if (translated.actions.length === 0) {
    return {
      supported: false,
      reason: 'Nenhuma action compatível com o contrato público do ESVP foi encontrada nesta gravação Maestro.',
      connectionMode: connection.mode,
      serverUrl: connection.serverUrl,
      executor,
      translatedActions: translated.actions,
      skippedActions: translated.skipped,
      networkEntries: [],
      networkCapture: createMobileNetworkCaptureMeta({
        source: 'esvp-mobile',
        sessionId: null,
      }),
      traceKinds: [],
      bootstrap: bootstrap.summary,
      recovery: null,
    };
  }

  let translatedActions = translated.actions;
  let skippedActions = [...translated.skipped];
  let recovery: ESVPMobileValidationResult['recovery'] = null;

  let execution = await runValidationSourceSession(
    recording,
    {
      executor,
      appId: normalizedAppId,
      translatedActions,
      requestedNetworkProfile,
      captureLogcat: shouldCaptureLogcat,
      serverUrl: options.serverUrl,
      metaSource: 'applab-discovery-maestro-validation',
      allowAppLabOwnedProxyAutostart: options.allowAppLabOwnedProxyAutostart,
    }
  );

  const initialSourceSessionId = execution.sourceSessionId;
  if (executor === 'maestro-ios' && didESVPRunFail(execution.run)) {
    const recoveryPlan = await buildIOSVisibleTextRecoveryPlan(
      execution.sourceSessionId,
      translatedActions,
      options.serverUrl,
      options.recoveryVisionProvider
    );
    if (recoveryPlan) {
      const retryExecution = await runValidationSourceSession(
        recording,
        {
          executor,
          appId: normalizedAppId,
          translatedActions: recoveryPlan.prunedActions,
          requestedNetworkProfile,
          captureLogcat: shouldCaptureLogcat,
          serverUrl: options.serverUrl,
          metaSource: 'applab-discovery-maestro-validation-recovered',
          extraMeta: {
            recovery_strategy: recoveryPlan.strategy,
            recovery_source_session_id: execution.sourceSessionId,
            recovery_pruned_action_count: recoveryPlan.prunedSkipped.length,
          },
          allowAppLabOwnedProxyAutostart: options.allowAppLabOwnedProxyAutostart,
        }
      );

      if (shouldPreferRecoveredExecution(execution.run, retryExecution.run)) {
        execution = retryExecution;
        translatedActions = recoveryPlan.prunedActions;
        skippedActions = [...skippedActions, ...recoveryPlan.prunedSkipped];
        recovery = {
          applied: true,
          strategy: recoveryPlan.strategy,
          initialSourceSessionId,
          finalSourceSessionId: retryExecution.sourceSessionId,
          prunedActionCount: recoveryPlan.prunedSkipped.length,
          resumedFromActionIndex: recoveryPlan.resumeFromIndex,
          matchedActionIndex: recoveryPlan.matchedActionIndex,
          matchedActionLabel: recoveryPlan.matchedActionLabel,
          checkpointScreenshotPath: recoveryPlan.checkpointScreenshotPath,
          visibleTextPreview: recoveryPlan.visibleTextPreview,
        };
      }
    }
  }

  const sourceSessionId = execution.sourceSessionId;

  const replay = options.replay === false
    ? null
    : await replayESVPSession(
        sourceSessionId,
        {
          executor,
          deviceId: recording.deviceId,
          captureLogcat: shouldCaptureLogcat,
          meta: {
            source: 'applab-discovery-maestro-replay',
            recording_id: recording.id,
            ...(recovery?.applied ? { recovery_strategy: recovery.strategy } : {}),
          },
        },
        options.serverUrl
      );
  const replaySessionId = replay?.replay_session?.id ? String(replay.replay_session.id) : null;

  const replayConsistency = replaySessionId
    ? await getESVPReplayConsistency(replaySessionId, options.serverUrl).catch(() => null)
    : null;

  const networkData = await collectESVPSessionNetworkData(sourceSessionId, options.serverUrl).catch(() => ({
    networkEntries: [],
    networkCapture: createMobileNetworkCaptureMeta({
      source: 'esvp-mobile',
      sessionId: sourceSessionId,
    }),
    traceKinds: [],
    networkState: null,
  }));
  const networkState = mergeNetworkState(
    networkData.networkState,
    extractNetworkStateFromConfig(execution.networkConfigResult)
  );
  if (networkState && execution.cleanupError && !networkState.last_error) {
    networkState.last_error = execution.cleanupError;
  }
  if (networkState && execution.clearedAt && !networkState.cleared_at) {
    networkState.cleared_at = execution.clearedAt;
  }

  return {
    supported: true,
    connectionMode: connection.mode,
    serverUrl: connection.serverUrl,
    executor,
    translatedActions,
    skippedActions,
    sourceSessionId,
    replaySessionId,
    runSummary: execution.run,
    checkpointComparison: replay?.checkpoint_comparison || null,
    replayConsistency: replayConsistency?.replay_consistency || null,
    networkEntries: networkData.networkEntries,
    networkCapture: networkData.networkCapture,
    traceKinds: networkData.traceKinds,
    networkState,
    managedProxy: networkState?.managed_proxy || null,
    captureProxy: execution.captureProxy || null,
    networkProfileApplied: isObject(execution.networkConfigResult?.applied)
      ? (execution.networkConfigResult?.applied as Record<string, unknown>)
      : null,
    bootstrap: bootstrap.summary,
    recovery,
  };
}

async function runValidationSourceSession(
  recording: MaestroRecordingLike,
  input: {
    executor: 'adb' | 'maestro-ios' | 'ios-sim';
    appId?: string;
    translatedActions: ESVPAction[];
    requestedNetworkProfile: Record<string, unknown> | null;
    captureLogcat: boolean;
    serverUrl?: string;
    metaSource: string;
    extraMeta?: Record<string, unknown>;
    allowAppLabOwnedProxyAutostart?: boolean;
  }
): Promise<{
  sourceSessionId: string;
  run: any;
  networkConfigResult: Record<string, unknown> | null;
  captureProxy: LocalCaptureProxyState | null;
  cleanupError: string | null;
  clearedAt: string | null;
}> {
  const created = await createESVPSession(
    {
      executor: input.executor,
      deviceId: recording.deviceId,
      meta: {
        source: input.metaSource,
        recording_id: recording.id,
        recording_name: recording.name,
        recording_platform: recording.platform,
        recording_device_name: recording.deviceName || null,
        ...(input.appId ? { appId: input.appId, app_id: input.appId } : {}),
        ...(input.extraMeta || {}),
      },
    },
    input.serverUrl
  );
  const sourceSessionId = String(created?.session?.id || created?.id || '');
  if (!sourceSessionId) {
    throw new Error('Falha ao criar sessão ESVP para validação Maestro.');
  }

  const preparedNetworkProfile = await ensureLocalCaptureProxyProfile({
    sessionId: sourceSessionId,
    profile: input.requestedNetworkProfile,
    platform: recording.platform,
    deviceId: recording.deviceId,
    allowAppLabOwnedProxy: input.allowAppLabOwnedProxyAutostart,
    lifecycle: {
      executor: input.executor,
      deviceId: recording.deviceId,
      serverUrl: input.serverUrl,
      captureLogcat: input.captureLogcat,
      cleanupMeta: {
        recording_id: recording.id,
        recording_name: recording.name,
        recording_platform: recording.platform,
      },
    },
  });

  let networkConfigResult: Record<string, unknown> | null = null;
  if (preparedNetworkProfile.profile) {
    networkConfigResult = await configureESVPNetwork(
      sourceSessionId,
      preparedNetworkProfile.profile,
      input.serverUrl
    );
  }

  let run: any = null;
  let runError: unknown = null;

  try {
    run = await runESVPActions(
      sourceSessionId,
      {
        actions: input.translatedActions,
        finish: false,
        captureLogcat: input.captureLogcat,
        checkpointAfterEach: true,
      },
      input.serverUrl
    );
  } catch (error) {
    runError = error;
  }

  const finalization = await finalizeLocalCaptureProxySession({
    sourceSessionId,
    executor: input.executor,
    deviceId: recording.deviceId,
    serverUrl: input.serverUrl,
    captureLogcat: input.captureLogcat,
    clearNetwork: Boolean(preparedNetworkProfile.profile),
    cleanupMeta: {
      recording_id: recording.id,
      recording_name: recording.name,
      recording_platform: recording.platform,
    },
  });

  if (runError) {
    throw runError;
  }

  return {
    sourceSessionId,
    run,
    networkConfigResult,
    captureProxy: preparedNetworkProfile.captureProxy,
    cleanupError: finalization.errors[0] || null,
    clearedAt: finalization.clearedAt,
  };
}

function didESVPRunFail(run: any): boolean {
  return Boolean(run?.failed || run?.session?.status === 'failed');
}

function getESVPRunCheckpointCount(run: any): number {
  return Number.isFinite(run?.session?.checkpoint_count) ? Number(run.session.checkpoint_count) : 0;
}

function shouldPreferRecoveredExecution(initialRun: any, retryRun: any): boolean {
  if (!didESVPRunFail(retryRun)) return true;
  return getESVPRunCheckpointCount(retryRun) > getESVPRunCheckpointCount(initialRun);
}

function getTranslatedActionId(action: ESVPAction, index: number): string {
  if (typeof action?.checkpointLabel === 'string' && action.checkpointLabel.trim()) {
    return action.checkpointLabel.trim();
  }
  return `esvp_action_${String(index + 1).padStart(3, '0')}`;
}

function normalizeMatchText(value?: string): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCandidateLabel(value?: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isLikelyBootstrapAnchorLabel(value?: string): boolean {
  const label = normalizeCandidateLabel(value);
  if (!label) return false;
  if (label.length > 24) return false;
  if (/@|https?:\/\/|www\./i.test(label)) return false;
  if (/\d/.test(label)) return false;
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  const lowered = label.toLowerCase();
  if (['preferred name', 'phone number', 'enable notifications', 'tap to see subscription options'].includes(lowered)) {
    return false;
  }
  return true;
}

async function inferBootstrapAnchorFromScreenshot(screenshotPath?: string): Promise<string | null> {
  const targetPath = normalizeCandidateLabel(screenshotPath);
  if (!targetPath) return null;

  const ocrResult = await recognizeText(targetPath, {
    recognitionLevel: 'accurate',
    languages: ['en-US', 'pt-BR'],
  }).catch(() => null);
  const text = typeof ocrResult?.text === 'string' ? ocrResult.text : '';
  if (!ocrResult?.success || !text.trim()) {
    return null;
  }

  const lines = text
    .split(/\n+/)
    .map((line) => normalizeCandidateLabel(line))
    .filter(Boolean);

  const counts = new Map<string, number>();
  const ordered: string[] = [];
  for (const line of lines) {
    if (!isLikelyBootstrapAnchorLabel(line)) continue;
    const normalized = normalizeMatchText(line);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
    if (!ordered.includes(normalized)) {
      ordered.push(normalized);
    }
  }

  for (const normalized of ordered) {
    if ((counts.get(normalized) || 0) < 2) continue;
    const original = lines.find((line) => normalizeMatchText(line) === normalized);
    if (original) {
      return original;
    }
  }

  return null;
}

async function buildRecordingBootstrapActions(
  recording: MaestroRecordingLike,
  options: {
    appId?: string;
    screenshotPath?: string;
  }
): Promise<{
  actions: MaestroRecordingAction[];
  summary: ESVPMobileValidationResult['bootstrap'];
}> {
  const actions: MaestroRecordingAction[] = [];
  const launchAppId = normalizeRecordingAppId(options.appId || recording.appId);
  const hasExplicitLaunch = (recording.actions || []).some((action) => action?.type === 'launch');

  if (launchAppId && !hasExplicitLaunch) {
    actions.push({
      id: 'bootstrap_launch',
      type: 'launch',
      timestamp: Date.now(),
      description: `Launch ${launchAppId}`,
      text: launchAppId,
      appId: launchAppId,
    });
  }

  const initialAnchorLabel = await inferBootstrapAnchorFromScreenshot(options.screenshotPath);
  const firstActionLabel = normalizeMatchText((recording.actions || [])[0]?.text);
  if (initialAnchorLabel && normalizeMatchText(initialAnchorLabel) !== firstActionLabel) {
    actions.push({
      id: 'bootstrap_anchor_001',
      type: 'tap',
      timestamp: Date.now(),
      description: `Return to ${initialAnchorLabel} screen`,
      text: initialAnchorLabel,
    });
  }

  return {
    actions,
    summary: {
      applied: actions.length > 0,
      launchInserted: actions.some((action) => action.type === 'launch'),
      initialAnchorLabel: initialAnchorLabel || null,
      actionCount: actions.length,
      screenshotPath: options.screenshotPath || null,
    },
  };
}

function previewVisibleText(value?: string, maxLength = 220): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function getActionTextCandidates(action: ESVPAction): string[] {
  const args = isObject(action?.args) ? (action.args as Record<string, unknown>) : {};
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value?: unknown) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  push(args.text);
  push(args.selector);
  if (Array.isArray(args.selectors)) {
    for (const selector of args.selectors) {
      if (!isObject(selector)) continue;
      push(selector.selector);
      push(selector.label);
    }
  }

  return candidates;
}

function scoreActionAgainstVisibleText(action: ESVPAction, visibleText: string): number {
  const haystack = normalizeMatchText(visibleText);
  if (!haystack) return 0;

  let bestScore = 0;
  for (const candidate of getActionTextCandidates(action)) {
    const needle = normalizeMatchText(candidate);
    if (!needle) continue;
    if (haystack.includes(needle)) {
      bestScore = Math.max(bestScore, 1);
      continue;
    }

    const tokens = needle.split(' ').filter((part) => part.length > 1);
    if (tokens.length === 0) continue;
    const matchedTokens = tokens.filter((part) => haystack.includes(part)).length;
    if (!matchedTokens) continue;
    const score = (matchedTokens / tokens.length) * 0.45;
    if (score > bestScore) {
      bestScore = score;
    }
  }

  return bestScore;
}

function getLatestScreenshotArtifactPath(artifacts: ESVPArtifactSummary[]): string | null {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (artifact?.kind !== 'screenshot') continue;
    if (typeof artifact.abs_path === 'string' && artifact.abs_path.trim()) {
      return artifact.abs_path.trim();
    }
  }
  return null;
}

async function buildIOSVisibleTextRecoveryPlan(
  sourceSessionId: string,
  translatedActions: ESVPAction[],
  serverUrl?: string,
  recoveryVisionProvider?: ActionDetectorProvider | ActionDetectorProvider[]
): Promise<{
  strategy: 'ios-visible-text-reconciliation';
  prunedActions: ESVPAction[];
  prunedSkipped: Array<{ actionId: string; type: string; reason: string }>;
  checkpointScreenshotPath: string;
  visibleTextPreview: string;
  resumeFromIndex: number;
  matchedActionIndex: number;
  matchedActionLabel: string | null;
} | null> {
  const inspection = await inspectESVPSession(
    sourceSessionId,
    {
      includeArtifacts: true,
      includeTranscript: false,
    },
    serverUrl
  ).catch(() => null);

  const completedCount = Number.isFinite(inspection?.session?.checkpoint_count)
    ? Number(inspection.session.checkpoint_count)
    : 0;
  if (completedCount <= 0 || completedCount >= translatedActions.length) {
    return null;
  }

  const artifacts = Array.isArray(inspection?.artifacts) ? (inspection.artifacts as ESVPArtifactSummary[]) : [];
  const checkpointScreenshotPath = getLatestScreenshotArtifactPath(artifacts);
  if (!checkpointScreenshotPath) {
    return null;
  }

  const ocrResult = await recognizeText(checkpointScreenshotPath, {
    recognitionLevel: 'accurate',
    languages: ['en-US', 'pt-BR'],
  }).catch(() => null);
  const visibleText = typeof ocrResult?.text === 'string' ? ocrResult.text : '';
  if (!ocrResult?.success || !visibleText.trim()) {
    return null;
  }

  const currentIndex = completedCount;
  const currentScore = scoreActionAgainstVisibleText(translatedActions[currentIndex], visibleText);
  if (currentScore >= 0.7) {
    return null;
  }

  const maxLookahead = Math.min(translatedActions.length, currentIndex + 3);
  let matchedActionIndex = -1;
  let matchedActionScore = 0;

  for (let index = currentIndex + 1; index < maxLookahead; index += 1) {
    const score = scoreActionAgainstVisibleText(translatedActions[index], visibleText);
    if (score > matchedActionScore) {
      matchedActionScore = score;
      matchedActionIndex = index;
    }
  }

  if (matchedActionIndex <= currentIndex || matchedActionScore < 0.7) {
    const visibleActionCandidates = translatedActions
      .slice(currentIndex, maxLookahead)
      .map((action) => getActionTextCandidates(action)[0] || String(action?.name || 'action'))
      .filter(Boolean);
    const visionSelection = await selectVisibleActionFromScreenshot(
      checkpointScreenshotPath,
      visibleActionCandidates,
      recoveryVisionProvider
    ).catch(() => null);

    if (!visionSelection?.selectedLabel) {
      return null;
    }

    const selectedNormalized = normalizeMatchText(visionSelection.selectedLabel);
    matchedActionIndex = translatedActions.findIndex((action, index) => {
      if (index < currentIndex || index >= maxLookahead) return false;
      return getActionTextCandidates(action).some((candidate) => normalizeMatchText(candidate) === selectedNormalized);
    });

    if (matchedActionIndex <= currentIndex) {
      return null;
    }
  }

  const prunedActions = translatedActions.filter((_, index) => index < currentIndex || index >= matchedActionIndex);
  if (prunedActions.length === translatedActions.length) {
    return null;
  }

  const prunedSkipped = translatedActions.slice(currentIndex, matchedActionIndex).map((action, offset) => ({
    actionId: getTranslatedActionId(action, currentIndex + offset),
    type: String(action?.name || 'action'),
    reason: 'pruned after checkpoint OCR matched a later visible UI action',
  }));

  return {
    strategy: 'ios-visible-text-reconciliation',
    prunedActions,
    prunedSkipped,
    checkpointScreenshotPath,
    visibleTextPreview: previewVisibleText(visibleText),
    resumeFromIndex: currentIndex,
    matchedActionIndex,
    matchedActionLabel: getActionTextCandidates(translatedActions[matchedActionIndex])[0] || null,
  };
}

function normalizeValidationOptions(input?: string | ESVPMobileValidationOptions): ESVPMobileValidationOptions {
  if (typeof input === 'string') {
    return {
      serverUrl: input,
    };
  }
  return input || {};
}

function normalizeRecordingAppId(appId?: string): string | undefined {
  const value = String(appId || '').trim();
  if (!value) return undefined;
  if (value === 'com.example.app') return undefined;
  if (value.includes('# TODO')) return undefined;
  return value;
}

function buildTextQueryVariants(value?: string): string[] {
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  if (!raw) return [];

  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (candidate?: string) => {
    const normalized = String(candidate || '').trim().replace(/\s+/g, ' ');
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    variants.push(normalized);
  };

  push(raw);

  const withoutContext = raw.replace(/\s+(?:in|inside|within|from|on)\s+.+$/i, '').trim();
  push(withoutContext);

  const withoutUiNoun = withoutContext.replace(/\s+(?:button|tab|icon|link|banner|card|item|field|input|modal|sheet|screen|section|row)$/i, '').trim();
  push(withoutUiNoun);

  const withoutCommonWords = withoutUiNoun
    .split(/\s+/)
    .filter((part) => !['my', 'the', 'a', 'an', 'to', 'for', 'of'].includes(part.toLowerCase()))
    .join(' ');
  push(withoutCommonWords);

  const firstSegment = withoutUiNoun.split(/\s*[\/>|-]\s*/)[0]?.trim();
  push(firstSegment);

  return variants;
}

function choosePrimaryTextQuery(value?: string): string {
  const variants = buildTextQueryVariants(value);
  if (variants.length === 0) return '';
  return variants[variants.length - 1] || variants[0] || '';
}

function resolveCaptureLogcat(executor: 'adb' | 'maestro-ios' | 'ios-sim', captureLogcat?: boolean): boolean {
  if (typeof captureLogcat === 'boolean') return captureLogcat;
  return executor === 'adb';
}

function normalizeRequestedNetworkProfile(
  input?: ESVPMobileNetworkProfileInput | null,
  context?: { platform?: MobilePlatform; deviceId?: string }
): Record<string, unknown> | null {
  return buildAppLabNetworkProfile(input, context);
}

function extractNetworkStateFromConfig(config: Record<string, unknown> | null): ESVPSessionNetworkState | null {
  if (!isObject(config?.network)) return null;
  return config.network as ESVPSessionNetworkState;
}

function mergeNetworkState(
  primary: ESVPSessionNetworkState | null,
  fallback: ESVPSessionNetworkState | null
): ESVPSessionNetworkState | null {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return {
    ...fallback,
    ...primary,
    active_profile: primary.active_profile ?? fallback.active_profile ?? null,
    effective_profile: primary.effective_profile ?? fallback.effective_profile ?? null,
    configured_at: primary.configured_at ?? fallback.configured_at ?? null,
    managed_proxy: primary.managed_proxy ?? fallback.managed_proxy ?? null,
  };
}

export function translateMaestroActionsToESVP(
  actions: MaestroRecordingAction[],
  options: { appId?: string } = {}
): {
  actions: ESVPAction[];
  skipped: Array<{ actionId: string; type: string; reason: string }>;
} {
  const translated: ESVPAction[] = [];
  const skipped: Array<{ actionId: string; type: string; reason: string }> = [];

  const pushTranslated = (action: ESVPAction | null, source: MaestroRecordingAction, reason?: string) => {
    if (action) {
      translated.push(action);
      return;
    }
    skipped.push({
      actionId: source.id,
      type: source.type,
      reason: reason || 'unsupported',
    });
  };

  for (const action of actions || []) {
    switch (action.type) {
      case 'launch': {
        const appId = String(action.appId || action.text || options.appId || '').trim();
        pushTranslated(
          appId
            ? {
                name: 'launch',
                args: { appId },
                checkpointAfter: true,
                checkpointLabel: `launch:${appId}`,
              }
            : null,
          action,
          'launch sem appId'
        );
        break;
      }

      case 'tap': {
        if (typeof action.x === 'number' && typeof action.y === 'number') {
          pushTranslated(
            {
              name: 'tap',
              args: {
                x: Math.round(action.x),
                y: Math.round(action.y),
              },
              checkpointAfter: true,
              checkpointLabel: action.id,
            },
            action
          );
        } else if (typeof action.text === 'string' && action.text.trim()) {
          const selector = choosePrimaryTextQuery(action.text);
          const selectorVariants = buildTextQueryVariants(action.text);
          pushTranslated(
            {
              name: 'tap',
              args: {
                text: selector,
                selector,
                selectors: selectorVariants.map((candidate) => ({
                  selector: candidate,
                  label: candidate,
                })),
              },
              checkpointAfter: true,
              checkpointLabel: action.id,
            },
            action
          );
        } else {
          pushTranslated(null, action, 'tap sem coordenadas ou selector traduzível para ESVP');
        }
        break;
      }

      case 'swipe':
      case 'scroll': {
        if (
          typeof action.x === 'number' &&
          typeof action.y === 'number' &&
          typeof action.endX === 'number' &&
          typeof action.endY === 'number'
        ) {
          pushTranslated(
            {
              name: 'swipe',
              args: {
                x1: Math.round(action.x),
                y1: Math.round(action.y),
                x2: Math.round(action.endX),
                y2: Math.round(action.endY),
                durationMs: Math.max(120, Math.round(action.duration || 280)),
              },
              checkpointAfter: true,
              checkpointLabel: action.id,
            },
            action
          );
        } else if (action.direction) {
          pushTranslated(
            {
              name: 'swipe',
              args: {
                direction: String(action.direction).toLowerCase(),
              },
              checkpointAfter: true,
              checkpointLabel: action.id,
            },
            action
          );
        } else {
          pushTranslated(null, action, 'swipe/scroll sem coordenadas ou direction');
        }
        break;
      }

      case 'input': {
        const text = typeof action.text === 'string' ? action.text : '';
        pushTranslated(
          text
            ? {
                name: 'type',
                args: { text },
                checkpointAfter: true,
                checkpointLabel: action.id,
              }
            : null,
          action,
          'input sem text'
        );
        break;
      }

      case 'back':
        pushTranslated(
          {
            name: 'back',
            checkpointAfter: true,
            checkpointLabel: action.id,
          },
          action
        );
        break;

      case 'home':
        pushTranslated(
          {
            name: 'home',
            checkpointAfter: true,
            checkpointLabel: action.id,
          },
          action
        );
        break;

      case 'pressKey': {
        const key = typeof action.text === 'string' ? action.text : '';
        pushTranslated(
          key
            ? {
                name: 'keyevent',
                args: { key },
                checkpointAfter: true,
                checkpointLabel: action.id,
              }
            : null,
          action,
          'pressKey sem key'
        );
        break;
      }

      case 'wait': {
        const ms = typeof action.seconds === 'number'
          ? Math.max(0, Math.round(action.seconds * 1000))
          : 1000;
        pushTranslated(
          {
            name: 'wait',
            args: { ms },
            checkpointAfter: true,
            checkpointLabel: action.id,
          },
          action
        );
        break;
      }

      default:
        pushTranslated(null, action, `tipo "${action.type}" ainda não é suportado pelo adapter ESVP`);
        break;
    }
  }

  return {
    actions: translated,
    skipped,
  };
}

async function normalizeESVPNetworkArtifacts(
  sessionId: string,
  artifacts: ESVPArtifactSummary[],
  serverUrl?: string
): Promise<{
  networkEntries: CapturedNetworkEntry[];
  networkCapture: NetworkCaptureMeta & Record<string, unknown>;
  traceKinds: string[];
}> {
  const networkArtifacts = (artifacts || []).filter((artifact) => artifact?.kind === 'network_trace' && typeof artifact?.path === 'string');
  const traceKinds = Array.from(
    new Set(
      networkArtifacts
        .map((artifact) => (artifact?.meta && typeof artifact.meta === 'object' ? String((artifact.meta as Record<string, unknown>).trace_kind || '') : ''))
        .filter(Boolean)
    )
  );
  const entries: CapturedNetworkEntry[] = [];

  for (const artifact of networkArtifacts) {
    const artifactPath = String(artifact.path || '');
    if (!artifactPath) continue;

    try {
      const payload = await getESVPArtifactContent(sessionId, artifactPath, serverUrl);
      const meta = artifact.meta && typeof artifact.meta === 'object'
        ? (artifact.meta as Record<string, unknown>)
        : {};
      const traceKind = typeof meta.trace_kind === 'string' ? meta.trace_kind : null;
      entries.push(...normalizeNetworkPayloadToEntries(payload, {
        traceKind,
        artifactPath,
        artifactMeta: meta,
      }));
    } catch {
      // Ignore malformed trace artifacts; they should not block the rest of the recording.
    }
  }

  return {
    networkEntries: entries.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)),
    networkCapture: createMobileNetworkCaptureMeta({
      source: 'esvp-mobile',
      truncated: false,
      maxEntries: Math.max(entries.length, 1200),
      resourceTypes: traceKinds.length > 0 ? traceKinds : ['mobile-http-trace'],
    }),
    traceKinds,
  };
}

function normalizeNetworkPayloadToEntries(
  payload: unknown,
  context: {
    traceKind: string | null;
    artifactPath: string;
    artifactMeta: Record<string, unknown>;
  }
): CapturedNetworkEntry[] {
  const payloadRecord = isObject(payload) ? (payload as Record<string, unknown>) : null;
  const payloadLog = payloadRecord && isObject(payloadRecord.log)
    ? (payloadRecord.log as Record<string, unknown>)
    : null;
  if (context.traceKind === 'har' && payloadLog && Array.isArray(payloadLog.entries)) {
    return normalizeHarEntries(payloadLog.entries as any[], context);
  }

  const candidates = extractTraceCandidates(payload);
  const normalized = candidates
    .map((candidate, index) => normalizeHttpTraceCandidate(candidate, index, context))
    .filter((entry): entry is CapturedNetworkEntry => entry !== null);

  return normalized;
}

function normalizeHarEntries(entries: any[], context: { artifactPath: string }): CapturedNetworkEntry[] {
  const normalized: CapturedNetworkEntry[] = [];

  for (const [index, entry] of (entries || []).entries()) {
    const requestUrl = String(entry?.request?.url || '').trim();
    if (!requestUrl) continue;
    const parsed = parseRequestUrl(requestUrl);
    const startedAt = Date.parse(String(entry?.startedDateTime || ''));
    const durationMs = numberOrNull(entry?.time);
    const finishedAt = Number.isFinite(startedAt) && durationMs != null ? startedAt + durationMs : null;
    const responseSize = numberOrNull(entry?.response?.content?.size) ?? numberOrNull(entry?.response?.bodySize);
    const requestHeaders = toHeaderMap(entry?.request?.headers);
    const responseHeaders = toHeaderMap(entry?.response?.headers);

    normalized.push({
      id: `net_${sanitizeIdentifier(context.artifactPath)}_${String(index + 1).padStart(4, '0')}`,
      url: parsed.url,
      origin: parsed.origin,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      routeKey: parsed.routeKey,
      method: String(entry?.request?.method || 'GET').toUpperCase(),
      resourceType: 'har',
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      finishedAt,
      durationMs,
      status: numberOrNull(entry?.response?.status),
      ok: typeof entry?.response?.status === 'number' ? entry.response.status < 400 : null,
      queryKeys: parsed.queryKeys,
      requestContentType: requestHeaders['content-type'] || null,
      responseContentType: responseHeaders['content-type'] || null,
      responseSize,
      failureText: typeof entry?.response?._error === 'string' ? entry.response._error : null,
      requestHeaders,
      responseHeaders,
      requestBodyPreview: null,
      responseBodyPreview: null,
      requestBodyBytes: null,
      responseBodyBytes: responseSize,
    });
  }

  return normalized;
}

function normalizeHttpTraceCandidate(
  candidate: unknown,
  index: number,
  context: {
    traceKind: string | null;
    artifactPath: string;
    artifactMeta: Record<string, unknown>;
  }
): CapturedNetworkEntry | null {
  if (!isObject(candidate)) return null;

  const request = isObject(candidate.request) ? candidate.request : candidate;
  const response = isObject(candidate.response) ? candidate.response : null;
  const url = firstString(
    candidate.url,
    request.url,
    context.artifactMeta.url
  );
  if (!url) return null;

  const parsed = parseRequestUrl(url);
  const method = firstString(candidate.method, request.method, context.artifactMeta.method) || 'GET';
  const status = firstNumber(
    candidate.status,
    candidate.statusCode,
    response?.status,
    response?.statusCode,
    context.artifactMeta.status_code
  );
  const durationMs = firstNumber(
    candidate.durationMs,
    candidate.duration_ms,
    response?.durationMs,
    response?.duration_ms,
    response?.time_ms,
    candidate.timeMs
  );
  const startedAt = firstTimestamp(
    candidate.startedAt,
    candidate.started_at,
    candidate.timestamp,
    candidate.ts,
    request.startedAt,
    request.timestamp,
    request.ts
  ) ?? Date.now();
  const finishedAt = durationMs != null ? startedAt + durationMs : firstTimestamp(candidate.finishedAt, candidate.finished_at) ?? null;

  const requestHeaders = headerObject(request.headers);
  const responseHeaders = headerObject(response?.headers);
  const requestBodyPreview = firstString(
    candidate.requestBodyPreview,
    candidate.request_body_preview,
    request.bodyPreview,
    request.body_preview
  );
  const responseBodyPreview = firstString(
    candidate.responseBodyPreview,
    candidate.response_body_preview,
    response?.bodyPreview,
    response?.body_preview
  );
  const requestBodyBytes = firstNumber(
    candidate.requestBodyBytes,
    candidate.request_body_bytes,
    request.bodyBytes,
    request.body_bytes
  );
  const responseSize = firstNumber(
    candidate.responseSize,
    candidate.response_size,
    response?.size,
    response?.bodyBytes,
    response?.contentLength,
    responseHeaders['content-length']
  );
  const failureText = firstString(
    candidate.failureText,
    candidate.error,
    response?.error,
    response?.failureText
  );

  return {
    id: `net_${sanitizeIdentifier(context.artifactPath)}_${String(index + 1).padStart(4, '0')}`,
    url: parsed.url,
    origin: parsed.origin,
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    routeKey: parsed.routeKey,
    method: String(method).toUpperCase(),
    resourceType: firstString(candidate.resourceType, candidate.kind, context.traceKind) || 'request',
    startedAt,
    finishedAt,
    durationMs,
    status,
    ok: status != null ? status < 400 : null,
    queryKeys: parsed.queryKeys,
    requestContentType: firstString(
      candidate.requestContentType,
      request.contentType,
      requestHeaders['content-type']
    ),
    responseContentType: firstString(
      candidate.responseContentType,
      response?.contentType,
      responseHeaders['content-type']
    ),
    responseSize,
    failureText,
    requestHeaders,
    responseHeaders,
    requestBodyPreview,
    responseBodyPreview,
    requestBodyBytes,
    responseBodyBytes: responseSize,
  };
}

function extractTraceCandidates(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isObject(payload)) return [];

  if (Array.isArray(payload.entries)) return payload.entries;
  if (Array.isArray(payload.requests)) return payload.requests;
  if (Array.isArray(payload.events)) return payload.events;
  if (Array.isArray(payload.items)) return payload.items;

  return [payload];
}

function parseRequestUrl(rawUrl: string): {
  url: string;
  origin: string;
  hostname: string;
  pathname: string;
  routeKey: string;
  queryKeys: string[];
} {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname || '/';
    const queryKeys = Array.from(new Set(Array.from(parsed.searchParams.keys()).filter(Boolean))).sort();
    return {
      url: buildDisplayUrl(parsed.origin, pathname),
      origin: parsed.origin,
      hostname: parsed.hostname,
      pathname,
      routeKey: `${parsed.hostname}${pathname}`,
      queryKeys,
    };
  } catch {
    const [baseWithoutQuery] = String(rawUrl).split('?');
    const [baseWithoutFragment] = String(baseWithoutQuery || rawUrl).split('#');
    return {
      url: baseWithoutFragment || rawUrl,
      origin: '',
      hostname: 'unknown host',
      pathname: '/',
      routeKey: rawUrl,
      queryKeys: [],
    };
  }
}

function buildDisplayUrl(origin: string, pathname: string): string {
  if (origin) return `${origin}${pathname || '/'}`;
  return pathname || '/';
}

function sanitizeIdentifier(value: string): string {
  return String(value || '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'trace';
}

function toHeaderMap(entries: unknown): Record<string, string> {
  if (!Array.isArray(entries)) return {};
  return entries.reduce<Record<string, string>>((acc, item) => {
    if (!isObject(item)) return acc;
    const key = firstString(item.name, item.key);
    if (!key) return acc;
    const value = firstString(item.value) || '';
    acc[key.toLowerCase()] = value;
    return acc;
  }, {});
}

function headerObject(value: unknown): Record<string, string> {
  if (!value) return {};
  if (Array.isArray(value)) return toHeaderMap(value);
  if (!isObject(value)) return {};
  return Object.entries(value).reduce<Record<string, string>>((acc, [key, entryValue]) => {
    acc[String(key).toLowerCase()] = String(entryValue);
    return acc;
  }, {});
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const numeric = numberOrNull(value);
    if (numeric != null) return numeric;
  }
  return null;
}

function firstTimestamp(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const direct = Number(value);
      if (Number.isFinite(direct)) return direct;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
