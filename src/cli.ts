#!/usr/bin/env node
/**
 * DiscoveryLab CLI
 * Command-line interface for the DiscoveryLab plugin
 */

import { Command } from 'commander';
import chalk from 'chalk';
import open from 'open';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from './core/appVersion.js';
import { buildAppLabNetworkProfile } from './core/integrations/esvp-network-profile.js';

const program = new Command();

// Detect which binary name was used (discoverylab or applab)
const binName = process.argv[1]?.replace(/.*[\\/]/, '').replace(/\.[^.]+$/, '') === 'applab' ? 'applab' : 'discoverylab';

// ============================================================================
// CLI CONFIGURATION
// ============================================================================
program
  .name(binName)
  .description('AI-powered app testing & evidence generator - Claude Code Plugin')
  .version(APP_VERSION);

function printCliOutput(value: unknown): void {
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function failCli(message: string): never {
  throw new Error(message);
}

async function readJsonSource(json?: string, filePath?: string, label = 'payload'): Promise<any> {
  if (json && filePath) {
    failCli(`Use either --json or --file for ${label}, not both.`);
  }

  if (json) {
    try {
      return JSON.parse(json);
    } catch (error) {
      failCli(`Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (filePath) {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const raw = await readFile(resolve(process.cwd(), filePath), 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return null;
}

async function withESVPCli(action: () => Promise<unknown>): Promise<void> {
  try {
    const result = await action();
    printCliOutput(result);
  } catch (error) {
    console.error(chalk.red(`  ESVP command failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

async function getESVPBaseResult(serverUrl?: string): Promise<{ serverUrl: string; connectionMode: 'remote' | 'local' }> {
  const { getESVPConnection } = await import('./core/integrations/esvp.js');
  const connection = await getESVPConnection(serverUrl);
  return {
    serverUrl: connection.serverUrl,
    connectionMode: connection.mode,
  };
}

function executorToPlatform(executor?: string): 'ios' | 'android' | undefined {
  if (executor === 'ios-sim' || executor === 'maestro-ios') return 'ios';
  if (executor === 'adb') return 'android';
  return undefined;
}

const esvp = program
  .command('esvp')
  .description('Access the public ESVP protocol and runtime from the CLI');

esvp
  .command('status')
  .description('Check the configured ESVP server health')
  .option('-s, --server <url>', 'ESVP base URL')
  .action(async (options) => {
    await withESVPCli(async () => {
      const { getESVPHealth } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        health: await getESVPHealth(options.server),
      };
    });
  });

esvp
  .command('devices')
  .description('List ESVP-visible devices')
  .option('-s, --server <url>', 'ESVP base URL')
  .option('-p, --platform <platform>', 'adb | ios-sim | maestro-ios | all', 'all')
  .action(async (options) => {
    await withESVPCli(async () => {
      const { listESVPDevices } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        devices: await listESVPDevices(options.platform, options.server),
      };
    });
  });

esvp
  .command('sessions')
  .description('List public ESVP sessions')
  .option('-s, --server <url>', 'ESVP base URL')
  .action(async (options) => {
    await withESVPCli(async () => {
      const { listESVPSessions } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await listESVPSessions(options.server)),
      };
    });
  });

esvp
  .command('create')
  .description('Create a new ESVP session')
  .requiredOption('-e, --executor <executor>', 'fake | adb | ios-sim | maestro-ios')
  .option('-s, --server <url>', 'ESVP base URL')
  .option('-d, --device-id <id>', 'Device or simulator ID')
  .option('--meta-json <json>', 'Session metadata as JSON')
  .option('--meta-file <path>', 'Path to session metadata JSON')
  .option('--crash-clip-json <json>', 'Crash clip config as JSON')
  .option('--crash-clip-file <path>', 'Path to crash clip config JSON')
  .option('--with-network', 'Auto-configure the default App Lab external-proxy profile after creating the session')
  .action(async (options) => {
    await withESVPCli(async () => {
      const { createESVPSession, configureESVPNetwork } = await import('./core/integrations/esvp.js');
      const meta = await readJsonSource(options.metaJson, options.metaFile, 'meta');
      const crashClip = await readJsonSource(options.crashClipJson, options.crashClipFile, 'crash clip');
      const createResult = await createESVPSession(
        {
          executor: options.executor,
          ...(options.deviceId ? { deviceId: options.deviceId } : {}),
          ...(meta ? { meta } : {}),
          ...(crashClip ? { crash_clip: crashClip } : {}),
        },
        options.server
      );

      let networkConfigured = null;
      if (options.withNetwork) {
        const sessionId = String(createResult?.session?.id || createResult?.id || '');
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
                platform: executorToPlatform(options.executor),
                deviceId: options.deviceId,
              }
            ) || {},
            options.server
          ).catch((err: Error) => ({ error: err.message }));
        }
      }

      return {
        ...(await getESVPBaseResult(options.server)),
        ...createResult,
        ...(networkConfigured ? { networkConfigured } : {}),
      };
    });
  });

