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
    command: 'npx playwright --version',
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
export const setupTools: MCPTool[] = [setupStatusTool, setupCheckTool, setupInitTool, setupInstallTool];
