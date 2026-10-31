import { applicationProbeContractDigest, getApplicationProbeCollectorStatus } from '../services/application-probes.js';
import { lessonSchema, publishLesson, lessonSuggestions, supersedeLesson } from '../services/incident-lessons.js';
import { exportIncidentEvidence } from '../services/incident-evidence.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { authMiddleware, getUser, requireRole } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import {
  getDependencyHealth,
  getFleetReadiness,
  getFleetTimeline,
  getPredictiveMaintenance,
  getIncidentSummary,
  classifyRemediationPlan,
  getHermesEffectiveState,
  getPackageSecurityPosture,
  getRetentionSummary,
  getTraceDependencyMap,
} from '../services/ops-service.js';

import { getOperationalObservations, getCapacityAdvice } from '../services/operational-observations.js';
import { getDb } from '../db/index.js';
import { getApplicationConfigs } from '../services/operations-config.js';
import { maintenanceSchema } from '../services/maintenance-service.js';
import { parseBody } from '../utils/validate.js';
import { logAuditEvent } from '../services/audit-service.js';
import { getCodexFleetPosture } from '../services/codex-service.js';
import { describeRemediationPlan } from '../services/team-approvals.js';
import {
  assessDelivery,
  assessDependencyFailure,
  assessForecast,
  assessRestore,
  assessRunbook,
  deliveryAssessmentSchema,
  dependencyFailureSchema,
  forecastAssessmentSchema,
  loadInventoryBoundOperationsCatalog,
  restoreAssessmentSchema,
  runbookAssessmentSchema,
} from '../services/engineering-assurance.js';
import { loadEngineeringEvidenceLedger } from '../services/engineering-evidence-ledger.js';
import { loadRecoveryExerciseAssessmentEvidence } from '../services/recovery-exercises.js';

export const opsRouter = new Hono<AppVariables>();

opsRouter.use('*', authMiddleware);

opsRouter.get('/dependency-health', async (c) => c.json({ success: true, data: await getDependencyHealth() }));
opsRouter.get('/readiness', async (c) => c.json({ success: true, data: await getFleetReadiness() }));
opsRouter.get('/timeline', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? '80'), 200);
  return c.json({ success: true, data: await getFleetTimeline(limit) });
});
opsRouter.get('/retention', async (c) => c.json({ success: true, data: await getRetentionSummary() }));
opsRouter.get('/trace-map', async (c) => c.json({ success: true, data: await getTraceDependencyMap() }));
opsRouter.get('/predictive-maintenance', async (c) => c.json({ success: true, data: await getPredictiveMaintenance() }));
opsRouter.get('/incident-summary', async (c) => {
  const nodeId = c.req.query('nodeId') ?? undefined;
  const hours = Math.min(Number(c.req.query('hours') ?? '24'), 168);
  return c.json({ success: true, data: await getIncidentSummary(nodeId, hours) });
});
opsRouter.post('/remediation-plan/classify', async (c) => {
  const body = await c.req.json<{ description?: string }>();
  return c.json({ success: true, data: classifyRemediationPlan(body.description ?? '') });
});
opsRouter.get('/hermes-effective-state', async (c) => c.json({ success: true, data: await getHermesEffectiveState() }));
opsRouter.get('/package-security-posture', async (c) => c.json({ success: true, data: await getPackageSecurityPosture() }));
opsRouter.get('/codex-fleet-status', (c) => c.json({ success: true, data: getCodexFleetPosture() }));

