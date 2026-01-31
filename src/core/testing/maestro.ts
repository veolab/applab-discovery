/**
 * DiscoveryLab Maestro Integration Module
 * Mobile app testing automation using Maestro CLI
 */

import { exec, execSync, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { PROJECTS_DIR } from '../../db/index.js';

const execAsync = promisify(exec);

function quoteCommand(cmd: string): string {
  return cmd.includes(' ') ? `"${cmd}"` : cmd;
}

function getMaestroCommandCandidates(): string[] {
  const candidates: string[] = [];
  const maestroHomePath = path.join(os.homedir(), '.maestro', 'bin', 'maestro');
  if (fs.existsSync(maestroHomePath)) {
    candidates.push(maestroHomePath);
  }
  const brewPaths = ['/opt/homebrew/bin/maestro', '/usr/local/bin/maestro'];
  for (const brewPath of brewPaths) {
    if (fs.existsSync(brewPath)) {
      candidates.push(brewPath);
    }
  }
  candidates.push('maestro');
  return candidates;
}

async function resolveMaestroCommand(): Promise<string | null> {
  for (const candidate of getMaestroCommandCandidates()) {
    try {
      const cmd = quoteCommand(candidate);
      await execAsync(`${cmd} --version`);
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

// Pending session file - survives server restarts
const PENDING_SESSION_FILE = path.join(PROJECTS_DIR, '.maestro-pending-session.json');

// ============================================================================
// TYPES
// ============================================================================
export interface MaestroConfig {
  flowPath: string; // Path to YAML flow file
  appId?: string; // App bundle ID
  device?: string; // Device ID or name
  env?: Record<string, string>; // Environment variables
  continuous?: boolean; // Run in continuous mode
  debug?: boolean; // Enable debug output
}

export interface MaestroRunOptions {
  flowPath: string;
  appId?: string;
  device?: string;
  env?: Record<string, string>;
  timeout?: number; // Milliseconds
  captureVideo?: boolean;
  captureScreenshots?: boolean;
  outputDir?: string;
}

export interface MaestroTestResult {
  success: boolean;
  error?: string;
  duration?: number; // Milliseconds
  flowPath?: string;
  output?: string;
  screenshots?: string[];
  video?: string;
}

export interface MaestroFlowStep {
  action: string;
  params?: Record<string, any>;
}

export interface MaestroFlow {
  appId: string;
  name?: string;
  env?: Record<string, string>;
  onFlowStart?: MaestroFlowStep[];
  onFlowComplete?: MaestroFlowStep[];
  steps: MaestroFlowStep[];
}

export interface MaestroDevice {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  status: 'connected' | 'disconnected';
}

// ============================================================================
// MAESTRO CLI HELPERS
// ============================================================================
export async function isMaestroInstalled(): Promise<boolean> {
  try {
    return !!(await resolveMaestroCommand());
  } catch {
    return false;
  }
}

/**
 * Check if idb (Facebook's iOS Development Bridge) is installed
 * idb provides faster iOS simulator taps than Maestro
 */
export async function isIdbInstalled(): Promise<boolean> {
  try {
    await execAsync('idb --version', { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tap via idb (Facebook's iOS Development Bridge)
 * Much faster than Maestro for iOS simulator taps (~1s vs ~30s)
 */
export async function tapViaIdb(deviceId: string, x: number, y: number): Promise<boolean> {
  try {
    await execAsync(`idb ui tap ${Math.round(x)} ${Math.round(y)} --udid ${deviceId}`, {
      timeout: 5000
    });
    return true;
  } catch (error) {
    console.error('[idb tap failed]', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Kill any zombie Maestro processes that may be running in the background
 * These can cause the "Wrote screenshot to: -" loop
 */
export async function killZombieMaestroProcesses(): Promise<void> {
  try {
    // Kill any lingering maestro processes
    await execAsync('pkill -f "maestro test" || true', { timeout: 3000 });
    await execAsync('pkill -f "maestro record" || true', { timeout: 3000 });
    console.log('[MaestroCleanup] Killed zombie maestro processes');
  } catch {
    // Ignore errors - processes may not exist
  }
}

export async function getMaestroVersion(): Promise<string | null> {
  try {
    const command = await resolveMaestroCommand();
    if (!command) return null;
    const cmd = quoteCommand(command);
    const { stdout } = await execAsync(`${cmd} --version`);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function listMaestroDevices(): Promise<MaestroDevice[]> {
  const devices: MaestroDevice[] = [];

  try {
    // Get iOS devices
    const { stdout: iosOutput } = await execAsync('xcrun simctl list devices -j');
    const iosData = JSON.parse(iosOutput);

    for (const [runtime, deviceList] of Object.entries(iosData.devices || {})) {
      if (!Array.isArray(deviceList)) continue;

      for (const device of deviceList as any[]) {
        if (device.state === 'Booted') {
          devices.push({
            id: device.udid,
            name: device.name,
            platform: 'ios',
            status: 'connected',
          });
        }
      }
    }
  } catch {
    // iOS simulators not available
  }

  try {
    // Get Android devices
    const { stdout: androidOutput } = await execAsync('adb devices -l');
    const lines = androidOutput.split('\n').slice(1); // Skip header

    for (const line of lines) {
      const match = line.match(/^(\S+)\s+device\s+(.*)$/);
      if (match) {
        const [, id, info] = match;
        const modelMatch = info.match(/model:(\S+)/);
        devices.push({
          id,
          name: modelMatch ? modelMatch[1] : id,
          platform: 'android',
          status: 'connected',
        });
      }
    }
  } catch {
    // Android devices not available
  }

  return devices;
}

// ============================================================================
// YAML FLOW GENERATION
// ============================================================================
export function generateMaestroFlow(flow: MaestroFlow): string {
  const lines: string[] = [];

  // App ID
  lines.push(`appId: ${flow.appId}`);
  lines.push('');

  // Name
  if (flow.name) {
    lines.push(`name: ${flow.name}`);
    lines.push('');
  }

  // Environment variables
  if (flow.env && Object.keys(flow.env).length > 0) {
    lines.push('env:');
    for (const [key, value] of Object.entries(flow.env)) {
      lines.push(`  ${key}: "${value}"`);
    }
    lines.push('');
  }

  // On flow start
  if (flow.onFlowStart && flow.onFlowStart.length > 0) {
    lines.push('onFlowStart:');
    for (const step of flow.onFlowStart) {
      lines.push(formatFlowStep(step, 2));
    }
    lines.push('');
  }

  // On flow complete
  if (flow.onFlowComplete && flow.onFlowComplete.length > 0) {
    lines.push('onFlowComplete:');
    for (const step of flow.onFlowComplete) {
      lines.push(formatFlowStep(step, 2));
    }
    lines.push('');
  }

  // Steps
  lines.push('---');
  for (const step of flow.steps) {
    lines.push(formatFlowStep(step, 0));
  }

  return lines.join('\n');
}

function formatFlowStep(step: MaestroFlowStep, indent: number): string {
  const prefix = ' '.repeat(indent);
  const { action, params } = step;

  if (!params || Object.keys(params).length === 0) {
    return `${prefix}- ${action}`;
  }

  if (Object.keys(params).length === 1) {
    const [key, value] = Object.entries(params)[0];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return `${prefix}- ${action}:\n${prefix}    ${key}: ${formatValue(value)}`;
    }
  }

  const lines = [`${prefix}- ${action}:`];
  for (const [key, value] of Object.entries(params)) {
    lines.push(`${prefix}    ${key}: ${formatValue(value)}`);
  }
  return lines.join('\n');
}

function formatValue(value: any): string {
  if (typeof value === 'string') {
    return value.includes('\n') || value.includes(':') ? `"${value}"` : value;
  }
  return String(value);
}

// ============================================================================
// COMMON FLOW ACTIONS
// ============================================================================
export const MaestroActions = {
  // App lifecycle
  launchApp: (appId?: string) => ({ action: 'launchApp', params: appId ? { appId } : undefined }),
  stopApp: (appId?: string) => ({ action: 'stopApp', params: appId ? { appId } : undefined }),
  clearState: (appId?: string) => ({ action: 'clearState', params: appId ? { appId } : undefined }),
  clearKeychain: () => ({ action: 'clearKeychain' }),

  // Navigation
  tapOn: (text: string) => ({ action: 'tapOn', params: { text } }),
  tapOnId: (id: string) => ({ action: 'tapOn', params: { id } }),
  tapOnPoint: (x: number, y: number) => ({ action: 'tapOn', params: { point: `${x},${y}` } }),
  doubleTapOn: (text: string) => ({ action: 'doubleTapOn', params: { text } }),
  longPressOn: (text: string) => ({ action: 'longPressOn', params: { text } }),

  // Input
  inputText: (text: string) => ({ action: 'inputText', params: { text } }),
  inputRandomText: () => ({ action: 'inputRandomText' }),
  inputRandomNumber: () => ({ action: 'inputRandomNumber' }),
  inputRandomEmail: () => ({ action: 'inputRandomEmail' }),
  eraseText: (chars?: number) => ({ action: 'eraseText', params: chars ? { charactersToErase: chars } : undefined }),

  // Gestures
  scroll: () => ({ action: 'scroll' }),
  scrollDown: () => ({ action: 'scrollUntilVisible', params: { direction: 'DOWN' } }),
  scrollUp: () => ({ action: 'scrollUntilVisible', params: { direction: 'UP' } }),
  swipeLeft: () => ({ action: 'swipe', params: { direction: 'LEFT' } }),
  swipeRight: () => ({ action: 'swipe', params: { direction: 'RIGHT' } }),
  swipeDown: () => ({ action: 'swipe', params: { direction: 'DOWN' } }),
  swipeUp: () => ({ action: 'swipe', params: { direction: 'UP' } }),

  // Assertions
  assertVisible: (text: string) => ({ action: 'assertVisible', params: { text } }),
  assertNotVisible: (text: string) => ({ action: 'assertNotVisible', params: { text } }),
  assertTrue: (condition: string) => ({ action: 'assertTrue', params: { condition } }),

  // Wait
  waitForAnimationToEnd: (timeout?: number) => ({
    action: 'waitForAnimationToEnd',
    params: timeout ? { timeout } : undefined,
  }),
  wait: (ms: number) => ({ action: 'extendedWaitUntil', params: { timeout: ms } }),

  // Screenshots
  takeScreenshot: (path: string) => ({ action: 'takeScreenshot', params: { path } }),

  // Keyboard
  hideKeyboard: () => ({ action: 'hideKeyboard' }),
  pressKey: (key: string) => ({ action: 'pressKey', params: { key } }),
  back: () => ({ action: 'back' }),

  // Conditional
  runFlow: (flowPath: string) => ({ action: 'runFlow', params: { file: flowPath } }),
  runScript: (script: string) => ({ action: 'runScript', params: { script } }),

  // Device
  openLink: (url: string) => ({ action: 'openLink', params: { link: url } }),
  setLocation: (lat: number, lon: number) => ({ action: 'setLocation', params: { latitude: lat, longitude: lon } }),
  travel: (steps: Array<{ lat: number; lon: number }>) => ({ action: 'travel', params: { points: steps } }),
};

// ============================================================================
// RUN MAESTRO TEST
// ============================================================================
export async function runMaestroTest(options: MaestroRunOptions): Promise<MaestroTestResult> {
  const installed = await isMaestroInstalled();
  if (!installed) {
    return {
      success: false,
      error: 'Maestro CLI is not installed. Install with: curl -Ls "https://get.maestro.mobile.dev" | bash',
    };
  }

  const {
    flowPath,
    appId,
    device,
    env = {},
    timeout = 300000, // 5 minutes default
    captureVideo = false,
    captureScreenshots = false,
    outputDir = path.join(PROJECTS_DIR, 'maestro-output', Date.now().toString()),
  } = options;

  const command = await resolveMaestroCommand();
  if (!command) {
    return {
      success: false,
      error: 'Maestro CLI is not installed or not runnable. Install with: curl -Ls "https://get.maestro.mobile.dev" | bash',
    };
  }

  // Validate flow file exists
  if (!fs.existsSync(flowPath)) {
    return { success: false, error: `Flow file not found: ${flowPath}` };
  }

  // Create output directory
  await fs.promises.mkdir(outputDir, { recursive: true });

  const startTime = Date.now();
  const args: string[] = ['test', flowPath];
  const maestroCmd = quoteCommand(command);

  // Add device option
  if (device) {
    args.push('--device', device);
  }

  // Add environment variables
  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`);
  }

  // Add output options
  args.push('--format', 'junit');
  args.push('--output', path.join(outputDir, 'report.xml'));

  try {
    const { stdout, stderr } = await execAsync(`${maestroCmd} ${args.join(' ')}`, {
      timeout,
      env: { ...process.env, ...env },
    });

    const duration = Date.now() - startTime;
    const screenshots: string[] = [];
    const videoPath = captureVideo ? path.join(outputDir, 'recording.mp4') : undefined;

    // Collect screenshots if captured
    if (captureScreenshots) {
      const files = await fs.promises.readdir(outputDir);
      for (const file of files) {
        if (file.endsWith('.png')) {
          screenshots.push(path.join(outputDir, file));
        }
      }
    }

    return {
      success: true,
      duration,
      flowPath,
      output: stdout + stderr,
      screenshots,
      video: videoPath,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    return {
      success: false,
      error: message,
      duration,
      flowPath,
      output: message,
    };
  }
}

// ============================================================================
// RUN WITH VIDEO CAPTURE
// ============================================================================
export async function runMaestroWithCapture(
  options: MaestroRunOptions,
  onProgress?: (message: string) => void
): Promise<MaestroTestResult> {
  const {
    flowPath,
    device,
    outputDir = path.join(PROJECTS_DIR, 'maestro-output', Date.now().toString()),
  } = options;

  await fs.promises.mkdir(outputDir, { recursive: true });

  const videoPath = path.join(outputDir, 'recording.mp4');
  let recordingProcess: ChildProcess | null = null;

  try {
    // Start screen recording
    onProgress?.('Starting screen recording...');

    if (device) {
      // Detect platform
      const devices = await listMaestroDevices();
      const targetDevice = devices.find(d => d.id === device || d.name === device);

      if (targetDevice?.platform === 'ios') {
        recordingProcess = spawn('xcrun', ['simctl', 'io', device, 'recordVideo', videoPath]);
      } else if (targetDevice?.platform === 'android') {
        // Android recording via adb
        recordingProcess = spawn('adb', ['-s', device, 'shell', 'screenrecord', '/sdcard/recording.mp4']);
      }
    }

    // Run the test
    onProgress?.('Running Maestro test...');
    const result = await runMaestroTest({ ...options, outputDir });

    // Stop recording
    onProgress?.('Stopping screen recording...');
    if (recordingProcess) {
      recordingProcess.kill('SIGINT');
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for file to be written

      // For Android, pull the recording
      const devices = await listMaestroDevices();
      const targetDevice = devices.find(d => d.id === device || d.name === device);
      if (targetDevice?.platform === 'android') {
        await execAsync(`adb -s ${device} pull /sdcard/recording.mp4 "${videoPath}"`);
        await execAsync(`adb -s ${device} shell rm /sdcard/recording.mp4`);
      }
    }

    return {
      ...result,
      video: fs.existsSync(videoPath) ? videoPath : undefined,
    };
  } catch (error) {
    if (recordingProcess) {
      recordingProcess.kill('SIGKILL');
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      flowPath,
    };
  }
}

// ============================================================================
// SAVE FLOW FILE
// ============================================================================
export async function saveMaestroFlow(
  flow: MaestroFlow,
  outputPath?: string
): Promise<string> {
  const yaml = generateMaestroFlow(flow);
  const filePath = outputPath || path.join(
    PROJECTS_DIR,
    'flows',
    `${flow.name || 'flow'}_${Date.now()}.yaml`
  );

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, yaml);

  return filePath;
}

// ============================================================================
// STUDIO MODE
// ============================================================================
export async function startMaestroStudio(appId?: string): Promise<{ success: boolean; error?: string }> {
  const installed = await isMaestroInstalled();
  if (!installed) {
    return {
      success: false,
      error: 'Maestro CLI is not installed',
    };
  }

  try {
    const args = ['studio'];
    if (appId) {
      args.push(appId);
    }
    const maestroCmd = await resolveMaestroCommand();
    if (!maestroCmd) {
      return { success: false, error: 'Maestro CLI is not installed or not runnable' };
    }

    // Start studio in background (non-blocking)
    spawn(maestroCmd, args, {
      detached: true,
      stdio: 'ignore',
    }).unref();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// PREDEFINED FLOWS
// ============================================================================
export function createLoginFlow(
  appId: string,
  usernameField: string,
  passwordField: string,
  loginButton: string,
  successIndicator: string
): MaestroFlow {
  return {
    appId,
    name: 'Login Flow',
    steps: [
      MaestroActions.launchApp(appId),
      MaestroActions.waitForAnimationToEnd(),
      MaestroActions.tapOn(usernameField),
      MaestroActions.inputText('${USERNAME}'),
      MaestroActions.tapOn(passwordField),
      MaestroActions.inputText('${PASSWORD}'),
      MaestroActions.hideKeyboard(),
      MaestroActions.tapOn(loginButton),
      MaestroActions.waitForAnimationToEnd(5000),
      MaestroActions.assertVisible(successIndicator),
    ],
  };
}

export function createOnboardingFlow(
  appId: string,
  screens: Array<{ nextButton: string; waitFor?: string }>
): MaestroFlow {
  const steps: MaestroFlowStep[] = [
    MaestroActions.launchApp(appId),
    MaestroActions.waitForAnimationToEnd(),
  ];

  for (const screen of screens) {
    if (screen.waitFor) {
      steps.push(MaestroActions.assertVisible(screen.waitFor));
    }
    steps.push(MaestroActions.tapOn(screen.nextButton));
    steps.push(MaestroActions.waitForAnimationToEnd());
  }

  return {
    appId,
    name: 'Onboarding Flow',
    steps,
  };
}

export function createNavigationTestFlow(
  appId: string,
  tabs: string[]
): MaestroFlow {
  const steps: MaestroFlowStep[] = [
    MaestroActions.launchApp(appId),
    MaestroActions.waitForAnimationToEnd(),
  ];

  for (const tab of tabs) {
    steps.push(MaestroActions.tapOn(tab));
    steps.push(MaestroActions.waitForAnimationToEnd());
    steps.push(MaestroActions.takeScreenshot(`${tab.replace(/\s+/g, '_')}.png`));
  }

  return {
    appId,
    name: 'Navigation Test',
    steps,
  };
}

// ============================================================================
// MAESTRO RECORDER - Captures touch events and generates YAML
// ============================================================================
import { EventEmitter } from 'events';

export interface MaestroRecordingAction {
  id: string;
  type: 'tap' | 'swipe' | 'input' | 'scroll' | 'longPress' | 'back' | 'home' | 'launch' | 'pressKey' | 'assert' | 'wait';
  timestamp: number;
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  text?: string;
  direction?: string;
  seconds?: number;
  appId?: string;
  duration?: number;
  description: string;
  screenshotPath?: string;
}

export interface MaestroRecordingSession {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  appId?: string;
  deviceId: string;
  deviceName: string;
  platform: 'ios' | 'android';
  actions: MaestroRecordingAction[];
  screenshotsDir: string;
  flowPath?: string;
  videoPath?: string;
  captureMode?: 'native' | 'manual';
  status: 'recording' | 'paused' | 'stopped' | 'error';
}

export class MaestroRecorder extends EventEmitter {
  private session: MaestroRecordingSession | null = null;
  private adbProcess: ChildProcess | null = null;
  private videoProcess: ChildProcess | null = null;
  private maestroRecordProcess: ChildProcess | null = null; // Native maestro record process
  private actionCounter = 0;
  private screenshotInterval: NodeJS.Timeout | null = null;
  private useNativeMaestroRecord = true; // Use native maestro record for better accuracy
  private legacyCaptureStarted = false;
  private baseScreenshotIntervalMs = 2000;
  private maxScreenshotIntervalMs = 12000;
  private currentScreenshotIntervalMs = this.baseScreenshotIntervalMs;
  private nextScreenshotAt = 0;
  private lastScreenshotHash: string | null = null;
  private unchangedScreenshotCount = 0;
  private screenshotBackoffThreshold = 3;

  constructor() {
    super();
    // Try to restore pending session from disk (survives server restarts)
    this.loadPendingSession();
  }

  /**
   * Check if maestro is available in system PATH
   */
  private isMaestroInPath(): boolean {
    try {
      execSync('which maestro', { encoding: 'utf-8', timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  private canRunMaestro(cmd: string): boolean {
    try {
      execSync(`"${cmd}" --version`, { encoding: 'utf-8', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  private startLegacyCapture(deviceId: string, platform: 'ios' | 'android'): void {
    if (platform === 'android') {
      if (!this.adbProcess) {
        this.startAndroidEventCapture(deviceId);
      }
    } else {
      this.startIOSEventCapture(deviceId);
    }
    this.legacyCaptureStarted = true;
  }

  private fallbackToLegacyCapture(reason: string): void {
    if (!this.session || this.session.status !== 'recording') return;
    if (this.legacyCaptureStarted) return;
    console.log(`[MaestroRecorder] Native record stopped (${reason}). Falling back to manual capture.`);
    this.session.captureMode = 'manual';
    this.startLegacyCapture(this.session.deviceId, this.session.platform);
  }

  /**
   * Save session state to disk for recovery after server restart
   */
  private savePendingSession(): void {
    if (!this.session) return;
    try {
      fs.writeFileSync(PENDING_SESSION_FILE, JSON.stringify(this.session, null, 2));
    } catch (error) {
      console.error('[MaestroRecorder] Failed to save pending session:', error);
    }
  }

  /**
   * Load pending session from disk (after server restart)
   */
  private loadPendingSession(): void {
    try {
      if (fs.existsSync(PENDING_SESSION_FILE)) {
        const data = fs.readFileSync(PENDING_SESSION_FILE, 'utf8');
        const savedSession = JSON.parse(data) as MaestroRecordingSession;

        // Only restore if session was actively recording
        if (savedSession.status === 'recording') {
          console.log('[MaestroRecorder] Restoring pending session from disk:', savedSession.id);
          this.session = savedSession;
          this.actionCounter = savedSession.actions.length;

          // Note: video/event capture processes are gone after restart
          // Session will be in a "recoverable" state where we can stop and save
        }
      }
    } catch (error) {
      console.error('[MaestroRecorder] Failed to load pending session:', error);
      // Clean up invalid file
      try {
        fs.unlinkSync(PENDING_SESSION_FILE);
      } catch {}
    }
  }

  /**
   * Clear pending session file (after successful stop)
   */
  private clearPendingSession(): void {
    try {
      if (fs.existsSync(PENDING_SESSION_FILE)) {
        fs.unlinkSync(PENDING_SESSION_FILE);
      }
    } catch (error) {
      console.error('[MaestroRecorder] Failed to clear pending session:', error);
    }
  }

  /**
   * Persist session metadata to session.json (available during recording)
   */
  private async writeSessionMetadata(): Promise<void> {
    if (!this.session) return;
    try {
      const metadataPath = path.join(this.session.screenshotsDir, '..', 'session.json');
      await fs.promises.writeFile(metadataPath, JSON.stringify(this.session, null, 2));
    } catch (error) {
      console.error('[MaestroRecorder] Failed to write session metadata:', error);
    }
  }

  /**
   * Start recording a mobile session
   */
  async startRecording(
    name: string,
    deviceId: string,
    deviceName: string,
    platform: 'ios' | 'android',
    appId?: string,
    options: { preferNativeRecord?: boolean } = {}
  ): Promise<MaestroRecordingSession> {
    if (this.session?.status === 'recording') {
      const hasActiveProcesses = !!(this.videoProcess || this.maestroRecordProcess || this.adbProcess);
      if (hasActiveProcesses) {
        throw new Error('Recording already in progress');
      }
      console.log('[MaestroRecorder] Stale recording session detected. Clearing before starting a new one.');
      this.session = null;
      if (this.screenshotInterval) {
        clearInterval(this.screenshotInterval);
        this.screenshotInterval = null;
      }
      this.clearPendingSession();
    }

    const sessionId = `maestro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const baseDir = path.join(PROJECTS_DIR, 'maestro-recordings', sessionId);
    const screenshotsDir = path.join(baseDir, 'screenshots');

    await fs.promises.mkdir(screenshotsDir, { recursive: true });

    this.session = {
      id: sessionId,
      name,
      startedAt: Date.now(),
      appId,
      deviceId,
      deviceName,
      platform,
      actions: [],
      screenshotsDir,
      status: 'recording',
    };

    this.actionCounter = 0;

    try {
      // Set up flow path for maestro record output
      const flowPath = path.join(baseDir, 'test.yaml');
      this.session.flowPath = flowPath;

      // Start video recording
      const videoPath = path.join(baseDir, 'recording.mp4');
      this.session.videoPath = videoPath;

      // Check if maestro is installed and runnable
      const maestroHomePath = path.join(os.homedir(), '.maestro', 'bin', 'maestro');
      const maestroPath = fs.existsSync(maestroHomePath) ? maestroHomePath : 'maestro';
      const maestroExists = fs.existsSync(maestroHomePath) || this.isMaestroInPath();
      const maestroRunnable = maestroExists && this.canRunMaestro(maestroPath);
      const preferNativeRecord = options.preferNativeRecord !== false;
      const useNativeRecord = preferNativeRecord && this.useNativeMaestroRecord && maestroRunnable;

      if (!maestroRunnable && this.useNativeMaestroRecord) {
        console.log('[MaestroRecorder] ⚠️ Maestro CLI not available or not runnable. Falling back to screenshot-based capture.');
        console.log('[MaestroRecorder] Ensure Java is installed or reinstall Maestro: curl -Ls "https://get.maestro.mobile.dev" | bash');
      }
      if (!preferNativeRecord) {
        console.log('[MaestroRecorder] Native record disabled for this session (manual capture mode).');
      }

      let nativeRecordStarted = false;
      this.legacyCaptureStarted = false;

      if (useNativeRecord) {
        // Use native maestro record for accurate event capture
        console.log('[MaestroRecorder] Starting native maestro record...');

        try {
          // Start maestro record process
          // Note: maestro record writes to the specified file when stopped
          this.maestroRecordProcess = spawn(maestroPath, ['record', flowPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
          });
          nativeRecordStarted = true;

          this.maestroRecordProcess.stdout?.on('data', (data: Buffer) => {
            console.log('[MaestroRecord]', data.toString().trim());
          });

          this.maestroRecordProcess.stderr?.on('data', (data: Buffer) => {
            console.log('[MaestroRecord ERROR]', data.toString().trim());
          });

          this.maestroRecordProcess.on('error', (err) => {
            console.log('[MaestroRecord] Spawn error:', err.message);
            this.fallbackToLegacyCapture('spawn error');
            this.maestroRecordProcess = null;
          });

          this.maestroRecordProcess.on('close', (code) => {
            console.log(`[MaestroRecord] Process exited with code ${code}`);
            this.fallbackToLegacyCapture(`exit code ${code}`);
            this.maestroRecordProcess = null;
          });
        } catch (err) {
          console.log('[MaestroRecorder] Failed to start native record, using legacy capture');
          this.maestroRecordProcess = null;
          nativeRecordStarted = false;
        }
      }

      this.session.captureMode = nativeRecordStarted ? 'native' : 'manual';

      if (!nativeRecordStarted && this.session.flowPath) {
        try {
          const initialYaml = this.generateFlowYaml();
          await fs.promises.writeFile(this.session.flowPath, initialYaml);
        } catch (error) {
          console.error('[MaestroRecorder] Failed to write initial flow YAML:', error);
        }
      }

      await this.writeSessionMetadata();

      if (nativeRecordStarted) {
        // Also start video recording for our UI
        if (platform === 'ios') {
          this.videoProcess = spawn('xcrun', ['simctl', 'io', deviceId, 'recordVideo', videoPath]);
        } else {
          const tempVideoPath = '/sdcard/maestro-recording.mp4';
          this.videoProcess = spawn('adb', ['-s', deviceId, 'shell', 'screenrecord', '--time-limit', '180', tempVideoPath]);
        }
      } else {
        if (useNativeRecord) {
          console.log('[MaestroRecorder] Native record failed to start, using legacy capture');
        }
        // Legacy: Manual event capture
        if (platform === 'android') {
          const tempVideoPath = '/sdcard/maestro-recording.mp4';
          this.videoProcess = spawn('adb', ['-s', deviceId, 'shell', 'screenrecord', '--time-limit', '180', tempVideoPath]);
          this.startLegacyCapture(deviceId, platform);
        } else {
          this.videoProcess = spawn('xcrun', ['simctl', 'io', deviceId, 'recordVideo', videoPath]);
          this.startLegacyCapture(deviceId, platform);
        }
      }

      this.currentScreenshotIntervalMs = this.baseScreenshotIntervalMs;
      this.nextScreenshotAt = 0;
      this.lastScreenshotHash = null;
      this.unchangedScreenshotCount = 0;

      // Take periodic screenshots for reference
      this.screenshotInterval = setInterval(() => {
        this.captureScreenshot(undefined, { reason: 'periodic' });
      }, 2000);

      // Save session to disk for recovery after server restart
      this.savePendingSession();

      this.emit('status', 'recording');
      return this.session;

    } catch (error) {
      this.session.status = 'error';
      this.clearPendingSession();
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Capture Android touch events via ADB
   */
  private startAndroidEventCapture(deviceId: string): void {
    // Get device screen dimensions
    exec(`adb -s ${deviceId} shell wm size`, (err, stdout) => {
      if (err) return;
      const match = stdout.match(/(\d+)x(\d+)/);
      const screenWidth = match ? parseInt(match[1]) : 1080;
      const screenHeight = match ? parseInt(match[2]) : 1920;

      // Start getevent to capture touch input
      this.adbProcess = spawn('adb', ['-s', deviceId, 'shell', 'getevent', '-lt']);

      let touchStartTime = 0;
      let touchStartX = 0;
      let touchStartY = 0;
      let currentX = 0;
      let currentY = 0;
      let isTracking = false;

      this.adbProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');

        for (const line of lines) {
          // Parse touch events
          // Format: [timestamp] /dev/input/eventX: TYPE CODE VALUE

          if (line.includes('ABS_MT_POSITION_X')) {
            const match = line.match(/ABS_MT_POSITION_X\s+([0-9a-f]+)/i);
            if (match) {
              currentX = Math.round((parseInt(match[1], 16) / 32767) * screenWidth);
            }
          }

          if (line.includes('ABS_MT_POSITION_Y')) {
            const match = line.match(/ABS_MT_POSITION_Y\s+([0-9a-f]+)/i);
            if (match) {
              currentY = Math.round((parseInt(match[1], 16) / 32767) * screenHeight);
            }
          }

          if (line.includes('BTN_TOUCH') && line.includes('DOWN')) {
            touchStartTime = Date.now();
            touchStartX = currentX;
            touchStartY = currentY;
            isTracking = true;
          }

          if (line.includes('BTN_TOUCH') && line.includes('UP') && isTracking) {
            const duration = Date.now() - touchStartTime;
            const deltaX = Math.abs(currentX - touchStartX);
            const deltaY = Math.abs(currentY - touchStartY);

            if (deltaX > 50 || deltaY > 50) {
              // Swipe gesture
              this.recordAction({
                type: 'swipe',
                x: touchStartX,
                y: touchStartY,
                endX: currentX,
                endY: currentY,
                duration,
                description: `Swipe from (${touchStartX}, ${touchStartY}) to (${currentX}, ${currentY})`,
              });
            } else if (duration > 500) {
              // Long press
              this.recordAction({
                type: 'longPress',
                x: touchStartX,
                y: touchStartY,
                duration,
                description: `Long press at (${touchStartX}, ${touchStartY})`,
              });
            } else {
              // Tap
              this.recordAction({
                type: 'tap',
                x: touchStartX,
                y: touchStartY,
                description: `Tap at (${touchStartX}, ${touchStartY})`,
              });
            }

            isTracking = false;
          }

          // Detect back button
          if (line.includes('KEY_BACK') && line.includes('DOWN')) {
            this.recordAction({
              type: 'back',
              description: 'Press back button',
            });
          }

          // Detect home button
          if (line.includes('KEY_HOME') && line.includes('DOWN')) {
            this.recordAction({
              type: 'home',
              description: 'Press home button',
            });
          }
        }
      });
    });
  }

  /**
   * Capture iOS events (limited - mainly screenshots)
   */
  private startIOSEventCapture(deviceId: string): void {
    // iOS doesn't expose raw touch events easily
    // We'll rely on screenshots and user can describe actions
    // In a more advanced version, we could use accessibility APIs
    console.log('[MaestroRecorder] iOS event capture started (screenshot-based)');
  }

  /**
   * Record an action
   */
  private async recordAction(actionData: Partial<MaestroRecordingAction>): Promise<void> {
    if (!this.session || this.session.status !== 'recording') return;

    this.actionCounter++;
    const actionId = `action_${this.actionCounter.toString().padStart(3, '0')}`;

    // Capture screenshot for this action
    const screenshotPath = await this.captureScreenshot(actionId, { force: true, reason: 'action' });

    const action: MaestroRecordingAction = {
      id: actionId,
      type: actionData.type || 'tap',
      timestamp: Date.now(),
      x: actionData.x,
      y: actionData.y,
      endX: actionData.endX,
      endY: actionData.endY,
      text: actionData.text,
      direction: actionData.direction,
      seconds: actionData.seconds,
      appId: actionData.appId,
      duration: actionData.duration,
      description: actionData.description || actionData.type || 'Action',
      screenshotPath,
    };

    this.session.actions.push(action);
    this.emit('action', action);
    console.log('[MaestroRecorder] Action captured:', action.type, action.description);

    if (action.type === 'launch') {
      const launchAppId = action.appId || action.text;
      if (launchAppId && !this.session.appId) {
        this.session.appId = launchAppId;
      }
    }

    const shouldWriteFlow = this.session.captureMode !== 'native' || !this.maestroRecordProcess;
    if (shouldWriteFlow && this.session.flowPath) {
      try {
        const flowYaml = this.generateFlowYaml();
        await fs.promises.writeFile(this.session.flowPath, flowYaml);
      } catch (error) {
        console.error('[MaestroRecorder] Failed to update flow YAML during recording:', error);
      }
    }

    await this.writeSessionMetadata();

    // Save session after each action to prevent data loss on restart
    this.savePendingSession();
  }

  /**
   * Capture a screenshot
   */
  private async captureScreenshot(
    name?: string,
    options: { force?: boolean; reason?: 'action' | 'periodic' } = {}
  ): Promise<string | undefined> {
    if (!this.session) return undefined;

    const now = Date.now();
    if (!options.force && now < this.nextScreenshotAt) {
      return undefined;
    }

    const screenshotName = name ? `${name}.png` : `screenshot_${Date.now()}.png`;
    const screenshotPath = path.join(this.session.screenshotsDir, screenshotName);

    try {
      if (this.session.platform === 'android') {
        await execAsync(`adb -s ${this.session.deviceId} exec-out screencap -p > "${screenshotPath}"`);
      } else {
        await execAsync(`xcrun simctl io ${this.session.deviceId} screenshot "${screenshotPath}"`);
      }
      const screenshotBuffer = await fs.promises.readFile(screenshotPath);
      const screenshotHash = createHash('sha1').update(screenshotBuffer).digest('hex');

      if (!options.force && this.lastScreenshotHash === screenshotHash) {
        this.unchangedScreenshotCount += 1;
        await fs.promises.unlink(screenshotPath);
        if (this.unchangedScreenshotCount >= this.screenshotBackoffThreshold) {
          this.currentScreenshotIntervalMs = Math.min(
            this.currentScreenshotIntervalMs * 2,
            this.maxScreenshotIntervalMs
          );
        }
        this.nextScreenshotAt = now + this.currentScreenshotIntervalMs;
        return undefined;
      }

      this.lastScreenshotHash = screenshotHash;
      this.unchangedScreenshotCount = 0;
      this.currentScreenshotIntervalMs = this.baseScreenshotIntervalMs;
      this.nextScreenshotAt = now + this.currentScreenshotIntervalMs;
      this.emit('screenshot', screenshotPath);
      return screenshotPath;
    } catch (error) {
      console.error('Screenshot failed:', error);
      return undefined;
    }
  }

  /**
   * Add a manual action (for iOS or user-initiated)
   */
  addManualAction(
    type: MaestroRecordingAction['type'],
    description: string,
    params?: Partial<MaestroRecordingAction>
  ): Promise<void> {
    return this.recordAction({
      type,
      description,
      ...params,
    });
  }

  /**
   * Stop recording and generate outputs
   */
  async stopRecording(): Promise<MaestroRecordingSession> {
    if (!this.session) throw new Error('No recording session');

    this.session.status = 'stopped';
    this.session.endedAt = Date.now();

    // Kill any zombie maestro processes first to prevent screenshot loops
    await killZombieMaestroProcesses();

    // Stop event capture (legacy)
    if (this.adbProcess) {
      this.adbProcess.kill();
      this.adbProcess = null;
    }

    // Stop screenshot interval
    if (this.screenshotInterval) {
      clearInterval(this.screenshotInterval);
      this.screenshotInterval = null;
    }

    // Stop native maestro record process
    if (this.maestroRecordProcess) {
      console.log('[MaestroRecorder] Stopping native maestro record...');

      // Send SIGINT to gracefully stop and save the YAML
      this.maestroRecordProcess.kill('SIGINT');

      // Wait for the process to finish
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.log('[MaestroRecorder] Timeout waiting for maestro record, forcing kill');
          this.maestroRecordProcess?.kill('SIGKILL');
          resolve();
        }, 5000);

        this.maestroRecordProcess?.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.maestroRecordProcess = null;

      // Wait a bit for the file to be written
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Read and parse the generated YAML
      const recordedActions = this.session.actions;
      let parsedActions: MaestroRecordingAction[] = [];
      if (this.session.flowPath && fs.existsSync(this.session.flowPath)) {
        console.log('[MaestroRecorder] Reading generated YAML from:', this.session.flowPath);
        try {
          const yamlContent = await fs.promises.readFile(this.session.flowPath, 'utf-8');
          parsedActions = this.parseActionsFromYaml(yamlContent);
          console.log(`[MaestroRecorder] Parsed ${parsedActions.length} actions from YAML`);
          this.session.actions = this.mergeParsedActionsWithRecorded(parsedActions, recordedActions);
        } catch (e) {
          console.error('[MaestroRecorder] Failed to read/parse YAML:', e);
        }
      } else {
        console.log('[MaestroRecorder] No YAML file found at:', this.session.flowPath);
      }

      const flowPath = this.session.flowPath || path.join(this.session.screenshotsDir, '..', 'test.yaml');
      if ((parsedActions.length === 0 || !fs.existsSync(flowPath)) && recordedActions.length > 0) {
        const flowYaml = this.generateFlowYaml();
        await fs.promises.writeFile(flowPath, flowYaml);
        this.session.flowPath = flowPath;
        this.session.actions = recordedActions;
        console.log('[MaestroRecorder] Fallback YAML generated from recorded actions');
      }
    }

    // Stop video recording
    if (this.videoProcess) {
      this.videoProcess.kill('SIGINT');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // For Android, pull the video file
      if (this.session.platform === 'android' && this.session.videoPath) {
        try {
          await execAsync(`adb -s ${this.session.deviceId} pull /sdcard/maestro-recording.mp4 "${this.session.videoPath}"`);
          await execAsync(`adb -s ${this.session.deviceId} shell rm /sdcard/maestro-recording.mp4`);
        } catch (e) {
          console.error('Failed to pull video:', e);
        }
      }
      this.videoProcess = null;
    }

    // Ensure we have a YAML flow if native record did not produce one
    if (!this.session.flowPath || !fs.existsSync(this.session.flowPath)) {
      if (this.session.actions.length > 0) {
        const flowYaml = this.generateFlowYaml();
        const fallbackFlowPath = path.join(this.session.screenshotsDir, '..', 'test.yaml');
        await fs.promises.writeFile(fallbackFlowPath, flowYaml);
        this.session.flowPath = fallbackFlowPath;
        console.log('[MaestroRecorder] Generated flow YAML from recorded actions');
      }
    }

    // Save session metadata
    const metadataPath = path.join(this.session.screenshotsDir, '..', 'session.json');
    await fs.promises.writeFile(metadataPath, JSON.stringify(this.session, null, 2));

    // Clear pending session file now that we've saved properly
    this.clearPendingSession();

    this.emit('status', 'stopped');
    this.emit('stopped', this.session);

    const result = this.session;
    this.session = null;
    return result;
  }

  /**
   * Parse actions from Maestro YAML content
   */
  private parseActionsFromYaml(yamlContent: string): MaestroRecordingAction[] {
    const actions: MaestroRecordingAction[] = [];
    const lines = yamlContent.split('\n');

    let currentAction: Partial<MaestroRecordingAction> | null = null;
    let actionIndex = 0;

    const nextId = () => `action_${String(++actionIndex).padStart(3, '0')}`;
    const cleanValue = (value: string) => value.trim().replace(/^["']|["']$/g, '');
    const pushAction = (action: Partial<MaestroRecordingAction>) => {
      actions.push({
        id: action.id || nextId(),
        type: action.type || 'tap',
        timestamp: action.timestamp || Date.now(),
        description: action.description || action.type || 'Action',
        x: action.x,
        y: action.y,
        endX: action.endX,
        endY: action.endY,
        text: action.text,
        direction: action.direction,
        seconds: action.seconds,
        appId: action.appId,
        duration: action.duration,
        screenshotPath: action.screenshotPath,
      });
    };

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (trimmed.startsWith('#') || trimmed === '' || trimmed === '---') {
        continue;
      }

      if (trimmed.startsWith('appId:')) {
        const parsedAppId = cleanValue(trimmed.replace('appId:', ''));
        if (this.session && parsedAppId && !this.session.appId) {
          this.session.appId = parsedAppId;
        }
        continue;
      }

      // Detect action types
      if (trimmed.startsWith('- tapOn:')) {
        const inlineValue = cleanValue(trimmed.replace('- tapOn:', ''));
        if (inlineValue) {
          pushAction({
            type: 'tap',
            description: `Tap on "${inlineValue}"`,
            text: inlineValue,
          });
          continue;
        }
        currentAction = { type: 'tap', description: 'Tap' };
      } else if (trimmed.startsWith('- tap:')) {
        currentAction = { type: 'tap', description: 'Tap' };
      } else if (trimmed.startsWith('- swipe:')) {
        currentAction = { type: 'swipe', description: 'Swipe' };
      } else if (trimmed.startsWith('- scroll:')) {
        currentAction = { type: 'scroll', description: 'Scroll' };
      } else if (trimmed.startsWith('- scrollUntilVisible:')) {
        currentAction = { type: 'scroll', description: 'Scroll' };
      } else if (trimmed.startsWith('- inputText:')) {
        const text = cleanValue(trimmed.replace('- inputText:', ''));
        pushAction({
          type: 'input',
          description: `Input: ${text.slice(0, 20)}${text.length > 20 ? '...' : ''}`,
          text,
        });
        continue;
      } else if (trimmed.startsWith('- launchApp:')) {
        const appId = cleanValue(trimmed.replace('- launchApp:', ''));
        pushAction({
          type: 'launch',
          description: `Launch: ${appId}`,
          text: appId,
          appId,
        });
        continue;
      } else if (trimmed === '- launchApp') {
        pushAction({
          type: 'launch',
          description: 'Launch app',
        });
        continue;
      } else if (trimmed.startsWith('- assertVisible:')) {
        const inlineValue = cleanValue(trimmed.replace('- assertVisible:', ''));
        if (inlineValue) {
          pushAction({
            type: 'assert',
            description: `Assert visible "${inlineValue}"`,
            text: inlineValue,
          });
          continue;
        }
        currentAction = { type: 'assert', description: 'Assert visible' };
      } else if (trimmed.startsWith('- extendedWaitUntil:')) {
        currentAction = { type: 'wait', description: 'Wait' };
      } else if (trimmed.startsWith('- pressKey:')) {
        const key = cleanValue(trimmed.replace('- pressKey:', '')).toLowerCase();
        if (key === 'back') {
          pushAction({ type: 'back', description: 'Back button' });
        } else if (key === 'home') {
          pushAction({ type: 'home', description: 'Home button' });
        } else {
          pushAction({
            type: 'pressKey',
            description: `Press: ${key}`,
            text: key,
          });
        }
        continue;
      } else if (trimmed.startsWith('- back')) {
        pushAction({ type: 'back', description: 'Back button' });
        continue;
      }

      // Parse point coordinates
      if (currentAction && trimmed.startsWith('point:')) {
        const point = cleanValue(trimmed.replace('point:', ''));
        const [x, y] = point.split(',').map(n => parseInt(n.trim()));
        if (!isNaN(x) && !isNaN(y)) {
          currentAction.x = x;
          currentAction.y = y;
          currentAction.description = `Tap at (${x}, ${y})`;
          pushAction(currentAction);
          currentAction = null;
          continue;
        }
      }

      // Parse text selector
      if (currentAction && trimmed.startsWith('text:')) {
        const text = cleanValue(trimmed.replace('text:', ''));
        currentAction.text = text;
        if (currentAction.type === 'assert') {
          currentAction.description = `Assert visible "${text}"`;
        } else {
          currentAction.description = `Tap on "${text}"`;
        }
        pushAction(currentAction);
        currentAction = null;
        continue;
      }

      // Parse id selector
      if (currentAction && trimmed.startsWith('id:')) {
        const id = cleanValue(trimmed.replace('id:', ''));
        currentAction.text = id;
        currentAction.description = `Tap on id: ${id}`;
        pushAction(currentAction);
        currentAction = null;
        continue;
      }

      // Parse swipe/scroll directions
      if (
        currentAction &&
        (currentAction.type === 'swipe' || currentAction.type === 'scroll') &&
        trimmed.startsWith('direction:')
      ) {
        const direction = cleanValue(trimmed.replace('direction:', '')).toLowerCase();
        currentAction.direction = direction;
        currentAction.description = currentAction.type === 'swipe'
          ? `Swipe ${direction}`
          : `Scroll ${direction}`;
        pushAction(currentAction);
        currentAction = null;
        continue;
      }

      // Parse wait timeout
      if (currentAction && currentAction.type === 'wait' && trimmed.startsWith('timeout:')) {
        const timeoutMs = parseInt(cleanValue(trimmed.replace('timeout:', '')), 10);
        const seconds = Number.isFinite(timeoutMs) && timeoutMs > 0
          ? Math.max(1, Math.round(timeoutMs / 1000))
          : 3;
        currentAction.seconds = seconds;
        currentAction.description = `Wait ${seconds}s`;
        pushAction(currentAction);
        currentAction = null;
        continue;
      }

      // Parse swipe start/end
      if (currentAction && currentAction.type === 'swipe') {
        if (trimmed.startsWith('start:')) {
          const point = cleanValue(trimmed.replace('start:', ''));
          const [x, y] = point.split(',').map(n => parseInt(n.trim()));
          if (!isNaN(x) && !isNaN(y)) {
            currentAction.x = x;
            currentAction.y = y;
          }
        } else if (trimmed.startsWith('end:')) {
          const point = cleanValue(trimmed.replace('end:', ''));
          const [x, y] = point.split(',').map(n => parseInt(n.trim()));
          if (!isNaN(x) && !isNaN(y)) {
            currentAction.endX = x;
            currentAction.endY = y;
            currentAction.description = `Swipe from (${currentAction.x}, ${currentAction.y}) to (${x}, ${y})`;
            pushAction(currentAction);
            currentAction = null;
          }
        }
      }
    }

    return actions;
  }

  private mergeParsedActionsWithRecorded(
    parsedActions: MaestroRecordingAction[],
    recordedActions: MaestroRecordingAction[]
  ): MaestroRecordingAction[] {
    if (parsedActions.length === 0) return recordedActions;
    if (recordedActions.length === 0) return parsedActions;

    const recordedWithScreens = recordedActions.filter(action => action.screenshotPath);
    if (recordedWithScreens.length === 0) return parsedActions;

    const shouldMapScreenshot = (action: MaestroRecordingAction) =>
      action.type === 'tap' ||
      action.type === 'swipe' ||
      action.type === 'scroll' ||
      action.type === 'longPress' ||
      action.type === 'back' ||
      action.type === 'home' ||
      action.type === 'assert' ||
      action.type === 'wait';

    let recordedIndex = 0;

    return parsedActions.map(action => {
      if (!shouldMapScreenshot(action) || recordedIndex >= recordedWithScreens.length) {
        return action;
      }

      const recorded = recordedWithScreens[recordedIndex++];

      return {
        ...recorded,
        ...action,
        id: recorded.id || action.id,
        screenshotPath: recorded.screenshotPath,
        x: action.x ?? recorded.x,
        y: action.y ?? recorded.y,
        endX: action.endX ?? recorded.endX,
        endY: action.endY ?? recorded.endY,
        text: action.text ?? recorded.text,
        direction: action.direction ?? recorded.direction,
        seconds: action.seconds ?? recorded.seconds,
        appId: action.appId ?? recorded.appId,
        duration: action.duration ?? recorded.duration,
        timestamp: recorded.timestamp || action.timestamp,
        description: action.description || recorded.description,
        type: action.type,
      };
    });
  }

  /**
   * Generate Maestro YAML from recorded actions
   */
  private generateFlowYaml(): string {
    if (!this.session) return '';

    const escapeYaml = (value: string) => value.replace(/"/g, '\\"');

    const lines: string[] = [
      `# Maestro Flow: ${this.session.name}`,
      `# Recorded: ${new Date(this.session.startedAt).toISOString()}`,
      `# Generated by DiscoveryLab`,
      ``,
    ];

    if (this.session.appId) {
      lines.push(`appId: ${this.session.appId}`);
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);

    for (const action of this.session.actions) {
      lines.push(`# ${action.description}`);

      switch (action.type) {
        case 'tap':
          if (action.text) {
            lines.push(`- tapOn:`);
            lines.push(`    text: "${escapeYaml(action.text)}"`);
          } else if (action.x !== undefined && action.y !== undefined) {
            lines.push(`- tapOn:`);
            lines.push(`    point: "${action.x},${action.y}"`);
          }
          break;

        case 'swipe':
          if (action.x !== undefined && action.y !== undefined && action.endX !== undefined && action.endY !== undefined) {
            lines.push(`- swipe:`);
            lines.push(`    start: "${action.x},${action.y}"`);
            lines.push(`    end: "${action.endX},${action.endY}"`);
            if (action.duration) {
              lines.push(`    duration: ${action.duration}`);
            }
          } else if (action.direction) {
            lines.push(`- swipe:`);
            lines.push(`    direction: "${action.direction.toUpperCase()}"`);
          }
          break;

        case 'longPress':
          if (action.x !== undefined && action.y !== undefined) {
            lines.push(`- longPressOn:`);
            lines.push(`    point: "${action.x},${action.y}"`);
          }
          break;

        case 'input':
          if (action.text) {
            lines.push(`- inputText: "${escapeYaml(action.text)}"`);
          }
          break;

        case 'back':
          lines.push(`- pressKey: back`);
          break;

        case 'home':
          lines.push(`- pressKey: home`);
          break;

        case 'scroll':
          if (action.direction && action.direction.toLowerCase() === 'down') {
            lines.push(`- scrollUntilVisible:`);
            lines.push(`    element: ".*"`);
            lines.push(`    direction: "DOWN"`);
          } else {
            lines.push(`- scroll`);
          }
          break;

        case 'launch': {
          const launchAppId = action.appId || action.text;
          if (launchAppId) {
            lines.push(`- launchApp: "${escapeYaml(launchAppId)}"`);
            if (!this.session.appId) {
              this.session.appId = launchAppId;
            }
          } else {
            lines.push(`- launchApp`);
          }
          break;
        }

        case 'assert':
          if (action.text) {
            lines.push(`- assertVisible:`);
            lines.push(`    text: "${escapeYaml(action.text)}"`);
          }
          break;

        case 'wait': {
          const seconds = action.seconds && action.seconds > 0 ? Math.round(action.seconds) : 3;
          lines.push(`- extendedWaitUntil:`);
          lines.push(`    visible: ".*"`);
          lines.push(`    timeout: ${seconds * 1000}`);
          break;
        }

        default:
          lines.push(`# Unknown action: ${action.type}`);
      }

      lines.push(``);
    }

    return lines.join('\n');
  }

  /**
   * Get current session
   */
  getSession(): MaestroRecordingSession | null {
    return this.session;
  }

  /**
   * Check if recording is active
   */
  isRecording(): boolean {
    return this.session?.status === 'recording';
  }
}

// Singleton instance
let maestroRecorderInstance: MaestroRecorder | null = null;

export function getMaestroRecorder(): MaestroRecorder {
  if (!maestroRecorderInstance) {
    maestroRecorderInstance = new MaestroRecorder();
  }
  return maestroRecorderInstance;
}
