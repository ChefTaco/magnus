import { describe, expect, it } from 'vitest';
import { assessDelivery, assessDependencyFailure, assessForecast, assessRestore, assessRunbook,
  assertCatalogInventory, deliveryAssessmentSchema, dependencyFailureSchema, forecastAssessmentSchema,
  operationsCatalogSchema, restoreAssessmentSchema, runbookAssessmentSchema, sha256 } from './engineering-assurance.js';
import { engineeringMetricEvidenceSha256 } from './engineering-metric-evidence.js';
const d = (v: string) => v.repeat(64).slice(0, 64);
const observed = (source: string, observedAt = '2026-09-20T12:00:00.000Z') => ({ evidenceSha256: d('a'), observedAt, source });
const probeContracts = [
  { id: 'postgres', projectId: 'magnus', serviceId: 'postgres', nodeId: 'magnus', healthPath: '/health', probeContractSha256: d('1') },
  { id: 'api', projectId: 'magnus', serviceId: 'api', nodeId: 'magnus', healthPath: '/health', probeContractSha256: d('2'), checks: [
    { sourceKey: 'reachability', method: 'GET' as const, path: '/health' },
    { sourceKey: 'worker-queue', method: 'GET' as const, path: '/health/queue' },
  ] },
  { id: 'dashboard', projectId: 'magnus', serviceId: 'dashboard', nodeId: 'magnus', healthPath: '/api/health', probeContractSha256: d('3') },
];
const probeResult = (digest: string, path: string, status = 'pass', httpStatus: number | null = 200) => JSON.stringify({
  status, probeContractSha256: digest, checks: [{ name: 'reachability', method: 'GET', path, status, httpStatus }],
});
const catalog = operationsCatalogSchema.parse({ schemaVersion: 1, applications: [
  { id: 'postgres', nodeId: 'magnus', deploySource: 'repo:magnus', runtimePath: '/var/lib/postgresql', healthContract: { method: 'GET', path: '/health', successStatuses: [200], maxAgeMs: 60_000 }, dataOwner: 'magnus', recoveryOrder: 1, dependsOn: [], investigationSequence: ['Check database probe'], recoverySequence: ['Restore database health'] },
  { id: 'api', nodeId: 'magnus', deploySource: 'repo:magnus', runtimePath: '/opt/magnus-api', healthContract: { method: 'GET', path: '/health', successStatuses: [200], maxAgeMs: 60_000 }, dataOwner: 'magnus', recoveryOrder: 2, dependsOn: ['postgres'], investigationSequence: ['Check API readiness'], recoverySequence: ['Verify API readiness'], metricSources: [
    { metric: 'gpu_queue', collector: 'application_probe', sourceKey: 'worker-queue' },
    { metric: 'dependency_latency', collector: 'application_probe', sourceKey: 'reachability' },
    { metric: 'backup_age', collector: 'cron_success', sourceKey: 'backup-job' },
    { metric: 'certificate_expiry', collector: 'health_service_expiry', sourceKey: 'api-tls', detailKey: 'certificateExpiresAt' },
    { metric: 'token_expiry', collector: 'health_service_expiry', sourceKey: 'hivemem-token:api', detailKey: 'expiresAt' },
  ] },
  { id: 'dashboard', nodeId: 'magnus', deploySource: 'repo:magnus', runtimePath: '/opt/magnus/apps/dashboard', healthContract: { method: 'GET', path: '/api/health', successStatuses: [200], maxAgeMs: 60_000 }, dataOwner: 'magnus', recoveryOrder: 3, dependsOn: ['api'], investigationSequence: ['Check user path'], recoverySequence: ['Verify user path'] },
], runbooks: [{ id: 'api-recovery', version: '1.0.0', executionVersion: 'restart-service.v1', kind: 'remediation', mutatesState: true,
  command: '/usr/bin/systemctl', args: ['restart', 'magnus-control-api.service'], timeoutSeconds: 300, maxAttempts: 1,
  preflight: ['Capture current health'], steps: ['Restart exact service'], postconditions: ['Verify application readiness'],
  directPostcondition: { kind: 'application_health', requirement: 'Verify application readiness' }, rollbackCriteria: ['Stop if readiness fails'] },
{ id: 'api-diagnostics', version: '1.0.0', executionVersion: 'diagnostics.v1', kind: 'diagnostics', mutatesState: false,
  command: '/usr/bin/uptime', args: [], timeoutSeconds: 60, maxAttempts: 1,
  preflight: ['Capture current health'], steps: ['Read uptime'], postconditions: ['Verify application readiness'],
  directPostcondition: { kind: 'application_health', requirement: 'Verify application readiness' }, rollbackCriteria: ['Retain result'] }] });

