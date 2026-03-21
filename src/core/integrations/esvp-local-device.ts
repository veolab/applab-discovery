import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getAdbCommand } from '../android/adb.js';
import {
  generateMaestroFlow,
  listMaestroDevices,
  MaestroActions,
  type MaestroFlow,
  type MaestroFlowStep,
  runMaestroTest,
} from '../testing/maestro.js';

const execFileAsync = promisify(execFile);

export type LocalESVPExecutor = 'fake' | 'adb' | 'ios-sim' | 'maestro-ios';

export type LocalESVPAction = {
  name: string;
  args?: Record<string, unknown>;
  checkpointAfter?: boolean;
  checkpointLabel?: string;
};

export type LocalPreflightConfig = {
  policy?: string;
  appId?: string;
  rules?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type LocalExecutionContext = {
  deviceId: string | null;
  networkProfile?: Record<string, unknown> | null;
  appId?: string | null;
  preflightConfig?: LocalPreflightConfig | null;
  lastRunOutput?: string | null;
  lastFlowPath?: string | null;
  lastRunFailed?: boolean;
  _macosProxyBackup?: Record<string, unknown>;
  _macosProxyInterface?: string;
};

export type LocalFlowCheckpoint = {
  actionIndex: number;
  label: string;
  relativePath: string;
  absPath: string;
  sha256: string;
  bytes: number;
};

export async function listDevicesForExecutor(executor: LocalESVPExecutor): Promise<Array<{
  id: string;
  name: string;
  platform: 'ios' | 'android';
  status: 'connected' | 'disconnected';
}>> {
  if (executor === 'fake') return [];
  const devices = await listMaestroDevices();
  if (executor === 'adb') {
    return devices.filter((device) => device.platform === 'android');
  }
  return devices.filter((device) => device.platform === 'ios');
}

export async function resolveDefaultDeviceId(executor: LocalESVPExecutor): Promise<string | null> {
  const devices = await listDevicesForExecutor(executor);
  return devices[0]?.id || null;
}

export async function runDeviceActionFlow(input: {
  executor: Exclude<LocalESVPExecutor, 'fake'>;
  deviceId: string;
  runDir: string;
  sessionId: string;
  meta?: Record<string, unknown>;
  preflightConfig?: LocalPreflightConfig | null;
  actions: LocalESVPAction[];
}): Promise<{
  success: boolean;
  error: string | null;
  output: string | null;
  flowPath: string;
  checkpoints: LocalFlowCheckpoint[];
  executedActionCount: number;
  appId: string;
}> {
  const appId = resolveFlowAppId(input.actions, input.meta, input.preflightConfig);
  if (!appId) {
    throw new Error('ESVP local requires an appId in session meta/preflight or a launch action before running device-backed actions.');
  }

  const flowDir = join(input.runDir, 'maestro');
  const checkpointsDir = join(input.runDir, 'checkpoints');
  await mkdir(flowDir, { recursive: true });
  await mkdir(checkpointsDir, { recursive: true });

  const flowPath = join(flowDir, `session-${Date.now()}.yaml`);
  const checkpointSpecs: Array<{ actionIndex: number; label: string; relativePath: string; absPath: string }> = [];
  const steps: MaestroFlowStep[] = [];

  steps.push(...buildPreflightSteps(input.preflightConfig, appId));

  for (const [index, action] of input.actions.entries()) {
    steps.push(...translateActionToMaestroSteps(action, appId));
    if (action.checkpointAfter) {
      const label = action.checkpointLabel || `${action.name}:${index + 1}`;
      const relativePath = `checkpoints/${String(index + 1).padStart(3, '0')}-${slugify(label)}.png`;
      const absPath = join(input.runDir, relativePath);
      steps.push(MaestroActions.takeScreenshot(absPath));
      checkpointSpecs.push({
        actionIndex: index,
        label,
        relativePath,
        absPath,
      });
    }
  }

  const flow: MaestroFlow = {
    appId,
    name: `ESVP ${input.sessionId}`,
    steps,
  };
  await writeFile(flowPath, generateMaestroFlow(flow), 'utf8');

  const result = await runMaestroTest({
    flowPath,
    device: input.deviceId,
    outputDir: join(flowDir, `output-${Date.now()}`),
    timeout: 300000,
  });

  const checkpoints: LocalFlowCheckpoint[] = [];
  for (const spec of checkpointSpecs) {
    if (!existsSync(spec.absPath)) break;
    const contents = await readFile(spec.absPath);
    checkpoints.push({
      ...spec,
      sha256: createHash('sha256').update(contents).digest('hex'),
      bytes: contents.length,
    });
  }

  return {
    success: result.success,
    error: result.success ? null : result.error || result.output || 'Maestro run failed',
    output: typeof result.output === 'string' ? result.output : result.error || null,
    flowPath,
    checkpoints,
    executedActionCount: result.success ? input.actions.length : Math.min(input.actions.length, checkpoints.length),
    appId,
  };
}

export async function configureDeviceNetwork(
  executor: LocalESVPExecutor,
  context: LocalExecutionContext,
  profile: Record<string, any> = {}
): Promise<{
  supported: boolean;
  applied: boolean;
  applied_features: string[];
  unsupported_features: string[];
  warnings: string[];
  capabilities: Record<string, unknown>;
  profile: Record<string, unknown>;
}> {
  if (executor === 'fake') {
    context.networkProfile = profile;
    return {
      supported: true,
      applied: true,
      applied_features: ['simulated'],
      unsupported_features: [],
      warnings: [],
      capabilities: networkCapabilitiesForExecutor(executor),
      profile,
    };
  }

  if (executor === 'adb') {
    const applied: string[] = [];
    const unsupported: string[] = [];
    const warnings: string[] = [];

    if (profile.connectivity === 'offline') {
      await setAndroidConnectivity(context, 'offline');
      applied.push('offline');
    } else if (profile.connectivity === 'online' || profile.connectivity === 'reset') {
      await setAndroidConnectivity(context, 'online');
      applied.push(String(profile.connectivity));
    }

    if (profile.proxy?.host && Number.isFinite(profile.proxy?.port) && profile.proxy.port > 0) {
      await setAndroidHttpProxy(context, profile.proxy);
      applied.push('proxy');
    } else if (profile.proxy === null && profile.connectivity === 'reset') {
      await clearAndroidHttpProxy(context);
      applied.push('proxy_cleared');
    }

    if (profile.faults?.delay_ms != null) unsupported.push('faults.delay_ms');
    if (profile.faults?.timeout === true) unsupported.push('faults.timeout');
    if (profile.faults?.offline_partial === true) unsupported.push('faults.offline_partial');
    if (profile.faults?.status_code != null) unsupported.push('faults.status_code');
    if (profile.faults?.body_patch != null) unsupported.push('faults.body_patch');
    if (profile.capture?.enabled === true && profile.capture?.mode !== 'esvp-managed-proxy') {
      warnings.push('capture.enabled was recorded, but external proxy traces still need to be attached via /network/trace');
    }

    context.networkProfile = profile;
    return {
      supported: true,
      applied: applied.length > 0,
      applied_features: applied,
      unsupported_features: unsupported,
      warnings,
      capabilities: networkCapabilitiesForExecutor(executor),
      profile,
    };
  }

  const applied: string[] = [];
  const warnings: string[] = [];
  if (profile.proxy?.host && Number.isFinite(profile.proxy?.port) && profile.proxy.port > 0) {
    await setMacHostHttpProxy(context, profile.proxy);
    applied.push('proxy');
    warnings.push('proxy was applied via macOS networksetup on the host, which temporarily affects host traffic during the session');
  } else if (profile.proxy === null) {
    await clearMacHostHttpProxy(context);
    applied.push('proxy_cleared');
  }

  context.networkProfile = profile;
  return {
    supported: true,
    applied: applied.length > 0,
    applied_features: applied,
    unsupported_features: [],
    warnings,
    capabilities: networkCapabilitiesForExecutor(executor),
    profile,
  };
}

export async function clearDeviceNetwork(
  executor: LocalESVPExecutor,
  context: LocalExecutionContext
): Promise<{
  supported: boolean;
  cleared: boolean;
  capabilities: Record<string, unknown>;
  warnings: string[];
}> {
  if (executor === 'adb') {
    await clearAndroidHttpProxy(context);
    await setAndroidConnectivity(context, 'online');
  } else if (executor === 'ios-sim' || executor === 'maestro-ios') {
    await clearMacHostHttpProxy(context);
  }

  context.networkProfile = null;
  return {
    supported: true,
    cleared: true,
    capabilities: networkCapabilitiesForExecutor(executor),
    warnings: [],
  };
}

export async function captureDeviceCheckpoint(input: {
  executor: Exclude<LocalESVPExecutor, 'fake'>;
  deviceId: string;
  targetPath: string;
}): Promise<{ success: boolean; error?: string }> {
  await mkdir(dirname(input.targetPath), { recursive: true });
  if (input.executor === 'adb') {
    const adbCommand = getAdbCommand();
    if (!adbCommand) {
      return { success: false, error: 'ADB not found. Set ANDROID_HOME/ANDROID_SDK_ROOT or add adb to PATH.' };
    }
    const tempPath = '/sdcard/esvp-checkpoint.png';
    try {
      await execFileAsync(adbCommand, ['-s', input.deviceId, 'shell', 'screencap', '-p', tempPath], { timeout: 10000 });
      await execFileAsync(adbCommand, ['-s', input.deviceId, 'pull', tempPath, input.targetPath], { timeout: 10000 });
      await execFileAsync(adbCommand, ['-s', input.deviceId, 'shell', 'rm', tempPath], { timeout: 5000 }).catch(() => undefined);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    await execFileAsync('xcrun', ['simctl', 'io', input.deviceId, 'screenshot', input.targetPath], { timeout: 10000 });
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function collectExecutorDebugArtifact(input: {
  executor: LocalESVPExecutor;
  context: LocalExecutionContext;
}): Promise<{ kind: 'logcat' | 'debug_asset'; content: string; extension: 'txt' | 'log' } | null> {
  if (input.executor === 'adb' && input.context.deviceId) {
    const adbCommand = getAdbCommand();
    if (adbCommand) {
      try {
        const { stdout, stderr } = await execFileAsync(adbCommand, ['-s', input.context.deviceId, 'logcat', '-d'], {
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const content = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (content) {
          return {
            kind: 'logcat',
            content,
            extension: 'log',
          };
        }
      } catch {
        // Fall back to textual debug output.
      }
    }
  }

  const output = typeof input.context.lastRunOutput === 'string' ? input.context.lastRunOutput.trim() : '';
  if (!output) return null;
  return {
    kind: 'debug_asset',
    content: output,
    extension: 'txt',
  };
}

export function networkCapabilitiesForExecutor(executor: LocalESVPExecutor): Record<string, unknown> {
  if (executor === 'adb') {
    return {
      proxy: true,
      connectivity: true,
      delay: false,
      loss: false,
      timeout: false,
      offline_partial: false,
      status_code: false,
      body_patch: false,
      trace_attach: true,
      capture: true,
    };
  }
  if (executor === 'ios-sim' || executor === 'maestro-ios') {
    return {
      proxy: true,
      connectivity: false,
      delay: false,
      loss: false,
      timeout: false,
      offline_partial: false,
      status_code: false,
      body_patch: false,
      trace_attach: true,
      capture: true,
    };
  }
  return {
    proxy: true,
    connectivity: true,
    delay: true,
    loss: false,
    timeout: true,
    offline_partial: true,
    status_code: true,
    body_patch: true,
    trace_attach: true,
    capture: true,
  };
}

function buildPreflightSteps(config: LocalPreflightConfig | null | undefined, appId: string): MaestroFlowStep[] {
  if (!config || typeof config !== 'object') return [];
  const steps: MaestroFlowStep[] = [];
  const rules = Array.isArray(config.rules) ? config.rules : [];
  for (const rule of rules) {
    const kind = String(rule?.kind || '').trim().toLowerCase();
    if (kind === 'clear_data') {
      steps.push(MaestroActions.clearState(String(config.appId || appId)));
      continue;
    }
    if (kind === 'wait_for_stable') {
      steps.push(MaestroActions.waitForAnimationToEnd(1000));
      continue;
    }
  }
  return steps;
}

function resolveFlowAppId(
  actions: LocalESVPAction[],
  meta?: Record<string, unknown>,
  preflightConfig?: LocalPreflightConfig | null
): string {
  const fromMeta = typeof meta?.appId === 'string' ? meta.appId.trim() : typeof meta?.app_id === 'string' ? String(meta.app_id).trim() : '';
  if (fromMeta) return fromMeta;
  const fromPreflight = typeof preflightConfig?.appId === 'string' ? preflightConfig.appId.trim() : '';
  if (fromPreflight) return fromPreflight;
  for (const action of actions) {
    if (action.name !== 'launch') continue;
    const appId = typeof action.args?.appId === 'string' ? action.args.appId.trim() : '';
    if (appId) return appId;
  }
  return '';
}

function translateActionToMaestroSteps(action: LocalESVPAction, appId: string): MaestroFlowStep[] {
  const args = action.args || {};
  switch (action.name) {
    case 'launch': {
      const launchAppId = typeof args.appId === 'string' && args.appId.trim() ? args.appId.trim() : appId;
      return [MaestroActions.launchApp(launchAppId)];
    }
    case 'tap': {
      if (typeof args.selector === 'string' && args.selector.trim()) {
        return [MaestroActions.tapOn(args.selector.trim())];
      }
      if (typeof args.text === 'string' && args.text.trim()) {
        return [MaestroActions.tapOn(args.text.trim())];
      }
      if (typeof args.x === 'number' && typeof args.y === 'number') {
        return [MaestroActions.tapOnPoint(Math.round(args.x), Math.round(args.y))];
      }
      throw new Error('ESVP tap action requires selector/text or x/y.');
    }
    case 'type': {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text) throw new Error('ESVP type action requires args.text.');
      return [MaestroActions.inputText(text)];
    }
    case 'back':
      return [MaestroActions.back()];
    case 'home':
      return [MaestroActions.pressKey('HOME')];
    case 'keyevent': {
      const key = typeof args.key === 'string' ? args.key : '';
      if (!key) throw new Error('ESVP keyevent action requires args.key.');
      return [MaestroActions.pressKey(key)];
    }
    case 'wait': {
      const ms = Number(args.ms);
      return [MaestroActions.wait(Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 1000)];
    }
    case 'swipe': {
      const direction = resolveSwipeDirection(args);
      switch (direction) {
        case 'left':
          return [MaestroActions.swipeLeft()];
        case 'right':
          return [MaestroActions.swipeRight()];
        case 'up':
          return [MaestroActions.swipeUp()];
        case 'down':
          return [MaestroActions.swipeDown()];
        default:
          throw new Error('ESVP swipe action requires a direction or coordinates that can be resolved to a direction.');
      }
    }
    default:
      throw new Error(`ESVP action "${action.name}" is not supported by the local AppLab executor.`);
  }
}

function resolveSwipeDirection(args: Record<string, unknown>): 'left' | 'right' | 'up' | 'down' | null {
  if (typeof args.direction === 'string' && args.direction.trim()) {
    const normalized = args.direction.trim().toLowerCase();
    if (normalized === 'left' || normalized === 'right' || normalized === 'up' || normalized === 'down') {
      return normalized;
    }
  }

  if (
    typeof args.x1 === 'number' &&
    typeof args.y1 === 'number' &&
    typeof args.x2 === 'number' &&
    typeof args.y2 === 'number'
  ) {
    const deltaX = args.x2 - args.x1;
    const deltaY = args.y2 - args.y1;
    if (Math.abs(deltaX) >= Math.abs(deltaY)) {
      return deltaX >= 0 ? 'right' : 'left';
    }
    return deltaY >= 0 ? 'down' : 'up';
  }

  return null;
}

async function setAndroidHttpProxy(context: LocalExecutionContext, proxy: Record<string, any>): Promise<void> {
  const adbCommand = getAdbCommand();
  if (!adbCommand) {
    throw new Error('ADB not found. Set ANDROID_HOME/ANDROID_SDK_ROOT or add adb to PATH.');
  }
  if (!context.deviceId) {
    throw new Error('Android proxy configuration requires a deviceId.');
  }
  const host = String(proxy.host || '').trim();
  const port = Number(proxy.port);
  if (!host || !Number.isFinite(port) || port <= 0) {
    throw new Error('Invalid Android proxy host/port.');
  }

  const endpoint = `${host}:${Math.round(port)}`;
  await execFileAsync(adbCommand, ['-s', context.deviceId, 'shell', 'settings', 'put', 'global', 'http_proxy', endpoint], { timeout: 7000 });
  await execFileAsync(adbCommand, ['-s', context.deviceId, 'shell', 'settings', 'put', 'global', 'global_http_proxy_host', host], { timeout: 7000 });
  await execFileAsync(adbCommand, ['-s', context.deviceId, 'shell', 'settings', 'put', 'global', 'global_http_proxy_port', String(Math.round(port))], { timeout: 7000 });

  const bypass = Array.isArray(proxy.bypass) ? proxy.bypass.filter(Boolean).join(',') : '';
  if (bypass) {
    await execFileAsync(adbCommand, ['-s', context.deviceId, 'shell', 'settings', 'put', 'global', 'global_http_proxy_exclusion_list', bypass], { timeout: 7000 });
  }
}

async function clearAndroidHttpProxy(context: LocalExecutionContext): Promise<void> {
  const adbCommand = getAdbCommand();
  if (!adbCommand || !context.deviceId) return;
  const commands = [
    ['-s', context.deviceId, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0'],
    ['-s', context.deviceId, 'shell', 'settings', 'delete', 'global', 'global_http_proxy_host'],
    ['-s', context.deviceId, 'shell', 'settings', 'delete', 'global', 'global_http_proxy_port'],
    ['-s', context.deviceId, 'shell', 'settings', 'delete', 'global', 'global_http_proxy_exclusion_list'],
  ];
  for (const command of commands) {
    await execFileAsync(adbCommand, command, { timeout: 7000 }).catch(() => undefined);
  }
}

async function setAndroidConnectivity(context: LocalExecutionContext, mode: 'online' | 'offline'): Promise<void> {
  const adbCommand = getAdbCommand();
  if (!adbCommand || !context.deviceId) return;
  if (mode === 'offline') {
    await execFileAsync(adbCommand, ['-s', context.deviceId, 'shell', 'svc', 'wifi', 'disable'], { timeout: 7000 }).catch(() => undefined);
    await execFileAsync(adbCommand, ['-s', context.deviceId, 'shell', 'svc', 'data', 'disable'], { timeout: 7000 }).catch(() => undefined);
    return;
  }
  await execFileAsync(adbCommand, ['-s', context.deviceId, 'shell', 'svc', 'wifi', 'enable'], { timeout: 7000 }).catch(() => undefined);
  await execFileAsync(adbCommand, ['-s', context.deviceId, 'shell', 'svc', 'data', 'enable'], { timeout: 7000 }).catch(() => undefined);
}

async function setMacHostHttpProxy(context: LocalExecutionContext, proxy: Record<string, any>): Promise<void> {
  const host = String(proxy.host || '').trim();
  const port = Number(proxy.port);
  if (!host || !Number.isFinite(port) || port <= 0) {
    throw new Error('Invalid macOS proxy host/port.');
  }

  const iface = await detectActiveNetworkInterface();
  const saved = await saveCurrentProxySettings(iface);
  context._macosProxyBackup = saved;
  context._macosProxyInterface = iface;

  const portStr = String(Math.round(port));
  await execFileAsync('networksetup', ['-setwebproxy', iface, host, portStr], { timeout: 5000 });
  await execFileAsync('networksetup', ['-setsecurewebproxy', iface, host, portStr], { timeout: 5000 });

  const { stdout } = await execFileAsync('networksetup', ['-getwebproxy', iface], { timeout: 5000 });
  const verify = String(stdout || '');
  if (!verify.includes('Enabled: Yes') || !verify.includes(host)) {
    throw new Error(`Failed to verify host proxy on macOS network service ${iface}.`);
  }
}

async function clearMacHostHttpProxy(context: LocalExecutionContext): Promise<void> {
  const iface = context._macosProxyInterface;
  const saved = context._macosProxyBackup as {
    http?: { enabled?: boolean; server?: string; port?: string };
    https?: { enabled?: boolean; server?: string; port?: string };
  } | undefined;

  if (!iface) return;
  if (saved?.http?.enabled) {
    await execFileAsync('networksetup', ['-setwebproxy', iface, saved.http.server || '', saved.http.port || '0'], { timeout: 5000 }).catch(() => undefined);
  } else {
    await execFileAsync('networksetup', ['-setwebproxystate', iface, 'off'], { timeout: 5000 }).catch(() => undefined);
  }
  if (saved?.https?.enabled) {
    await execFileAsync('networksetup', ['-setsecurewebproxy', iface, saved.https.server || '', saved.https.port || '0'], { timeout: 5000 }).catch(() => undefined);
  } else {
    await execFileAsync('networksetup', ['-setsecurewebproxystate', iface, 'off'], { timeout: 5000 }).catch(() => undefined);
  }

  delete context._macosProxyBackup;
  delete context._macosProxyInterface;
}

async function detectActiveNetworkInterface(): Promise<string> {
  const { stdout } = await execFileAsync('networksetup', ['-listallnetworkservices'], { timeout: 5000 });
  const services = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*') && !line.startsWith('An asterisk'));

  const preferred = ['Wi-Fi', 'Ethernet', 'USB 10/100/1000 LAN', 'Thunderbolt Ethernet'];
  for (const service of [...preferred, ...services.filter((candidate) => !preferred.includes(candidate))]) {
    if (!services.includes(service)) continue;
    try {
      const { stdout: info } = await execFileAsync('networksetup', ['-getinfo', service], { timeout: 5000 });
      if (/IP address:\s*\d+\.\d+/.test(String(info || ''))) {
        return service;
      }
    } catch {
      // Try next service.
    }
  }
  throw new Error('No active macOS network service was found via networksetup.');
}

async function saveCurrentProxySettings(iface: string): Promise<{
  http: { enabled: boolean; server: string; port: string };
  https: { enabled: boolean; server: string; port: string };
}> {
  const parseProxyOutput = (stdout: string) => {
    const lines = String(stdout || '').split('\n');
    const get = (key: string) => {
      const line = lines.find((candidate) => candidate.toLowerCase().startsWith(`${key.toLowerCase()}:`));
      return line ? line.split(':').slice(1).join(':').trim() : '';
    };
    return {
      enabled: get('Enabled') === 'Yes',
      server: get('Server') || '',
      port: get('Port') || '0',
    };
  };

  const { stdout: httpOut } = await execFileAsync('networksetup', ['-getwebproxy', iface], { timeout: 5000 });
  const { stdout: httpsOut } = await execFileAsync('networksetup', ['-getsecurewebproxy', iface], { timeout: 5000 });
  return {
    http: parseProxyOutput(String(httpOut || '')),
    https: parseProxyOutput(String(httpsOut || '')),
  };
}

function slugify(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'checkpoint';
}
