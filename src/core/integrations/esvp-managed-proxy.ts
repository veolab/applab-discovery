import http from 'node:http';
import net from 'node:net';

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export type ManagedProxyPublicState = {
  id: string;
  active: boolean;
  bind_host: string;
  host: string;
  port: number | null;
  url: string | null;
  started_at: string | null;
  entry_count: number;
  capture_mode: 'esvp-managed-proxy';
};

type ManagedProxyTrace = {
  trace_kind: 'http_trace';
  label: string;
  format: 'json';
  source: 'esvp-managed-proxy';
  payload: {
    session_id: string;
    proxy_id: string;
    generated_at: string;
    entries: Array<Record<string, unknown>>;
  };
  artifactMeta: {
    capture_mode: 'esvp-managed-proxy';
    proxy_id: string;
    entry_count: number;
  };
};

export class ESVPManagedProxyManager {
  private readonly bindHost: string;
  private readonly defaultAdvertiseHost: string | null;
  private readonly proxies = new Map<string, ManagedSessionProxy>();
  private readonly defaultBodyCaptureBytes: number;

  constructor(options: {
    bindHost?: string;
    advertiseHost?: string | null;
    maxBodyCaptureBytes?: number;
  } = {}) {
    this.bindHost = String(options.bindHost || '127.0.0.1');
    this.defaultAdvertiseHost = normalizeOptionalString(options.advertiseHost);
    this.defaultBodyCaptureBytes = clampInt(options.maxBodyCaptureBytes, 2048, 131072, 16384);
  }

  shouldManageProfile(profile: Record<string, any> = {}): boolean {
    const captureMode = String(profile.capture?.mode || '').trim().toLowerCase();
    return (
      captureMode === 'esvp-managed-proxy' ||
      captureMode === 'esvp-proxy' ||
      ((profile.capture?.enabled === true || hasAdvancedFaults(profile)) && !hasExplicitProxy(profile))
    );
  }

  async configureSessionProxy(input: {
    sessionId: string;
    session: { context?: { deviceId?: string | null } | null };
    profile?: Record<string, any>;
  }): Promise<{
    managed: boolean;
    proxy: ManagedProxyPublicState;
    capabilities: Record<string, unknown>;
    effectiveProfile: Record<string, unknown>;
  }> {
    const existing = this.proxies.get(input.sessionId) || null;
    if (existing) {
      existing.profile = input.profile || {};
      return {
        managed: true,
        proxy: existing.publicState(),
        capabilities: managedProxyCapabilities(),
        effectiveProfile: {
          ...(input.profile || {}),
          proxy: {
            ...normalizeProxyShape(input.profile?.proxy),
            host: existing.advertiseHost,
            port: existing.port,
            protocol: 'http',
          },
          capture: {
            ...(input.profile?.capture || {}),
            enabled: true,
            mode: 'esvp-managed-proxy',
          },
        },
      };
    }

    const proxy = new ManagedSessionProxy({
      sessionId: input.sessionId,
      profile: input.profile || {},
      bindHost: normalizeOptionalString(input.profile?.proxy?.bind_host) || this.bindHost,
      advertiseHost:
        normalizeOptionalString(input.profile?.proxy?.advertise_host) ||
        inferAdvertiseHost(input.profile, input.session) ||
        this.defaultAdvertiseHost ||
        inferSessionAdvertiseHost(input.session) ||
        '127.0.0.1',
      maxBodyCaptureBytes: this.defaultBodyCaptureBytes,
    });
    await proxy.start();
    this.proxies.set(input.sessionId, proxy);

    return {
      managed: true,
      proxy: proxy.publicState(),
      capabilities: managedProxyCapabilities(),
      effectiveProfile: {
        ...(input.profile || {}),
        proxy: {
          ...normalizeProxyShape(input.profile?.proxy),
          host: proxy.advertiseHost,
          port: proxy.port,
          protocol: 'http',
        },
        capture: {
          ...(input.profile?.capture || {}),
          enabled: true,
          mode: 'esvp-managed-proxy',
        },
      },
    };
  }

  getSessionProxy(sessionId: string): ManagedProxyPublicState | null {
    return this.proxies.get(sessionId)?.publicState() || null;
  }

  async releaseSessionProxy(sessionId: string, options: { reason?: string } = {}): Promise<{
    managed: boolean;
    traces: ManagedProxyTrace[];
    proxy: ManagedProxyPublicState | null;
  }> {
    const proxy = this.proxies.get(sessionId);
    if (!proxy) {
      return {
        managed: false,
        traces: [],
        proxy: null,
      };
    }

    this.proxies.delete(sessionId);
    const traces = proxy.snapshotTraceEntries({
      reason: options.reason || 'released',
    });
    await proxy.stop();
    return {
      managed: true,
      traces,
      proxy: proxy.publicState({ active: false }),
    };
  }
}

