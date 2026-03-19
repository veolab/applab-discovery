import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  attachESVPNetworkTrace,
  clearESVPNetwork,
  createESVPSession,
  finishESVPSession,
  type ESVPExecutor,
} from './esvp.js';

type MobilePlatform = 'ios' | 'android';

type ProxyProfile = Record<string, unknown> | null;
type LocalCaptureProxyLifecycleConfig = {
  executor?: ESVPExecutor | string | null;
  deviceId?: string | null;
  serverUrl?: string;
  captureLogcat?: boolean;
  cleanupMeta?: Record<string, unknown>;
  maxDurationMs?: number | null;
};

export type LocalCaptureProxyState = {
  id: string;
  sessionId: string;
  active: boolean;
  bindHost: string;
  host: string;
  port: number | null;
  url: string | null;
  startedAt: string | null;
  entryCount: number;
  captureMode: 'external-proxy';
  source: 'applab-external-proxy';
};

type TracePayload = {
  trace_kind: 'http_trace';
  label: string;
  format: 'json';
  source: 'applab-external-proxy';
  payload: {
    session_id: string;
    proxy_id: string;
    generated_at: string;
    entries: Array<Record<string, unknown>>;
  };
  artifactMeta: {
    capture_mode: 'external-proxy';
    proxy_id: string;
    entry_count: number;
  };
};

export type LocalCaptureProxyFinalizationResult = {
  captureProxy: LocalCaptureProxyState | null;
  traceAttached: boolean;
  cleanupSessionId: string | null;
  clearResult: Record<string, unknown> | null;
  clearedAt: string | null;
  finishResult: Record<string, unknown> | null;
  errors: string[];
};

const activeProxies = new Map<string, AppLabCaptureProxy>();
const finalizationsInFlight = new Map<string, Promise<LocalCaptureProxyFinalizationResult>>();
let cleanupRegistered = false;

export async function ensureLocalCaptureProxyProfile(input: {
  sessionId: string;
  profile: ProxyProfile;
  platform?: MobilePlatform | string | null;
  deviceId?: string | null;
  lifecycle?: LocalCaptureProxyLifecycleConfig | null;
  allowAppLabOwnedProxy?: boolean;
}): Promise<{
  profile: ProxyProfile;
  captureProxy: LocalCaptureProxyState | null;
  usesExternalProxy: boolean;
  appLabOwnedProxy: boolean;
}> {
  const profile = cloneProfile(input.profile);
  if (!profile) {
    return {
      profile,
      captureProxy: null,
      usesExternalProxy: false,
      appLabOwnedProxy: false,
    };
  }

  const captureMode = String((profile.capture as Record<string, unknown> | undefined)?.mode || '').trim().toLowerCase();
  const usesExternalProxy = captureMode === 'external-proxy';
  if (!usesExternalProxy) {
    return {
      profile,
      captureProxy: null,
      usesExternalProxy,
      appLabOwnedProxy: false,
    };
  }

  if (hasExplicitProxy(profile)) {
    return {
      profile,
      captureProxy: null,
      usesExternalProxy,
      appLabOwnedProxy: false,
    };
  }

  if (input.allowAppLabOwnedProxy === false) {
    throw new Error('App Lab proxy emergency lock is enabled. Unlock it in Settings or provide an explicit external proxy host/port.');
  }

  const proxy = await startLocalCaptureProxy({
    sessionId: input.sessionId,
    platform: input.platform,
    deviceId: input.deviceId,
  });
  proxy.configureLifecycle(input.lifecycle || null);
  profile.proxy = {
    host: proxy.host,
    port: proxy.port,
    protocol: 'http',
  };

  return {
    profile,
    captureProxy: proxy.publicState(),
    usesExternalProxy,
    appLabOwnedProxy: true,
  };
}

export async function stopLocalCaptureProxy(sessionId: string): Promise<{
  captureProxy: LocalCaptureProxyState | null;
  trace: TracePayload | null;
}> {
  const proxy = activeProxies.get(sessionId) || null;
  if (!proxy) {
    return {
      captureProxy: null,
      trace: null,
    };
  }

  activeProxies.delete(sessionId);
  await proxy.stop();

  return {
    captureProxy: proxy.publicState({ active: false }),
    trace: proxy.snapshotTrace(),
  };
}

export function listLocalCaptureProxyStates(): LocalCaptureProxyState[] {
  return [...activeProxies.values()].map((proxy) => proxy.publicState());
}

