import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationConfigSchema } from './operations-config.js';
import { boundedJson, probeApplication, summarizeProbeBody } from './application-probes.js';
const config = (extra = {}) =>
  applicationConfigSchema.parse({
    id: 'factory',
    projectId: 'example/workflow',
    serviceId: 'factory',
    nodeId: 'node1',
    baseUrl: 'https://factory.invalid',
    healthPath: '/health',
    kind: 'workflow-queue',
    ...extra,
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('application readiness contracts', () => {
  it('distinguishes worker and backend failure from healthy HTTP', () => {
    expect(summarizeProbeBody({ status: 'ok', workflows: { workers: 0 } }, 'workflow-queue').status).toBe(
      'fail',
    );
    expect(summarizeProbeBody({ success: true, data: { ready: false } }, 'workflow-queue').status).toBe(
      'fail',
    );
    expect(
      summarizeProbeBody({ status: 'ok', backends: [{ status: 'quarantined' }] }, 'backend-pool')
        .status,
    ).toBe('fail');
    expect(
      summarizeProbeBody({ backends: [{ status: 'healthy' }], draining: true }, 'backend-pool')
        .status,
    ).toBe('fail');
  });
  it('probes every configured path with GET and binds the probe contract digest', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ok: true }))));
    vi.stubGlobal('fetch', fetch);
    const result = await probeApplication(config({ kind: 'http', healthPath: '/api/status', readinessPath: '/api/ready' }));
    expect(result.probeContractSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.checks[0]).toMatchObject({ method: 'GET', path: '/api/status', httpStatus: 200 });
    expect(fetch.mock.calls.every(call => (call[1] as RequestInit).method === 'GET')).toBe(true);
  });
  it('shows missing and rejected readiness credentials separately from reachability', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"status":"ok"}'));
    vi.stubGlobal('fetch', fetch);
    const result = await probeApplication(
      config({ readinessPath: '/api/readiness', tokenEnv: 'PROBE_TEST_TOKEN' }),
    );
    expect(result.status).toBe('unconfigured');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.stubEnv('PROBE_TEST_TOKEN', 'test-only');
    fetch
      .mockResolvedValueOnce(new Response('{"status":"ok"}'))
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    const rejected = await probeApplication(
      config({ readinessPath: '/api/readiness', tokenEnv: 'PROBE_TEST_TOKEN' }),
    );
    expect(rejected.status).toBe('fail');
    expect(rejected.checks[1]).toMatchObject({ method: 'GET', path: '/api/readiness', httpStatus: 401 });
    expect(JSON.stringify(rejected)).not.toContain('test-only');
  });
  it('extracts bounded queue depth and latency measurements from successful probes', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{"status":"ok"}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', workflows: {
        workers: 2, counts: { waiting: 3, delayed: 2, paused: 1, completed: 99 }, latencyMsP50: 5,
      } }))));
    const result = await probeApplication(config({ queuePath: '/health/queue' }));
    expect(result.checks[0]).toMatchObject({ name: 'reachability', status: 'pass', durationMs: expect.any(Number) });
    expect(result.checks[1]).toMatchObject({ name: 'worker-queue', status: 'pass', gpuQueueDepth: 6,
      durationMs: expect.any(Number) });
  });
  it('bounds responses and rejects credential redirects or forbidden restart services', async () => {
    await expect(boundedJson(new Response('x'.repeat(100)), 20)).rejects.toThrow('limit');
    expect(() => config({ restartService: 'sshd.service' })).toThrow();
    expect(() => config({ baseUrl: 'https://user:secret@factory.invalid' })).toThrow();
    expect(() => config({ readinessPath: '//attacker.invalid' })).toThrow();
  });
});