esvp
  .command('get <sessionId>')
  .description('Get a public ESVP session summary')
  .option('-s, --server <url>', 'ESVP base URL')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { getESVPSession } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await getESVPSession(sessionId, options.server)),
      };
    });
  });

esvp
  .command('inspect <sessionId>')
  .description('Inspect a session and optionally load transcript and artifacts')
  .option('-s, --server <url>', 'ESVP base URL')
  .option('--transcript', 'Include transcript')
  .option('--artifacts', 'Include artifacts')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { inspectESVPSession } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await inspectESVPSession(
          sessionId,
          {
            includeTranscript: options.transcript === true,
            includeArtifacts: options.artifacts === true,
          },
          options.server
        )),
      };
    });
  });

esvp
  .command('transcript <sessionId>')
  .description('Fetch the canonical session transcript')
  .option('-s, --server <url>', 'ESVP base URL')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { getESVPTranscript } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        sessionId,
        transcript: (await getESVPTranscript(sessionId, options.server))?.events || [],
      };
    });
  });

esvp
  .command('artifacts <sessionId>')
  .description('List session artifacts')
  .option('-s, --server <url>', 'ESVP base URL')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { listESVPArtifacts } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        sessionId,
        artifacts: (await listESVPArtifacts(sessionId, options.server))?.artifacts || [],
      };
    });
  });

esvp
  .command('artifact <sessionId> <artifactPath>')
  .description('Read a public artifact payload')
  .option('-s, --server <url>', 'ESVP base URL')
  .action(async (sessionId, artifactPath, options) => {
    await withESVPCli(async () => {
      const { getESVPArtifactContent } = await import('./core/integrations/esvp.js');
      return await getESVPArtifactContent(sessionId, artifactPath, options.server);
    });
  });

esvp
  .command('actions <sessionId>')
  .description('Run public ESVP actions inside a session')
  .option('-s, --server <url>', 'ESVP base URL')
  .option('--actions-json <json>', 'JSON array of ESVP actions')
  .option('--actions-file <path>', 'Path to a JSON file with ESVP actions')
  .option('--finish', 'Finish the session after actions')
  .option('--capture-logcat', 'Capture logcat on finish when supported')
  .option('--checkpoint-after-each', 'Set checkpointAfter on every action')
  .option('--with-network', 'Auto-configure the default App Lab external-proxy profile before running actions if not already configured')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { runESVPActions, getESVPSessionNetwork, configureESVPNetwork } = await import('./core/integrations/esvp.js');
      const actions = await readJsonSource(options.actionsJson, options.actionsFile, 'actions');
      if (!Array.isArray(actions) || actions.length === 0) {
        failCli('Provide --actions-json or --actions-file with a non-empty array of ESVP actions.');
      }

      let networkConfigured = null;
      if (options.withNetwork) {
        const networkState = await getESVPSessionNetwork(sessionId, options.server).catch(() => null);
        const hasActiveProfile = networkState?.network?.active_profile || networkState?.network?.effective_profile;
        if (!hasActiveProfile) {
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
                platform: executorToPlatform(typeof networkState?.session?.executor === 'string' ? networkState.session.executor : undefined),
                deviceId: typeof networkState?.session?.device_id === 'string' ? networkState.session.device_id : undefined,
              }
            ) || {},
            options.server
          ).catch((err: Error) => ({ error: err.message }));
        }
      }

      return {
        ...(await getESVPBaseResult(options.server)),
        ...(networkConfigured ? { networkConfigured } : {}),
        ...(await runESVPActions(
          sessionId,
          {
            actions,
            finish: options.finish === true,
            captureLogcat: options.captureLogcat === true,
            checkpointAfterEach: options.checkpointAfterEach === true,
          },
          options.server
        )),
      };
    });
  });