class ManagedSessionProxy {
  readonly id = randomId('proxy');
  readonly sessionId: string;
  profile: Record<string, any>;
  readonly bindHost: string;
  readonly advertiseHost: string;
  readonly maxBodyCaptureBytes: number;
  readonly entries: Array<Record<string, any>> = [];
  server: http.Server | null = null;
  startedAt: string | null = null;
  port: number | null = null;
  private seq = 0;

  constructor(options: {
    sessionId: string;
    profile?: Record<string, any>;
    bindHost?: string;
    advertiseHost?: string;
    maxBodyCaptureBytes?: number;
  }) {
    this.sessionId = String(options.sessionId);
    this.profile = options.profile || {};
    this.bindHost = String(options.bindHost || '127.0.0.1');
    this.advertiseHost = String(options.advertiseHost || this.bindHost);
    this.maxBodyCaptureBytes = clampInt(options.maxBodyCaptureBytes, 2048, 131072, 16384);
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer();
    this.server.on('request', (req, res) => {
      void this.handleHttpRequest(req, res).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        res.end(`ESVP proxy error: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    this.server.on('connect', (req, clientSocket, head) => {
      void this.handleConnect(req, clientSocket, head).catch(() => {
        try {
          clientSocket.destroy();
        } catch {
          // Ignore socket cleanup failures.
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
    this.port = typeof address === 'object' && address && 'port' in address ? Number(address.port) : null;
    this.startedAt = nowIso();
    this.server.unref();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  }

  publicState(options: { active?: boolean } = {}): ManagedProxyPublicState {
    return {
      id: this.id,
      active: options.active === false ? false : Boolean(this.server),
      bind_host: this.bindHost,
      host: this.advertiseHost,
      port: this.port,
      url: this.port ? `http://${this.advertiseHost}:${this.port}` : null,
      started_at: this.startedAt,
      entry_count: this.entries.length,
      capture_mode: 'esvp-managed-proxy',
    };
  }

  snapshotTraceEntries(options: { reason?: string } = {}): ManagedProxyTrace[] {
    if (!this.entries.length) return [];
    return [
      {
        trace_kind: 'http_trace',
        label: options.reason ? `managed-proxy-${slugify(options.reason)}` : 'managed-proxy',
        format: 'json',
        source: 'esvp-managed-proxy',
        payload: {
          session_id: this.sessionId,
          proxy_id: this.id,
          generated_at: nowIso(),
          entries: this.entries.map((entry) => JSON.parse(JSON.stringify(entry))),
        },
        artifactMeta: {
          capture_mode: 'esvp-managed-proxy',
          proxy_id: this.id,
          entry_count: this.entries.length,
        },
      },
    ];
  }

  private async handleHttpRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): Promise<void> {
    const entry = this.createBaseEntry({
      kind: 'request',
      method: clientReq.method || 'GET',
      url: inferProxyRequestUrl(clientReq),
    });

    const body = await readStreamBuffer(clientReq, this.maxBodyCaptureBytes);
    entry.request = {
      url: entry.url,
      method: entry.method,
      headers: redactHeaders(clientReq.headers),
      startedAt: entry.startedAt,
      bodyPreview: previewBody(body),
      bodyBytes: body.length,
    };

    const fault = await maybeApplyFaults({
      profile: this.profile,
      entry,
      respondHttp: async ({ statusCode, headers, bodyText, delayMs = 0 }) => {
        if (delayMs > 0) await sleep(delayMs);
        clientRes.writeHead(statusCode, headers);
        clientRes.end(bodyText);
      },
      abortHttp: async ({ delayMs = 0, errorText = 'ESVP_PROXY_ABORT' }) => {
        if (delayMs > 0) await sleep(delayMs);
        clientReq.destroy(new Error(errorText));
        clientRes.destroy(new Error(errorText));
      },
    });
    if (fault.handled) {
      entry.finishedAt = Date.now();
      entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);
      this.entries.push(entry);
      return;
    }

    const targetUrl = new URL(entry.url);
    const upstreamReq = http.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        method: entry.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers: filterHopByHopHeaders(clientReq.headers),
      },
      async (upstreamRes) => {
        const responseBody = await readStreamBuffer(upstreamRes, this.maxBodyCaptureBytes);
        entry.status = upstreamRes.statusCode || null;
        entry.ok = typeof upstreamRes.statusCode === 'number' ? upstreamRes.statusCode < 400 : null;
        entry.response = {
          status: upstreamRes.statusCode || null,
          headers: redactHeaders(upstreamRes.headers as http.IncomingHttpHeaders),
          durationMs: Math.max(0, Date.now() - entry.startedAt),
          size: responseBody.length,
          contentType: headerValue(upstreamRes.headers['content-type']),
          bodyPreview: previewBody(responseBody),
        };
        entry.finishedAt = Date.now();
        entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);

