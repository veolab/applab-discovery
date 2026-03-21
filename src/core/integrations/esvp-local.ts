import { getAppLabESVPLocalRuntime, LOCAL_ESVP_SERVER_URL } from './esvp-local-runtime.js';

export interface ESVPResolvedConnection {
  mode: 'remote' | 'local';
  serverUrl: string;
}

export async function resolveESVPConnection(serverUrl?: string): Promise<ESVPResolvedConnection> {
  assertLocalOnlyESVPConfig(serverUrl);
  await getAppLabESVPLocalRuntime();
  return {
    mode: 'local',
    serverUrl: LOCAL_ESVP_SERVER_URL,
  };
}

export function assertLocalOnlyESVPConfig(serverUrl?: string): void {
  const explicit = normalizeOptionalUrl(serverUrl);
  if (explicit && explicit !== LOCAL_ESVP_SERVER_URL) {
    throw new Error(
      'App Lab agora embute o runtime ESVP local no próprio processo. Remova o --server/serverUrl informado e use o modo local padrão.'
    );
  }

  const envUrl = normalizeOptionalUrl(process.env.ESVP_BASE_URL);
  if (envUrl && envUrl !== LOCAL_ESVP_SERVER_URL) {
    throw new Error(
      'ESVP_BASE_URL não é mais suportado no App Lab local. Remova essa variável para usar o runtime ESVP embutido.'
    );
  }
}

export async function stopEmbeddedESVPServer(): Promise<void> {
  // No-op for compatibility. The local runtime now lives in-process.
}

function normalizeOptionalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\/+$/, '');
  return normalized || null;
}