esvp
  .command('checkpoint <sessionId>')
  .description('Capture an ESVP checkpoint')
  .option('-s, --server <url>', 'ESVP base URL')
  .option('-l, --label <label>', 'Checkpoint label')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { captureESVPCheckpoint } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await captureESVPCheckpoint(
          sessionId,
          {
            ...(options.label ? { label: options.label } : {}),
          },
          options.server
        )),
      };
    });
  });

esvp
  .command('finish <sessionId>')
  .description('Finish an ESVP session')
  .option('-s, --server <url>', 'ESVP base URL')
  .option('--capture-logcat', 'Capture logcat on finish when supported')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { finishESVPSession } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await finishESVPSession(
          sessionId,
          {
            captureLogcat: options.captureLogcat === true,
          },
          options.server
        )),
      };
    });
  });

esvp
  .command('preflight <sessionId>')
  .description('Run preflight/bootstrap rules on an ESVP session')
  .option('-s, --server <url>', 'ESVP base URL')
  .option('--policy <policy>', 'Preflight policy name (e.g. fresh_install)')
  .option('--app-id <appId>', 'Target app ID')
  .option('--json <json>', 'Preflight config as JSON string')
  .option('--file <path>', 'Path to preflight config JSON file')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { runESVPPreflight } = await import('./core/integrations/esvp.js');
      const fromSource = await readJsonSource(options.json, options.file, 'preflight config');
      const config = {
        ...(typeof fromSource === 'object' && fromSource ? fromSource : {}),
        ...(options.policy ? { policy: options.policy } : {}),
        ...(options.appId ? { appId: options.appId } : {}),
      };
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await runESVPPreflight(sessionId, config, options.server)),
      };
    });
  });

esvp
  .command('replay-run <sessionId>')
  .description('Replay a session to a new ESVP session')
  .option('-s, --server <url>', 'ESVP base URL')
  .option('-e, --executor <executor>', 'fake | adb | ios-sim | maestro-ios')
  .option('-d, --device-id <id>', 'Replay target device ID')
  .option('--capture-logcat', 'Capture logcat on finish when supported')
  .option('--meta-json <json>', 'Replay metadata as JSON')
  .option('--meta-file <path>', 'Path to replay metadata JSON')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { replayESVPSession, getESVPReplayConsistency } = await import('./core/integrations/esvp.js');
      const meta = await readJsonSource(options.metaJson, options.metaFile, 'replay meta');
      const replay = await replayESVPSession(
        sessionId,
        {
          ...(options.executor ? { executor: options.executor } : {}),
          ...(options.deviceId ? { deviceId: options.deviceId } : {}),
          ...(options.captureLogcat === true ? { captureLogcat: true } : {}),
          ...(meta ? { meta } : {}),
        },
        options.server
      );
      const replaySessionId = replay?.replay_session?.id;
      const replayConsistency = replaySessionId
        ? (await getESVPReplayConsistency(replaySessionId, options.server)).replay_consistency
        : null;
      return {
        ...(await getESVPBaseResult(options.server)),
        ...replay,
        replayConsistency,
      };
    });
  });

esvp
  .command('replay-validate <sessionId>')
  .description('Validate whether a session supports public replay')
  .option('-s, --server <url>', 'ESVP base URL')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { validateESVPReplay } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await validateESVPReplay(sessionId, options.server)),
      };
    });
  });

esvp
  .command('replay-consistency <sessionId>')
  .description('Inspect replay consistency for a replay session')
  .option('-s, --server <url>', 'ESVP base URL')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { getESVPReplayConsistency } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await getESVPReplayConsistency(sessionId, options.server)),
      };
    });
  });

esvp
  .command('network <sessionId>')
  .description('Read the public network state for a session')
  .option('-s, --server <url>', 'ESVP base URL')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { getESVPSessionNetwork } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await getESVPSessionNetwork(sessionId, options.server)),
      };
    });
  });