export async function finalizeAllLocalCaptureProxySessions(input: {
  reason?: string;
} = {}): Promise<{
  total: number;
  finalized: number;
  results: Array<{
    sessionId: string;
    result: LocalCaptureProxyFinalizationResult;
  }>;
}> {
  const proxies = [...activeProxies.values()];
  const reason = normalizeOptionalString(input.reason) || 'manual-emergency-stop';
  const results = await Promise.all(
    proxies.map(async (proxy) => {
      try {
        return {
          sessionId: proxy.sessionId,
          result: await proxy.finalizeWithReason(reason),
        };
      } catch (error) {
        return {
          sessionId: proxy.sessionId,
          result: {
            captureProxy: proxy.publicState({ active: false }),
            traceAttached: false,
            cleanupSessionId: null,
            clearResult: null,
            clearedAt: null,
            finishResult: null,
            errors: [safeErrorMessage(error)],
          } satisfies LocalCaptureProxyFinalizationResult,
        };
      }
    })
  );
  return {
    total: proxies.length,
    finalized: results.length,
    results,
  };
}

export async function finalizeLocalCaptureProxySession(input: {
  sourceSessionId: string;
  executor?: ESVPExecutor | string | null;
  deviceId?: string | null;
  serverUrl?: string;
  captureLogcat?: boolean;
  clearNetwork?: boolean;
  cleanupMeta?: Record<string, unknown>;
}): Promise<LocalCaptureProxyFinalizationResult> {
  const existing = finalizationsInFlight.get(input.sourceSessionId);
  if (existing) return existing;

  const promise = finalizeLocalCaptureProxySessionInternal(input).finally(() => {
    finalizationsInFlight.delete(input.sourceSessionId);
  });
  finalizationsInFlight.set(input.sourceSessionId, promise);
  return promise;
}

async function finalizeLocalCaptureProxySessionInternal(input: {
  sourceSessionId: string;
  executor?: ESVPExecutor | string | null;
  deviceId?: string | null;
  serverUrl?: string;
  captureLogcat?: boolean;
  clearNetwork?: boolean;
  cleanupMeta?: Record<string, unknown>;
}): Promise<LocalCaptureProxyFinalizationResult> {
  const errors: string[] = [];
  let clearResult: Record<string, unknown> | null = null;
  let cleanupSessionId: string | null = null;
  let clearedAt: string | null = null;

  if (input.clearNetwork !== false) {
    try {
      clearResult = await clearESVPNetwork(input.sourceSessionId, input.serverUrl);
      clearedAt = new Date().toISOString();
    } catch (error) {
      errors.push(safeErrorMessage(error));
      const cleanup = await runFallbackNetworkCleanupSession({
        executor: input.executor,
        deviceId: input.deviceId,
        sourceSessionId: input.sourceSessionId,
        serverUrl: input.serverUrl,
        cleanupMeta: input.cleanupMeta,
      });
      cleanupSessionId = cleanup.cleanupSessionId;
      if (cleanup.clearResult) {
        clearResult = cleanup.clearResult;
        clearedAt = new Date().toISOString();
        errors.length = 0;
      }
      if (cleanup.errors.length > 0) {
        errors.splice(0, errors.length, ...cleanup.errors);
      }
    }
  }

  const stopped = await stopLocalCaptureProxy(input.sourceSessionId).catch((error) => {
    errors.push(safeErrorMessage(error));
    return {
      captureProxy: null,
      trace: null,
    };
  });

  let traceAttached = false;
  if (stopped.trace) {
    try {
      await attachESVPNetworkTrace(input.sourceSessionId, stopped.trace, input.serverUrl);
      traceAttached = true;
    } catch (error) {
      errors.push(safeErrorMessage(error));
    }
  }

  const finishResult = await finishESVPSession(
    input.sourceSessionId,
    {
      captureLogcat: input.captureLogcat,
    },
    input.serverUrl
  ).catch((error) => {
    errors.push(safeErrorMessage(error));
    return null;
  });

  return {
    captureProxy: stopped.captureProxy,
    traceAttached,
    cleanupSessionId,
    clearResult,
    clearedAt,
    finishResult: isObjectRecord(finishResult) ? finishResult : null,
    errors,
  };
}

function cloneProfile(profile: ProxyProfile): ProxyProfile {
  if (!profile || typeof profile !== 'object') return profile;
  return JSON.parse(JSON.stringify(profile));
}

