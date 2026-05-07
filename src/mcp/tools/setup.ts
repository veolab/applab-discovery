/**
 * DiscoveryLab Setup Tools
 * MCP tools for checking dependencies and setup status
 */

import { z } from 'zod';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform, homedir } from 'node:os';
import type { MCPTool } from '../server.js';
import { createTextResult, createJsonResult } from '../server.js';
import { DATA_DIR, DB_PATH } from '../../db/index.js';
import { getESVPHealth, listESVPDevices } from '../../core/integrations/esvp.js';
import { LOCAL_ESVP_SERVER_URL } from '../../core/integrations/esvp-local-runtime.js';
import { getPlaywrightRuntimeStatus } from '../../core/testing/playwright.js';

// ============================================================================
// DEPENDENCY DEFINITIONS
// ============================================================================
interface Dependency {
  name: string;
  command: string;
  versionPattern: RegExp;
  required: boolean;
  description: string;
  installHint: string;
}

const dependencies: Dependency[] = [
  {
    name: 'FFmpeg',
    command: 'ffmpeg -version',
    versionPattern: /ffmpeg version (\d+\.\d+(?:\.\d+)?)/,
    required: true,
    description: 'Video processing and export',
    installHint: 'brew install ffmpeg (macOS) or apt install ffmpeg (Linux)',
  },
  {
    name: 'Maestro CLI',
    command: '', // Special handling - check multiple paths
    versionPattern: /(\d+\.\d+\.\d+)/,
    required: false,
    description: 'Mobile app testing automation',
    installHint: 'curl -Ls "https://get.maestro.mobile.dev" | bash',
  },
  {
    name: 'Playwright',
    command: '', // Special handling - avoid npx auto-install false positives
    versionPattern: /(\d+\.\d+\.\d+)/,
    required: false,
    description: 'Web app testing and browser automation',
    installHint: 'npm install -g playwright && npx playwright install chromium',
  },
  {
    name: 'Xcode CLI Tools',
    command: 'xcode-select -p',
    versionPattern: /.*/,
    required: false,
    description: 'iOS Simulator access (macOS only)',
    installHint: 'xcode-select --install',
  },
  {
    name: 'ADB',
    command: 'adb version',
    versionPattern: /Android Debug Bridge version (\d+\.\d+\.\d+)/,
    required: false,
    description: 'Android Emulator access',
    installHint: 'Install Android Studio or: brew install android-platform-tools',
  },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
type DependencyStatus = {
  installed: boolean;
  ready: boolean;
  status: 'ready' | 'warning' | 'missing';
  version: string | null;
  error?: string;
  details?: string;
  detectedPath?: string | null;
  browserInstalled?: boolean;
  browserExecutablePath?: string | null;
  warning?: string;
  actionHint?: string;
};

function getDependencyActionHint(dep: Dependency): string {
  switch (dep.name) {
    case 'FFmpeg':
      return platform() === 'darwin' ? 'brew install ffmpeg' : 'sudo apt install -y ffmpeg';
    case 'ADB':
      return platform() === 'darwin' ? 'brew install android-platform-tools' : 'sudo apt install -y adb';
    case 'Playwright':
      return 'npm install -g playwright && npx playwright install chromium';
    default:
      return dep.installHint;
  }
}

function formatDependencyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Command failed');
  return message.length > 1200 ? `${message.slice(0, 1200)}...` : message;
}

function createMissingDependencyStatus(dep: Dependency, error?: unknown): DependencyStatus {
  return {
    installed: false,
    ready: false,
    status: 'missing',
    version: null,
    error: error ? formatDependencyError(error) : undefined,
    warning: `${dep.name} is not installed. ${dep.description} will be unavailable until it is installed.`,
    actionHint: getDependencyActionHint(dep),
  };
}