opsRouter.get('/observations', async c => c.json({ success: true, data: await getOperationalObservations() }));
opsRouter.get('/capacity-advice', async c => c.json({ success: true, data: await getCapacityAdvice() }));
opsRouter.get('/engineering/catalog', requireRole('ADMIN', 'OPERATOR'), async c => {
  const catalog = await loadInventoryBoundOperationsCatalog();
  return c.json({ success: true, data: catalog });
});
opsRouter.post('/engineering/dependency-impact', requireRole('ADMIN', 'OPERATOR'), async c => {
  const body = await parseBody(c, dependencyFailureSchema);
  const catalog = await loadInventoryBoundOperationsCatalog();
  if (!catalog.applications.some(application => application.id === body.failedApplicationId))
    throw new HttpError(409, 'OPERATIONS_CATALOG_TARGET_MISSING', 'Failed application is absent from the authoritative catalog');
  const observations = await getDb().applicationObservation.findMany({
    where: { id: { in: catalog.applications.map(application => application.id) } },
    select: { id: true, projectId: true, serviceId: true, nodeId: true, status: true, resultJson: true, observedAt: true },
    take: 200,
    orderBy: { id: 'asc' },
  });
  const probeContracts = getApplicationConfigs().map(config => ({ id: config.id, projectId: config.projectId,
    serviceId: config.serviceId, nodeId: config.nodeId, healthPath: config.healthPath,
    probeContractSha256: applicationProbeContractDigest(config) }));
  return c.json({ success: true, data: assessDependencyFailure(catalog, body, observations, probeContracts) });
});
opsRouter.post('/engineering/runbook-assessment', requireRole('ADMIN', 'OPERATOR'), async c => {
  const body = await parseBody(c, runbookAssessmentSchema);
  const catalog = await loadInventoryBoundOperationsCatalog();
  const target = catalog.applications.find(application => application.id === body.applicationId);
  if (!target) throw new HttpError(409, 'OPERATIONS_CATALOG_TARGET_MISSING', 'Runbook target is absent from the authoritative catalog');
  const approval = body.approvalExecutionId ? await getDb().teamApprovalDecision.findUnique({
    where: { executionId: body.approvalExecutionId },
    select: { decisionId: true, executionId: true, planSha256: true, decision: true, decidedAt: true, expiresAt: true },
  }) : null;
  const lease = await getDb().commandResourceLease.findUnique({
    where: { id: body.leaseId },
    select: { id: true, nodeId: true, commandId: true, state: true, deadline: true, acquiredAt: true,
      dispatchedAt: true, settledAt: true, evidenceSha256: true },
  });
  const command = lease ? await getDb().remoteCommand.findUnique({ where: { id: lease.commandId },
    select: { id: true, nodeId: true, correlationId: true, command: true, args: true, timeoutSeconds: true } }) : null;
  let executionBinding = null;
  if (command?.correlationId?.startsWith('remediation_')) {
    const remediation = await getDb().remediationExecution.findUnique({ where: { id: command.correlationId.slice('remediation_'.length) } });
    if (remediation) {
      try {
        const plan = JSON.parse(remediation.input) as { runbookVersion?: unknown; applicationId?: unknown;
          nodeId?: unknown; command?: unknown; args?: unknown; timeoutSeconds?: unknown; catalogPlanSha256?: unknown };
        const output = JSON.parse(remediation.output ?? '{}') as { telegramExecutionId?: unknown; telegramDecisionId?: unknown };
        const view = describeRemediationPlan(remediation);
        const args = JSON.parse(command.args) as unknown;
        if (typeof plan.runbookVersion === 'string' && typeof plan.command === 'string'
          && Array.isArray(plan.args) && plan.args.every((arg) => typeof arg === 'string')
          && Number.isInteger(plan.timeoutSeconds) && Array.isArray(args) && args.every((arg) => typeof arg === 'string')
          && remediation.nodeId === command.nodeId && (plan.nodeId === undefined || plan.nodeId === command.nodeId)
          && plan.command === command.command && JSON.stringify(plan.args) === JSON.stringify(args)
          && plan.timeoutSeconds === command.timeoutSeconds) executionBinding = {
          commandId: command.id, nodeId: command.nodeId,
          applicationId: typeof plan.applicationId === 'string' ? plan.applicationId : null,
          runbookVersion: plan.runbookVersion,
          command: command.command, args, timeoutSeconds: command.timeoutSeconds,
          telegramExecutionId: typeof output.telegramExecutionId === 'string' ? output.telegramExecutionId : null,
          decisionId: typeof output.telegramDecisionId === 'string' ? output.telegramDecisionId : null,
          approvalPlanSha256: view.plan_sha256,
          catalogPlanSha256: typeof plan.catalogPlanSha256 === 'string' ? plan.catalogPlanSha256 : null,
        };
      } catch { /* malformed stored rows fail the assessment closed */ }
    }
  }
  const observation = await getDb().applicationObservation.findUnique({ where: { id: target.id },
    select: { id: true, projectId: true, serviceId: true, nodeId: true, status: true, resultJson: true, observedAt: true } });
  const probe = getApplicationConfigs().find(config => config.id === target.id);
  const probeContract = probe ? { id: probe.id, projectId: probe.projectId, serviceId: probe.serviceId,
    nodeId: probe.nodeId, healthPath: probe.healthPath, probeContractSha256: applicationProbeContractDigest(probe) } : undefined;
  return c.json({ success: true, data: assessRunbook(catalog, body, approval, lease, executionBinding, observation ?? undefined, probeContract) });
});
opsRouter.post('/engineering/delivery-assessment', requireRole('ADMIN', 'OPERATOR'), async c => {
  const body = await parseBody(c, deliveryAssessmentSchema);
  const catalog = await loadInventoryBoundOperationsCatalog();
  const ledger = loadEngineeringEvidenceLedger();
  const record = ledger.records.filter(candidate => candidate.kind === 'delivery').find(candidate => candidate.requestId === body.requestId);
  if (!record) return c.json({ success: true, data: assessDelivery(catalog, body, undefined, null, undefined, undefined, ledger.ledgerSha256) });
  const canary = await getDb().magnusReleaseCanary.findFirst({ where: { acceptedCommit: record.source.workingRevision,
    sourceTreeSha256: record.source.sourceTreeSha256 }, select: { acceptedCommit: true, sourceTreeSha256: true, createdAt: true },
    orderBy: { createdAt: 'desc' } });
  const observation = await getDb().applicationObservation.findUnique({ where: { id: record.applicationId },
    select: { id: true, projectId: true, serviceId: true, nodeId: true, status: true, resultJson: true, observedAt: true } });
  const probe = getApplicationConfigs().find(config => config.id === record.applicationId);
  const contract = probe ? { id: probe.id, projectId: probe.projectId, serviceId: probe.serviceId,
    nodeId: probe.nodeId, healthPath: probe.healthPath, probeContractSha256: applicationProbeContractDigest(probe) } : undefined;
  return c.json({ success: true, data: assessDelivery(catalog, body, record, canary, observation ?? undefined, contract, ledger.ledgerSha256) });
});
opsRouter.post('/engineering/forecast-assessment', requireRole('ADMIN', 'OPERATOR'), async c => {
  const body = await parseBody(c, forecastAssessmentSchema);
  const catalog = await loadInventoryBoundOperationsCatalog();
  const application = catalog.applications.find(candidate => candidate.id === body.applicationId);
  if (!application)
    throw new HttpError(409, 'OPERATIONS_CATALOG_TARGET_MISSING', 'Forecast target is absent from the authoritative catalog');
  const now = Date.now();
  const source = application.metricSources.find(candidate => candidate.metric === body.metric);
  const needsHealthSnapshots = body.metric === 'disk' || body.metric === 'memory'
    || source?.collector === 'health_service_expiry' || source?.collector === 'cron_success';
  const snapshots = needsHealthSnapshots ? await getDb().healthSnapshot.findMany({
    where: { nodeId: application.nodeId, timestamp: { gte: new Date(now - body.maxWindowMs) } },
    select: { id: true, nodeId: true, timestamp: true, memoryPercent: true, disks: true, services: true, source: true },
    take: 10_001,
    orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
  }) : [];
  const metricSamples = source?.collector === 'application_probe' ? await getDb().engineeringMetricSample.findMany({
    where: { applicationId: application.id, nodeId: application.nodeId, metric: body.metric, sourceKey: source.sourceKey,
      observedAt: { gte: new Date(now - body.maxWindowMs) } },
    select: { id: true, applicationId: true, nodeId: true, metric: true, sourceKey: true, unit: true,
      value: true, observedAt: true, probeContractSha256: true, method: true, path: true,
      httpStatus: true, evidenceSha256: true }, take: 10_001, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
  }) : [];
  const windowStart = new Date(now - body.maxWindowMs);
  const cronExecutionsInWindow = source?.collector === 'cron_success' ? await getDb().cronJobExecution.findMany({
    where: { cronJobId: source.sourceKey, nodeId: application.nodeId,
      completedAt: { gte: windowStart, lte: new Date(now) }, exitCode: 0 },
    select: { id: true, cronJobId: true, nodeId: true, startedAt: true, completedAt: true, exitCode: true },
    take: 10_001, orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
  }) : [];
  const cronPredecessor = source?.collector === 'cron_success' ? await getDb().cronJobExecution.findFirst({
    where: { cronJobId: source.sourceKey, nodeId: application.nodeId, completedAt: { lt: windowStart }, exitCode: 0 },
    select: { id: true, cronJobId: true, nodeId: true, startedAt: true, completedAt: true, exitCode: true },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
  }) : null;
  const cronExecutions = [...cronExecutionsInWindow.slice(0, 10_000), ...(cronPredecessor ? [cronPredecessor] : [])];
  const probe = source?.collector === 'application_probe' ? getApplicationConfigs().find(config => config.id === application.id) : undefined;
  const probeContract = probe ? { id: probe.id, projectId: probe.projectId, serviceId: probe.serviceId,
    nodeId: probe.nodeId, healthPath: probe.healthPath, probeContractSha256: applicationProbeContractDigest(probe),
    checks: [
      { sourceKey: 'reachability', method: 'GET' as const, path: probe.healthPath },
      ...(probe.readinessPath ? [{ sourceKey: 'readiness', method: 'GET' as const, path: probe.readinessPath }] : []),
      ...(probe.queuePath ? [{ sourceKey: 'worker-queue', method: 'GET' as const, path: probe.queuePath }] : []),
    ] } : undefined;
  const evidenceWindowComplete = snapshots.length <= 10_000 && metricSamples.length <= 10_000 && cronExecutionsInWindow.length <= 10_000;
  return c.json({ success: true, data: assessForecast(catalog, body, { healthSnapshots: snapshots.slice(0, 10_000),
    metricSamples: metricSamples.slice(0, 10_000), cronExecutions, probeContract }, evidenceWindowComplete, now) });
});
opsRouter.post('/engineering/restore-assessment', requireRole('ADMIN', 'OPERATOR'), async c => {
  const body = await parseBody(c, restoreAssessmentSchema);
  const evidence = await loadRecoveryExerciseAssessmentEvidence(body.exerciseId);
  return c.json({ success: true, data: assessRestore(body, evidence.record, evidence.productionIdentityFound,
    Date.now(), evidence.inventorySnapshotSha256) });
});
opsRouter.get('/applications', async c => {
  const configs = getApplicationConfigs();
  const rows = await getDb().applicationObservation.findMany({ where: { id: { in: configs.map(config => config.id) } }, take: 100, orderBy: { id: 'asc' } });
  return c.json({ success: true, meta: { collector: getApplicationProbeCollectorStatus() }, data: configs.map(config => {
    const row = rows.find(r => r.id === config.id);
    return { id: config.id, projectId: config.projectId, serviceId: config.serviceId, nodeId: config.nodeId, kind: config.kind,
      status: row?.observedAt && Date.now() - row.observedAt.getTime() < 180000 ? row.status : 'unknown',
      observedAt: row?.observedAt?.toISOString() ?? null, result: JSON.parse(row?.resultJson ?? '{}') };
  }) });
});
opsRouter.get('/maintenance', async c => c.json({ success: true, data: await getDb().maintenanceWindow.findMany({ take: 100, orderBy: { createdAt: 'desc' } }) }));
opsRouter.post('/maintenance', requireRole('ADMIN', 'OPERATOR'), async c => {
  const body = await parseBody(c, maintenanceSchema);
  const actorId = getUser(c).userId;
  const window = await getDb().maintenanceWindow.create({ data: { ...body, nodeIds: JSON.stringify(body.nodeIds), serviceIds: JSON.stringify(body.serviceIds),
    startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt), actorId } });
  await logAuditEvent({ action: 'maintenance.create', actorId, targetType: 'maintenance', targetId: window.id,
    details: { nodeIds: body.nodeIds, serviceIds: body.serviceIds, startsAt: body.startsAt, endsAt: body.endsAt } });
  return c.json({ success: true, data: window }, 201);
});
opsRouter.post('/maintenance/:id/cancel', requireRole('ADMIN', 'OPERATOR'), async c => {
  const window = await getDb().maintenanceWindow.update({ where: { id: c.req.param('id') }, data: { cancelledAt: new Date() } });
  await logAuditEvent({ action: 'maintenance.cancel', actorId: getUser(c).userId, targetType: 'maintenance', targetId: window.id, details: {} });
  return c.json({ success: true, data: window });
});