function hasExplicitProxy(profile: Record<string, unknown>): boolean {
  const proxy = profile.proxy;
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) return false;
  const normalizedProxy = proxy as Record<string, unknown>;
  const host = typeof normalizedProxy.host === 'string' ? normalizedProxy.host.trim() : '';
  const port = Number(normalizedProxy.port);
  return Boolean(host) && Number.isFinite(port) && port > 0;
}

async function startLocalCaptureProxy(input: {
  sessionId: string;
  platform?: MobilePlatform | string | null;
  deviceId?: string | null;
}): Promise<AppLabCaptureProxy> {
  const existing = activeProxies.get(input.sessionId);
  if (existing) return existing;

  const advertiseHost = resolveAdvertiseHost(input);
  const bindHost = resolveBindHost(advertiseHost);
  const proxy = new AppLabCaptureProxy({
    sessionId: input.sessionId,
    bindHost,
    advertiseHost,
  });
  await proxy.start();
  activeProxies.set(input.sessionId, proxy);
  registerCleanup();
  return proxy;
}

function resolveAdvertiseHost(input: {
  platform?: MobilePlatform | string | null;
  deviceId?: string | null;
}): string {
  const explicit = normalizeOptionalString(process.env.DISCOVERYLAB_NETWORK_PROXY_HOST);
  if (explicit) return explicit;

  const platform = String(input.platform || '').trim().toLowerCase();
  if (platform === 'ios') return '127.0.0.1';

  if (platform === 'android') {
    const deviceId = String(input.deviceId || '').trim();
    if (deviceId.startsWith('emulator-')) return '10.0.2.2';
    return inferLanIpAddress() || '127.0.0.1';
  }

  return '127.0.0.1';
}

function resolveBindHost(advertiseHost: string): string {
  const explicit = normalizeOptionalString(process.env.DISCOVERYLAB_NETWORK_PROXY_BIND_HOST);
  if (explicit) return explicit;
  if (advertiseHost === '127.0.0.1' || advertiseHost === '10.0.2.2') return '127.0.0.1';
  return '0.0.0.0';
}

function inferLanIpAddress(): string | null {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      if (entry.family === 'IPv4') return entry.address;
    }
  }
  return null;
}

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = async () => {
    const proxies = [...activeProxies.values()];
    await Promise.allSettled(proxies.map((proxy) => proxy.finalizeOnProcessExit()));
    activeProxies.clear();
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
}