async function checkDependency(dep: Dependency): Promise<DependencyStatus> {
  // Special handling for Maestro - check multiple paths
  if (dep.name === 'Maestro CLI') {
    return checkMaestro(dep);
  }
  // Special handling for Playwright - check module resolvable by DiscoveryLab, not npx auto-download
  if (dep.name === 'Playwright') {
    return checkPlaywright();
  }
  if (dep.name === 'Xcode CLI Tools') {
    return checkXcode(dep);
  }
  if (dep.name === 'ADB') {
    return checkAdb(dep);
  }

  try {
    const output = execSync(dep.command, { encoding: 'utf-8', timeout: 5000 }).trim();
    const match = output.match(dep.versionPattern);
    return {
      installed: true,
      ready: true,
      status: 'ready',
      version: match ? match[1] || 'installed' : 'installed',
    };
  } catch (error) {
    return createMissingDependencyStatus(dep, error);
  }
}

async function checkPlaywright(): Promise<DependencyStatus> {
  const status = await getPlaywrightRuntimeStatus();
  return {
    installed: status.packageInstalled,
    ready: status.ready,
    status: status.ready ? 'ready' : (status.packageInstalled ? 'warning' : 'missing'),
    version: status.version,
    error: status.error,
    browserInstalled: status.ready,
    browserExecutablePath: status.executablePath,
    warning: status.ready ? undefined : status.warning,
    actionHint: status.ready ? undefined : status.actionHint,
  };
}