        clientRes.writeHead(upstreamRes.statusCode || 502, filterHopByHopHeaders(upstreamRes.headers));
        clientRes.end(responseBody);
        this.entries.push(entry);
      }
    );

    upstreamReq.on('error', (error) => {
      entry.finishedAt = Date.now();
      entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);
      entry.failureText = error instanceof Error ? error.message : String(error);
      entry.response = {
        error: entry.failureText,
      };
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      clientRes.end(`ESVP upstream error: ${entry.failureText}`);
      this.entries.push(entry);
    });

    if (body.length) upstreamReq.write(body);
    upstreamReq.end();
  }

  private async handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> {
    const authority = String(req.url || '');
    const [hostname, portRaw] = authority.split(':');
    const port = Number(portRaw || 443);
    const entry = this.createBaseEntry({
      kind: 'connect',
      method: 'CONNECT',
      url: `https://${authority}`,
    });
    entry.request = {
      url: entry.url,
      method: 'CONNECT',
      headers: redactHeaders(req.headers),
      startedAt: entry.startedAt,
    };

    const fault = await maybeApplyFaults({
      profile: this.profile,
      entry,
      respondConnect: async ({ delayMs = 0, statusCode = 502, message = 'Bad Gateway' }) => {
        if (delayMs > 0) await sleep(delayMs);
        clientSocket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
        clientSocket.destroy();
      },
      abortConnect: async ({ delayMs = 0 }) => {
        if (delayMs > 0) await sleep(delayMs);
        clientSocket.destroy();
      },
    });
    if (fault.handled) {
      entry.finishedAt = Date.now();
      entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);
      this.entries.push(entry);
      return;
    }

    const upstreamSocket = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      entry.status = 200;
      entry.ok = true;
      entry.response = {
        status: 200,
      };
    });

    const finalize = (error: unknown = null) => {
      if (entry.finishedAt) return;
      entry.finishedAt = Date.now();
      entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);
      if (error) {
        entry.failureText = error instanceof Error ? error.message : String(error);
        entry.response = {
          ...(entry.response || {}),
          error: entry.failureText,
        };
      }
      this.entries.push(entry);
    };

    upstreamSocket.on('error', (error) => {
      finalize(error);
      try {
        clientSocket.destroy(error as Error);
      } catch {
        // Ignore socket cleanup failures.
      }
    });
    clientSocket.on('error', (error) => finalize(error));
    upstreamSocket.on('close', () => finalize());
    clientSocket.on('close', () => finalize());
  }

  private createBaseEntry(input: { kind: string; method: string; url: string }): Record<string, any> {
    this.seq += 1;
    return {
      id: `${this.id}-${String(this.seq).padStart(4, '0')}`,
      kind: input.kind,
      resourceType: input.kind === 'connect' ? 'connect_tunnel' : 'request',
      method: String(input.method || 'GET').toUpperCase(),
      url: input.url,
      startedAt: Date.now(),
      sessionId: this.sessionId,
      proxyId: this.id,
    };
  }
}