class AppLabCaptureProxy {
  private readonly id: string;
  readonly sessionId: string;
  readonly bindHost: string;
  readonly host: string;
  private readonly entries: Array<Record<string, unknown>> = [];
  private readonly maxBodyCaptureBytes: number;
  private server: http.Server | null = null;
  private startedAt: string | null = null;
  port: number | null = null;
  private sequence = 0;
  private lifecycle: LocalCaptureProxyLifecycleConfig | null = null;
  private autoFinalizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: { sessionId: string; bindHost: string; advertiseHost: string; maxBodyCaptureBytes?: number }) {
    this.id = `appproxy-${Math.random().toString(36).slice(2, 10)}`;
    this.sessionId = String(input.sessionId);
    this.bindHost = String(input.bindHost || '127.0.0.1');
    this.host = String(input.advertiseHost || this.bindHost);
    this.maxBodyCaptureBytes = clampInt(input.maxBodyCaptureBytes, 2048, 131072, 16384);
  }

  configureLifecycle(config: LocalCaptureProxyLifecycleConfig | null) {
    if (!config) return;
    this.lifecycle = {
      ...this.lifecycle,
      ...config,
      maxDurationMs: config.maxDurationMs ?? this.lifecycle?.maxDurationMs ?? readProxyMaxDurationMs(),
    };
    this.scheduleAutoFinalize();
  }

  publicState(options: { active?: boolean } = {}): LocalCaptureProxyState {
    return {
      id: this.id,
      sessionId: this.sessionId,
      active: options.active === false ? false : Boolean(this.server),
      bindHost: this.bindHost,
      host: this.host,
      port: this.port,
      url: this.port ? `http://${this.host}:${this.port}` : null,
      startedAt: this.startedAt,
      entryCount: this.entries.length,
      captureMode: 'external-proxy',
      source: 'applab-external-proxy',
    };
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer();
    this.server.on('request', (req, res) => {
      this.handleHttpRequest(req, res).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        res.end(`AppLab proxy error: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    this.server.on('connect', (req, clientSocket, head) => {
      this.handleConnectRequest(req, clientSocket as net.Socket, head).catch(() => {
        try {
          clientSocket.destroy();
        } catch {
          // ignore
        }
      });
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => {
        this.server?.off('listening', onListening);
        rejectListen(error);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolveListen();
      };
      this.server?.once('error', onError);
      this.server?.once('listening', onListening);
      this.server?.listen(0, this.bindHost);
    });

    const address = this.server.address();
    this.port = address && typeof address === 'object' && 'port' in address ? Number(address.port) : null;
    this.startedAt = new Date().toISOString();
    this.scheduleAutoFinalize();
  }

  async stop(): Promise<void> {
    this.clearAutoFinalizeTimer();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  }

  snapshotTrace(): TracePayload | null {
    if (this.entries.length === 0) return null;
    return {
      trace_kind: 'http_trace',
      label: 'applab-external-proxy',
      format: 'json',
      source: 'applab-external-proxy',
      payload: {
        session_id: this.sessionId,
        proxy_id: this.id,
        generated_at: new Date().toISOString(),
        entries: this.entries.map((entry) => JSON.parse(JSON.stringify(entry))),
      },
      artifactMeta: {
        capture_mode: 'external-proxy',
        proxy_id: this.id,
        entry_count: this.entries.length,
      },
    };
  }

  async finalizeOnProcessExit(): Promise<void> {
    await this.finalizeWithReason('process-exit').catch(() => null);
  }

  private clearAutoFinalizeTimer() {
    if (!this.autoFinalizeTimer) return;
    clearTimeout(this.autoFinalizeTimer);
    this.autoFinalizeTimer = null;
  }

  private scheduleAutoFinalize() {
    this.clearAutoFinalizeTimer();
    if (!this.server) return;
    const durationMs = this.lifecycle?.maxDurationMs ?? readProxyMaxDurationMs();
    if (!durationMs || durationMs <= 0) return;
    this.autoFinalizeTimer = setTimeout(() => {
      this.autoFinalizeTimer = null;
      void this.finalizeWithReason('max-duration-timeout').catch(() => null);
    }, durationMs);
    this.autoFinalizeTimer.unref?.();
  }

  async finalizeWithReason(reason: string): Promise<LocalCaptureProxyFinalizationResult> {
    if (this.lifecycle) {
      return finalizeLocalCaptureProxySession({
        sourceSessionId: this.sessionId,
        executor: this.lifecycle.executor,
        deviceId: this.lifecycle.deviceId,
        serverUrl: this.lifecycle.serverUrl,
        captureLogcat: this.lifecycle.captureLogcat,
        clearNetwork: true,
        cleanupMeta: {
          ...(this.lifecycle.cleanupMeta || {}),
          finalize_reason: reason,
        },
      });
    }

    const stopped = await stopLocalCaptureProxy(this.sessionId);
    return {
      captureProxy: stopped.captureProxy,
      traceAttached: false,
      cleanupSessionId: null,
      clearResult: null,
      clearedAt: null,
      finishResult: null,
      errors: [],
    };
  }

  private createBaseEntry(input: { kind: string; method: string; url: string; resourceType: string }): Record<string, unknown> {
    this.sequence += 1;
    return {
      id: `${this.id}-${String(this.sequence).padStart(4, '0')}`,
      kind: input.kind,
      resourceType: input.resourceType,
      method: String(input.method || 'GET').toUpperCase(),
      url: input.url,
      startedAt: Date.now(),
      sessionId: this.sessionId,
      proxyId: this.id,
    };
  }

  private async handleHttpRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): Promise<void> {
    const url = inferProxyRequestUrl(clientReq);
    const targetUrl = new URL(url);
    const transport = targetUrl.protocol === 'https:' ? https : http;
    const entry = this.createBaseEntry({
      kind: 'request',
      method: clientReq.method || 'GET',
      url,
      resourceType: targetUrl.protocol === 'https:' ? 'https_request' : 'http_request',
    });

    await new Promise<void>((resolveRequest) => {
      const requestCapture = createBodyCapture(this.maxBodyCaptureBytes);
      let requestBytes = 0;
      let finalized = false;
      const finalize = (error?: unknown) => {
        if (finalized) return;
        finalized = true;
        if (error) {
          (entry as Record<string, unknown>).failureText = error instanceof Error ? error.message : String(error);
          (entry as Record<string, unknown>).response = {
            error: (entry as Record<string, unknown>).failureText,
          };
        }
        if (!(entry as Record<string, unknown>).finishedAt) {
          (entry as Record<string, unknown>).finishedAt = Date.now();
          (entry as Record<string, unknown>).durationMs = Math.max(
            0,
            Number((entry as Record<string, unknown>).finishedAt) - Number((entry as Record<string, unknown>).startedAt)
          );
        }
        this.entries.push(entry);
        resolveRequest();
      };

      (entry as Record<string, unknown>).request = {
        url,
        method: String(clientReq.method || 'GET').toUpperCase(),
        headers: redactHeaders(clientReq.headers),
        startedAt: entry.startedAt,
        bodyPreview: null,
        bodyBytes: 0,
      };

      const upstreamReq = transport.request(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80)),
          method: String(clientReq.method || 'GET').toUpperCase(),
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers: filterHopByHopHeaders(clientReq.headers),
        },
        (upstreamRes) => {
          const responseCapture = createBodyCapture(this.maxBodyCaptureBytes);
          let responseBytes = 0;

          clientRes.writeHead(upstreamRes.statusCode || 502, filterHopByHopHeaders(upstreamRes.headers));
          upstreamRes.on('data', (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            responseBytes += buffer.length;
            responseCapture.add(buffer);
            clientRes.write(buffer);
          });
          upstreamRes.on('end', () => {
            (entry as Record<string, unknown>).status = upstreamRes.statusCode || null;
            (entry as Record<string, unknown>).ok = typeof upstreamRes.statusCode === 'number' ? upstreamRes.statusCode < 400 : null;
            (entry as Record<string, unknown>).response = {
              status: upstreamRes.statusCode || null,
              headers: redactHeaders(upstreamRes.headers),
              durationMs: Math.max(0, Date.now() - Number(entry.startedAt)),
              size: responseBytes,
              contentType: headerValue(upstreamRes.headers['content-type']),
              bodyPreview: responseCapture.preview(),
            };
            clientRes.end();
            finalize();
          });
          upstreamRes.on('error', (error) => {
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            }
            clientRes.end(`AppLab upstream error: ${error instanceof Error ? error.message : String(error)}`);
            finalize(error);
          });
        }
      );

      upstreamReq.on('error', (error) => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        clientRes.end(`AppLab upstream error: ${error instanceof Error ? error.message : String(error)}`);
        finalize(error);
      });

      clientReq.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        requestBytes += buffer.length;
        requestCapture.add(buffer);
        upstreamReq.write(buffer);
      });
      clientReq.on('end', () => {
        (entry as Record<string, unknown>).request = {
          ...(entry.request as Record<string, unknown>),
          bodyPreview: requestCapture.preview(),
          bodyBytes: requestBytes,
        };
        upstreamReq.end();
      });
      clientReq.on('error', (error) => {
        upstreamReq.destroy(error);
        finalize(error);
      });
    });
  }

  private async handleConnectRequest(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> {
    const authority = String(req.url || '').trim();
    const [hostname, portRaw] = authority.split(':');
    const port = clampInt(portRaw, 1, 65535, 443);
    const entry = this.createBaseEntry({
      kind: 'connect',
      method: 'CONNECT',
      url: `https://${authority}`,
      resourceType: 'connect_tunnel',
    });
    (entry as Record<string, unknown>).request = {
      url: `https://${authority}`,
      method: 'CONNECT',
      headers: redactHeaders(req.headers),
      startedAt: entry.startedAt,
    };

    const upstreamSocket = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      (entry as Record<string, unknown>).status = 200;
      (entry as Record<string, unknown>).ok = true;
      (entry as Record<string, unknown>).response = {
        status: 200,
      };
    });

    let finalized = false;
    const finalize = (error?: unknown) => {
      if (finalized) return;
      finalized = true;
      (entry as Record<string, unknown>).finishedAt = Date.now();
      (entry as Record<string, unknown>).durationMs = Math.max(
        0,
        Number((entry as Record<string, unknown>).finishedAt) - Number((entry as Record<string, unknown>).startedAt)
      );
      if (error) {
        (entry as Record<string, unknown>).failureText = error instanceof Error ? error.message : String(error);
        (entry as Record<string, unknown>).response = {
          ...((entry.response as Record<string, unknown> | undefined) || {}),
          error: (entry as Record<string, unknown>).failureText,
        };
      }
      this.entries.push(entry);
    };

    upstreamSocket.on('error', (error) => {
      finalize(error);
      try {
        clientSocket.destroy();
      } catch {
        // ignore
      }
    });
    clientSocket.on('error', (error) => finalize(error));
    upstreamSocket.on('close', () => finalize());
    clientSocket.on('close', () => finalize());
  }
}

