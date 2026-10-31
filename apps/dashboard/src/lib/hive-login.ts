import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Redis } from 'ioredis';
import { getSecretKey } from './auth-constants';
import type { SessionPayload } from './auth';
import { hiveLoginConfigured as integrationHiveLoginConfigured } from '../../runtime-integrations.mjs';

export interface HiveLoginSession {
  username: string;
  userId: string;
  role: 'ADMIN' | 'OPERATOR' | 'VIEWER';
  provider: 'hive';
  sessionId: string;
  ttl: number;
}

type HiveSessionReference = Pick<SessionPayload, 'provider' | 'sessionId' | 'userId'>;

let client: Redis | undefined;
function redis() {
  if (!client) {
    client = new Redis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    client.on('error', () => undefined);
  }
  return client;
}
async function store() {
  const r = redis();
  if (r.status === 'wait') await r.connect();
  return r;
}
const key = () =>
  createHash('sha256').update('magnus:hive-session:v1\0').update(getSecretKey()).digest();
function seal(value: unknown, id: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(id));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
function open(value: string, id: string) {
  const data = Buffer.from(value, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12));
  cipher.setAAD(Buffer.from(id));
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'),
  );
}
export function hiveLoginConfigured(): boolean {
  return integrationHiveLoginConfigured(process.env);
}
function settings() {
  if (!hiveLoginConfigured()) throw new Error('Hive login is not configured');
  const discovery = new URL(process.env['HIVE_OAUTH_DISCOVERY_URL']!);
  const origin = new URL(process.env['DASHBOARD_PUBLIC_ORIGIN']!);
  if (
    [discovery, origin].some((u) => u.protocol !== 'https:' || u.username || u.password || u.hash)
  )
    throw new Error('Hive login requires HTTPS');
  return {
    discovery,
    origin,
    clientId: process.env['HIVE_OAUTH_CLIENT_ID']!,
    issuer: process.env['HIVE_OAUTH_ISSUER']!,
    audience: process.env['HIVE_OAUTH_API_AUDIENCE']!,
    callback: `${origin.origin}/api/auth/hive/callback`,
  };
}
async function json(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Hive identity request failed');
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Empty Hive response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) throw new Error('Hive identity response too large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function discovery() {
  const config = settings();
  const doc = (await json(config.discovery.toString())) as Record<string, unknown>;
  if (doc.issuer !== config.issuer) throw new Error('Hive issuer mismatch');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof doc[key] !== 'string') throw new Error('Incomplete Hive discovery');
    const u = new URL(doc[key]);
    if (u.origin !== config.discovery.origin || u.username || u.password)
      throw new Error('Unexpected Hive endpoint origin');
  }
  return { config, doc: doc as Record<string, string> };
}
export async function beginHiveLogin() {
  const { config, doc } = await discovery();
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  await (
    await store()
  ).set(
    `magnus:hive:oauth:${state}`,
    seal({ verifier, callback: config.callback }, state),
    'EX',
    300,
  );
  const url = new URL(doc['authorization_endpoint']!);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.callback,
    scope: process.env['HIVE_OAUTH_SCOPE'] ?? 'openid profile email',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return { state, url: url.toString() };
}
export function hiveRole(roles: unknown): 'ADMIN' | 'OPERATOR' | 'VIEWER' {
  const values = Array.isArray(roles) ? roles : [];
  for (const role of values) {
    if (role === 'SUPER_ADMIN' || role === 'IAM_ADMIN') return 'ADMIN';
    if (role === 'OPERATOR') return 'OPERATOR';
    if (role === 'VIEWER') return 'VIEWER';
  }
  return 'VIEWER';
}
export async function finishHiveLogin(state: string, code: string): Promise<HiveLoginSession> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 4096)
    throw new Error('Invalid OAuth callback');
  const saved = await (await store()).getdel(`magnus:hive:oauth:${state}`);
  if (!saved) throw new Error('OAuth state expired or already consumed');
  const previous = open(saved, state) as { verifier: string; callback: string };
  const { config, doc } = await discovery();
  if (previous.callback !== config.callback) throw new Error('Callback configuration changed');
  const response = await json(doc['token_endpoint']!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      redirect_uri: config.callback,
      code_verifier: previous.verifier,
      ...(process.env['HIVE_OAUTH_CLIENT_SECRET']
        ? { client_secret: process.env['HIVE_OAUTH_CLIENT_SECRET'] }
        : {}),
    }),
  });
  if (typeof response.access_token !== 'string') throw new Error('Missing Hive access token');
  const { payload } = await jwtVerify(
    response.access_token,
    createRemoteJWKSet(new URL(doc['jwks_uri']!)),
    { algorithms: ['RS256'], issuer: config.issuer, audience: config.audience },
  );
  if (!payload.sub || !payload.exp || payload['actorType'] === 'SERVICE_ACCOUNT')
    throw new Error('Named user identity required');
  const ttl = Math.min(3600, payload.exp - Math.floor(Date.now() / 1000));
  if (ttl <= 0) throw new Error('Hive session expired');
  const sessionId = randomBytes(32).toString('base64url');
  await (
    await store()
  ).set(
    `magnus:hive:session:${sessionId}`,
    seal(
      { accessToken: response.access_token, userId: payload.sub, expiresAt: payload.exp },
      sessionId,
    ),
    'EX',
    ttl,
  );
  return {
    username: String(payload['preferred_username'] ?? payload.sub),
    userId: payload.sub,
    role: hiveRole(payload['roles']),
    provider: 'hive' as const,
    sessionId,
    ttl,
  };
}
export async function hiveCredential(session: HiveSessionReference, target: string) {
  if (session.provider !== 'hive') return null;
  if (!session.sessionId || !/^[A-Za-z0-9_-]{43}$/.test(session.sessionId))
    throw new Error('Invalid Hive session');
  const canonical = new URL(process.env['CONTROL_API_URL']!);
  if (new URL(target).origin !== canonical.origin)
    throw new Error('Hive delegation is limited to the canonical Control API');
  const encrypted = await (await store()).get(`magnus:hive:session:${session.sessionId}`);
  if (!encrypted) throw new Error('Hive session expired');
  const value = open(encrypted, session.sessionId) as {
    accessToken: string;
    userId: string;
    expiresAt: number;
  };
  if (value.userId !== session.userId || value.expiresAt <= Date.now() / 1000)
    throw new Error('Hive session identity expired');
  return value.accessToken;
}
export async function revokeHiveSession(session: HiveSessionReference) {
  if (session.provider === 'hive' && session.sessionId)
    await (await store()).del(`magnus:hive:session:${session.sessionId}`);
}