esvp
  .command('network-configure <sessionId>')
  .description('Apply a public ESVP network profile')
  .option('-s, --server <url>', 'ESVP base URL')
  .option('--json <json>', 'Raw network profile JSON')
  .option('--file <path>', 'Path to network profile JSON')
  .option('--profile <name>', 'Profile name')
  .option('--label <label>', 'Profile label')
  .option('--connectivity <state>', 'online | offline | reset')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { configureESVPNetwork } = await import('./core/integrations/esvp.js');
      const payload = (await readJsonSource(options.json, options.file, 'network profile')) || {};
      const merged = {
        ...(typeof payload === 'object' && payload ? payload : {}),
        ...(options.profile ? { profile: options.profile } : {}),
        ...(options.label ? { label: options.label } : {}),
        ...(options.connectivity ? { connectivity: options.connectivity } : {}),
      };
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await configureESVPNetwork(sessionId, merged, options.server)),
      };
    });
  });

esvp
  .command('network-clear <sessionId>')
  .description('Clear the active ESVP network profile')
  .option('-s, --server <url>', 'ESVP base URL')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { clearESVPNetwork } = await import('./core/integrations/esvp.js');
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await clearESVPNetwork(sessionId, options.server)),
      };
    });
  });

esvp
  .command('trace-attach <sessionId>')
  .description('Attach a public network trace artifact to a session')
  .requiredOption('--trace-kind <kind>', 'Trace kind, e.g. http_trace or har')
  .option('-s, --server <url>', 'ESVP base URL')
  .option('--json <json>', 'Trace payload JSON')
  .option('--file <path>', 'Path to trace payload JSON/text')
  .option('--label <label>', 'Trace label')
  .option('--source <source>', 'Trace source')
  .option('--request-id <id>', 'Correlated request ID')
  .option('--method <method>', 'HTTP method')
  .option('--url <url>', 'Request URL')
  .option('--status-code <code>', 'HTTP status code')
  .option('--format <format>', 'Payload format label')
  .action(async (sessionId, options) => {
    await withESVPCli(async () => {
      const { attachESVPNetworkTrace } = await import('./core/integrations/esvp.js');
      const payload = await readJsonSource(options.json, options.file, 'trace payload');
      if (payload == null) {
        failCli('Provide --json or --file with the trace payload to attach.');
      }
      return {
        ...(await getESVPBaseResult(options.server)),
        ...(await attachESVPNetworkTrace(
          sessionId,
          {
            trace_kind: options.traceKind,
            ...(options.label ? { label: options.label } : {}),
            ...(options.source ? { source: options.source } : {}),
            ...(options.requestId ? { request_id: options.requestId } : {}),
            ...(options.method ? { method: options.method } : {}),
            ...(options.url ? { url: options.url } : {}),
            ...(options.statusCode ? { status_code: Number(options.statusCode) } : {}),
            ...(options.format ? { format: options.format } : {}),
            payload,
          },
          options.server
        )),
      };
    });
  });

// ============================================================================
// SERVE COMMAND
// ============================================================================
program
  .command('serve')
  .alias('server')
  .description('Start the DiscoveryLab web UI server')
  .option('-p, --port <number>', 'Port to listen on', '3847')
  .option('-o, --open', 'Open browser automatically', false)
  .action(async (options) => {
    const port = parseInt(options.port, 10);

    console.log(chalk.cyan('\n  DiscoveryLab'));
    console.log(chalk.gray('  AI-powered app testing & evidence generator\n'));

    try {
      // Import server dynamically to avoid loading everything at startup
      const { startServer } = await import('./web/server.js');
      await startServer(port);

      console.log(chalk.green(`  Server running at http://localhost:${port}`));
      console.log(chalk.gray('  Press Ctrl+C to stop\n'));

      if (options.open) {
        await open(`http://localhost:${port}`);
      }
    } catch (error) {
      console.error(chalk.red(`  Failed to start server: ${error}`));
      process.exit(1);
    }
  });

