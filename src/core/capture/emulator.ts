/**
 * DiscoveryLab Emulator Detection & Capture Module
 * Handles iOS Simulator and Android Emulator detection and capture
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PROJECTS_DIR } from '../../db/index.js';

// ============================================================================
// TYPES
// ============================================================================
export interface EmulatorDevice {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  state: 'booted' | 'shutdown' | 'unknown';
  osVersion?: string;
  deviceType?: string;
}

export interface EmulatorCaptureOptions {
  projectId: string;
  deviceId: string;
  type: 'screenshot' | 'video';
  duration?: number; // seconds, for video
}

export interface EmulatorCaptureResult {
  success: boolean;
  filePath?: string;
  error?: string;
  device?: EmulatorDevice;
}

// ============================================================================
// iOS SIMULATOR (macOS only)
// ============================================================================
export function listIOSSimulators(): EmulatorDevice[] {
  if (platform() !== 'darwin') {
    return [];
  }

  try {
    const output = execSync('xcrun simctl list devices -j', { encoding: 'utf-8' });
    const data = JSON.parse(output);
    const devices: EmulatorDevice[] = [];

    for (const [runtime, deviceList] of Object.entries(data.devices) as [string, any[]][]) {
      // Extract iOS version from runtime string
      const versionMatch = runtime.match(/iOS[- ](\d+[.-]\d+)/i);
      const osVersion = versionMatch ? versionMatch[1].replace('-', '.') : undefined;

      for (const device of deviceList) {
        if (device.isAvailable !== false) {
          devices.push({
            id: device.udid,
            name: device.name,
            platform: 'ios',
            state: device.state === 'Booted' ? 'booted' : 'shutdown',
            osVersion,
            deviceType: device.deviceTypeIdentifier?.split('.').pop(),
          });
        }
      }
    }

    return devices;
  } catch (error) {
    console.error('Failed to list iOS simulators:', error);
    return [];
  }
}

export function getBootedIOSSimulator(): EmulatorDevice | null {
  const simulators = listIOSSimulators();
  return simulators.find((s) => s.state === 'booted') || null;
}

export async function captureIOSSimulatorScreenshot(
  options: EmulatorCaptureOptions
): Promise<EmulatorCaptureResult> {
  if (platform() !== 'darwin') {
    return { success: false, error: 'iOS Simulator capture is only available on macOS' };
  }

  const projectDir = join(PROJECTS_DIR, options.projectId);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `ios-screenshot-${timestamp}.png`;
  const outputPath = join(projectDir, filename);

  return new Promise((resolve) => {
    const args = ['simctl', 'io', options.deviceId, 'screenshot', outputPath];
    const proc = spawn('xcrun', args);

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && existsSync(outputPath)) {
        resolve({ success: true, filePath: outputPath });
      } else {
        resolve({ success: false, error: stderr || `xcrun simctl failed with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

export async function startIOSSimulatorRecording(
  options: EmulatorCaptureOptions
): Promise<{ sessionId: string; outputPath: string } | { error: string }> {
  if (platform() !== 'darwin') {
    return { error: 'iOS Simulator recording is only available on macOS' };
  }

  const projectDir = join(PROJECTS_DIR, options.projectId);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  const sessionId = randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `ios-recording-${timestamp}.mp4`;
  const outputPath = join(projectDir, filename);

  const args = ['simctl', 'io', options.deviceId, 'recordVideo', outputPath];
  const proc = spawn('xcrun', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  // Store the process for later stopping
  iosRecordingSessions.set(sessionId, { process: proc, outputPath });

  // Auto-stop after duration if specified
  if (options.duration) {
    setTimeout(() => {
      stopIOSSimulatorRecording(sessionId);
    }, options.duration * 1000);
  }

  return { sessionId, outputPath };
}

const iosRecordingSessions = new Map<string, { process: ReturnType<typeof spawn>; outputPath: string }>();

export async function stopIOSSimulatorRecording(sessionId: string): Promise<EmulatorCaptureResult> {
  const session = iosRecordingSessions.get(sessionId);

  if (!session) {
    return { success: false, error: `Recording session not found: ${sessionId}` };
  }

  return new Promise((resolve) => {
    // Send SIGINT to stop recording gracefully
    session.process.kill('SIGINT');

    const timeout = setTimeout(() => {
      session.process.kill('SIGKILL');
    }, 5000);

    session.process.on('close', () => {
      clearTimeout(timeout);
      iosRecordingSessions.delete(sessionId);

      if (existsSync(session.outputPath)) {
        resolve({ success: true, filePath: session.outputPath });
      } else {
        resolve({ success: false, error: 'Recording file not found' });
      }
    });
  });
}

// ============================================================================
// ANDROID EMULATOR
// ============================================================================
export function listAndroidEmulators(): EmulatorDevice[] {
  try {
    // Get running devices
    const output = execSync('adb devices -l', { encoding: 'utf-8' });
    const lines = output.split('\n').slice(1); // Skip header
    const devices: EmulatorDevice[] = [];

    for (const line of lines) {
      if (!line.trim() || line.includes('offline')) continue;

      const parts = line.split(/\s+/);
      const id = parts[0];

      if (id.startsWith('emulator-') || id.includes(':')) {
        // This is an emulator
        const modelMatch = line.match(/model:(\S+)/);
        const deviceMatch = line.match(/device:(\S+)/);

        devices.push({
          id,
          name: modelMatch?.[1] || deviceMatch?.[1] || id,
          platform: 'android',
          state: parts[1] === 'device' ? 'booted' : 'unknown',
        });
      }
    }

    return devices;
  } catch (error) {
    console.error('Failed to list Android emulators:', error);
    return [];
  }
}

export function getBootedAndroidEmulator(): EmulatorDevice | null {
  const emulators = listAndroidEmulators();
  return emulators.find((e) => e.state === 'booted') || null;
}

export async function captureAndroidEmulatorScreenshot(
  options: EmulatorCaptureOptions
): Promise<EmulatorCaptureResult> {
  const projectDir = join(PROJECTS_DIR, options.projectId);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `android-screenshot-${timestamp}.png`;
  const outputPath = join(projectDir, filename);
  const tempPath = '/sdcard/screenshot.png';

  return new Promise((resolve) => {
    // Take screenshot on device
    const captureProc = spawn('adb', ['-s', options.deviceId, 'shell', 'screencap', '-p', tempPath]);

    captureProc.on('close', (captureCode) => {
      if (captureCode !== 0) {
        resolve({ success: false, error: `screencap failed with code ${captureCode}` });
        return;
      }

      // Pull screenshot to local
      const pullProc = spawn('adb', ['-s', options.deviceId, 'pull', tempPath, outputPath]);

      pullProc.on('close', (pullCode) => {
        // Clean up temp file
        spawn('adb', ['-s', options.deviceId, 'shell', 'rm', tempPath]);

        if (pullCode === 0 && existsSync(outputPath)) {
          resolve({ success: true, filePath: outputPath });
        } else {
          resolve({ success: false, error: `adb pull failed with code ${pullCode}` });
        }
      });

      pullProc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });

    captureProc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

export async function startAndroidEmulatorRecording(
  options: EmulatorCaptureOptions
): Promise<{ sessionId: string; outputPath: string } | { error: string }> {
  const projectDir = join(PROJECTS_DIR, options.projectId);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  const sessionId = randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `android-recording-${timestamp}.mp4`;
  const outputPath = join(projectDir, filename);
  const tempPath = '/sdcard/recording.mp4';

  // Start recording on device
  const args = ['-s', options.deviceId, 'shell', 'screenrecord'];

  // Add time limit if specified (max 180 seconds for Android)
  if (options.duration) {
    args.push('--time-limit', Math.min(options.duration, 180).toString());
  }

  args.push(tempPath);

  const proc = spawn('adb', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  androidRecordingSessions.set(sessionId, {
    process: proc,
    deviceId: options.deviceId,
    tempPath,
    outputPath,
  });

  return { sessionId, outputPath };
}

const androidRecordingSessions = new Map<
  string,
  { process: ReturnType<typeof spawn>; deviceId: string; tempPath: string; outputPath: string }
>();

export async function stopAndroidEmulatorRecording(sessionId: string): Promise<EmulatorCaptureResult> {
  const session = androidRecordingSessions.get(sessionId);

  if (!session) {
    return { success: false, error: `Recording session not found: ${sessionId}` };
  }

  return new Promise((resolve) => {
    // Send SIGINT to stop recording
    session.process.kill('SIGINT');

    setTimeout(() => {
      // Pull the file after a short delay
      const pullProc = spawn('adb', ['-s', session.deviceId, 'pull', session.tempPath, session.outputPath]);

      pullProc.on('close', (pullCode) => {
        // Clean up temp file
        spawn('adb', ['-s', session.deviceId, 'shell', 'rm', session.tempPath]);
        androidRecordingSessions.delete(sessionId);

        if (pullCode === 0 && existsSync(session.outputPath)) {
          resolve({ success: true, filePath: session.outputPath });
        } else {
          resolve({ success: false, error: 'Failed to pull recording file' });
        }
      });

      pullProc.on('error', (err) => {
        androidRecordingSessions.delete(sessionId);
        resolve({ success: false, error: err.message });
      });
    }, 1000);
  });
}

// ============================================================================
// UNIFIED API
// ============================================================================
export function listAllEmulators(): EmulatorDevice[] {
  const ios = platform() === 'darwin' ? listIOSSimulators() : [];
  const android = listAndroidEmulators();
  return [...ios, ...android];
}

export function getBootedEmulator(): EmulatorDevice | null {
  // Prefer iOS simulator on macOS
  if (platform() === 'darwin') {
    const ios = getBootedIOSSimulator();
    if (ios) return ios;
  }

  return getBootedAndroidEmulator();
}

export async function captureEmulatorScreenshot(
  options: EmulatorCaptureOptions
): Promise<EmulatorCaptureResult> {
  // Determine platform from device ID
  const allDevices = listAllEmulators();
  const device = allDevices.find((d) => d.id === options.deviceId);

  if (!device) {
    return { success: false, error: `Device not found: ${options.deviceId}` };
  }

  if (device.platform === 'ios') {
    const result = await captureIOSSimulatorScreenshot(options);
    return { ...result, device };
  } else {
    const result = await captureAndroidEmulatorScreenshot(options);
    return { ...result, device };
  }
}

export async function startEmulatorRecording(
  options: EmulatorCaptureOptions
): Promise<{ sessionId: string; outputPath: string; platform: 'ios' | 'android' } | { error: string }> {
  const allDevices = listAllEmulators();
  const device = allDevices.find((d) => d.id === options.deviceId);

  if (!device) {
    return { error: `Device not found: ${options.deviceId}` };
  }

  if (device.platform === 'ios') {
    const result = await startIOSSimulatorRecording(options);
    if ('error' in result) return result;
    return { ...result, platform: 'ios' };
  } else {
    const result = await startAndroidEmulatorRecording(options);
    if ('error' in result) return result;
    return { ...result, platform: 'android' };
  }
}

export async function stopEmulatorRecording(
  sessionId: string,
  platformHint?: 'ios' | 'android'
): Promise<EmulatorCaptureResult> {
  // Check iOS sessions first
  if (platformHint === 'ios' || iosRecordingSessions.has(sessionId)) {
    return stopIOSSimulatorRecording(sessionId);
  }

  // Check Android sessions
  if (platformHint === 'android' || androidRecordingSessions.has(sessionId)) {
    return stopAndroidEmulatorRecording(sessionId);
  }

  return { success: false, error: `Recording session not found: ${sessionId}` };
}

// ============================================================================
// UTILITY
// ============================================================================
export function checkADB(): boolean {
  try {
    execSync('adb version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function checkSimctl(): boolean {
  if (platform() !== 'darwin') return false;

  try {
    execSync('xcrun simctl list', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
