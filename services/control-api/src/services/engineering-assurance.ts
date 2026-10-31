import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import type { DeliveryEvidenceRecord } from './engineering-evidence-ledger.js';
import { engineeringMetricEvidenceSha256 } from './engineering-metric-evidence.js';
import { assessRecoveryExercise, type RecoveryExerciseRecord } from './recovery-exercises.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,159}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

const metricSourceSchema = z.discriminatedUnion('metric', [
  z.object({ metric: z.literal('gpu_queue'), collector: z.literal('application_probe'), sourceKey: id }).strict(),
  z.object({ metric: z.literal('dependency_latency'), collector: z.literal('application_probe'), sourceKey: id }).strict(),
  z.object({ metric: z.literal('backup_age'), collector: z.literal('cron_success'), sourceKey: id }).strict(),
  z.object({ metric: z.literal('certificate_expiry'), collector: z.literal('health_service_expiry'), sourceKey: id,
    detailKey: z.literal('certificateExpiresAt') }).strict(),
  z.object({ metric: z.literal('token_expiry'), collector: z.literal('health_service_expiry'), sourceKey: id,
    detailKey: z.enum(['expiresAt', 'keyExpiry', 'renewalGrantExpiresAt']) }).strict(),
]);

const applicationSchema = z.object({
  id, nodeId: id,
  deploySource: z.string().min(1).max(500),
  runtimePath: z.string().regex(/^\/[a-zA-Z0-9._/@+-]+(?:\/[a-zA-Z0-9._@+-]+)*$/),
  healthContract: z.object({
    method: z.literal('GET'), path: z.string().regex(/^\/[a-zA-Z0-9/_.-]*$/),
    successStatuses: z.array(z.number().int().min(200).max(399)).min(1).max(20),
    maxAgeMs: z.number().int().min(1_000).max(86_400_000),
  }).strict(),
  dataOwner: id,
  recoveryOrder: z.number().int().min(1).max(10_000),
  dependsOn: z.array(id).max(100),
  investigationSequence: z.array(z.string().min(1).max(500)).min(1).max(20),
  recoverySequence: z.array(z.string().min(1).max(500)).min(1).max(20),
  metricSources: z.array(metricSourceSchema).max(5).default([]),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.metricSources.map(source => source.metric)).size !== value.metricSources.length)
    ctx.addIssue({ code: 'custom', message: 'Metric source must be unique per metric', path: ['metricSources'] });
});

const runbookSchema = z.object({
  id, version: id, executionVersion: z.enum(['diagnostics.v1', 'restart-service.v1']),
  kind: z.enum(['diagnostics', 'deploy', 'recovery', 'remediation', 'containment']),
  mutatesState: z.boolean(),
  timeoutSeconds: z.number().int().min(1).max(3_600),
  maxAttempts: z.literal(1),
  command: z.string().regex(/^\/[a-zA-Z0-9._/+@-]+(?:\/[a-zA-Z0-9._+@-]+)*$/),
  args: z.array(z.string().max(500)).max(16),
  preflight: z.array(z.string().min(1).max(500)).min(1).max(20),
  steps: z.array(z.string().min(1).max(500)).min(1).max(30),
  postconditions: z.array(z.string().min(1).max(500)).min(1).max(20),
  directPostcondition: z.object({ kind: z.literal('application_health'), requirement: z.string().min(1).max(500) }).strict(),
  rollbackCriteria: z.array(z.string().min(1).max(500)).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  if (value.postconditions.length !== 1 || value.postconditions[0] !== value.directPostcondition.requirement)
    ctx.addIssue({ code: 'custom', message: 'Direct application health must cover the only postcondition', path: ['directPostcondition'] });
  if (value.kind === 'diagnostics' && value.mutatesState)
    ctx.addIssue({ code: 'custom', message: 'Diagnostics runbooks must be nonmutating', path: ['mutatesState'] });
  if (value.kind !== 'diagnostics' && !value.mutatesState)
    ctx.addIssue({ code: 'custom', message: 'Deploy, recovery, remediation, and containment runbooks must require mutation approval', path: ['mutatesState'] });
});