function createBodyCapture(limitBytes: number) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  return {
    add(buffer: Buffer) {
      totalBytes += buffer.length;
      const remaining = limitBytes - chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (remaining <= 0) return;
      chunks.push(buffer.subarray(0, Math.min(buffer.length, remaining)));
    },
    preview() {
      if (chunks.length === 0) return null;
      return Buffer.concat(chunks).toString('utf8').slice(0, 1024);
    },
    totalBytes() {
      return totalBytes;
    },
  };
}

function inferProxyRequestUrl(req: http.IncomingMessage): string {
  const raw = String(req.url || '');
  if (/^https?:\/\//i.test(raw)) return raw;
  const host = headerValue(req.headers.host) || '127.0.0.1';
  return `http://${host}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function filterHopByHopHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase();
    if (
      lower === 'proxy-connection' ||
      lower === 'connection' ||
      lower === 'keep-alive' ||
      lower === 'transfer-encoding' ||
      lower === 'te' ||
      lower === 'trailer' ||
      lower === 'upgrade' ||
      lower === 'proxy-authorization'
    ) {
      continue;
    }
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function redactHeaders(headers: http.IncomingHttpHeaders): Record<string, string | null> {
  const output: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase();
    if (lower === 'authorization' || lower === 'proxy-authorization' || lower === 'cookie' || lower === 'set-cookie') {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = Array.isArray(value) ? value.join(', ') : value != null ? String(value) : null;
  }
  return output;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] || null;
  return value != null ? String(value) : null;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function readProxyMaxDurationMs(): number | null {
  const raw = normalizeOptionalString(process.env.DISCOVERYLAB_NETWORK_PROXY_MAX_DURATION_MS);
  if (raw == null) return 15 * 60 * 1000;
  const durationMs = Number(raw);
  if (!Number.isFinite(durationMs)) return 15 * 60 * 1000;
  if (durationMs <= 0) return null;
  return clampInt(durationMs, 30000, 24 * 60 * 60 * 1000, 15 * 60 * 1000);
}

async function runFallbackNetworkCleanupSession(input: {
  executor?: ESVPExecutor | string | null;
  deviceId?: string | null;
  sourceSessionId: string;
  serverUrl?: string;
  cleanupMeta?: Record<string, unknown>;
}): Promise<{
  cleanupSessionId: string | null;
  clearResult: Record<string, unknown> | null;
  errors: string[];
}> {
  const errors: string[] = [];
  const deviceId = normalizeOptionalString(input.deviceId);
  const executor = normalizeOptionalExecutor(input.executor);
  if (!deviceId || !executor) {
    return {
      cleanupSessionId: null,
      clearResult: null,
      errors,
    };
  }

  let cleanupSessionId: string | null = null;
  try {
    const created = await createESVPSession(
      {
        executor,
        deviceId,
        meta: {
          source: 'applab-discovery-network-cleanup',
          cleanup_for_session_id: input.sourceSessionId,
          ...(input.cleanupMeta || {}),
        },
      },
      input.serverUrl
    );
    cleanupSessionId = normalizeOptionalString(created?.session?.id || created?.id);
    if (!cleanupSessionId) {
      throw new Error('Failed to create a cleanup ESVP session.');
    }

    const cleared = await clearESVPNetwork(cleanupSessionId, input.serverUrl);
    await finishESVPSession(cleanupSessionId, { captureLogcat: false }, input.serverUrl).catch(() => null);
    return {
      cleanupSessionId,
      clearResult: isObjectRecord(cleared) ? cleared : null,
      errors,
    };
  } catch (error) {
    errors.push(safeErrorMessage(error));
    if (cleanupSessionId) {
      await finishESVPSession(cleanupSessionId, { captureLogcat: false }, input.serverUrl).catch(() => null);
    }
    return {
      cleanupSessionId,
      clearResult: null,
      errors,
    };
  }
}

function normalizeOptionalExecutor(value: unknown): ESVPExecutor | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  if (normalized === 'adb' || normalized === 'ios-sim' || normalized === 'maestro-ios' || normalized === 'fake') {
    return normalized;
  }
  return null;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
