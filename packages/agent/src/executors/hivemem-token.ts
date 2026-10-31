import { readFile } from 'node:fs/promises';

export type HiveMemTokenStatus = 'missing' | 'valid' | 'expiring' | 'expired' | 'rejected' | 'unreachable' | 'unknown';

export interface HiveMemTokenPosture {
  status: HiveMemTokenStatus;
  expiresAt: string | null;
  checkedAt: string;
}

const EXPIRING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function tokenFromEnv(contents: string): string | null {
  const line = contents.split(/\r?\n/).find((entry) => entry.startsWith('HERMES_HIVEMEM_TOKEN='));
  if (!line) return null;
  const value = line.slice('HERMES_HIVEMEM_TOKEN='.length).trim();
  return value.replace(/^(['"])(.*)\1$/, '$2') || null;
}

function expiryFromJwt(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    const timestamp = payload.exp * 1000;
    return Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8.64e15
      ? new Date(timestamp).toISOString() : null;
  } catch {
    return null;
  }
}

export async function inspectHiveMemToken(envPath: string, apiUrl: string | null): Promise<HiveMemTokenPosture> {
  const checkedAt = new Date().toISOString();
  let token: string | null;
  try {
    token = tokenFromEnv(await readFile(envPath, 'utf8'));
  } catch {
    token = null;
  }
  if (!token) return { status: 'missing', expiresAt: null, checkedAt };
  const expiresAt = expiryFromJwt(token);
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(checkedAt)) return { status: 'expired', expiresAt, checkedAt };
  if (!apiUrl) return { status: 'unknown', expiresAt, checkedAt };
  try {
    const url = new URL('/v1/auth/me', apiUrl);
    if (!['https:', 'http:'].includes(url.protocol)) return { status: 'unknown', expiresAt, checkedAt };
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403) return { status: 'rejected', expiresAt, checkedAt };
    if (!response.ok) return { status: 'unreachable', expiresAt, checkedAt };
    return {
      status: expiresAt && Date.parse(expiresAt) - Date.parse(checkedAt) <= EXPIRING_WINDOW_MS ? 'expiring' : 'valid',
      expiresAt,
      checkedAt,
    };
  } catch {
    return { status: 'unreachable', expiresAt, checkedAt };
  }
}
