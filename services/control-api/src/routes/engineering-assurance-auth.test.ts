import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applicationConfigSchema } from '../services/operations-config.js';
import { applicationProbeContractDigest } from '../services/application-probes.js';

const applicationObservationFindMany = vi.hoisted(() => vi.fn());
const healthSnapshotFindMany = vi.hoisted(() => vi.fn(async () => [1, 2, 3].map(index => ({ id: `health-${index}`, nodeId: 'magnus',
  timestamp: new Date(Date.now() - (4 - index) * 60_000), memoryPercent: 50 + index, disks: '[]', source: 'system-probe' }))));
const cronExecutionFindMany = vi.hoisted(() => vi.fn(async () => []));
const cronExecutionFindFirst = vi.hoisted(() => vi.fn(async () => ({ id: 'backup-before-window', cronJobId: 'backup-job', nodeId: 'magnus',
  startedAt: new Date(Date.now() - 900_000), completedAt: new Date(Date.now() - 840_000), exitCode: 0 })));
const recoveryExerciseFindUnique = vi.hoisted(() => vi.fn());
const assessmentInventoryFindMany = vi.hoisted(() => vi.fn(async () => []));
const assessmentSnapshotQuery = vi.hoisted(() => vi.fn(async () => [{ snapshot: '100:200:' }]));

vi.mock('../utils/env.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/env.js')>()),
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '',
  MAGNUS_PLUGIN_API_ENABLED: true, MAGNUS_APPROVAL_BRIDGE_CONSUMER: '',
  MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: JSON.stringify({
    magnus: '4cd2cd8ce912b646598abfc7c79e8fd745b31d27e953cbc3eaca9bc6d11cc561',
  }),
  MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: '5673efb18fe4af55edc214a9c3aa3f85e7a0aa5463fce31f9f676e2c4d274811',
  MAGNUS_FLEET_CHECK_TOKEN_SHA256: '', MAGNUS_COLLECTOR_TOKEN_SHA256: '',
}));
vi.mock('../db/index.js', () => ({ getDb: () => ({
  $transaction: async (callback: (tx: unknown) => unknown) => callback({
    $queryRaw: assessmentSnapshotQuery,
    node: { findMany: assessmentInventoryFindMany },
    engineeringRecoveryExercise: { findUnique: recoveryExerciseFindUnique },
  }),
  node: { findMany: async () => [{ id: 'magnus' }] },
  applicationObservation: { findMany: applicationObservationFindMany },
  healthSnapshot: { findMany: healthSnapshotFindMany },
  cronJobExecution: { findMany: cronExecutionFindMany, findFirst: cronExecutionFindFirst },
}) }));
vi.mock('../services/credential-rotation-service.js', () => ({ verifyWithRotation: () => false, secretFingerprint: () => null }));

const { opsRouter } = await import('./ops.js');
const { errorHandler } = await import('../middleware/error-handler.js');
const app = new Hono().route('/api/v1/ops', opsRouter).onError(errorHandler);
const operator = 'plugin-operator-token-for-unit-tests-123';
const reader = 'plugin-scoped-token-for-unit-tests-12345';
const directory = mkdtempSync(join(tmpdir(), 'magnus-engineering-auth-'));
const catalogPath = join(directory, 'catalog.json');
const probesPath = join(directory, 'probes.json');
const probeConfig = applicationConfigSchema.parse({ id: 'api', projectId: 'magnus', serviceId: 'api', nodeId: 'magnus',
  baseUrl: 'https://api.invalid', healthPath: '/health', kind: 'http' });

