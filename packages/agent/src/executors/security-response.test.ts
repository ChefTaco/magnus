import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ error: null as null | { code: number }, unsafe: false }));
const run = vi.hoisted(() =>
  vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: unknown) => void) =>
    callback(state.error),
  ),
);
vi.mock('node:child_process', () => ({ execFile: run }));
vi.mock('node:fs/promises', () => ({
  realpath: async (path: string) => path,
  lstat: async (path: string) => ({
    isDirectory: () => !path.endsWith('magnus-security-containment'),
    isFile: () => path.endsWith('magnus-security-containment'),
    isSymbolicLink: () => false,
    uid: 0,
    mode: state.unsafe ? 0o777 : 0o755,
  }),
}));
import { securityResponseRoutes } from './security-response.js';
beforeEach(() => {
  state.error = null;
  state.unsafe = false;
  run.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const body = {
  operation: 'execute',
  kind: 'service_restart',
  serviceName: 'fixture.service',
  isolationMinutes: null,
};
it('keeps node response disabled until explicitly enabled', async () => {
  vi.stubEnv('MAGNUS_SECURITY_RESPONSE_ENABLED', 'false');
  const res = await securityResponseRoutes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(403);
});
it('denies response from an unprivileged agent', async () => {
  vi.stubEnv('MAGNUS_AGENT_PRIVILEGED', 'false');
  vi.stubEnv('MAGNUS_SECURITY_RESPONSE_ENABLED', 'true');
  const res = await securityResponseRoutes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: { code: 'AGENT_NOT_PRIVILEGED' } });
});
it('rejects arbitrary commands and malformed service targets', async () => {
  vi.stubEnv('MAGNUS_SECURITY_RESPONSE_ENABLED', 'true');
  const res = await securityResponseRoutes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, command: 'sh', serviceName: 'fixture.service; true' }),
  });
  expect(res.status).toBe(403);
});
it('runs only the fixed root-controlled helper with a minimal child environment', async () => {
  vi.stubEnv('MAGNUS_SECURITY_RESPONSE_ENABLED', 'true');
  vi.stubEnv('MAGNUS_SECURITY_CONTAINMENT_COMMAND', '/usr/local/sbin/magnus-security-containment');
  const response = await securityResponseRoutes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  expect(run.mock.calls[0]?.slice(0, 3)).toEqual([
    '/usr/local/sbin/magnus-security-containment',
    ['restart-service', 'fixture.service'],
    { timeout: 110000, maxBuffer: 65536, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } },
  ]);
});
it('keeps failed rollback outcomes unknown and refuses writable helpers', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('MAGNUS_SECURITY_RESPONSE_ENABLED', 'true');
  vi.stubEnv('MAGNUS_SECURITY_CONTAINMENT_COMMAND', '/usr/local/sbin/magnus-security-containment');
  state.error = { code: 70 };
  const request = () =>
    securityResponseRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await request()).status).toBe(500);
  expect(run).toHaveBeenCalledTimes(1);
  state.unsafe = true;
  expect((await request()).status).toBe(500);
  expect(run).toHaveBeenCalledTimes(1);
});