describe('engineering assurance contracts', () => {
  it('maps impact from durable application observations and rejects target drift', () => {
    const result = assessDependencyFailure(catalog, { failedApplicationId: 'postgres' }, [
      { id: 'postgres', projectId: 'magnus', serviceId: 'postgres', nodeId: 'magnus', status: 'fail', resultJson: probeResult(d('1'), '/health', 'fail', 503), observedAt: new Date('2026-09-20T12:00:00.000Z') },
      { id: 'api', projectId: 'magnus', serviceId: 'api', nodeId: 'magnus', status: 'pass', resultJson: probeResult(d('2'), '/health'), observedAt: new Date('2026-09-20T12:00:00.000Z') },
      { id: 'dashboard', projectId: 'magnus', serviceId: 'dashboard', nodeId: 'wrong-node', status: 'pass', resultJson: probeResult(d('3'), '/api/health'), observedAt: new Date('2026-09-20T12:00:00.000Z') },
    ], probeContracts, Date.parse('2026-09-20T12:00:30.000Z'));
    expect(result.affectedApplications.map(a => a.id)).toEqual(['postgres', 'api', 'dashboard']);
    expect(result).toMatchObject({ failureDurablyObserved: true, durableObservationsComplete: false, provenance: 'magnus_application_observations' });
    expect(result.affectedApplications).toEqual([
      expect.objectContaining({ id: 'postgres', observedStatus: 'failed', durablyBound: true, evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ id: 'api', observedStatus: 'healthy', durablyBound: true }),
      expect.objectContaining({ id: 'dashboard', observedStatus: 'unknown', durablyBound: false, evidenceSha256: null }),
    ]);
  });

  it('does not treat a caller-selected healthy application as a durably observed failure', () => {
    const result = assessDependencyFailure(catalog, { failedApplicationId: 'postgres' }, [
      { id: 'postgres', projectId: 'magnus', serviceId: 'postgres', nodeId: 'magnus', status: 'pass', resultJson: probeResult(d('1'), '/health'), observedAt: new Date('2026-09-20T12:00:00.000Z') },
      { id: 'api', projectId: 'magnus', serviceId: 'api', nodeId: 'magnus', status: 'pass', resultJson: probeResult(d('2'), '/health'), observedAt: new Date('2026-09-20T12:00:00.000Z') },
      { id: 'dashboard', projectId: 'magnus', serviceId: 'dashboard', nodeId: 'magnus', status: 'pass', resultJson: probeResult(d('3'), '/api/health'), observedAt: new Date('2026-09-20T12:00:00.000Z') },
    ], probeContracts, Date.parse('2026-09-20T12:00:30.000Z'));
    expect(result).toMatchObject({ failureDurablyObserved: false, durableObservationsComplete: true });
  });

  it('rejects same-id and same-node evidence from a different probe contract', () => {
    const result = assessDependencyFailure(catalog, { failedApplicationId: 'postgres' }, [
      { id: 'postgres', projectId: 'magnus', serviceId: 'postgres', nodeId: 'magnus', status: 'fail',
        resultJson: probeResult(d('9'), '/other', 'fail', 503), observedAt: new Date('2026-09-20T12:00:00.000Z') },
    ], probeContracts, Date.parse('2026-09-20T12:00:30.000Z'));
    expect(result).toMatchObject({ failureDurablyObserved: false, durableObservationsComplete: false });
    expect(result.affectedApplications[0]).toMatchObject({ probeContractValid: false, durablyBound: false, observedStatus: 'unknown' });
  });

  it('durably binds exact runbook execution and verifies only a fresh post-settlement application probe', () => {
    const now = Date.parse('2026-09-20T12:00:30.000Z');
    const planSha256 = sha256({ runbookId: 'api-recovery', runbookVersion: '1.0.0', executionVersion: 'restart-service.v1',
      applicationId: 'api', nodeId: 'magnus', kind: 'remediation', mutatesState: true,
      command: '/usr/bin/systemctl', args: ['restart', 'magnus-control-api.service'], timeoutSeconds: 300, maxAttempts: 1,
      preflight: ['Capture current health'], steps: ['Restart exact service'], postconditions: ['Verify application readiness'],
      directPostcondition: { kind: 'application_health', requirement: 'Verify application readiness' },
      rollbackCriteria: ['Stop if readiness fails'] });
    const input = { runbookId: 'api-recovery', runbookVersion: '1.0.0', applicationId: 'api', planSha256,
      approvalExecutionId: 'exec-1', leaseId: 'lease-1' };
    const approvalPlanSha256 = d('a');
    const approval = { decisionId: 'decision-1', executionId: 'exec-1', planSha256: approvalPlanSha256, decision: 'approve',
      decidedAt: new Date('2026-09-20T11:59:00.000Z'), expiresAt: new Date('2026-09-20T12:05:00.000Z') };
    const lease = { id: 'lease-1', nodeId: 'magnus', commandId: 'command-1', state: 'released', acquiredAt: new Date('2026-09-20T11:59:59.000Z'),
      deadline: new Date('2026-09-20T12:05:00.000Z'), dispatchedAt: new Date('2026-09-20T12:00:00.000Z'),
      settledAt: new Date('2026-09-20T12:00:01.000Z'), evidenceSha256: d('c') };
    const binding = { commandId: 'command-1', nodeId: 'magnus', applicationId: 'api', runbookVersion: 'restart-service.v1',
      command: '/usr/bin/systemctl', args: ['restart', 'magnus-control-api.service'], timeoutSeconds: 300,
      telegramExecutionId: 'exec-1', decisionId: 'decision-1', approvalPlanSha256, catalogPlanSha256: planSha256 };
    const observation = { id: 'api', projectId: 'magnus', serviceId: 'api', nodeId: 'magnus', status: 'pass',
      resultJson: probeResult(d('2'), '/health'), observedAt: new Date('2026-09-20T12:00:02.000Z') };
    expect(assessRunbook(catalog, input, approval, lease, binding, observation, probeContracts[1], now)).toMatchObject({
      verified: true, executionDurablyBound: true, catalogPlanDigestValid: true, directPostconditionVerified: true,
      provenance: 'durable_execution_and_application_probe' });
    expect(assessRunbook(catalog, input, approval, lease, { ...binding, args: ['restart', 'other.service'] }, observation, probeContracts[1], now).verified).toBe(false);
    expect(assessRunbook(catalog, input, approval, lease, binding,
      { ...observation, observedAt: new Date('2026-09-20T12:00:00.500Z') }, probeContracts[1], now).directPostconditionVerified).toBe(false);
    const forgedDigest = d('f');
    expect(assessRunbook(catalog, { ...input, planSha256: forgedDigest }, approval, lease,
      { ...binding, catalogPlanSha256: forgedDigest }, observation, probeContracts[1], now)).toMatchObject({
      verified: false, executionDurablyBound: false, catalogPlanDigestValid: false,
    });
  });

  it('binds catalog-backed diagnostics without requiring a Telegram approval', () => {
    const now = Date.parse('2026-09-20T12:00:30.000Z');
    const planSha256 = sha256({ runbookId: 'api-diagnostics', runbookVersion: '1.0.0', executionVersion: 'diagnostics.v1',
      applicationId: 'api', nodeId: 'magnus', kind: 'diagnostics', mutatesState: false,
      command: '/usr/bin/uptime', args: [], timeoutSeconds: 60, maxAttempts: 1,
      preflight: ['Capture current health'], steps: ['Read uptime'], postconditions: ['Verify application readiness'],
      directPostcondition: { kind: 'application_health', requirement: 'Verify application readiness' }, rollbackCriteria: ['Retain result'] });
    const lease = { id: 'diagnostic-lease', nodeId: 'magnus', commandId: 'diagnostic-command', state: 'released',
      acquiredAt: new Date('2026-09-20T11:59:59.000Z'), deadline: new Date('2026-09-20T12:05:00.000Z'),
      dispatchedAt: new Date('2026-09-20T12:00:00.000Z'), settledAt: new Date('2026-09-20T12:00:01.000Z'), evidenceSha256: d('d') };
    const binding = { commandId: 'diagnostic-command', nodeId: 'magnus', applicationId: 'api', runbookVersion: 'diagnostics.v1',
      command: '/usr/bin/uptime', args: [], timeoutSeconds: 60, telegramExecutionId: null, decisionId: null,
      approvalPlanSha256: d('a'), catalogPlanSha256: planSha256 };
    const observation = { id: 'api', projectId: 'magnus', serviceId: 'api', nodeId: 'magnus', status: 'pass',
      resultJson: probeResult(d('2'), '/health'), observedAt: new Date('2026-09-20T12:00:02.000Z') };
    expect(assessRunbook(catalog, { runbookId: 'api-diagnostics', runbookVersion: '1.0.0', applicationId: 'api',
      planSha256, leaseId: 'diagnostic-lease' }, null, lease, binding, observation, probeContracts[1], now)).toMatchObject({
      verified: true, approvalValid: true, catalogPlanDigestValid: true, directPostconditionVerified: true,
    });
  });

  it('binds delivery receipts from the pinned ledger to a release canary and post-deploy application probe', () => {
    const revision = 'a'.repeat(40), now = Date.parse('2026-09-20T12:00:30.000Z');
    const base = { kind: 'delivery' as const, sequence: 1, previousReceiptSha256: null, receiptSha256: d('e'),
      recordedAt: '2026-09-20T12:00:01.000Z', requestId: 'task-1', applicationId: 'api', documentationOnly: false, establishedProductionWorkflow: true,
      deploySource: 'repo:magnus',
      source: { workingRevision: revision, mainRevision: revision, remoteRevision: revision, sourceTreeSha256: d('b') },
      tests: [{ name: 'unit', revision, status: 'passed' as const, ...observed('ci', '2026-09-20T11:55:00.000Z') }],
      review: { revision, ...observed('reviewer', '2026-09-20T11:56:00.000Z') },
      ci: { revision, status: 'passed' as const, ...observed('ci', '2026-09-20T11:57:00.000Z') },
      deployment: { applicationId: 'api', deploySource: 'repo:magnus', revision, sourceTreeSha256: d('b'),
        deployedAt: '2026-09-20T11:59:30.000Z', evidenceSha256: d('d'), source: 'deploy-script' },
      limitations: [] };
    const canary = { acceptedCommit: revision, sourceTreeSha256: d('b'), createdAt: new Date('2026-09-20T11:59:00.000Z') };
    const observation = { id: 'api', projectId: 'magnus', serviceId: 'api', nodeId: 'magnus', status: 'pass',
      resultJson: JSON.stringify({ status: 'pass', releaseRevision: revision, probeContractSha256: d('2'),
        checks: [{ name: 'reachability', method: 'GET', path: '/health', status: 'pass', httpStatus: 200 }] }),
      observedAt: new Date('2026-09-20T12:00:00.000Z') };
    expect(assessDelivery(catalog, { requestId: 'task-1' }, base, canary, observation, probeContracts[1], d('9'), now)).toMatchObject({
      verified: true, deploymentVerified: true, provenance: 'pinned_engineering_evidence_ledger' });
    expect(assessDelivery(catalog, { requestId: 'task-1' }, { ...base, tests: [{ ...base.tests[0]!, revision: 'b'.repeat(40) }] },
      canary, observation, probeContracts[1], d('9'), now).verified).toBe(false);
    expect(assessDelivery(catalog, { requestId: 'task-1' }, base, { ...canary, sourceTreeSha256: d('c') },
      observation, probeContracts[1], d('9'), now).verified).toBe(false);
    expect(assessDelivery(catalog, { requestId: 'task-1' }, { ...base, deploySource: 'repo:other' }, canary,
      observation, probeContracts[1], d('9'), now)).toMatchObject({ verified: false, deploySourceValid: false });
    expect(assessDelivery(catalog, { requestId: 'task-1' }, { ...base, deployment: { ...base.deployment, applicationId: 'other' } }, canary,
      observation, probeContracts[1], d('9'), now)).toMatchObject({ verified: false, deploymentIdentityValid: false });
  });

  it('derives capacity evidence from retained health snapshots and fails closed on stale or truncated windows', () => {
    const base = { applicationId: 'api', metric: 'memory' as const, threshold: 80, breachDirection: 'above' as const,
      maxSampleAgeMs: 86_400_000, maxWindowMs: 7 * 86_400_000 };
    const snapshots = [70,81,82,83].map((memoryPercent,index) => ({ id: `snapshot-${index}`, nodeId: 'magnus',
      timestamp: new Date(`2026-09-${17+index}T12:00:00.000Z`), memoryPercent, disks: '[]', source: 'system-probe' }));
    const now = Date.parse('2026-09-20T12:00:30.000Z');
    expect(assessForecast(catalog, base, { healthSnapshots: snapshots }, true, now)).toMatchObject({ candidateAlert: true,
      durablyMeasured: true, provenance: 'magnus_health_snapshots', nodeId: 'magnus', unit: 'percent' });
    expect(assessForecast(catalog, base, { healthSnapshots: snapshots }, false, now)).toMatchObject({ candidateAlert: false, durablyMeasured: false, evidenceWindowComplete: false });
    expect(assessForecast(catalog, base, { healthSnapshots: snapshots }, true, Date.parse('2026-09-22T12:00:30.000Z')).candidateAlert).toBe(false);
  });

  it('extracts only the exact disk mount and omits malformed or wrong-node health rows', () => {
    const input = { applicationId: 'api', metric: 'disk' as const, diskMountPoint: '/srv/models', threshold: 80,
      breachDirection: 'above' as const, maxSampleAgeMs: 86_400_000, maxWindowMs: 7 * 86_400_000 };
    const row = (id: string, day: number, usagePercent: number, nodeId = 'magnus', disks: string | undefined = undefined) => ({
      id, nodeId, timestamp: new Date(`2026-09-${day}T12:00:00.000Z`), memoryPercent: 5,
      disks: disks ?? JSON.stringify([{ mountPoint: '/', usagePercent: 99 }, { mountPoint: '/srv/models', usagePercent }]), source: 'system-probe' });
    const result = assessForecast(catalog, input, { healthSnapshots: [row('one', 18, 79), row('two', 19, 81), row('zzz-duplicate', 19, 82), row('wrong', 19, 99, 'other'),
      row('bad', 20, 99, 'magnus', '{'), row('three', 20, 82), row('four', 21, 83)] }, true, Date.parse('2026-09-21T12:00:30.000Z'));
    expect(result).toMatchObject({ sampleCount: 4, candidateAlert: true, diskMountPoint: '/srv/models', durablyMeasured: true });
    expect(result.evidenceSetSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('derives queue, latency, backup-age, and expiry forecasts from configured durable sources', () => {
    const now = Date.parse('2026-09-20T12:00:30.000Z');
    const policy = (metric: 'gpu_queue' | 'dependency_latency' | 'backup_age' | 'certificate_expiry' | 'token_expiry') => ({
      applicationId: 'api', metric, threshold: 1, breachDirection: 'above' as const,
      maxSampleAgeMs: 86_400_000, maxWindowMs: 7 * 86_400_000,
    });
    const metricRows = [18, 19, 20].flatMap((day, index) => (['gpu_queue', 'dependency_latency'] as const).map(metric => {
      const row = { id: `${metric}-${day}`, applicationId: 'api', nodeId: 'magnus', metric,
      sourceKey: metric === 'gpu_queue' ? 'worker-queue' : 'reachability', unit: metric === 'gpu_queue' ? 'jobs' : 'ms',
      value: index + 2, observedAt: new Date(`2026-09-${day}T12:00:00.000Z`), probeContractSha256: d('2'), method: 'GET',
      path: metric === 'gpu_queue' ? '/health/queue' : '/health', httpStatus: 200 };
      return { ...row, evidenceSha256: engineeringMetricEvidenceSha256(row) };
    }));
    expect(assessForecast(catalog, policy('gpu_queue'), { metricSamples: metricRows, probeContract: probeContracts[1] }, true, now)).toMatchObject({
      durablyMeasured: true, candidateAlert: true, unit: 'jobs', provenance: 'magnus_engineering_metric_samples' });
    expect(assessForecast(catalog, policy('dependency_latency'), { metricSamples: metricRows, probeContract: probeContracts[1] }, true, now)).toMatchObject({
      durablyMeasured: true, unit: 'ms' });
    expect(assessForecast(catalog, policy('gpu_queue'), { metricSamples: metricRows.map(row => ({ ...row, value: row.value + 100 })),
      probeContract: probeContracts[1] }, true, now)).toMatchObject({ durablyMeasured: false, sampleCount: 0 });
    expect(assessForecast(catalog, policy('gpu_queue'), { metricSamples: metricRows,
      probeContract: { ...probeContracts[1]!, probeContractSha256: d('9') } }, true, now)).toMatchObject({ durablyMeasured: false, sampleCount: 0 });
    const healthSnapshots = [18, 19, 20].map(day => ({ id: `health-${day}`, nodeId: 'magnus',
      timestamp: new Date(`2026-09-${day}T12:00:00.000Z`), memoryPercent: 20, disks: '[]', source: 'system-probe',
      services: JSON.stringify([
        { name: 'api-tls', details: { certificateExpiresAt: '2026-10-20T12:00:00.000Z' } },
        { name: 'hivemem-token:api', details: JSON.stringify({ expiresAt: '2026-10-10T12:00:00.000Z' }) },
      ]) }));
    const cronExecutions = [{ id: 'backup-1', cronJobId: 'backup-job', nodeId: 'magnus',
      startedAt: new Date('2026-09-17T10:00:00.000Z'), completedAt: new Date('2026-09-17T11:00:00.000Z'), exitCode: 0 }];
    expect(assessForecast(catalog, policy('backup_age'), { healthSnapshots, cronExecutions }, true, now)).toMatchObject({
      durablyMeasured: true, unit: 'days', provenance: 'magnus_cron_execution_history' });
    expect(assessForecast(catalog, policy('certificate_expiry'), { healthSnapshots }, true, now)).toMatchObject({
      durablyMeasured: true, unit: 'days', provenance: 'magnus_health_service_snapshots' });
    expect(assessForecast(catalog, policy('token_expiry'), { healthSnapshots }, true, now)).toMatchObject({ durablyMeasured: true });
  });

  it('rejects caller-supplied dependency observations and forecast samples', () => {
    expect(() => dependencyFailureSchema.parse({ failedApplicationId: 'api', observations: [] })).toThrow();
    expect(() => forecastAssessmentSchema.parse({ applicationId: 'api', metric: 'memory', threshold: 80,
      breachDirection: 'above', maxSampleAgeMs: 60_000, maxWindowMs: 60_000, samples: [] })).toThrow();
    expect(() => forecastAssessmentSchema.parse({ applicationId: 'api', metric: 'disk', threshold: 80,
      breachDirection: 'above', maxSampleAgeMs: 60_000, maxWindowMs: 60_000 })).toThrow(/diskMountPoint/);
    expect(() => forecastAssessmentSchema.parse({ applicationId: 'api', metric: 'memory', diskMountPoint: '/', threshold: 80,
      breachDirection: 'above', maxSampleAgeMs: 60_000, maxWindowMs: 60_000 })).toThrow(/only valid/);
    expect(() => runbookAssessmentSchema.parse({ runbookId: 'api-recovery', runbookVersion: '1.0.0', applicationId: 'api',
      planSha256: d('1'), leaseId: 'lease-1', postconditions: [] })).toThrow();
    expect(() => deliveryAssessmentSchema.parse({ requestId: 'task-1', tests: [] })).toThrow();
    expect(() => restoreAssessmentSchema.parse({ exerciseId: 'restore-1', before: {} })).toThrow();
  });

  it('fails closed when the durable runtime exercise record is absent', () => {
    expect(assessRestore({ exerciseId: 'restore-1' }, undefined, false)).toMatchObject({
      verified: false, exerciseId: 'restore-1', provenance: 'magnus_recovery_exercise_store',
    });
  });

  it('rejects catalog graph and inventory drift', () => {
    expect(() => operationsCatalogSchema.parse({ ...catalog, applications: [{ ...catalog.applications[0], dependsOn: ['missing'] }] })).toThrow();
    expect(() => assertCatalogInventory(catalog, new Set(['magnus']))).not.toThrow();
    expect(() => assertCatalogInventory(catalog, new Set())).toThrow(/absent from Magnus inventory/i);
    expect(() => operationsCatalogSchema.parse({ ...catalog, runbooks: [{ ...catalog.runbooks[0], mutatesState: false }] }))
      .toThrow(/must require mutation approval/);
    expect(() => operationsCatalogSchema.parse({ ...catalog, runbooks: [{ ...catalog.runbooks[0], kind: 'diagnostics', mutatesState: true }] }))
      .toThrow(/must be nonmutating/);
  });
});