async function maybeApplyFaults(input: {
  profile: Record<string, any>;
  entry: Record<string, any>;
  respondHttp?: (args: {
    statusCode: number;
    headers: Record<string, string>;
    bodyText: string;
    delayMs?: number;
  }) => Promise<void>;
  abortHttp?: (args: { delayMs?: number; errorText?: string }) => Promise<void>;
  respondConnect?: (args: { delayMs?: number; statusCode?: number; message?: string }) => Promise<void>;
  abortConnect?: (args: { delayMs?: number }) => Promise<void>;
}): Promise<{ handled: boolean }> {
  const faults = input.profile?.faults || {};
  const delayMs = clampInt(faults.delay_ms, 0, 60000, 0);
  if (faults.offline_partial === true && shouldFailOfflinePartial(input.entry)) {
    input.entry.failureText = 'ESVP_PROXY_OFFLINE_PARTIAL';
    if (input.entry.method === 'CONNECT') {
      await input.abortConnect?.({ delayMs });
    } else {
      await input.abortHttp?.({ delayMs, errorText: 'ESVP_PROXY_OFFLINE_PARTIAL' });
    }
    return { handled: true };
  }

  if (faults.timeout === true) {
    input.entry.failureText = 'ESVP_PROXY_TIMEOUT';
    if (input.entry.method === 'CONNECT') {
      await input.abortConnect?.({ delayMs: Math.max(delayMs, 15000) });
    } else {
      await input.abortHttp?.({ delayMs: Math.max(delayMs, 15000), errorText: 'ESVP_PROXY_TIMEOUT' });
    }
    return { handled: true };
  }

  if (input.entry.method !== 'CONNECT' && Number.isFinite(faults.status_code) && faults.status_code > 0) {
    const statusCode = Math.max(100, Math.min(599, Number(faults.status_code)));
    const bodyText =
      faults.body_patch != null
        ? typeof faults.body_patch === 'string'
          ? faults.body_patch
          : JSON.stringify(faults.body_patch, null, 2)
        : '';
    input.entry.status = statusCode;
    input.entry.ok = statusCode < 400;
    input.entry.response = {
      status: statusCode,
      headers: {
        'content-type': typeof faults.body_patch === 'object' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
        'x-esvp-fault': 'status_code',
      },
      durationMs: delayMs,
      size: Buffer.byteLength(bodyText),
      bodyPreview: previewBody(Buffer.from(bodyText, 'utf8')),
    };
    await input.respondHttp?.({
      statusCode,
      delayMs,
      headers: input.entry.response.headers,
      bodyText,
    });
    return { handled: true };
  }

  if (delayMs > 0) {
    await sleep(delayMs);
  }
  return { handled: false };
}

function shouldFailOfflinePartial(entry: Record<string, any>): boolean {
  const idNum = Number(String(entry.id || '').split('-').pop());
  return Number.isFinite(idNum) ? idNum % 2 === 0 : false;
}

function inferProxyRequestUrl(req: http.IncomingMessage): string {
  const raw = String(req.url || '');
  if (/^https?:\/\//i.test(raw)) return raw;
  const host = headerValue(req.headers.host) || '127.0.0.1';
  return `http://${host}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function filterHopByHopHeaders(headers: http.IncomingHttpHeaders = {}): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
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
    result[key] = value;
  }
  return result;
}

function redactHeaders(headers: http.IncomingHttpHeaders = {}): Record<string, string | null> {
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

async function readStreamBuffer(stream: AsyncIterable<any>, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total <= limitBytes) {
      chunks.push(buffer);
    }
  }
  return Buffer.concat(chunks);
}

function previewBody(buffer: Buffer): string | null {
  if (!buffer || buffer.length === 0) return null;
  return buffer.toString('utf8').slice(0, 1024);
}

function hasExplicitProxy(profile: Record<string, any> = {}): boolean {
  return Boolean(profile?.proxy?.host) && Number.isFinite(profile?.proxy?.port) && Number(profile.proxy.port) > 0;
}

function hasAdvancedFaults(profile: Record<string, any> = {}): boolean {
  const faults = profile?.faults || {};
  return Boolean(
    faults.delay_ms != null ||
      faults.timeout === true ||
      faults.offline_partial === true ||
      faults.status_code != null ||
      faults.body_patch != null
  );
}

function normalizeProxyShape(proxy: Record<string, any> | null = null): {
  host: string | null;
  port: number | null;
  protocol: string;
  bypass: string[];
} {
  if (!proxy || typeof proxy !== 'object') {
    return {
      host: null,
      port: null,
      protocol: 'http',
      bypass: [],
    };
  }
  return {
    host: normalizeOptionalString(proxy.host),
    port: Number.isFinite(proxy.port) ? Number(proxy.port) : null,
    protocol: normalizeOptionalString(proxy.protocol) || 'http',
    bypass: Array.isArray(proxy.bypass) ? proxy.bypass.map((value: unknown) => String(value)) : [],
  };
}

function inferAdvertiseHost(profile: Record<string, any> = {}, session?: { context?: { deviceId?: string | null } | null }): string | null {
  return normalizeOptionalString(profile?.proxy?.advertise_host) || inferSessionAdvertiseHost(session);
}

function inferSessionAdvertiseHost(session?: { context?: { deviceId?: string | null } | null }): string | null {
  const deviceId = String(session?.context?.deviceId || '');
  if (deviceId.startsWith('emulator-')) return '10.0.2.2';
  return null;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function slugify(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'trace';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function managedProxyCapabilities(): Record<string, unknown> {
  return {
    proxy: true,
    connectivity: false,
    delay: true,
    loss: false,
    timeout: true,
    offline_partial: true,
    status_code: true,
    body_patch: true,
    trace_attach: true,
    capture: true,
    mode: 'esvp-managed-proxy',
  };
}