function checkMaestro(dep: Dependency): DependencyStatus {
  const homeDir = homedir();

  // Common Maestro installation paths
  const maestroPaths = [
    `${homeDir}/.maestro/bin/maestro`,
    '/usr/local/bin/maestro',
    '/opt/homebrew/bin/maestro',
  ];

  // First try if maestro is in PATH
  try {
    const output = execSync('maestro --version 2>/dev/null || maestro version 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
      shell: '/bin/bash'
    }).trim();
    const match = output.match(dep.versionPattern);
    return {
      installed: true,
      ready: true,
      status: 'ready',
      version: match ? match[1] : 'installed',
    };
  } catch {}

  // Check each path directly
  for (const maestroPath of maestroPaths) {
    if (existsSync(maestroPath)) {
      try {
        const output = execSync(`"${maestroPath}" --version 2>/dev/null || "${maestroPath}" version 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 5000,
          shell: '/bin/bash'
        }).trim();
        const match = output.match(dep.versionPattern);
        return {
          installed: true,
          ready: true,
          status: 'ready',
          version: match ? match[1] : 'installed',
          detectedPath: maestroPath,
        };
      } catch (error) {
        // File exists but couldn't get version - report as partial instead of green.
        return {
          installed: true,
          ready: false,
          status: 'warning',
          version: 'installed',
          detectedPath: maestroPath,
          error: formatDependencyError(error),
          warning: 'Maestro CLI was found, but DiscoveryLab could not run it to verify the version. Mobile automation may fail until Maestro is repaired or reinstalled.',
          actionHint: getDependencyActionHint(dep),
        };
      }
    }
  }

  return createMissingDependencyStatus(dep, 'Maestro not found in PATH or common installation directories');
}

function checkXcode(dep: Dependency): DependencyStatus {
  if (platform() !== 'darwin') {
    return {
      installed: false,
      ready: false,
      status: 'missing',
      version: null,
      warning: 'Xcode CLI Tools are only available on macOS.',
    };
  }

  let developerPath = '';
  try {
    developerPath = execSync('xcode-select -p', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch (error) {
    return createMissingDependencyStatus(dep, error);
  }

  try {
    execSync('xcrun simctl help', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return {
      installed: true,
      ready: true,
      status: 'ready',
      version: 'installed',
      detectedPath: developerPath,
      details: 'simctl available',
    };
  } catch (error) {
    return {
      installed: true,
      ready: false,
      status: 'warning',
      version: 'installed',
      detectedPath: developerPath,
      error: formatDependencyError(error),
      warning: 'Xcode CLI Tools are installed, but simctl is not available. iOS Simulator capture and replay may fail until Xcode command line tools are repaired.',
      actionHint: 'xcode-select --install',
    };
  }
}

function checkAdb(dep: Dependency): DependencyStatus {
  const candidates = [
    'adb',
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : '',
    process.env.ANDROID_SDK_ROOT ? `${process.env.ANDROID_SDK_ROOT}/platform-tools/adb` : '',
  ].filter(Boolean);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    if (candidate !== 'adb' && !existsSync(candidate)) continue;

    try {
      const command = candidate === 'adb' ? 'adb version' : `"${candidate}" version`;
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: 5000,
        shell: '/bin/bash',
      }).trim();
      const match = output.match(dep.versionPattern);
      return {
        installed: true,
        ready: true,
        status: 'ready',
        version: match ? match[1] : 'installed',
        detectedPath: candidate === 'adb' ? null : candidate,
      };
    } catch (error) {
      if (candidate !== 'adb' && existsSync(candidate)) {
        return {
          installed: true,
          ready: false,
          status: 'warning',
          version: 'installed',
          detectedPath: candidate,
          error: formatDependencyError(error),
          warning: 'ADB was found, but DiscoveryLab could not run it. Android Emulator capture and replay may fail until Android platform tools are repaired.',
          actionHint: getDependencyActionHint(dep),
        };
      }
    }
  }

  return createMissingDependencyStatus(dep, 'adb not found in PATH or common Android SDK locations');
}

type ReplayExecutorStatus = {
  available: boolean;
  dependencyReady: boolean;
  deviceCount: number;
  devices: Array<{ id: string; name: string; platform: string; status: string }>;
  missing: string[];
};

function buildReplayExecutorStatus(input: {
  devices: Array<{ id: string; name: string; platform: string; status: string }>;
  dependencyReady: boolean;
  missing: string[];
}): ReplayExecutorStatus {
  return {
    available: input.dependencyReady && input.devices.length > 0,
    dependencyReady: input.dependencyReady,
    deviceCount: input.devices.length,
    devices: input.devices,
    missing: input.missing,
  };
}

function createLocalReplayMessage(input: {
  ready: boolean;
  recommendedExecutor: 'adb' | 'ios-sim' | 'maestro-ios' | null;
  androidReady: boolean;
  iosReady: boolean;
}): string {
  if (input.ready && input.recommendedExecutor) {
    return `Local replay is ready. Recommended executor: ${input.recommendedExecutor}.`;
  }

  if (input.androidReady || input.iosReady) {
    return 'A mobile runtime is partially available, but the full local replay path still needs one or more dependencies.';
  }

  return 'Local replay is not ready yet. Install the missing mobile dependencies and boot at least one iOS Simulator or Android device/emulator.';
}

// ============================================================================
// dlab.setup.status
// ============================================================================
export const setupStatusTool: MCPTool = {
  name: 'dlab.setup.status',
  description: 'Check the status of DiscoveryLab setup and all dependencies.',
  inputSchema: z.object({}),
  handler: async () => {
    const results: any[] = [];
    let allRequiredInstalled = true;

    for (const dep of dependencies) {
      // Skip macOS-only deps on other platforms
      if (dep.name === 'Xcode CLI Tools' && platform() !== 'darwin') {
        continue;
      }

      const status = await checkDependency(dep);
      results.push({
        name: dep.name,
        installed: status.installed,
        ready: status.ready,
        status: status.status,
        version: status.version,
        required: dep.required,
        description: dep.description,
        installHint: status.ready ? null : (status.actionHint || getDependencyActionHint(dep)),
        details: status.details || null,
        detectedPath: status.detectedPath || null,
        error: status.error || null,
        ...(typeof status.browserInstalled === 'boolean' ? { browserInstalled: status.browserInstalled } : {}),
        ...(typeof status.browserExecutablePath === 'string' || status.browserExecutablePath === null
          ? { browserExecutablePath: status.browserExecutablePath }
          : {}),
        ...(status.warning ? { warning: status.warning } : {}),
        ...(status.actionHint ? { actionHint: status.actionHint } : {}),
      });

      if (dep.required && !status.ready) {
        allRequiredInstalled = false;
      }
    }

    // Check DiscoveryLab data directory
    const dataReady = existsSync(DATA_DIR);
    const dbReady = existsSync(DB_PATH);

    return createJsonResult({
      ready: allRequiredInstalled && dataReady,
      platform: platform(),
      dataDirectory: {
        path: DATA_DIR,
        exists: dataReady,
      },
      database: {
        path: DB_PATH,
        exists: dbReady,
      },
      dependencies: results,
      summary: {
        total: results.length,
        installed: results.filter((r) => r.installed).length,
        ready: results.filter((r) => r.ready).length,
        missing: results.filter((r) => r.status === 'missing').length,
        attention: results.filter((r) => r.status !== 'ready').length,
        requiredMissing: results.filter((r) => r.required && !r.ready).map((r) => r.name),
        warnings: results.filter((r) => r.status !== 'ready').map((r) => ({
          name: r.name,
          status: r.status,
          warning: r.warning || `${r.name} needs setup.`,
          actionHint: r.actionHint || r.installHint,
        })),
      },
    });
  },
};

// ============================================================================
// dlab.setup.check
// ============================================================================
export const setupCheckTool: MCPTool = {
  name: 'dlab.setup.check',
  description: 'Quick check if a specific tool is installed.',
  inputSchema: z.object({
    tool: z.enum(['ffmpeg', 'maestro', 'playwright', 'xcode', 'adb']).describe('Tool to check'),
  }),
  handler: async (params) => {
    const toolMap: Record<string, Dependency> = {
      ffmpeg: dependencies[0],
      maestro: dependencies[1],
      playwright: dependencies[2],
      xcode: dependencies[3],
      adb: dependencies[4],
    };

    const dep = toolMap[params.tool];
    if (!dep) {
      return createTextResult(`Unknown tool: ${params.tool}`);
    }

    const status = await checkDependency(dep);

    if (!status.ready) {
      return createTextResult(`${dep.name} needs setup/update.\n${status.warning || `${dep.name} is not ready.`}\nRun: ${status.actionHint || getDependencyActionHint(dep)}`);
    }

    if (status.installed) {
      return createTextResult(`${dep.name} is installed (version: ${status.version})`);
    } else {
      return createTextResult(`${dep.name} is NOT installed.\nInstall with: ${dep.installHint}`);
    }
  },
};

// ============================================================================
// dlab.setup.replay.status
// ============================================================================
export const setupReplayStatusTool: MCPTool = {
  name: 'dlab.setup.replay.status',
  description: 'Check whether this machine can run local ESVP replay for Claude Desktop using iOS Simulator or Android.',
  inputSchema: z.object({}),
  handler: async () => {
    const adbStatus = await checkDependency(dependencies[4]);
    const xcodeStatus = platform() === 'darwin'
      ? await checkDependency(dependencies[3])
      : {
          installed: false,
          ready: false,
          status: 'missing' as const,
          version: null,
          error: 'Xcode CLI Tools are only available on macOS',
          warning: 'Xcode CLI Tools are only available on macOS.',
        };
    const maestroStatus = await checkDependency(dependencies[1]);

    const deviceEnvelope = await listESVPDevices('all').catch((error) => ({
      adb: { devices: [], error: error instanceof Error ? error.message : String(error) },
      iosSim: { devices: [], error: error instanceof Error ? error.message : String(error) },
      maestroIos: { devices: [], error: error instanceof Error ? error.message : String(error) },
    }));
    const localEntropyHealth = await getESVPHealth(LOCAL_ESVP_SERVER_URL).catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));

    const androidDevices = Array.isArray(deviceEnvelope?.adb?.devices) ? deviceEnvelope.adb.devices : [];
    const iosSimDevices = Array.isArray(deviceEnvelope?.iosSim?.devices) ? deviceEnvelope.iosSim.devices : [];
    const maestroIosDevices = Array.isArray(deviceEnvelope?.maestroIos?.devices) ? deviceEnvelope.maestroIos.devices : [];

    const android = buildReplayExecutorStatus({
      devices: androidDevices,
      dependencyReady: adbStatus.ready,
      missing: adbStatus.ready ? [] : ['adb'],
    });
    const iosSimulator = buildReplayExecutorStatus({
      devices: iosSimDevices,
      dependencyReady: xcodeStatus.ready,
      missing: xcodeStatus.ready ? [] : ['xcode'],
    });
    const iosMaestro = buildReplayExecutorStatus({
      devices: maestroIosDevices,
      dependencyReady: maestroStatus.ready && xcodeStatus.ready,
      missing: [
        ...(maestroStatus.ready ? [] : ['maestro']),
        ...(xcodeStatus.ready ? [] : ['xcode']),
      ],
    });

    const recommendedExecutor: 'adb' | 'ios-sim' | 'maestro-ios' | null =
      android.available ? 'adb' : iosSimulator.available ? 'ios-sim' : iosMaestro.available ? 'maestro-ios' : null;
    const ready = Boolean(localEntropyHealth?.ok) && Boolean(recommendedExecutor);

    return createJsonResult({
      ready,
      minimumMobileReady: android.available || iosSimulator.available || iosMaestro.available,
      recommendedExecutor,
      message: createLocalReplayMessage({
        ready,
        recommendedExecutor,
        androidReady: android.available,
        iosReady: iosSimulator.available || iosMaestro.available,
      }),
      entropyLocal: {
        available: localEntropyHealth?.ok === true,
        kind: 'embedded-app-lab-runtime',
        serverUrl: LOCAL_ESVP_SERVER_URL,
        service: typeof localEntropyHealth?.service === 'string' ? localEntropyHealth.service : 'applab-esvp-local',
        version: typeof localEntropyHealth?.version === 'string' ? localEntropyHealth.version : null,
        note: 'Entropy local is the in-process AppLab ESVP runtime. It runs on this machine, stores runs under the local data directory, and uses local emulators/devices instead of a remote control-plane.',
        error: localEntropyHealth?.ok === true ? null : (typeof localEntropyHealth?.error === 'string' ? localEntropyHealth.error : null),
      },
      executors: {
        android,
        iosSimulator,
        iosMaestro,
      },
      dependencies: {
        adb: {
          installed: adbStatus.installed,
          ready: adbStatus.ready,
          version: adbStatus.version,
          warning: adbStatus.warning || null,
          installHint: adbStatus.ready ? null : (adbStatus.actionHint || getDependencyActionHint(dependencies[4])),
        },
        xcode: {
          installed: xcodeStatus.installed,
          ready: xcodeStatus.ready,
          version: xcodeStatus.version,
          warning: xcodeStatus.warning || null,
          installHint: xcodeStatus.ready ? null : (xcodeStatus.actionHint || getDependencyActionHint(dependencies[3])),
        },
        maestro: {
          installed: maestroStatus.installed,
          ready: maestroStatus.ready,
          version: maestroStatus.version,
          warning: maestroStatus.warning || null,
          installHint: maestroStatus.ready ? null : (maestroStatus.actionHint || getDependencyActionHint(dependencies[1])),
        },
      },
      dataDirectory: DATA_DIR,
    });
  },
};

// ============================================================================
// dlab.setup.init
// ============================================================================
export const setupInitTool: MCPTool = {
  name: 'dlab.setup.init',
  description: 'Initialize DiscoveryLab data directories and database.',
  inputSchema: z.object({}),
  handler: async () => {
    try {
      // Import and call getDatabase which auto-creates directories
      const { getDatabase, DATA_DIR, PROJECTS_DIR, EXPORTS_DIR, FRAMES_DIR } = await import('../../db/index.js');
      getDatabase(); // This initializes everything

      return createJsonResult({
        message: 'DiscoveryLab initialized successfully',
        directories: {
          data: DATA_DIR,
          projects: PROJECTS_DIR,
          exports: EXPORTS_DIR,
          frames: FRAMES_DIR,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Initialization failed';
      return createTextResult(`Error: ${message}`);
    }
  },
};

// ============================================================================
// dlab.setup.install
// ============================================================================
export const setupInstallTool: MCPTool = {
  name: 'dlab.setup.install',
  description: 'Get installation commands for missing DiscoveryLab dependencies. Claude should run these commands after user approval.',
  inputSchema: z.object({
    tool: z.enum(['all', 'ffmpeg', 'maestro', 'playwright', 'xcode', 'adb']).optional().describe('Specific tool to install (default: all missing)'),
  }),
  handler: async (params) => {
    const toolToInstall = params.tool || 'all';
    const installCommands: { name: string; command: string; description: string }[] = [];
    const isMac = platform() === 'darwin';

    // FFmpeg
    if (toolToInstall === 'all' || toolToInstall === 'ffmpeg') {
      const status = await checkDependency(dependencies[0]);
      if (!status.ready) {
        installCommands.push({
          name: 'FFmpeg',
          command: status.actionHint || getDependencyActionHint(dependencies[0]),
          description: status.warning || 'Required for video processing and export',
        });
      }
    }

    // Maestro
    if (toolToInstall === 'all' || toolToInstall === 'maestro') {
      const status = await checkDependency(dependencies[1]);
      if (!status.ready) {
        installCommands.push({
          name: 'Maestro CLI',
          command: status.actionHint || getDependencyActionHint(dependencies[1]),
          description: status.warning || 'Mobile app testing automation',
        });
      }
    }

    // Playwright
    if (toolToInstall === 'all' || toolToInstall === 'playwright') {
      const status = await checkDependency(dependencies[2]);
      if (!status.ready) {
        installCommands.push({
          name: 'Playwright',
          command: status.actionHint || getDependencyActionHint(dependencies[2]),
          description: status.warning || 'Web app testing and browser automation',
        });
      }
    }

    // Xcode CLI (macOS only)
    if (isMac && (toolToInstall === 'all' || toolToInstall === 'xcode')) {
      const status = await checkDependency(dependencies[3]);
      if (!status.ready) {
        installCommands.push({
          name: 'Xcode CLI Tools',
          command: status.actionHint || getDependencyActionHint(dependencies[3]),
          description: status.warning || 'Required for iOS Simulator access',
        });
      }
    }

    // ADB
    if (toolToInstall === 'all' || toolToInstall === 'adb') {
      const status = await checkDependency(dependencies[4]);
      if (!status.ready) {
        installCommands.push({
          name: 'ADB (Android Debug Bridge)',
          command: status.actionHint || getDependencyActionHint(dependencies[4]),
          description: status.warning || 'Required for Android Emulator access',
        });
      }
    }

    if (installCommands.length === 0) {
      return createTextResult(
        toolToInstall === 'all'
          ? '✅ All dependencies are already installed!'
          : `✅ ${toolToInstall} is already installed!`
      );
    }

    // Format as a clear instruction for Claude
    const instructions = installCommands.map((cmd, i) =>
      `${i + 1}. **${cmd.name}** (${cmd.description})\n   \`\`\`bash\n   ${cmd.command}\n   \`\`\``
    ).join('\n\n');

    return createTextResult(
      `## Missing Dependencies\n\n` +
      `Please run the following commands to install missing dependencies:\n\n` +
      instructions +
      `\n\n*Run these commands one at a time and verify each installation before proceeding.*`
    );
  },
};

// ============================================================================
// EXPORTS
// ============================================================================
export const setupTools: MCPTool[] = [setupStatusTool, setupCheckTool, setupReplayStatusTool, setupInitTool, setupInstallTool];