// ============================================================================
// SETUP COMMAND
// ============================================================================
program
  .command('setup')
  .description('Check and configure DiscoveryLab dependencies')
  .action(async () => {
    console.log(chalk.cyan('\n  DiscoveryLab Setup\n'));

    try {
      const { setupStatusTool } = await import('./mcp/tools/setup.js');
      const result = await setupStatusTool.handler({});

      if (result.isError) {
        console.error(chalk.red('  Setup check failed'));
        return;
      }

      const data = JSON.parse(result.content[0].text!);

      // Show platform
      console.log(chalk.gray(`  Platform: ${data.platform}`));
      console.log(chalk.gray(`  Data directory: ${data.dataDirectory.path}`));
      console.log();

      // Show dependencies
      console.log(chalk.white('  Dependencies:'));
      for (const dep of data.dependencies) {
        const status = dep.installed
          ? chalk.green(`  ${dep.name} ${dep.version}`)
          : chalk.red(`  ${dep.name} (not installed)`);

        const required = dep.required ? chalk.yellow(' [required]') : chalk.gray(' [optional]');
        console.log(`${status}${required}`);

        if (!dep.installed && dep.installHint) {
          console.log(chalk.gray(`     Install: ${dep.installHint}`));
        }
      }

      console.log();

      // Summary
      if (data.ready) {
        console.log(chalk.green('  Ready to use!'));
        console.log(chalk.gray('  Run: discoverylab serve'));
      } else {
        console.log(chalk.yellow('  Some required dependencies are missing.'));
        console.log(chalk.gray('  Install them and run setup again.'));
      }

      console.log();
    } catch (error) {
      console.error(chalk.red(`  Setup failed: ${error}`));
      process.exit(1);
    }
  });

// ============================================================================
// INIT COMMAND
// ============================================================================
program
  .command('init')
  .description('Initialize DiscoveryLab data directories')
  .action(async () => {
    console.log(chalk.cyan('\n  Initializing DiscoveryLab...\n'));

    try {
      const { getDatabase, DATA_DIR, PROJECTS_DIR, EXPORTS_DIR } = await import('./db/index.js');
      getDatabase(); // This creates directories and tables

      console.log(chalk.green('  Created directories:'));
      console.log(chalk.gray(`    ${DATA_DIR}`));
      console.log(chalk.gray(`    ${PROJECTS_DIR}`));
      console.log(chalk.gray(`    ${EXPORTS_DIR}`));
      console.log();
      console.log(chalk.green('  Database initialized successfully!'));
      console.log();
    } catch (error) {
      console.error(chalk.red(`  Initialization failed: ${error}`));
      process.exit(1);
    }
  });

