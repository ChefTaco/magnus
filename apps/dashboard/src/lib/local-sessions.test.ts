import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ token: '' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: state.token }) }) }));
vi.mock('@/lib/security-events', () => ({
  recordSecurityEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/hive-login', () => ({ revokeHiveSession: vi.fn(), hiveCredential: vi.fn() }));
let dir: string, redis: ChildProcess;
let auth: typeof import('./auth'),
  logout: typeof import('../app/api/auth/logout/route'),
  me: typeof import('../app/api/auth/me/route');
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'local-session-test-'));
  redis = spawn(
    'redis-server',
    [
      '--port',
      '0',
      '--unixsocket',
      path.join(dir, 'redis.sock'),
      '--save',
      '',
      '--appendonly',
      'no',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    redis.on('error', reject);
    redis.stdout!.on('data', (data) => {
      if (String(data).toLowerCase().includes('ready to accept connections')) resolve();
    });
  });
  vi.stubEnv('REDIS_URL', path.join(dir, 'redis.sock'));
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-'.repeat(4));
  vi.stubEnv('DASHBOARD_ADMIN_USERNAME', 'admin');
  vi.stubEnv('DASHBOARD_ADMIN_PASSWORD_HASH', '$argon2id$test-verifier');
  auth = await import('./auth');
  logout = await import('../app/api/auth/logout/route');
  me = await import('../app/api/auth/me/route');
}, 10000);
afterAll(async () => {
  if (redis.exitCode === null) {
    redis.kill();
    await once(redis, 'exit');
  }
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
it('rejects copied-cookie reuse after logout with HTTP 401', async () => {
  state.token = await auth.createSessionToken('admin');
  expect((await me.GET()).status).toBe(200);
  expect(
    (await logout.POST(new NextRequest('https://example.test/api/auth/logout', { method: 'POST' })))
      .status,
  ).toBe(200);
  expect((await me.GET()).status).toBe(401);
  const proxy = (await import('../proxy')).default;
  expect(
    (
      await proxy(
        new NextRequest('https://example.test/api/auth/me', {
          headers: { cookie: `${auth.COOKIE_NAME}=${state.token}` },
        }),
      )
    ).status,
  ).toBe(401);
});
it('revokes all sessions while allowing a subsequent login', async () => {
  const first = await auth.createSessionToken('admin'),
    second = await auth.createSessionToken('admin');
  state.token = first;
  expect(
    (
      await logout.POST(
        new NextRequest('https://example.test/api/auth/logout?all=true', { method: 'POST' }),
      )
    ).status,
  ).toBe(200);
  expect(await auth.verifySessionToken(first)).toBeNull();
  expect(await auth.verifySessionToken(second)).toBeNull();
  expect(await auth.verifySessionToken(await auth.createSessionToken('admin'))).not.toBeNull();
});
it('credential rotation invalidates existing sessions without rotating signing keys', async () => {
  const token = await auth.createSessionToken('admin');
  vi.stubEnv('DASHBOARD_ADMIN_PASSWORD_HASH', '$argon2id$new-verifier');
  expect(await auth.verifySessionToken(token)).toBeNull();
  expect(await auth.verifySessionToken(await auth.createSessionToken('admin'))).not.toBeNull();
});
it('bounds active sessions to 50 and rejects legacy stateless tokens', async () => {
  const first = await auth.createSessionToken('admin');
  for (let i = 0; i < 50; i++) await auth.createSessionToken('admin');
  expect(await auth.verifySessionToken(first)).toBeNull();
  const { SignJWT } = await import('jose');
  const constants = await import('./auth-constants');
  const legacy = await new SignJWT({ username: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(constants.SESSION_ISSUER)
    .setAudience(constants.SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(constants.getSecretKey());
  expect(await auth.verifySessionToken(legacy)).toBeNull();
});
it('retains Hive revocation behavior', async () => {
  state.token = await auth.createSessionToken('named', {
    provider: 'hive',
    sessionId: 'hive-session',
    userId: 'hive-user',
  });
  await logout.POST(new NextRequest('https://example.test/api/auth/logout', { method: 'POST' }));
  const { revokeHiveSession } = await import('./hive-login');
  expect(revokeHiveSession).toHaveBeenCalled();
});

it('fails authentication closed and does not claim logout succeeded during Redis outage', async () => {
  state.token = await auth.createSessionToken('admin');
  redis.kill();
  await once(redis, 'exit');
  expect((await me.GET()).status).toBe(401);
  expect(
    (await logout.POST(new NextRequest('https://example.test/api/auth/logout', { method: 'POST' })))
      .status,
  ).toBe(503);
});