export const operationsCatalogSchema = z.object({
  schemaVersion: z.literal(1), applications: z.array(applicationSchema).max(200),
  runbooks: z.array(runbookSchema).max(100),
}).strict().superRefine((value, ctx) => {
  const appIds = new Set(value.applications.map((app) => app.id));
  if (appIds.size !== value.applications.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate application id' });
  if (new Set(value.runbooks.map((runbook) => `${runbook.id}@${runbook.version}`)).size !== value.runbooks.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate runbook revision' });
  if (new Set(value.applications.map((app) => app.recoveryOrder)).size !== value.applications.length)
    ctx.addIssue({ code: 'custom', message: 'Recovery order must be unambiguous', path: ['applications'] });
  const byId = new Map(value.applications.map((app) => [app.id, app]));
  for (const app of value.applications) for (const dependency of app.dependsOn) {
    if (!appIds.has(dependency)) ctx.addIssue({ code: 'custom', message: `Unknown dependency ${dependency}`, path: ['applications'] });
    if (dependency === app.id) ctx.addIssue({ code: 'custom', message: 'Application cannot depend on itself', path: ['applications'] });
    if ((byId.get(dependency)?.recoveryOrder ?? 0) >= app.recoveryOrder)
      ctx.addIssue({ code: 'custom', message: `Dependency ${dependency} must recover before ${app.id}`, path: ['applications'] });
  }
  const dependencies = new Map(value.applications.map((app) => [app.id, app.dependsOn]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (applicationId: string): boolean => {
    if (visiting.has(applicationId)) return true;
    if (visited.has(applicationId)) return false;
    visiting.add(applicationId);
    if ((dependencies.get(applicationId) ?? []).some(visit)) return true;
    visiting.delete(applicationId); visited.add(applicationId); return false;
  };
  if (value.applications.some((app) => visit(app.id))) ctx.addIssue({ code: 'custom', message: 'Dependency cycle detected', path: ['applications'] });
});
export type OperationsCatalog = z.infer<typeof operationsCatalogSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sha256(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function catalogDigest(catalog: OperationsCatalog): string {
  return sha256({ schemaVersion: catalog.schemaVersion, applications: catalog.applications, runbooks: catalog.runbooks });
}

export function loadOperationsCatalog(path = process.env['MAGNUS_OPERATIONS_CATALOG_FILE']): OperationsCatalog & { catalogSha256: string } {
  if (!path) throw new Error('MAGNUS_OPERATIONS_CATALOG_FILE is not configured');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000 || (stat.mode & 0o022))
    throw new Error('Unsafe operations catalog');
  const parsed = operationsCatalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  return { ...parsed, catalogSha256: catalogDigest(parsed) };
}
export function assertCatalogInventory(catalog: OperationsCatalog, inventoryNodeIds: ReadonlySet<string>): void {
  const missing = [...new Set(catalog.applications.map((app) => app.nodeId))].filter((nodeId) => !inventoryNodeIds.has(nodeId));
  if (missing.length) throw new HttpError(409, 'OPERATIONS_CATALOG_INVENTORY_DRIFT',
    `Operations catalog references nodes absent from Magnus inventory: ${missing.join(', ')}`);
}
export async function loadInventoryBoundOperationsCatalog() {
  const catalog = loadOperationsCatalog();
  const nodeIds = [...new Set(catalog.applications.map((app) => app.nodeId))];
  const rows = await getDb().node.findMany({ where: { id: { in: nodeIds } }, select: { id: true }, take: 200 });
  assertCatalogInventory(catalog, new Set(rows.map((row) => row.id)));
  return catalog;
}

export const dependencyFailureSchema = z.object({
  failedApplicationId: id,
}).strict();
export interface RecordedApplicationObservation {
  id: string;
  projectId: string;
  serviceId: string;
  nodeId: string;
  status: string;
  resultJson: string;
  observedAt: Date | null;
}
export interface RecordedProbeContract {
  id: string;
  projectId: string;
  serviceId: string;
  nodeId: string;
  healthPath: string;
  probeContractSha256: string;
  checks?: readonly { sourceKey: string; method: 'GET' | 'POST'; path: string }[];
}
type RetainedProbeResult = { status?: unknown; probeContractSha256?: unknown; checks?: unknown; releaseRevision?: unknown };
function bindApplicationObservation(app: OperationsCatalog['applications'][number], row: RecordedApplicationObservation | undefined,
  contract: RecordedProbeContract | undefined, now: number) {
  let retained: RetainedProbeResult | null = null;
  try { retained = row ? JSON.parse(row.resultJson) as RetainedProbeResult : null; } catch { retained = null; }
  const checks = retained && Array.isArray(retained.checks) ? retained.checks : [];
  const health = checks.find((check): check is Record<string, unknown> => Boolean(check && typeof check === 'object'
    && !Array.isArray(check) && check['name'] === 'reachability'));
  const httpStatus = health?.['httpStatus'];
  const healthStatus = health?.['status'];
  const statusContractValid = (typeof httpStatus === 'number' && Number.isInteger(httpStatus))
    ? (app.healthContract.successStatuses.includes(httpStatus)
        ? healthStatus === 'pass' || healthStatus === 'fail'
        : healthStatus === 'fail')
    : httpStatus === null && health?.['status'] === 'fail';
  const probeContractValid = Boolean(contract && row
    && contract.id === app.id && contract.nodeId === app.nodeId
    && row.projectId === contract.projectId && row.serviceId === contract.serviceId
    && row.nodeId === contract.nodeId && app.healthContract.method === 'GET'
    && app.healthContract.path === contract.healthPath
    && retained?.status === row.status && ['pass', 'fail', 'unknown', 'unconfigured'].includes(row.status)
    && retained?.probeContractSha256 === contract.probeContractSha256
    && health?.['method'] === app.healthContract.method && health?.['path'] === app.healthContract.path
    && statusContractValid);
  const durablyBound = Boolean(row && probeContractValid && row.observedAt
    && row.observedAt.getTime() <= now + 30_000 && now - row.observedAt.getTime() <= app.healthContract.maxAgeMs);
  const observedStatus = !durablyBound ? 'unknown' : row!.status === 'pass' ? 'healthy' : row!.status === 'fail' ? 'failed' : 'unknown';
  return {
    applicationId: app.id,
    observedStatus,
    observedAt: durablyBound ? row!.observedAt!.toISOString() : null,
    releaseRevision: durablyBound && typeof retained?.releaseRevision === 'string' ? retained.releaseRevision : null,
    evidenceSha256: durablyBound ? sha256({ id: row!.id, projectId: row!.projectId, serviceId: row!.serviceId,
      nodeId: row!.nodeId, status: row!.status, resultJson: row!.resultJson, observedAt: row!.observedAt!.toISOString() }) : null,
    durablyBound,
    probeContractValid,
  };
}
export function assessDependencyFailure(catalog: OperationsCatalog, input: z.infer<typeof dependencyFailureSchema>,
  recordedObservations: readonly RecordedApplicationObservation[], probeContracts: readonly RecordedProbeContract[], now = Date.now()) {
  const failed = catalog.applications.find((app) => app.id === input.failedApplicationId);
  if (!failed) throw new Error('Failed application is absent from the authoritative catalog');
  const affected = new Set([failed.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const app of catalog.applications) if (!affected.has(app.id) && app.dependsOn.some((dep) => affected.has(dep))) {
      affected.add(app.id); changed = true;
    }
  }
  const applications = catalog.applications.filter((app) => affected.has(app.id)).sort((a, b) => a.recoveryOrder - b.recoveryOrder);
  const observations = new Map(recordedObservations.map((row) => [row.id, row]));
  const contracts = new Map(probeContracts.map((contract) => [contract.id, contract]));
  const evidenceRows = applications.map((app) => bindApplicationObservation(app, observations.get(app.id), contracts.get(app.id), now));
  const evidenceByApplication = new Map(evidenceRows.map((row) => [row.applicationId, row]));
  const failedEvidence = evidenceByApplication.get(failed.id)!;
  const failureDurablyObserved = failedEvidence.durablyBound && failedEvidence.observedStatus === 'failed';
  const durableObservationsComplete = evidenceRows.every((row) => row.durablyBound && row.observedStatus !== 'unknown');
  return {
    schemaVersion: 1, catalogSha256: catalogDigest(catalog), failedApplicationId: failed.id,
    affectedApplications: applications.map((app) => ({ id: app.id, nodeId: app.nodeId, deploySource: app.deploySource, runtimePath: app.runtimePath,
      dataOwner: app.dataOwner, recoveryOrder: app.recoveryOrder, healthContract: app.healthContract,
      observedStatus: evidenceByApplication.get(app.id)!.observedStatus,
      observedAt: evidenceByApplication.get(app.id)!.observedAt,
      evidenceSha256: evidenceByApplication.get(app.id)!.evidenceSha256,
      durablyBound: evidenceByApplication.get(app.id)!.durablyBound,
      probeContractValid: evidenceByApplication.get(app.id)!.probeContractValid })),
    investigationSequence: applications.flatMap((app) => app.investigationSequence.map((step) => ({ applicationId: app.id, step }))),
    recoverySequence: applications.flatMap((app) => app.recoverySequence.map((step) => ({ applicationId: app.id, step }))),
    provenance: 'magnus_application_observations' as const,
    failureDurablyObserved, durableObservationsComplete,
  };
}

export const runbookAssessmentSchema = z.object({
  runbookId: id, runbookVersion: id, applicationId: id, planSha256: digest, leaseId: id,
  approvalExecutionId: id.optional(),
}).strict();
export interface RecordedApproval { decisionId: string; executionId: string | null; planSha256: string; decision: string; decidedAt: Date; expiresAt: Date }
export interface RecordedLease { id: string; nodeId: string; commandId: string; state: string; deadline: Date; acquiredAt: Date;
  dispatchedAt: Date | null; settledAt: Date | null; evidenceSha256: string | null }
export interface RecordedExecutionBinding { commandId: string; nodeId: string; applicationId: string | null;
  runbookVersion: string; command: string; args: string[]; timeoutSeconds: number;
  telegramExecutionId: string | null; decisionId: string | null; approvalPlanSha256: string;
  catalogPlanSha256: string | null }
export function catalogRunbookPlan(catalog: OperationsCatalog, runbookId: string, runbookVersion: string, applicationId: string) {
  const runbook = catalog.runbooks.find(candidate => candidate.id === runbookId && candidate.version === runbookVersion);
  const target = catalog.applications.find(candidate => candidate.id === applicationId);
  if (!runbook || !target) return null;
  return { runbookId: runbook.id, runbookVersion: runbook.version, executionVersion: runbook.executionVersion,
    applicationId, nodeId: target.nodeId, kind: runbook.kind, mutatesState: runbook.mutatesState,
    command: runbook.command, args: runbook.args, timeoutSeconds: runbook.timeoutSeconds, maxAttempts: runbook.maxAttempts,
    preflight: runbook.preflight, steps: runbook.steps, postconditions: runbook.postconditions,
    directPostcondition: runbook.directPostcondition, rollbackCriteria: runbook.rollbackCriteria };
}
export function catalogRunbookPlanSha256(catalog: OperationsCatalog, runbookId: string, runbookVersion: string, applicationId: string) {
  const plan = catalogRunbookPlan(catalog, runbookId, runbookVersion, applicationId);
  return plan ? sha256(plan) : null;
}
export function assessRunbook(catalog: OperationsCatalog, input: z.infer<typeof runbookAssessmentSchema>,
  recordedApproval: RecordedApproval | null, recordedLease: RecordedLease | null,
  executionBinding: RecordedExecutionBinding | null, recordedObservation: RecordedApplicationObservation | undefined,
  probeContract: RecordedProbeContract | undefined, now = Date.now()) {
  const runbook = catalog.runbooks.find((r) => r.id === input.runbookId && r.version === input.runbookVersion);
  if (!runbook) throw new Error('Runbook revision is not approved in the authoritative catalog');
  if (!catalog.applications.some((app) => app.id === input.applicationId)) throw new Error('Runbook target is absent from the authoritative catalog');
  const target = catalog.applications.find((app) => app.id === input.applicationId)!;
  const catalogPlanSha256 = catalogRunbookPlanSha256(catalog, runbook.id, runbook.version, input.applicationId)!;
  const actionAt = recordedLease?.dispatchedAt?.getTime() ?? Number.NaN;
  const catalogBindingValid = Boolean(executionBinding && recordedLease && executionBinding.commandId === recordedLease.commandId
    && executionBinding.nodeId === target.nodeId && executionBinding.applicationId === target.id
    && executionBinding.runbookVersion === runbook.executionVersion && executionBinding.command === runbook.command
    && JSON.stringify(executionBinding.args) === JSON.stringify(runbook.args)
    && executionBinding.timeoutSeconds === runbook.timeoutSeconds);
  const expectedPlanSha256 = executionBinding?.catalogPlanSha256 ?? null;
  const approvalValid = !runbook.mutatesState || Boolean(input.approvalExecutionId && recordedApproval && executionBinding
    && recordedApproval.executionId === input.approvalExecutionId && recordedApproval.decision === 'approve'
    && executionBinding.telegramExecutionId === input.approvalExecutionId && executionBinding.decisionId === recordedApproval.decisionId
    && recordedApproval.planSha256 === executionBinding.approvalPlanSha256 && recordedApproval.decidedAt.getTime() <= actionAt
    && recordedApproval.expiresAt.getTime() > actionAt);
  const leaseValid = Boolean(recordedLease && recordedLease.id === input.leaseId && recordedLease.nodeId === target.nodeId
    && recordedLease.commandId === executionBinding?.commandId && recordedLease.state === 'released'
    && recordedLease.acquiredAt.getTime() <= actionAt && recordedLease.deadline.getTime() >= actionAt
    && recordedLease.dispatchedAt && recordedLease.dispatchedAt.getTime() <= actionAt
    && recordedLease.settledAt && recordedLease.settledAt.getTime() >= actionAt
    && recordedLease.evidenceSha256 !== null && digest.safeParse(recordedLease.evidenceSha256).success);
  const catalogPlanDigestValid = input.planSha256 === catalogPlanSha256 && expectedPlanSha256 === catalogPlanSha256;
  const executionDurablyBound = catalogPlanDigestValid && catalogBindingValid && approvalValid && leaseValid;
  const applicationEvidence = bindApplicationObservation(target, recordedObservation, probeContract, now);
  const directPostconditionVerified = Boolean(runbook.directPostcondition.kind === 'application_health'
    && applicationEvidence.durablyBound && applicationEvidence.observedStatus === 'healthy'
    && recordedLease?.settledAt && applicationEvidence.observedAt
    && Date.parse(applicationEvidence.observedAt) >= recordedLease.settledAt.getTime());
  const verified = executionDurablyBound && directPostconditionVerified;
  return { schemaVersion: 2, verified, provenance: 'durable_execution_and_application_probe' as const,
    executionDurablyBound, directPostconditionVerified, expectedPlanSha256, catalogPlanSha256,
    catalogPlanDigestValid, catalogBindingValid, approvalValid, leaseValid, noBlindRetry: runbook.maxAttempts === 1,
    directPostcondition: runbook.directPostcondition, applicationEvidence,
    reason: verified ? null : 'Plan, permission, settled lease, or direct postcondition evidence is incomplete' };
}

export const deliveryAssessmentSchema = z.object({
  requestId: id,
}).strict();
export interface RecordedReleaseCanary { acceptedCommit: string; sourceTreeSha256: string; createdAt: Date }
export function assessDelivery(catalog: OperationsCatalog, input: z.infer<typeof deliveryAssessmentSchema>,
  record: DeliveryEvidenceRecord | undefined, canary: RecordedReleaseCanary | null,
  recordedObservation: RecordedApplicationObservation | undefined, probeContract: RecordedProbeContract | undefined,
  ledgerSha256: string, now = Date.now()) {
  if (!record || record.requestId !== input.requestId) return { schemaVersion: 2, verified: false,
    provenance: 'pinned_engineering_evidence_ledger' as const, requestId: input.requestId,
    reason: 'No direct delivery evidence receipt exists for this request', ledgerSha256 };
  const application = catalog.applications.find(candidate => candidate.id === record.applicationId);
  if (!application) throw new Error('Delivery application is absent from the authoritative catalog');
  const revision = record.source.workingRevision;
  const deploySourceValid = record.deploySource === application.deploySource;
  const revisionsMatch = record.source.mainRevision === revision && record.source.remoteRevision === revision
    && record.ci.revision === revision && record.review.revision === revision
    && record.tests.every(test => test.revision === revision)
    && (!record.deployment || record.deployment.revision === revision);
  const testTimes = record.tests.map(test => Date.parse(test.observedAt));
  const reviewAt = Date.parse(record.review.observedAt); const ciAt = Date.parse(record.ci.observedAt);
  const receiptAt = Date.parse(record.recordedAt);
  const chronologyValid = [...testTimes, reviewAt, ciAt, receiptAt].every(timestamp => timestamp <= now + 30_000)
    && testTimes.every(timestamp => timestamp <= reviewAt && timestamp <= ciAt)
    && reviewAt <= receiptAt && ciAt <= receiptAt
    && (!record.deployment || Date.parse(record.deployment.deployedAt) <= receiptAt);
  const deploymentRequired = record.establishedProductionWorkflow && !record.documentationOnly;
  const deploymentIdentityValid = Boolean(record.deployment
    && record.deployment.applicationId === application.id
    && record.deployment.deploySource === application.deploySource
    && record.deployment.sourceTreeSha256 === record.source.sourceTreeSha256
    && Date.parse(record.deployment.deployedAt) <= now + 30_000);
  const canaryValid = Boolean(canary && canary.acceptedCommit === revision
    && canary.sourceTreeSha256 === record.source.sourceTreeSha256
    && canary.createdAt.getTime() >= reviewAt && canary.createdAt.getTime() >= ciAt
    && canary.createdAt.getTime() <= now + 30_000
    && record.deployment && canary.createdAt.getTime() <= Date.parse(record.deployment.deployedAt));
  const applicationEvidence = bindApplicationObservation(application, recordedObservation, probeContract, now);
  const postDeployHealthValid = Boolean(canaryValid && applicationEvidence.durablyBound
    && applicationEvidence.observedStatus === 'healthy' && applicationEvidence.releaseRevision === revision
    && applicationEvidence.observedAt && record.deployment
    && Date.parse(applicationEvidence.observedAt) >= Date.parse(record.deployment.deployedAt));
  const deploymentVerified = deploymentRequired ? deploymentIdentityValid && canaryValid && postDeployHealthValid : true;
  const verified = deploySourceValid && revisionsMatch && chronologyValid && deploymentVerified;
  return { schemaVersion: 2, verified, provenance: 'pinned_engineering_evidence_ledger' as const,
    requestId: record.requestId, applicationId: record.applicationId, revision, revisionsMatch, chronologyValid,
    deploySourceValid, deploymentRequired, deploymentIdentityValid, deploymentVerified, canaryValid, postDeployHealthValid, applicationEvidence,
    receiptSha256: record.receiptSha256, ledgerSha256, limitations: record.limitations,
    reason: verified ? null : 'Repository, tests, review, CI, release canary, or post-deploy health evidence is incomplete' };
}

export const forecastAssessmentSchema = z.object({
  applicationId: id,
  metric: z.enum(['disk', 'memory', 'gpu_queue', 'backup_age', 'certificate_expiry', 'token_expiry', 'dependency_latency']),
  diskMountPoint: z.string().regex(/^\/(?:[a-zA-Z0-9._@+-]+(?:\/[a-zA-Z0-9._@+-]+)*)?$/).max(500)
    .refine(value => !value.split('/').some(segment => segment === '..'), 'diskMountPoint cannot traverse').optional(),
  threshold: z.number().finite().min(0).max(1_000_000_000_000), breachDirection: z.enum(['above', 'below']),
  maxSampleAgeMs: z.number().int().min(60_000).max(2_592_000_000),
  maxWindowMs: z.number().int().min(60_000).max(31_536_000_000),
}).strict().superRefine((value, ctx) => {
  if (value.metric === 'disk' && !value.diskMountPoint)
    ctx.addIssue({ code: 'custom', message: 'diskMountPoint is required for disk forecasts', path: ['diskMountPoint'] });
  if (value.metric === 'memory' && value.diskMountPoint)
    ctx.addIssue({ code: 'custom', message: 'diskMountPoint is only valid for disk forecasts', path: ['diskMountPoint'] });
  if (!['disk', 'memory'].includes(value.metric) && value.diskMountPoint)
    ctx.addIssue({ code: 'custom', message: 'diskMountPoint is only valid for disk forecasts', path: ['diskMountPoint'] });
  if (['disk', 'memory'].includes(value.metric) && value.threshold > 100)
    ctx.addIssue({ code: 'custom', message: 'Percent thresholds cannot exceed 100', path: ['threshold'] });
});
export interface RecordedHealthSnapshot {
  id: string;
  nodeId: string;
  timestamp: Date;
  memoryPercent: number;
  disks: string;
  services?: string;
  source: string;
}
export interface RecordedEngineeringMetricSample {
  id: string; applicationId: string; nodeId: string; metric: string; sourceKey: string; unit: string;
  value: number; observedAt: Date; probeContractSha256: string; method: string; path: string;
  httpStatus: number; evidenceSha256: string;
}
export interface RecordedCronExecution {
  id: string; cronJobId: string; nodeId: string; startedAt: Date; completedAt: Date | null; exitCode: number | null;
}
type ForecastSample = { observedAt: string; value: number; evidenceSha256: string; source: string };
function assessDurableForecast(input: z.infer<typeof forecastAssessmentSchema>, samples: ForecastSample[],
  evidenceWindowComplete: boolean, unit: string, provenance: string, now = Date.now()) {
  if (samples.length < 3) return {
    schemaVersion: 3, applicationId: input.applicationId, metric: input.metric, unit,
    diskMountPoint: input.diskMountPoint ?? null, sampleCount: samples.length, window: null,
    trendPerDay: null, confidence: null, timestampsValid: false, sustainedBreach: false,
    evidenceWindowComplete, durablyMeasured: false, provenance,
    candidateAlert: false, evidenceSetSha256: sha256(samples),
    reason: 'At least three durable Magnus source samples are required',
  };
  const t0 = Date.parse(samples[0]!.observedAt); const day = 86_400_000;
  const xs = samples.map((s) => (Date.parse(s.observedAt) - t0) / day); const ys = samples.map((s) => s.value);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length; const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const denominator = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  const slope = denominator ? xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index]! - my), 0) / denominator : 0;
  const residual = ys.reduce((sum, y, index) => sum + (y - (my + slope * (xs[index]! - mx))) ** 2, 0);
  const total = ys.reduce((sum, y) => sum + (y - my) ** 2, 0);
  const confidence = total === 0 ? 1 : Math.max(0, Math.min(1, 1 - residual / total));
  const breaches = samples.slice(-3).map((s) => input.breachDirection === 'above' ? s.value >= input.threshold : s.value <= input.threshold);
  const latestAt = Date.parse(samples.at(-1)!.observedAt);
  const timestampsValid = samples.every((sample, index) => Date.parse(sample.observedAt) <= now
      && (index === 0 || Date.parse(sample.observedAt) > Date.parse(samples[index - 1]!.observedAt)))
    && latestAt >= now - input.maxSampleAgeMs
    && Date.parse(samples[0]!.observedAt) >= now - input.maxWindowMs
    && latestAt - Date.parse(samples[0]!.observedAt) <= input.maxWindowMs;
  const durablyMeasured = timestampsValid && evidenceWindowComplete;
  return { schemaVersion: 3, applicationId: input.applicationId, metric: input.metric, unit,
    diskMountPoint: input.diskMountPoint ?? null, sampleCount: samples.length,
    window: { start: samples[0]!.observedAt, end: samples.at(-1)!.observedAt }, trendPerDay: slope,
    confidence, timestampsValid, sustainedBreach: breaches.length === 3 && breaches.every(Boolean),
    evidenceWindowComplete, durablyMeasured, provenance,
    candidateAlert: durablyMeasured && breaches.length === 3 && breaches.every(Boolean),
    evidenceSetSha256: sha256(samples), reason: durablyMeasured ? null : 'Source evidence is stale, unordered, or truncated' };
}
export function assessForecast(catalog: OperationsCatalog, input: z.infer<typeof forecastAssessmentSchema>,
  evidenceRows: { healthSnapshots?: readonly RecordedHealthSnapshot[]; metricSamples?: readonly RecordedEngineeringMetricSample[];
    cronExecutions?: readonly RecordedCronExecution[]; probeContract?: RecordedProbeContract }, evidenceWindowComplete = true, now = Date.now()) {
  const application = catalog.applications.find((app) => app.id === input.applicationId);
  if (!application) throw new Error('Forecast target is absent from the authoritative catalog');
  const source = application.metricSources.find(candidate => candidate.metric === input.metric);
  if (!['disk', 'memory'].includes(input.metric) && !source) return {
    schemaVersion: 3, applicationId: input.applicationId, nodeId: application.nodeId, metric: input.metric,
    unit: null, sampleCount: 0, window: null, trendPerDay: null, confidence: null, timestampsValid: false,
    sustainedBreach: false, evidenceWindowComplete, durablyMeasured: false, candidateAlert: false,
    provenance: 'unconfigured', evidenceSetSha256: sha256([]), reason: 'No authoritative metric source is configured',
  };
  const byTimestamp = new Map<number, RecordedHealthSnapshot>();
  for (const row of [...(evidenceRows.healthSnapshots ?? [])].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id))) {
    if (row.nodeId === application.nodeId) byTimestamp.set(row.timestamp.getTime(), row);
  }
  const samples: ForecastSample[] = [];
  if (input.metric === 'disk' || input.metric === 'memory') for (const row of byTimestamp.values()) {
    let value: number | null = null;
    if (input.metric === 'memory' && Number.isFinite(row.memoryPercent) && row.memoryPercent >= 0 && row.memoryPercent <= 100)
      value = row.memoryPercent;
    if (input.metric === 'disk') {
      try {
        const disks = JSON.parse(row.disks) as unknown;
        if (Array.isArray(disks)) {
          const disk = disks.find((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'
            && !Array.isArray(item) && item['mountPoint'] === input.diskMountPoint));
          const usage = disk?.['usagePercent'];
          if (typeof usage === 'number' && Number.isFinite(usage) && usage >= 0 && usage <= 100) value = usage;
        }
      } catch { /* malformed retained telemetry is omitted and cannot become evidence */ }
    }
    if (value === null) continue;
    const observedAt = row.timestamp.toISOString();
    samples.push({ observedAt, value, source: 'magnus-health-snapshot',
      evidenceSha256: sha256({ id: row.id, nodeId: row.nodeId, timestamp: observedAt,
        memoryPercent: row.memoryPercent, disks: row.disks, source: row.source }) });
  }
  if (source?.collector === 'application_probe') {
    const expectedUnit = input.metric === 'gpu_queue' ? 'jobs' : 'ms';
    const currentContract = evidenceRows.probeContract;
    const expectedCheck = currentContract?.checks?.find(check => check.sourceKey === source.sourceKey);
    const rows = [...(evidenceRows.metricSamples ?? [])].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime() || a.id.localeCompare(b.id));
    const direct = new Map<number, RecordedEngineeringMetricSample>();
    for (const row of rows) if (row.applicationId === application.id && row.nodeId === application.nodeId
      && row.metric === input.metric && row.sourceKey === source.sourceKey && row.unit === expectedUnit
      && Number.isFinite(row.value) && row.value >= 0 && currentContract?.id === application.id
      && currentContract.nodeId === application.nodeId && row.probeContractSha256 === currentContract.probeContractSha256
      && expectedCheck && row.method === expectedCheck.method && row.path === expectedCheck.path
      && Number.isInteger(row.httpStatus) && row.httpStatus >= 200 && row.httpStatus <= 399
      && engineeringMetricEvidenceSha256(row) === row.evidenceSha256)
      direct.set(row.observedAt.getTime(), row);
    for (const row of direct.values()) samples.push({ observedAt: row.observedAt.toISOString(), value: row.value,
      evidenceSha256: row.evidenceSha256, source: `application-probe:${source.sourceKey}` });
  }
  if (source?.collector === 'health_service_expiry') for (const row of byTimestamp.values()) {
    try {
      const services = JSON.parse(row.services ?? '[]') as unknown;
      if (!Array.isArray(services)) continue;
      const service = services.find((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'
        && !Array.isArray(item) && item['name'] === source.sourceKey));
      const details = typeof service?.['details'] === 'string' ? JSON.parse(service['details']) as unknown : service?.['details'];
      if (!details || typeof details !== 'object' || Array.isArray(details)) continue;
      const expiry = (details as Record<string, unknown>)[source.detailKey];
      if (typeof expiry !== 'string') continue;
      const expiresAt = Date.parse(expiry); if (!Number.isFinite(expiresAt)) continue;
      samples.push({ observedAt: row.timestamp.toISOString(), value: Math.max(0, (expiresAt - row.timestamp.getTime()) / 86_400_000),
        source: `health-service:${source.sourceKey}:${source.detailKey}`,
        evidenceSha256: sha256({ id: row.id, nodeId: row.nodeId, timestamp: row.timestamp.toISOString(),
          services: row.services, source: row.source, sourceKey: source.sourceKey, detailKey: source.detailKey }) });
    } catch { /* malformed retained service telemetry is omitted */ }
  }
  if (source?.collector === 'cron_success') {
    const executions = [...(evidenceRows.cronExecutions ?? [])].filter(row => row.cronJobId === source.sourceKey
      && row.nodeId === application.nodeId && row.exitCode === 0 && row.completedAt)
      .sort((a, b) => a.completedAt!.getTime() - b.completedAt!.getTime());
    let executionIndex = 0; let latest: RecordedCronExecution | undefined;
    for (const row of byTimestamp.values()) {
      while (executionIndex < executions.length
        && executions[executionIndex]!.completedAt!.getTime() <= row.timestamp.getTime())
        latest = executions[executionIndex++];
      if (!latest) continue;
      samples.push({ observedAt: row.timestamp.toISOString(), value: (row.timestamp.getTime() - latest.completedAt!.getTime()) / 86_400_000,
        source: `cron-success:${source.sourceKey}`,
        evidenceSha256: sha256({ healthSnapshotId: row.id, cronExecutionId: latest.id, nodeId: row.nodeId,
          timestamp: row.timestamp.toISOString(), completedAt: latest.completedAt!.toISOString(), exitCode: latest.exitCode }) });
    }
  }
  const unit = input.metric === 'disk' || input.metric === 'memory' ? 'percent'
    : input.metric === 'gpu_queue' ? 'jobs' : input.metric === 'dependency_latency' ? 'ms' : 'days';
  const provenance = input.metric === 'disk' || input.metric === 'memory' ? 'magnus_health_snapshots'
    : source?.collector === 'application_probe' ? 'magnus_engineering_metric_samples'
      : source?.collector === 'cron_success' ? 'magnus_cron_execution_history' : 'magnus_health_service_snapshots';
  return { ...assessDurableForecast(input, samples, evidenceWindowComplete, unit, provenance, now),
    nodeId: application.nodeId };
}

export const restoreAssessmentSchema = z.object({
  exerciseId: id,
}).strict();
export function assessRestore(input: z.infer<typeof restoreAssessmentSchema>, record: RecoveryExerciseRecord | undefined,
  productionIdentityFound: boolean, now = Date.now(), assessmentInventorySnapshotSha256: string | null = null) {
  return assessRecoveryExercise(input.exerciseId, record, productionIdentityFound, now, assessmentInventorySnapshotSha256);
}
