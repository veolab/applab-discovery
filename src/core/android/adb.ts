import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ADB_COMMAND_CACHE_SUCCESS_TTL_MS = 5 * 60 * 1000;
const ADB_COMMAND_CACHE_FAILURE_TTL_MS = 5 * 1000;

let adbCommandCache: { value: string | null; checkedAt: number } | null = null;

export type AndroidConnectedDevice = {
  serial: string;
  state: string;
  model?: string;
  device?: string;
  avdName?: string;
};

function quoteCommand(cmd: string): string {
  return cmd.includes(' ') ? `"${cmd}"` : cmd;
}

function shellQuoteArg(value: string): string {
  const str = String(value ?? '');
  if (!str) return "''";
  return `'${str.replace(/'/g, `'\"'\"'`)}'`;
}

export function findAndroidSdkPath(): string | null {
  const envPaths = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_SDK,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const envPath of envPaths) {
    if (existsSync(join(envPath, 'platform-tools', 'adb'))) {
      return envPath;
    }
  }

  const home = homedir();
  const commonPaths = [
    join(home, 'Library', 'Android', 'sdk'),
    join(home, 'Android', 'Sdk'),
    '/opt/android-sdk',
    '/usr/local/android-sdk',
  ];

  for (const sdkPath of commonPaths) {
    if (existsSync(join(sdkPath, 'platform-tools', 'adb'))) {
      return sdkPath;
    }
  }

  return null;
}

export function getAdbPath(): string | null {
  const sdkPath = findAndroidSdkPath();
  if (!sdkPath) return null;
  const adbPath = join(sdkPath, 'platform-tools', 'adb');
  return existsSync(adbPath) ? adbPath : null;
}

export function getEmulatorPath(): string | null {
  const sdkPath = findAndroidSdkPath();
  if (!sdkPath) return null;
  const emulatorPath = join(sdkPath, 'emulator', 'emulator');
  return existsSync(emulatorPath) ? emulatorPath : null;
}

export function getAdbCommand(options?: { forceRefresh?: boolean }): string | null {
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();

  if (!forceRefresh && adbCommandCache) {
    const ttlMs = adbCommandCache.value
      ? ADB_COMMAND_CACHE_SUCCESS_TTL_MS
      : ADB_COMMAND_CACHE_FAILURE_TTL_MS;
    if ((now - adbCommandCache.checkedAt) < ttlMs) {
      return adbCommandCache.value;
    }
  }

  const candidates = [
    getAdbPath(),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    'adb',
  ].filter((value, index, arr): value is string => Boolean(value) && arr.indexOf(value) === index);

  for (const candidate of candidates) {
    try {
      if (candidate === 'adb') {
        execSync('which adb', { stdio: 'pipe', timeout: 2000 });
      } else if (!existsSync(candidate)) {
        continue;
      }
      adbCommandCache = { value: candidate, checkedAt: Date.now() };
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  adbCommandCache = { value: null, checkedAt: Date.now() };
  return null;
}

function normalizeAndroidDeviceToken(value: string): string {
  return value
    .trim()
    .replace(/^android:/i, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

export function listConnectedAndroidDevices(adbCommand = getAdbCommand()): AndroidConnectedDevice[] {
  if (!adbCommand) return [];

  try {
    const adbOutput = execSync(`${quoteCommand(adbCommand)} devices -l`, {
      encoding: 'utf8',
      timeout: 4000,
    });
    const lines = adbOutput.split('\n').slice(1);
    const devices: AndroidConnectedDevice[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const parts = line.split(/\s+/);
      const serial = parts[0];
      const state = parts[1];
      if (!serial || !state) continue;

      const modelMatch = line.match(/model:(\S+)/);
      const deviceMatch = line.match(/device:(\S+)/);
      const deviceInfo: AndroidConnectedDevice = {
        serial,
        state,
        model: modelMatch?.[1],
        device: deviceMatch?.[1],
      };

      if (serial.startsWith('emulator-') && state === 'device') {
        try {
          const avdNameOutput = execSync(
            `${quoteCommand(adbCommand)} -s ${shellQuoteArg(serial)} emu avd name`,
            {
              encoding: 'utf8',
              timeout: 1500,
            }
          );
          const avdName = avdNameOutput
            .split('\n')
            .map((value) => value.trim())
            .find((value) => value && value !== 'OK');
          if (avdName) {
            deviceInfo.avdName = avdName;
          }
        } catch {
          // Ignore AVD name lookup failures and keep serial-only info.
        }
      }

      devices.push(deviceInfo);
    }

    return devices;
  } catch {
    return [];
  }
}

export function resolveAndroidDeviceSerial(
  deviceId: string | null | undefined,
  adbCommand = getAdbCommand()
): string | null {
  const connectedDevices = listConnectedAndroidDevices(adbCommand);
  const onlineDevices = connectedDevices.filter((device) => device.state === 'device');
  if (onlineDevices.length === 0) return null;

  const requested = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (!requested) {
    return onlineDevices[0]?.serial || null;
  }

  const requestedToken = normalizeAndroidDeviceToken(requested);

  for (const device of onlineDevices) {
    const candidates = [device.serial, device.avdName, device.model, device.device]
      .filter((value): value is string => Boolean(value))
      .map((value) => normalizeAndroidDeviceToken(value));

    if (candidates.includes(requestedToken)) {
      return device.serial;
    }
  }

  return null;
}