beforeAll(() => {
  writeFileSync(catalogPath, JSON.stringify({ schemaVersion: 1, applications: [{ id: 'api', nodeId: 'magnus',
    deploySource: 'repo:magnus', runtimePath: '/opt/magnus-api', healthContract: { method: 'GET', path: '/health', successStatuses: [200], maxAgeMs: 60_000 },
    dataOwner: 'magnus', recoveryOrder: 1, dependsOn: [], investigationSequence: ['Inspect health'], recoverySequence: ['Verify health'],
    metricSources: [{ metric: 'backup_age', collector: 'cron_success', sourceKey: 'backup-job' }] }],
    runbooks: [] }), { mode: 0o600 });
  writeFileSync(probesPath, JSON.stringify({ schemaVersion: 1, applications: [probeConfig] }), { mode: 0o600 });
  vi.stubEnv('MAGNUS_OPERATIONS_CATALOG_FILE', catalogPath);
  vi.stubEnv('MAGNUS_APPLICATION_PROBES_FILE', probesPath);
  applicationObservationFindMany.mockResolvedValue([{ id: 'api', projectId: 'magnus', serviceId: 'api', nodeId: 'magnus', status: 'pass',
    resultJson: JSON.stringify({ status: 'pass', probeContractSha256: applicationProbeContractDigest(probeConfig),
      checks: [{ name: 'reachability', method: 'GET', path: '/health', status: 'pass', httpStatus: 200 }] }), observedAt: new Date() }]);
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('engineering assurance scoped HTTP boundary', () => {
  it('allows the exact operator-scoped catalog read and denies read-only or anonymous credentials', async () => {
    expect((await app.request('/api/v1/ops/engineering/catalog', { headers: { authorization: `Bearer ${operator}` } })).status).toBe(200);
    expect((await app.request('/api/v1/ops/engineering/catalog', { headers: { authorization: `Bearer ${reader}` } })).status).toBe(403);
    expect((await app.request('/api/v1/ops/engineering/catalog')).status).toBe(401);
  });

  it.each(['dependency-impact', 'runbook-assessment', 'delivery-assessment', 'forecast-assessment', 'restore-assessment'])(
    'reaches %s only with the exact operator credential', async route => {
      const url = `/api/v1/ops/engineering/${route}`;
      const init = { method: 'POST', headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' }, body: '{}' };
      expect((await app.request(url, init)).status).toBe(400);
      expect((await app.request(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${reader}` } })).status).toBe(403);
    },
  );

  it('collects dependency and forecast evidence inside the operator boundary', async () => {
    const headers = { authorization: `Bearer ${operator}`, 'content-type': 'application/json' };
    const dependency = await app.request('/api/v1/ops/engineering/dependency-impact', {
      method: 'POST', headers, body: JSON.stringify({ failedApplicationId: 'api' }),
    });
    expect(dependency.status).toBe(200);
    await expect(dependency.json()).resolves.toMatchObject({ success: true, data: {
      provenance: 'magnus_application_observations', durableObservationsComplete: true,
      failureDurablyObserved: false,
    } });
    const forecast = await app.request('/api/v1/ops/engineering/forecast-assessment', {
      method: 'POST', headers, body: JSON.stringify({ applicationId: 'api', metric: 'memory', threshold: 80,
        breachDirection: 'above', maxSampleAgeMs: 300_000, maxWindowMs: 600_000 }),
    });
    expect(forecast.status).toBe(200);
    await expect(forecast.json()).resolves.toMatchObject({ success: true, data: {
      provenance: 'magnus_health_snapshots', durablyMeasured: true, sampleCount: 3,
    } });
    expect(applicationObservationFindMany).toHaveBeenCalledOnce();
    expect(healthSnapshotFindMany).toHaveBeenCalledOnce();
    const backup = await app.request('/api/v1/ops/engineering/forecast-assessment', {
      method: 'POST', headers, body: JSON.stringify({ applicationId: 'api', metric: 'backup_age', threshold: 1,
        breachDirection: 'above', maxSampleAgeMs: 300_000, maxWindowMs: 600_000 }),
    });
    expect(backup.status).toBe(200);
    expect(cronExecutionFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      completedAt: expect.objectContaining({ gte: expect.any(Date), lte: expect.any(Date) }),
    }) }));
    expect(cronExecutionFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      completedAt: expect.objectContaining({ lt: expect.any(Date) }),
    }) }));
  });

  it('resolves restore evidence by exercise ID only and rechecks production inventory', async () => {
    recoveryExerciseFindUnique.mockResolvedValueOnce({
      id: 'restore-1', targetId: 'disposable:restore-1', scenario: 'rollback',
      startedAt: new Date(), recoveredAt: new Date(), recoveryPointAt: new Date(), createdAt: new Date(),
      rtoObjectiveSeconds: 60, rpoObjectiveSeconds: 60,
      beforeStateSha256: 'a'.repeat(64), beforeTaskSha256: 'a'.repeat(64), beforeArtifactSha256: 'a'.repeat(64),
      afterStateSha256: 'a'.repeat(64), afterTaskSha256: 'a'.repeat(64), afterArtifactSha256: 'a'.repeat(64),
      beforeEvidenceJson: '{}', afterEvidenceJson: '{}', runtimeEvidenceJson: '[]',
      directEvidenceSha256: 'a'.repeat(64), recordSha256: 'a'.repeat(64),
    });
    const headers = { authorization: `Bearer ${operator}`, 'content-type': 'application/json' };
    const response = await app.request('/api/v1/ops/engineering/restore-assessment', {
      method: 'POST', headers, body: JSON.stringify({ exerciseId: 'restore-1' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, data: {
      verified: false, provenance: 'magnus_recovery_exercise_store', exerciseId: 'restore-1',
    } });
    expect(recoveryExerciseFindUnique).toHaveBeenCalledWith({ where: { id: 'restore-1' } });
    expect(assessmentInventoryFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10_001 }));
    expect((await app.request('/api/v1/ops/engineering/restore-assessment', {
      method: 'POST', headers, body: JSON.stringify({ exerciseId: 'restore-1', targetId: 'disposable:attacker' }),
    })).status).toBe(400);
  });
});
