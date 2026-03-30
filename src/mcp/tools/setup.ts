/**
 * DiscoveryLab Setup Tools
 * MCP tools for checking dependencies and setup status
 */

import { z } from 'zod';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform, homedir } from 'node:os';
import type { MCPTool } from '../server.js';
import { createTextResult, createJsonResult } from '../server.js';
import { DATA_DIR, DB_PATH } from '../../db/index.js';
import { getESVPHealth, listESVPDevices } from '../../core/integrations/esvp.js';
import { LOCAL_ESVP_SERVER_URL } from '../../core/integrations/esvp-local-runtime.js';
const requireFromHere = createRequire(import.meta.url);

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
    installHint: 'npm install -g playwright',
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
function checkDependency(dep: Dependency): { installed: boolean; version: string | null; error?: string } {
  // Special handling for Maestro - check multiple paths
  if (dep.name === 'Maestro CLI') {
    return checkMaestro(dep);
  }
  // Special handling for Playwright - check module resolvable by DiscoveryLab, not npx auto-download
  if (dep.name === 'Playwright') {
    return checkPlaywright(dep);
  }

  try {
    const output = execSync(dep.command, { encoding: 'utf-8', timeout: 5000 }).trim();
    const match = output.match(dep.versionPattern);
    return {
      installed: true,
      version: match ? match[1] || 'installed' : 'installed',
    };
  } catch (error) {
    return {
      installed: false,
      version: null,
      error: error instanceof Error ? error.message : 'Command failed',
    };
  }
}

function checkPlaywright(dep: Dependency): { installed: boolean; version: string | null; error?: string } {
  try {
    const pkgPath = requireFromHere.resolve('playwright/package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return {
      installed: true,
      version: typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : 'installed',
    };
  } catch (error) {
    return {
      installed: false,
      version: null,
      error: error instanceof Error ? error.message : 'Playwright package not found',
    };
  }
}

function checkMaestro(dep: Dependency): { installed: boolean; version: string | null; error?: string } {
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
          version: match ? match[1] : 'installed',
        };
      } catch {
        // File exists but couldn't get version - still consider it installed
        return {
          installed: true,
          version: 'installed',
        };
      }
    }
  }

  return {
    installed: false,
    version: null,
    error: 'Maestro not found in PATH or common installation directories',
  };
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

      const status = checkDependency(dep);
      results.push({
        name: dep.name,
        installed: status.installed,
        version: status.version,
        required: dep.required,
        description: dep.description,
        installHint: status.installed ? null : dep.installHint,
      });

      if (dep.required && !status.installed) {
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
        missing: results.filter((r) => !r.installed).length,
        requiredMissing: results.filter((r) => r.required && !r.installed).map((r) => r.name),
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

    const status = checkDependency(dep);

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
    const adbStatus = checkDependency(dependencies[4]);
    const xcodeStatus = platform() === 'darwin'
      ? checkDependency(dependencies[3])
      : { installed: false, version: null, error: 'Xcode CLI Tools are only available on macOS' };
    const maestroStatus = checkDependency(dependencies[1]);

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
      dependencyReady: adbStatus.installed,
      missing: adbStatus.installed ? [] : ['adb'],
    });
    const iosSimulator = buildReplayExecutorStatus({
      devices: iosSimDevices,
      dependencyReady: xcodeStatus.installed,
      missing: xcodeStatus.installed ? [] : ['xcode'],
    });
    const iosMaestro = buildReplayExecutorStatus({
      devices: maestroIosDevices,
      dependencyReady: maestroStatus.installed && xcodeStatus.installed,
      missing: [
        ...(maestroStatus.installed ? [] : ['maestro']),
        ...(xcodeStatus.installed ? [] : ['xcode']),
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
          version: adbStatus.version,
          installHint: adbStatus.installed ? null : dependencies[4].installHint,
        },
        xcode: {
          installed: xcodeStatus.installed,
          version: xcodeStatus.version,
          installHint: xcodeStatus.installed ? null : dependencies[3].installHint,
        },
        maestro: {
          installed: maestroStatus.installed,
          version: maestroStatus.version,
          installHint: maestroStatus.installed ? null : dependencies[1].installHint,
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
      const status = checkDependency(dependencies[0]);
      if (!status.installed) {
        installCommands.push({
          name: 'FFmpeg',
          command: isMac ? 'brew install ffmpeg' : 'sudo apt install -y ffmpeg',
          description: 'Required for video processing and export',
        });
      }
    }

    // Maestro
    if (toolToInstall === 'all' || toolToInstall === 'maestro') {
      const status = checkDependency(dependencies[1]);
      if (!status.installed) {
        installCommands.push({
          name: 'Maestro CLI',
          command: 'curl -Ls "https://get.maestro.mobile.dev" | bash',
          description: 'Mobile app testing automation',
        });
      }
    }

    // Playwright
    if (toolToInstall === 'all' || toolToInstall === 'playwright') {
      const status = checkDependency(dependencies[2]);
      if (!status.installed) {
        installCommands.push({
          name: 'Playwright',
          command: 'npm install -g playwright && npx playwright install',
          description: 'Web app testing and browser automation',
        });
      }
    }

    // Xcode CLI (macOS only)
    if (isMac && (toolToInstall === 'all' || toolToInstall === 'xcode')) {
      const status = checkDependency(dependencies[3]);
      if (!status.installed) {
        installCommands.push({
          name: 'Xcode CLI Tools',
          command: 'xcode-select --install',
          description: 'Required for iOS Simulator access',
        });
      }
    }

    // ADB
    if (toolToInstall === 'all' || toolToInstall === 'adb') {
      const status = checkDependency(dependencies[4]);
      if (!status.installed) {
        installCommands.push({
          name: 'ADB (Android Debug Bridge)',
          command: isMac ? 'brew install android-platform-tools' : 'sudo apt install -y adb',
          description: 'Required for Android Emulator access',
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