// ============================================================================
// INSTALL COMMAND (auto-configure MCP)
// ============================================================================
program
  .command('install')
  .description('Install DiscoveryLab as MCP server for Claude Code and/or Claude Desktop')
  .option('--target <target>', 'Installation target: code, desktop, all (default: auto-detect)', '')
  .action(async (opts: { target: string }) => {
    const { homedir, platform } = await import('node:os');
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');

    const home = homedir();
    const localMcpEntrypoint = fileURLToPath(new URL('./index.js', import.meta.url));
    const mcpEntry = existsSync(localMcpEntrypoint)
      ? {
          command: process.execPath,
          args: [localMcpEntrypoint],
        }
      : {
          command: 'npx',
          args: ['-y', '@veolab/discoverylab@latest', 'mcp'],
        };

    // Config paths for each target
    const targets: Record<string, { name: string; path: string; restart: string }> = {
      code: {
        name: 'Claude Code',
        path: join(home, '.claude.json'),
        restart: 'Restart Claude Code to activate.',
      },
      desktop: {
        name: 'Claude Desktop',
        path: platform() === 'win32'
          ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
          : join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
        restart: 'Restart Claude Desktop to activate.',
      },
    };

    // Determine which targets to install
    let selectedTargets: string[] = [];
    const target = opts.target?.toLowerCase() || '';

    if (target === 'code') {
      selectedTargets = ['code'];
    } else if (target === 'desktop') {
      selectedTargets = ['desktop'];
    } else if (target === 'all') {
      selectedTargets = ['code', 'desktop'];
    } else {
      // Auto-detect: always install for Claude Code, add Desktop if its config dir exists
      selectedTargets = ['code'];
      const desktopDir = dirname(targets.desktop.path);
      if (existsSync(desktopDir)) {
        selectedTargets.push('desktop');
      }
    }

    console.log(chalk.cyan('\n  Installing DiscoveryLab MCP...\n'));
    let installed = 0;

    for (const key of selectedTargets) {
      const t = targets[key];
      try {
        // Ensure directory exists
        const dir = dirname(t.path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        // Read existing config or create new one
        let config: { mcpServers?: Record<string, unknown> } = {};
        if (existsSync(t.path)) {
          const content = readFileSync(t.path, 'utf-8');
          try { config = JSON.parse(content); } catch { config = {}; }
        }

        // Merge - don't overwrite other mcpServers
        if (!config.mcpServers) config.mcpServers = {};
        config.mcpServers.discoverylab = mcpEntry;

        writeFileSync(t.path, JSON.stringify(config, null, 2));
        console.log(chalk.green(`  ✓ ${t.name} configured`));
        console.log(chalk.gray(`    ${t.path}`));
        installed++;
      } catch (error) {
        console.log(chalk.yellow(`  ✗ ${t.name} skipped: ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    console.log();
    if (installed > 0) {
      for (const key of selectedTargets) {
        console.log(chalk.white(`  ${targets[key].restart}`));
      }
      console.log(chalk.gray('  Or run: discoverylab serve'));
    } else {
      console.log(chalk.red('  No targets configured.'));
    }
    console.log();
  });

// ============================================================================
// MCP COMMAND (for Claude Code integration)
// ============================================================================
program
  .command('mcp')
  .description('Run as MCP server (for Claude Code integration)')
  .action(async () => {
    try {
      // Initialize database first
      const { getDatabase } = await import('./db/index.js');
      getDatabase();

      // Import and start MCP server
      const { mcpServer } = await import('./mcp/server.js');
      const {
        uiTools,
        projectTools,
        setupTools,
        captureTools,
        analyzeTools,
        canvasTools,
        exportTools,
        testingTools,
        integrationTools,
        taskHubTools,
        esvpTools,
        knowledgeTools,
      } = await import('./mcp/tools/index.js');

      // Register all tools
      mcpServer.registerTools([
        ...uiTools,
        ...projectTools,
        ...setupTools,
        ...captureTools,
        ...analyzeTools,
        ...canvasTools,
        ...exportTools,
        ...testingTools,
        ...integrationTools,
        ...taskHubTools,
        ...esvpTools,
        ...knowledgeTools,
      ]);

      // Start STDIO transport
      await mcpServer.runStdio();
    } catch (error) {
      console.error(`MCP server error: ${error}`);
      process.exit(1);
    }
  });

// ============================================================================
// VERSION INFO
// ============================================================================
program
  .command('info')
  .description('Show version and configuration info')
  .action(async () => {
    console.log(chalk.cyan(`\n  DiscoveryLab v${APP_VERSION}\n`));
    console.log(chalk.gray('  AI-powered app testing & evidence generator'));
    console.log(chalk.gray('  Claude Code Plugin\n'));

    try {
      const { DATA_DIR, DB_PATH } = await import('./db/index.js');
      console.log(chalk.white('  Paths:'));
      console.log(chalk.gray(`    Data: ${DATA_DIR}`));
      console.log(chalk.gray(`    Database: ${DB_PATH}`));
      console.log();
    } catch {
      console.log(chalk.gray('  (Database not initialized)'));
      console.log();
    }
  });

// ============================================================================
// EXPORT COMMAND
// ============================================================================
program
  .command('export')
  .description('Export project in various formats')
  .argument('<project-id>', 'Project ID or slug')
  .option('--format <format>', 'Export format (infographic, applab, esvp)', 'infographic')
  .option('--output <path>', 'Custom output path')
  .option('--open', 'Open file after generation')
  .option('--compress', 'Force image compression')
  .option('--no-baseline', 'Omit baseline info')
  .action(async (projectId: string, opts: { format: string; output?: string; open?: boolean; compress?: boolean; baseline?: boolean }) => {
    try {
      if (opts.format === 'infographic') {
        console.log(chalk.cyan(`\n  Exporting infographic for: ${projectId}\n`));

        const { join: pathJoin } = await import('node:path');
        const { getDatabase, projects, frames: framesTable, FRAMES_DIR, EXPORTS_DIR, PROJECTS_DIR } = await import('./db/index.js');
        const { eq } = await import('drizzle-orm');
        const { collectFrameImages, buildInfographicData, generateInfographicHtml } = await import('./core/export/infographic.js');

        const db = getDatabase();
        const allProjects = await db.select().from(projects);
        const project = allProjects.find(p => p.id === projectId || p.id.startsWith(projectId) || p.name.toLowerCase().includes(projectId.toLowerCase()));

        if (!project) {
          console.log(chalk.red(`  Project not found: ${projectId}`));
          console.log(chalk.gray('  Available projects:'));
          for (const p of allProjects.slice(0, 10)) {
            console.log(chalk.gray(`    ${p.id.slice(0, 12)} - ${p.marketingTitle || p.name}`));
          }
          return;
        }

        console.log(chalk.green(`  ✔ Found project: ${project.marketingTitle || project.name}`));

        // Get frames
        const dbFrames = await db.select().from(framesTable).where(eq(framesTable.projectId, project.id)).orderBy(framesTable.frameNumber).limit(20);
        let frameFiles: string[];
        let frameOcr: Array<{ ocrText?: string | null }>;

        if (dbFrames.length > 0) {
          frameFiles = dbFrames.map(f => f.imagePath);
          frameOcr = dbFrames;
        } else {
          frameFiles = collectFrameImages(pathJoin(FRAMES_DIR, project.id), project.videoPath, PROJECTS_DIR, project.id);
          frameOcr = frameFiles.map(() => ({ ocrText: null }));
        }

        console.log(chalk.green(`  ✔ ${frameFiles.length} frames found`));

        if (frameFiles.length === 0) {
          console.log(chalk.red('  No frames found. Run analyzer first.'));
          return;
        }

        // Annotations not available in CLI context (server not running)

        const data = buildInfographicData(project, frameFiles, frameOcr);
        console.log(chalk.green(`  ✔ ${project.aiSummary ? 'AI analysis loaded' : 'No analysis (basic labels)'}`));

        const slug = (project.marketingTitle || project.name || project.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        const outputPath = opts.output
          ? pathJoin(opts.output, `${slug}-infographic.html`)
          : pathJoin(EXPORTS_DIR, `${slug}-infographic.html`);

        const result = generateInfographicHtml(data, outputPath);

        if (result.success) {
          const sizeKb = ((result.size || 0) / 1024).toFixed(1);
          console.log(chalk.green(`  ✔ Exported: ${result.outputPath} (${sizeKb}KB, ${result.frameCount} frames)`));

          if (opts.open) {
            const { exec } = await import('node:child_process');
            exec(`open "${result.outputPath}"`);
          }
        } else {
          console.log(chalk.red(`  Export failed: ${result.error}`));
        }
      } else {
        console.log(chalk.yellow(`  Format "${opts.format}" - use the web UI for applab/esvp exports.`));
      }
    } catch (error) {
      console.log(chalk.red(`  Export failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  });

// ============================================================================
// IMPORT COMMAND
// ============================================================================
program
  .command('import')
  .description('Import a shared .applab project bundle')
  .argument('<file>', 'Path to .applab file')
  .action(async (file: string) => {
    try {
      const { resolve } = await import('node:path');
      const filePath = resolve(file);

      console.log(chalk.cyan(`\n  Importing: ${filePath}\n`));

      const { getDatabase, projects, frames: framesTable, DATA_DIR, FRAMES_DIR, PROJECTS_DIR } = await import('./db/index.js');
      const { importApplabBundle } = await import('./core/export/import.js');

      const db = getDatabase();
      const result = await importApplabBundle(filePath, db, { projects, frames: framesTable }, {
        dataDir: DATA_DIR,
        framesDir: FRAMES_DIR,
        projectsDir: PROJECTS_DIR,
      });

      if (result.success) {
        console.log(chalk.green(`  ✔ Imported: ${result.projectName}`));
        console.log(chalk.green(`  ✔ ${result.frameCount} frames`));
        console.log(chalk.gray(`  ID: ${result.projectId}\n`));
      } else {
        console.log(chalk.red(`  Import failed: ${result.error}\n`));
      }
    } catch (error) {
      console.log(chalk.red(`  Import failed: ${error instanceof Error ? error.message : String(error)}\n`));
    }
  });

// ============================================================================
// PARSE ARGS
// ============================================================================
program.parse();

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