opsRouter.get('/incidents/:id/evidence', requireRole('ADMIN', 'OPERATOR'), async c => c.json({ success: true, data: await exportIncidentEvidence(c.req.param('id')!) }));
opsRouter.get('/storage-evidence/:nodeId', requireRole('ADMIN', 'OPERATOR'), async c => {
  const node = await getDb().node.findUnique({ where: { id: c.req.param('nodeId')! }, select: { ipAddress: true, port: true } });
  const mount = c.req.query('mount');
  if (!node || !mount || mount.length > 4096) return c.json({ success: false, error: { message: 'Valid node and mount required' } }, 400);
  const host = node.ipAddress.includes(':') ? `[${node.ipAddress}]` : node.ipAddress;
  const response = await fetch(`https://${host}:${node.port}/api/v1/storage-evidence?${new URLSearchParams({ mount })}`, { headers: { 'x-node-token': getNodeManagerSecret() }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  const { boundedJson } = await import('../services/application-probes.js');
  const body = await boundedJson(response);
  await logAuditEvent({ action: 'storage.investigate', actorId: getUser(c).userId, targetType: 'node', targetId: c.req.param('nodeId')!, details: { operation: 'storage-evidence', readOnly: true, success: response.ok } });
  return c.json(body as object, response.ok ? 200 : 502);
});

opsRouter.get('/lessons', requireRole('ADMIN','OPERATOR'), async c => c.json({success:true,data:await lessonSuggestions((c.req.query('query') ?? '').slice(0,500))}));
opsRouter.post('/lessons', requireRole('ADMIN','OPERATOR'), async c => {
  const body=await parseBody(c,lessonSchema);const actorId=getUser(c).userId;
  const data=await publishLesson(body,actorId);
  await logAuditEvent({action:'incident.lesson.publish',actorId,targetType:'incident',targetId:body.incidentId,details:{lessonId:data.id,publication:data.publication}});
  return c.json({success:true,data},201);
});
opsRouter.post('/lessons/:id/supersede', requireRole('ADMIN','OPERATOR'), async c => {
  const data=await supersedeLesson(c.req.param('id')!);
  await logAuditEvent({action:'incident.lesson.supersede',actorId:getUser(c).userId,targetType:'lesson',targetId:data.id,details:{publication:data.publication}});
  return c.json({success:true,data});
});

opsRouter.post('/applications/:id/canary', requireRole('ADMIN','OPERATOR'), async c => {
  const config=getApplicationConfigs().find(a=>a.id===c.req.param('id')&&a.kind==='hive-router');
  const token=config?.tokenEnv?process.env[config.tokenEnv]:undefined;
  if(!config?.canaryModel||!token)return c.json({success:false,error:{message:'A scoped Hive Router credential and canary model must be configured'}},409);
  const { boundedJson }=await import('../services/application-probes.js');
  const started=Date.now();let data:{status:string;durationMs:number;totalTokens:number|null};
  try {const response=await fetch(new URL('/v1/chat/completions',config.baseUrl),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({model:config.canaryModel,messages:[{role:'user',content:'Reply OK.'}],max_tokens:1,stream:false}),signal:AbortSignal.timeout(8000),redirect:'error'});
    const body=await boundedJson(response) as {choices?:unknown[];usage?:{total_tokens?:number}};
    data={status:response.ok&&Array.isArray(body.choices)&&body.choices.length?'pass':'fail',durationMs:Date.now()-started,totalTokens:typeof body.usage?.total_tokens==='number'?body.usage.total_tokens:null};
  }catch{data={status:'fail',durationMs:Date.now()-started,totalTokens:null};}
  await logAuditEvent({action:'application.canary',actorId:getUser(c).userId,targetType:'application',targetId:config.id,details:data});
  return c.json({success:true,data});
});
