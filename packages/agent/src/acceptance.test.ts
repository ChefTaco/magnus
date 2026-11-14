import { expect, it, vi } from 'vitest';
import { probeAgentAcceptance, runAgentAcceptance } from './acceptance.js';
const now = Date.parse('2026-01-01T00:00:30Z');
const options = {
  selfUrl: 'https://node-1.example.com:4100',
  credential: 'obviously-fake-native-node-credential',
  expectedVersion: '2.0.0',
  waitSeconds: 0,
};
const body = () => ({
  success: true,
  data: {
    service: 'magnus-agent',
    status: 'healthy',
    version: '2.0.0',
    heartbeat: { running: true, lastAcceptedAt: '2026-01-01T00:00:00Z', consecutiveFailures: 0 },
    fingerprints: { nodeManagerSecret: 'obviously-fake-fingerprint' },
    checks: [{ message: 'private server diagnostic must stay private' }],
  },
});
it('accepts recent native heartbeat evidence without returning raw diagnostics or fingerprints', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body()));
  const result = await probeAgentAcceptance(options, { fetch, now: () => now });
  expect(result).toEqual({
    ok: true,
    version: '2.0.0',
    heartbeatAcceptedAt: '2026-01-01T00:00:00Z',
  });
  expect(String(fetch.mock.calls[0]?.[0])).toBe(
    'https://node-1.example.com:4100/api/v1/health/check',
  );
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-node-token')).toBe(
    options.credential,
  );
  expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('error');
  expect(JSON.stringify(result)).not.toContain('fingerprint');
  expect(JSON.stringify(result)).not.toContain(options.credential);
  expect(JSON.stringify(result)).not.toContain('diagnostic');
});
it('refuses missing configuration or credential-bearing, non-HTTPS and non-origin URLs before sending credentials', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const selfUrl of [
    '',
    'http://node-1.example.com',
    'https://admin:password@node-1.example.com',
    'https://node-1.example.com/path',
    'https://node-1.example.com/?key=fake',
    'https://node-1.example.com/#fragment',
  ])
    expect(await probeAgentAcceptance({ ...options, selfUrl }, { fetch })).toEqual({
      ok: false,
      reason: 'INVALID_CONFIGURATION',
    });
  expect(fetch).not.toHaveBeenCalled();
  expect(await runAgentAcceptance(['--unexpected'], {}, '2.0.0')).toEqual({
    ok: false,
    reason: 'INVALID_CONFIGURATION',
  });
  // 3.0.0: without the shared secret the probe needs the node key; with neither nothing is sent.
  const { credential: _credential, ...keyOnly } = options;
  expect(await probeAgentAcceptance(keyOnly, { fetch })).toEqual({ ok: false, reason: 'INVALID_CONFIGURATION' });
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValue(new Response('{}', { status: 401 }));
  await probeAgentAcceptance({ ...keyOnly, waitSeconds: 0 }, { fetch, selfSign: () => ({ 'x-magnus-signature': 'fixture' }) });
  expect(Object.keys(fetch.mock.calls[0]![1]!.headers as Record<string, string>)).toEqual(['x-magnus-signature']);
});
it('refuses stale, future, missing or failed heartbeats and a different running artifact', async () => {
  for (const heartbeat of [
    { running: false, lastAcceptedAt: null, consecutiveFailures: 0 },
    { running: true, lastAcceptedAt: '2025-12-31T23:57:00Z', consecutiveFailures: 0 },
    { running: true, lastAcceptedAt: '2026-01-01T00:01:00Z', consecutiveFailures: 0 },
    { running: true, lastAcceptedAt: '2026-01-01T00:00:00Z', consecutiveFailures: 1 },
  ]) {
    const payload = body();
    payload.data.heartbeat = heartbeat as typeof payload.data.heartbeat;
    expect(
      await probeAgentAcceptance(options, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)),
        now: () => now,
      }),
    ).toEqual({ ok: false, reason: 'HEARTBEAT_NOT_ACCEPTED' });
  }
  const payload = body();
  payload.data.version = '1.0.0';
  expect(
    await probeAgentAcceptance(options, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)),
      now: () => now,
    }),
  ).toEqual({ ok: false, reason: 'VERSION_MISMATCH' });
});
it('holds on TLS/authentication failures and malformed or oversized responses without echoing their contents', async () => {
  for (const response of [
    new Response('private diagnostic', { status: 403 }),
    Response.json({ success: true, data: { secret: 'private fixture' } }),
    new Response('x'.repeat(1024 * 1024 + 1)),
  ])
    expect(
      await probeAgentAcceptance(options, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
        now: () => now,
      }),
    ).toEqual({ ok: false, reason: 'PROBE_FAILED' });
  expect(
    await probeAgentAcceptance(options, {
      fetch: vi.fn<typeof fetch>().mockRejectedValue(Error('private TLS details')),
      now: () => now,
    }),
  ).toEqual({ ok: false, reason: 'PROBE_FAILED' });
});
it('waits within the configured bound for the first accepted heartbeat', async () => {
  let time = now;
  const payload = body();
  payload.data.heartbeat.running = false;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(payload))
    .mockResolvedValueOnce(Response.json(body()));
  const result = await probeAgentAcceptance(
    { ...options, waitSeconds: 2 },
    {
      fetch,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
    },
  );
  expect(result.ok).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});
