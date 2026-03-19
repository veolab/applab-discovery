import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA_DIR } from '../../db/index.js';

type ESVPServerHandle = {
  close: (cb: (error?: Error | null) => void) => void;
};

type ESVPStartResult = {
  server: ESVPServerHandle;
  manager?: { cleanupIosSimProxies?: () => Promise<void> };
  url: string;
};

type ESVPLocalRuntimeModule = {
  startServer: (options?: {
    host?: string;
    port?: number;
    rootDir?: string;
    apiToken?: string | null;
    corsOrigins?: string | string[];
    maxBodyBytes?: number;
  }) => Promise<ESVPStartResult>;
  stopServer?: (serverOrResult: ESVPServerHandle | ESVPStartResult) => Promise<void>;
};

export interface ESVPResolvedConnection {
  mode: 'remote' | 'local';
  serverUrl: string;
}

let localServerPromise: Promise<ESVPResolvedConnection> | null = null;
let cleanupRegistered = false;
let activeLocalServer:
  | {
      startResult: ESVPStartResult;
      runtime: ESVPLocalRuntimeModule;
    }
  | null = null;

export async function resolveESVPConnection(serverUrl?: string): Promise<ESVPResolvedConnection> {
  const explicit = typeof serverUrl === 'string' && serverUrl.trim() ? normalizeBaseUrl(serverUrl) : null;
  if (explicit) {
    return {
      mode: 'remote',
      serverUrl: explicit,
    };
  }

  const envUrl = typeof process.env.ESVP_BASE_URL === 'string' && process.env.ESVP_BASE_URL.trim()
    ? normalizeBaseUrl(process.env.ESVP_BASE_URL)
    : null;
  if (envUrl) {
    return {
      mode: 'remote',
      serverUrl: envUrl,
    };
  }

  if (!localServerPromise) {
    localServerPromise = startEmbeddedLocalServer().catch((error) => {
      localServerPromise = null;
      throw error;
    });
  }

  return localServerPromise;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

async function startEmbeddedLocalServer(): Promise<ESVPResolvedConnection> {
  const runtime = await loadLocalRuntimeModule();
  const rootDir = join(DATA_DIR, 'esvp-local');
  const started = await runtime.startServer({
    host: '127.0.0.1',
    port: 0,
    rootDir,
  });
  activeLocalServer = {
    startResult: started,
    runtime,
  };

  if (!cleanupRegistered) {
    cleanupRegistered = true;
    const cleanup = async () => {
      try {
        await stopEmbeddedESVPServer();
      } catch {
        // Ignore cleanup errors during process shutdown.
      }
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

    // Safety net: clean up proxy even on unexpected crashes.
    // Without this, a crash leaves macOS proxy pointing at a dead port,
    // which kills all internet on the host (critical for VPN/corporate networks).
    process.once('uncaughtException', (error) => {
      void cleanup().finally(() => {
        console.error('[esvp-local] uncaught exception after proxy cleanup:', error);
        process.exit(1);
      });
    });
    process.once('unhandledRejection', (reason) => {
      void cleanup().finally(() => {
        console.error('[esvp-local] unhandled rejection after proxy cleanup:', reason);
        process.exit(1);
      });
    });
  }

  return {
    mode: 'local',
    serverUrl: normalizeBaseUrl(started.url),
  };
}

export async function stopEmbeddedESVPServer(): Promise<void> {
  const current = activeLocalServer;
  activeLocalServer = null;
  localServerPromise = null;
  if (!current) return;

  // Always clean up macOS proxy settings before shutting down the server.
  // This is critical: if the proxy is left active, the host machine loses internet.
  const manager = current.startResult.manager;
  if (manager && typeof manager.cleanupIosSimProxies === 'function') {
    try {
      await manager.cleanupIosSimProxies();
    } catch {
      // best effort
    }
  }

  if (current.runtime.stopServer) {
    await current.runtime.stopServer(current.startResult);
    return;
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    current.startResult.server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

async function loadLocalRuntimeModule(): Promise<ESVPLocalRuntimeModule> {
  const explicitModulePath = process.env.DISCOVERYLAB_ESVP_LOCAL_MODULE?.trim();
  const candidates = explicitModulePath
    ? [explicitModulePath]
    : ['@entropylab/esvp-local', ...discoverWorkspaceRuntimeCandidates()];

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const module = (await dynamicImport(resolveModuleSpecifier(candidate))) as Partial<ESVPLocalRuntimeModule>;
      if (typeof module.startServer === 'function') {
        return module as ESVPLocalRuntimeModule;
      }
      throw new Error(`Módulo ${candidate} não exporta startServer()`);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    [
      'ESVP local não disponível.',
      'Instale o pacote público @entropylab/esvp-local, mantenha o entropy-poc acessível no workspace, ou defina DISCOVERYLAB_ESVP_LOCAL_MODULE com o caminho do server.js do runtime local.',
      lastError instanceof Error ? `Detalhe: ${lastError.message}` : null,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function discoverWorkspaceRuntimeCandidates(): string[] {
  const seen = new Set<string>();
  const roots = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  const suffixes = [
    ['esvp-server-reference', 'server.js'],
    ['entropy-poc', 'esvp-server-reference', 'server.js'],
    ['entropy', 'entropy-poc', 'esvp-server-reference', 'server.js'],
  ];
  const candidates: string[] = [];

  for (const root of roots) {
    let current = resolve(root);
    for (let depth = 0; depth < 6; depth += 1) {
      for (const suffix of suffixes) {
        const candidate = join(current, ...suffix);
        if (existsSync(candidate) && !seen.has(candidate)) {
          seen.add(candidate);
          candidates.push(candidate);
        }
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return candidates;
}

function resolveModuleSpecifier(value: string): string {
  if (value.startsWith('.') || value.startsWith('/') || value.startsWith('file://')) {
    return value.startsWith('file://') ? value : pathToFileURL(resolve(process.cwd(), value)).href;
  }
  return value;
}

async function dynamicImport(specifier: string): Promise<unknown> {
  return Function('specifier', 'return import(specifier)')(specifier) as Promise<unknown>;
}
