import type { Page, Request } from 'playwright';

export const PLAYWRIGHT_NETWORK_RESOURCE_TYPES = ['document', 'xhr', 'fetch', 'websocket'] as const;
const DEFAULT_MAX_NETWORK_ENTRIES = 1200;

export interface CapturedNetworkEntry {
  id: string;
  url: string;
  origin: string;
  hostname: string;
  pathname: string;
  routeKey: string;
  method: string;
  resourceType: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  status: number | null;
  ok: boolean | null;
  queryKeys: string[];
  requestContentType: string | null;
  responseContentType: string | null;
  responseSize: number | null;
  failureText: string | null;
  requestHeaders?: Record<string, string> | null;
  responseHeaders?: Record<string, string> | null;
  requestBodyPreview?: string | null;
  responseBodyPreview?: string | null;
  requestBodyBytes?: number | null;
  responseBodyBytes?: number | null;
}

export interface NetworkCaptureMeta {
  truncated: boolean;
  maxEntries: number;
  resourceTypes: string[];
}

export interface PlaywrightNetworkCaptureHandle {
  entries: CapturedNetworkEntry[];
  meta: NetworkCaptureMeta;
  detach: () => void;
}

function parseRequestUrl(rawUrl: string): {
  url: string;
  origin: string;
  hostname: string;
  pathname: string;
  routeKey: string;
  queryKeys: string[];
} {
  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname || '/';
    const queryKeys = Array.from(new Set(Array.from(parsed.searchParams.keys()).filter(Boolean))).sort();
    return {
      url: `${parsed.origin}${pathname}`,
      origin: parsed.origin,
      hostname: parsed.hostname,
      pathname,
      routeKey: `${parsed.hostname}${pathname}`,
      queryKeys,
    };
  } catch {
    return {
      url: rawUrl,
      origin: '',
      hostname: '',
      pathname: '/',
      routeKey: rawUrl,
      queryKeys: [],
    };
  }
}

function shouldCaptureRequest(request: Request, resourceTypes: Set<string>): boolean {
  const url = request.url();
  if (!/^https?:/i.test(url)) return false;
  return resourceTypes.has(request.resourceType());
}

function parseContentLength(headers: Record<string, string>): number | null {
  const raw = headers['content-length'];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function attachPlaywrightNetworkCapture(
  page: Page,
  options?: {
    entries?: CapturedNetworkEntry[];
    meta?: Partial<NetworkCaptureMeta>;
    maxEntries?: number;
    onEntry?: (entry: CapturedNetworkEntry) => void;
    onUpdate?: (entry: CapturedNetworkEntry) => void;
  }
): PlaywrightNetworkCaptureHandle {
  const entries = options?.entries ?? [];
  const configuredTypes = Array.isArray(options?.meta?.resourceTypes) && options?.meta?.resourceTypes.length > 0
    ? options.meta.resourceTypes
    : [...PLAYWRIGHT_NETWORK_RESOURCE_TYPES];
  const resourceTypes = new Set(configuredTypes);
  const maxEntries = options?.maxEntries ?? options?.meta?.maxEntries ?? DEFAULT_MAX_NETWORK_ENTRIES;
  const meta: NetworkCaptureMeta = {
    truncated: options?.meta?.truncated === true,
    maxEntries,
    resourceTypes: [...configuredTypes],
  };

  let sequence = entries.length;
  const pendingRequests = new WeakMap<Request, CapturedNetworkEntry>();

  const createEntry = (request: Request): CapturedNetworkEntry => {
    const parsedUrl = parseRequestUrl(request.url());
    const requestHeaders = request.headers();
    sequence += 1;

    return {
      id: `net_${sequence.toString().padStart(4, '0')}`,
      url: parsedUrl.url,
      origin: parsedUrl.origin,
      hostname: parsedUrl.hostname,
      pathname: parsedUrl.pathname,
      routeKey: parsedUrl.routeKey,
      method: request.method(),
      resourceType: request.resourceType(),
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      status: null,
      ok: null,
      queryKeys: parsedUrl.queryKeys,
      requestContentType: requestHeaders['content-type'] || null,
      responseContentType: null,
      responseSize: null,
      failureText: null,
    };
  };

  const finalizeEntry = async (
    request: Request,
    overrides?: {
      failureText?: string | null;
      ok?: boolean | null;
      status?: number | null;
    }
  ): Promise<void> => {
    const entry = pendingRequests.get(request);
    if (!entry || entry.finishedAt) return;

    const finishedAt = Date.now();
    entry.finishedAt = finishedAt;
    entry.durationMs = Math.max(finishedAt - entry.startedAt, 0);

    let responseHeaders: Record<string, string> | null = null;
    try {
      const response = await request.response();
      if (response) {
        responseHeaders = response.headers();
        entry.status = response.status();
        entry.ok = response.ok();
      }
    } catch {
      responseHeaders = null;
    }

    if (overrides?.status !== undefined && entry.status === null) {
      entry.status = overrides.status;
    }
    if (overrides?.ok !== undefined && entry.ok === null) {
      entry.ok = overrides.ok;
    }
    if (overrides?.failureText !== undefined) {
      entry.failureText = overrides.failureText;
    }

    if (responseHeaders) {
      entry.responseContentType = responseHeaders['content-type'] || null;
      entry.responseSize = parseContentLength(responseHeaders);
    }

    options?.onUpdate?.(entry);
  };

  const onRequest = (request: Request): void => {
    if (!shouldCaptureRequest(request, resourceTypes)) return;
    if (entries.length >= maxEntries) {
      meta.truncated = true;
      return;
    }

    const entry = createEntry(request);
    entries.push(entry);
    pendingRequests.set(request, entry);
    options?.onEntry?.(entry);
  };

  const onRequestFinished = (request: Request): void => {
    void finalizeEntry(request);
  };

  const onRequestFailed = (request: Request): void => {
    const failureText = request.failure()?.errorText || 'Request failed';
    void finalizeEntry(request, {
      failureText,
      ok: false,
    });
  };

  page.on('request', onRequest);
  page.on('requestfinished', onRequestFinished);
  page.on('requestfailed', onRequestFailed);

  return {
    entries,
    meta,
    detach: () => {
      page.off('request', onRequest);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFailed);
    },
  };
}
