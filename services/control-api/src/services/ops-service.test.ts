import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]),
    hermesInstallation: { count: vi.fn().mockResolvedValue(1) },
    node: { findMany: vi.fn().mockResolvedValue([]) },
    healthSnapshot: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    gpuSnapshot: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    engineeringMetricSample: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    engineeringRecoveryExercise: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    logEntry: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    notification: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    securityFusionEvent: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    remoteCommand: { count: vi.fn().mockResolvedValue(0) },
    deployJob: { count: vi.fn().mockResolvedValue(0) },
    hermesOperationJob: { count: vi.fn().mockResolvedValue(0) },
  }),
}));

vi.mock('../queue/redis.js', () => ({
  getRedis: () => ({
    ping: vi.fn().mockResolvedValue('PONG'),
    llen: vi.fn().mockResolvedValue(0),
  }),
}));

vi.mock('../utils/env.js', () => ({
  API_SECRET: 'a'.repeat(32),
  IAM_CORE_URL: '',
  getNodeManagerSecret: () => 'n'.repeat(32),
  getValidatedEnv: () => ({
    HEALTH_SNAPSHOT_RETENTION_DAYS: 7,
    HEALTH_SNAPSHOT_FULL_FIDELITY_HOURS: 24,
    HEALTH_SNAPSHOT_SAMPLE_MINUTES: 15,
    ENGINEERING_EXERCISE_RETENTION_DAYS: 90,
    NOTIFICATION_READ_RETENTION_DAYS: 30,
    NOTIFICATION_MAX_RETENTION_DAYS: 90,
  }),
}));

const { checkHttp, getDependencyHealth, getFleetReadiness, getRetentionSummary, resolveRouterHealthUrl } = await import('./ops-service.js');

describe('ops-service', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('derives Router health from the origin rather than the OpenAI /v1 base path', () => {
    expect(resolveRouterHealthUrl('https://hive.example:4020/v1')).toBe('https://hive.example:4020/health');
    expect(resolveRouterHealthUrl('https://ignored.example/v1', 'https://health.example/ready')).toBe('https://health.example/ready');
  });

  it('requires a 2xx dependency response and surfaces the transport cause', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })));
    await expect(checkHttp('router', 'https://router.example/health')).resolves.toEqual(
      expect.objectContaining({ status: 'warn', message: 'HTTP 401' }),
    );

    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(
      new TypeError('fetch failed', { cause: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }) }),
    ));
    await expect(checkHttp('router', 'https://router.example/health')).resolves.toEqual(
      expect.objectContaining({ status: 'warn', message: 'fetch failed (ECONNREFUSED: connect refused)' }),
    );
  });

  it('returns dependency health checks', async () => {
    const health = await getDependencyHealth();
    expect(health.checks.some((check) => check.name === 'postgres')).toBe(true);
    expect(health.checks.some((check) => check.name === 'rate-limiter')).toBe(true);
  });

  it('returns readiness with secret fingerprints and nodes array', async () => {
    const readiness = await getFleetReadiness();
    expect(readiness.nodes).toEqual([]);
    expect(readiness.expectedFingerprints).toHaveProperty('nodeManagerSecret');
  });

  it('returns retention table summaries', async () => {
    const retention = await getRetentionSummary() as { tables: Array<{ name: string; cutoffs?: Record<string, string> }> };
    expect(retention).toHaveProperty('tables');
    expect(retention.tables.find((table) => table.name === 'HealthSnapshot')?.cutoffs).toEqual({
      fullFidelityAfter: expect.any(String),
      expiresBefore: expect.any(String),
    });
    expect(retention.tables.find((table) => table.name === 'EngineeringMetricSample')?.cutoffs).toEqual({
      fullFidelityAfter: expect.any(String),
      expiresBefore: expect.any(String),
    });
    expect(retention.tables.find((table) => table.name === 'EngineeringRecoveryExercise')?.cutoffs).toEqual({
      expiresBefore: expect.any(String),
    });
  });
});
