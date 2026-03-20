type MobilePlatform = 'ios' | 'android';

type NetworkProfileInput = {
  enabled?: boolean;
  mode?: string;
  profile?: string;
  label?: string;
  connectivity?: 'online' | 'offline' | 'reset';
  proxy?: Record<string, unknown>;
  capture?: Record<string, unknown>;
  faults?: Record<string, unknown>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeOptionalPort(value: unknown): number | null {
  const port = Number(value);
  if (!Number.isFinite(port) || port <= 0) return null;
  return Math.round(port);
}

function normalizeOptionalBypass(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : null;
}

function readExternalProxyPortFromEnv(): number | null {
  return normalizeOptionalPort(process.env.DISCOVERYLAB_NETWORK_PROXY_PORT);
}

function readExternalProxyHostFromEnv(): string | null {
  return normalizeOptionalString(process.env.DISCOVERYLAB_NETWORK_PROXY_HOST);
}

function readExternalProxyProtocolFromEnv(): string | null {
  return normalizeOptionalString(process.env.DISCOVERYLAB_NETWORK_PROXY_PROTOCOL);
}

function readExternalProxyBypassFromEnv(): string[] | null {
  const raw = normalizeOptionalString(process.env.DISCOVERYLAB_NETWORK_PROXY_BYPASS);
  if (!raw) return null;
  const normalized = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : null;
}

export function normalizeAppLabNetworkMode(mode?: string | null): 'managed-proxy' | 'external-proxy' | 'external-mitm' | 'app-http-trace' {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'managed-proxy') return 'managed-proxy';
  if (normalized === 'external-mitm') return 'external-mitm';
  if (normalized === 'app-http-trace') return 'app-http-trace';
  return 'external-proxy';
}

export function inferAppLabExternalProxyHost(input: {
  platform?: string | null;
  deviceId?: string | null;
  explicitHost?: string | null;
}): string | null {
  const explicitHost = normalizeOptionalString(input.explicitHost);
  if (explicitHost) return explicitHost;

  const envHost = readExternalProxyHostFromEnv();
  if (envHost) return envHost;

  const platform = String(input.platform || '').trim().toLowerCase();
  if (platform === 'ios') return '127.0.0.1';

  if (platform === 'android') {
    const deviceId = String(input.deviceId || '').trim();
    if (deviceId.startsWith('emulator-')) return '10.0.2.2';
  }

  return null;
}

export function resolveAppLabExternalProxy(input: {
  platform?: string | null;
  deviceId?: string | null;
  proxy?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  const explicitProxy = isObject(input.proxy) ? input.proxy : null;
  const host = inferAppLabExternalProxyHost({
    platform: input.platform,
    deviceId: input.deviceId,
    explicitHost: explicitProxy?.host as string | null | undefined,
  });
  const port = normalizeOptionalPort(explicitProxy?.port) || readExternalProxyPortFromEnv();
  if (!host || !port) return null;

  const proxy: Record<string, unknown> = {
    host,
    port,
    protocol: normalizeOptionalString(explicitProxy?.protocol) || readExternalProxyProtocolFromEnv() || 'http',
  };

  const bypass = normalizeOptionalBypass(explicitProxy?.bypass) || readExternalProxyBypassFromEnv();
  if (bypass) proxy.bypass = bypass;

  return proxy;
}

export function buildAppLabNetworkProfile(
  input?: NetworkProfileInput | null,
  context?: { platform?: MobilePlatform | string | null; deviceId?: string | null }
): Record<string, unknown> | null {
  if (!input || input.enabled === false) return null;

  const mode = normalizeAppLabNetworkMode(input.mode);
  const capture = {
    ...(isObject(input.capture) ? input.capture : {}),
    enabled: true,
    mode: mode === 'managed-proxy'
      ? 'esvp-managed-proxy'
      : mode === 'app-http-trace'
        ? 'app-http-trace'
        : 'external-proxy',
    ...(mode === 'external-mitm' ? { applabMode: 'external-mitm' } : {}),
  };

  const profile: Record<string, unknown> = {
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.connectivity ? { connectivity: input.connectivity } : {}),
    ...(isObject(input.faults) ? { faults: input.faults } : {}),
    capture,
  };

  if (mode === 'managed-proxy' || mode === 'app-http-trace') {
    if (isObject(input.proxy)) {
      profile.proxy = input.proxy;
    }
    return profile;
  }

  const resolvedProxy = resolveAppLabExternalProxy({
    platform: context?.platform,
    deviceId: context?.deviceId,
    proxy: isObject(input.proxy) ? input.proxy : null,
  });
  if (resolvedProxy) {
    profile.proxy = resolvedProxy;
  }

  return profile;
}
