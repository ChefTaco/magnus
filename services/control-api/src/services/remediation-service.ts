import { nanoid } from 'nanoid';
import { describeRemediationPlan } from './team-approvals.js';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { getApplicationConfigs } from './operations-config.js';
import { createRollout, getRolloutStatus } from './rollout-service.js';
import { catalogRunbookPlanSha256, loadOperationsCatalog } from './engineering-assurance.js';

export const RUNBOOKS = ['diagnostics.v1', 'restart-service.v1'] as const;
interface RuleInput {
  name: string;
  description?: string;
  metric?: string;
  severityThreshold?: string;
  agentDefinitionId: string;
  input?: string;
  cooldownMinutes?: number;
  maxConcurrentRuns?: number;
  nodeFilter?: string | null;
  enabled?: boolean;
  createdBy?: string;
}
interface Plan {
  runbookVersion: string;
  nodeId: string;
  applicationId?: string;
  command: string;
  args: string[];
  expiresAt: string;
  timeoutSeconds: number;
  catalogRunbookId?: string;
  catalogRunbookVersion?: string;
  catalogPlanSha256?: string;
}
function bindCatalogPlan(plan: Plan): Plan {
  if (!process.env['MAGNUS_OPERATIONS_CATALOG_FILE'] || !plan.applicationId) return plan;
  const catalog = loadOperationsCatalog();
  const target = catalog.applications.find(application => application.id === plan.applicationId && application.nodeId === plan.nodeId);
  const candidates = catalog.runbooks.filter(runbook => runbook.executionVersion === plan.runbookVersion
    && runbook.command === plan.command && JSON.stringify(runbook.args) === JSON.stringify(plan.args)
    && runbook.timeoutSeconds === plan.timeoutSeconds);
  if (!target || candidates.length !== 1)
    throw new HttpError(409, 'CATALOG_PLAN_UNAVAILABLE', 'Stored remediation must match one exact catalog runbook and application');
  const runbook = candidates[0]!;
  const catalogPlanSha256 = catalogRunbookPlanSha256(catalog, runbook.id, runbook.version, target.id)!;
  return { ...plan, catalogRunbookId: runbook.id, catalogRunbookVersion: runbook.version, catalogPlanSha256 };
}
export function buildRemediationPlan(rule: { agentDefinitionId: string; input: string }, nodeId: string): Plan {
  if (!RUNBOOKS.includes(rule.agentDefinitionId as (typeof RUNBOOKS)[number]))
    throw new HttpError(
      409,
      'REMEDIATION_RETIRED',
      'Legacy rule is record-only; select a versioned runbook',
    );
  const base = {
    runbookVersion: rule.agentDefinitionId,
    nodeId,
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    timeoutSeconds: 60,
  };
  let applicationId: unknown;
  try {
    applicationId = JSON.parse(rule.input).applicationId;
  } catch {
    /* reject below */
  }
  if (rule.agentDefinitionId === 'diagnostics.v1') {
    const diagnostic = { ...base, command: '/usr/bin/uptime', args: [] };
    if (!process.env['MAGNUS_OPERATIONS_CATALOG_FILE']) return diagnostic;
    const config = getApplicationConfigs().find(application => application.id === applicationId && application.nodeId === nodeId);
    if (!config)
      throw new HttpError(400, 'VALIDATION_ERROR', 'Select an application with an operator-configured health probe on this node');
    return bindCatalogPlan({ ...diagnostic, applicationId: config.id });
  }
  const config = getApplicationConfigs().find(
    (a) => a.id === applicationId && a.nodeId === nodeId && a.restartService,
  );
  if (!config?.restartService)
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Select an application with an operator-allowlisted restart service on this node',
    );
  return bindCatalogPlan({
    ...base,
    applicationId: config.id,
    command: '/usr/bin/systemctl',
    args: ['restart', config.restartService],
  });
}
function validateRule(data: { agentDefinitionId: string }) {
  if (!RUNBOOKS.includes(data.agentDefinitionId as (typeof RUNBOOKS)[number]))
    throw new HttpError(400, 'VALIDATION_ERROR', 'Choose diagnostics.v1 or restart-service.v1');
}
export async function listRules() {
  const rows = await getDb().remediationRule.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { executions: true } } },
  });
  return rows.map((rule) => ({
    ...rule,
    runbookVersion: rule.agentDefinitionId,
    disposition: RUNBOOKS.includes(rule.agentDefinitionId as (typeof RUNBOOKS)[number])
      ? 'approval_required'
      : 'legacy_record_only',
  }));
}
export async function getRule(id: string) {
  return getDb().remediationRule.findUnique({ where: { id } });
}
export async function createRule(data: RuleInput) {
  validateRule(data);
  return getDb().remediationRule.create({ data: { ...data, id: nanoid() } });
}
export async function updateRule(id: string, data: Partial<RuleInput>) {
  const current = await getRule(id);
  if (!current) throw new HttpError(404, 'NOT_FOUND', 'Rule not found');
  validateRule({ agentDefinitionId: data.agentDefinitionId ?? current.agentDefinitionId });
  return getDb().remediationRule.update({ where: { id }, data });
}
export async function deleteRule(id: string) {
  await getDb().remediationRule.delete({ where: { id } });
}
export async function listExecutions(params?: {
  ruleId?: string;
  nodeId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, params?.page ?? 1);
  const pageSize = Math.max(1, Math.min(params?.pageSize ?? 50, 200));
  const where = {
    ...(params?.ruleId ? { ruleId: params.ruleId } : {}),
    ...(params?.nodeId ? { nodeId: params.nodeId } : {}),
    ...(params?.status ? { status: params.status } : {}),
  };
  const [executions, total] = await Promise.all([
    getDb().remediationExecution.findMany({
      where,
      orderBy: { triggeredAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { rule: { select: { name: true, metric: true, agentDefinitionId: true } } },
    }),
    getDb().remediationExecution.count({ where }),
  ]);
  return { executions, total, page, pageSize };
}
async function propose(ruleId: string, anomalyEventId: string, nodeId: string) {
  const db = getDb();
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`remediation:${ruleId}`}, 0))`;
    const rule = await tx.remediationRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw new HttpError(404, 'NOT_FOUND', 'Rule not found');
    const existing = await tx.remediationExecution.findFirst({
      where: {
        ruleId,
        nodeId,
        triggeredAt: { gte: new Date(Date.now() - rule.cooldownMinutes * 60000) },
      },
      orderBy: { triggeredAt: 'desc' },
    });
    if (existing) return existing;
    const active = await tx.remediationExecution.count({
      where: { ruleId, status: { in: ['pending_approval', 'approving', 'running'] } },
    });
    if (active >= rule.maxConcurrentRuns)
      throw new HttpError(409, 'REMEDIATION_BUSY', 'Rule has reached its active plan limit');
    let plan: Plan;
    try {
      plan = buildRemediationPlan(rule, nodeId);
    } catch (error) {
      return tx.remediationExecution.create({
        data: {
          ruleId,
          nodeId,
          anomalyEventId,
          status: 'skipped',
          input: '',
          output: error instanceof HttpError ? error.message : 'Runbook unavailable',
          completedAt: new Date(),
        },
      });
    }
    return tx.remediationExecution.create({
      data: {
        ruleId,
        nodeId,
        anomalyEventId,
        status: 'pending_approval',
        input: JSON.stringify(plan),
      },
    });
  });
}
export async function evaluateRemediation(anomaly: {
  id: string;
  nodeId: string;
  nodeName: string;
  metric: string;
  severity: 'info' | 'warning' | 'critical';
  value: number;
  zScore: number;
}): Promise<void> {
  const ranks: Record<string, number> = { info: 0, warning: 1, critical: 2 };
  const rules = await getDb().remediationRule.findMany({ where: { enabled: true } });
  for (const rule of rules) {
    if (
      (rule.metric !== '*' && rule.metric !== anomaly.metric) ||
      (ranks[anomaly.severity] ?? 0) < (ranks[rule.severityThreshold] ?? 2)
    )
      continue;
    if (rule.nodeFilter && ![anomaly.nodeId, anomaly.nodeName].includes(rule.nodeFilter)) continue;
    try {
      await propose(rule.id, anomaly.id, anomaly.nodeId);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409)) throw e;
    }
  }
}
export async function triggerManualRemediation(params: {
  anomalyEventId: string;
  ruleId: string;
  triggeredBy: string;
}) {
  const anomaly = await getDb().anomalyEvent.findUnique({ where: { id: params.anomalyEventId } });
  if (!anomaly) throw new HttpError(404, 'NOT_FOUND', 'Anomaly not found');
  const execution = await propose(params.ruleId, anomaly.id, anomaly.nodeId);
  return {
    executionId: execution.id,
    orchestraRunId: null,
    status: execution.status,
    plan: execution.input ? JSON.parse(execution.input) : null,
  };
}
export async function approveRemediation(_id: string, _actorId: string): Promise<never> {
  // Missing bridge configuration must never restore blanket service approvals.
  throw new HttpError(403, 'TELEGRAM_APPROVAL_REQUIRED', 'Review and approve the exact proposal through the signed approval bridge');
}
export async function reconcileRemediation() {
  const db = getDb();
  const rows = await db.remediationExecution.findMany({
    where: { status: { in: ['pending_approval', 'approving', 'running'] } },
    take: 100,
    orderBy: { triggeredAt: 'asc' },
  });
  for (const execution of rows) {
    const plan = JSON.parse(execution.input) as Plan;
    if (execution.status === 'pending_approval') {
      if (Date.parse(plan.expiresAt) <= Date.now())
        await db.remediationExecution.updateMany({
          where: { id: execution.id, status: 'pending_approval' },
          data: { status: 'skipped', output: 'Approval expired', completedAt: new Date() },
        });
      continue;
    }
    const output = JSON.parse(execution.output ?? '{}') as {
      approvedBy: string;
      rolloutId?: string;
      telegramDecisionId?: string;
      telegramPlanSha256?: string;
      telegramExpiresAt?: number;
      telegramExecutionId?: string;

    };
    const rolloutId = `remediation_${execution.id}`;
    if (execution.status === 'approving') {
      try {
        const admitted = await db.executionRun.findUnique({ where: { id: rolloutId } });
        {
          {
            const permission = output.telegramDecisionId ? await db.teamApprovalDecision.findUnique({ where: { decisionId: output.telegramDecisionId } }) : null;
            const expected = describeRemediationPlan(execution);
            if (!permission || permission.decision !== 'approve' || permission.proposalId !== expected.plan_id
              || permission.planSha256 !== expected.plan_sha256 || permission.planSha256 !== output.telegramPlanSha256
              || permission.executionId !== output.telegramExecutionId || permission.expiresAt.getTime() !== output.telegramExpiresAt
              || (!admitted && permission.expiresAt.getTime() <= Date.now())
              || output.approvedBy !== `telegram:${permission.actorBindingSha256}`)
              throw new HttpError(403, 'TELEGRAM_APPROVAL_REQUIRED', 'Exact, current Telegram permission is required before dispatch');
          }
          // Recheck the current allowlist; an edited/revoked service cannot inherit an old approval.
          const current = buildRemediationPlan(
            {
              agentDefinitionId: plan.runbookVersion,
              input: JSON.stringify({ applicationId: plan.applicationId }),
            },
            plan.nodeId,
          );
          if (
            current.command !== plan.command ||
            JSON.stringify(current.args) !== JSON.stringify(plan.args) ||
            current.catalogRunbookId !== plan.catalogRunbookId ||
            current.catalogRunbookVersion !== plan.catalogRunbookVersion ||
            current.catalogPlanSha256 !== plan.catalogPlanSha256
          )
            throw new HttpError(409, 'REMEDIATION_CHANGED', 'Runbook configuration changed');
          if (!admitted && Date.parse(plan.expiresAt) <= Date.now())
            throw new HttpError(409, 'REMEDIATION_EXPIRED', 'Approval expired before dispatch');
          await createRollout({
            type: 'command',
            strategy: 'one_at_a_time',
            nodeIds: [plan.nodeId],
            rolloutId,
            createdBy: output.approvedBy,
            metadata: {
              command: plan.command,
              args: plan.args,
              timeoutSeconds: plan.timeoutSeconds,
              ...(output.telegramExpiresAt ? { executionDeadline: Math.min(output.telegramExpiresAt, Date.parse(plan.expiresAt)) } : {}),
              ...(plan.applicationId ? { applicationId: plan.applicationId } : {}),
            },
          });
        }
        await db.remediationExecution.updateMany({
          where: { id: execution.id, status: 'approving' },
          data: { status: 'running', output: JSON.stringify({ ...output, rolloutId }) },
        });
      } catch (error) {
        // Database/transport failures are retried. A deterministic run ID adopts a committed
        // admission after a crash, even if the approval has since expired.
        if (!(error instanceof HttpError)) continue;
        await db.remediationExecution.updateMany({
          where: { id: execution.id, status: 'approving' },
          data: {
            status: 'failed',
            output:
              'Runbook admission failed; inspect target readiness, allowlist and conflicting rollouts',
            completedAt: new Date(),
          },
        });
      }
    } else {
      const result = await getRolloutStatus(rolloutId);
      if (['completed', 'failed', 'cancelled'].includes(result.status))
        await db.remediationExecution.updateMany({
          where: { id: execution.id, status: 'running' },
          data: {
            status: result.status === 'completed' ? 'completed' : 'failed',
            completedAt: new Date(),
            output: JSON.stringify({
              ...output,
              rolloutId,
              status: result.status,
              targets: result.targets.map((t) => ({
                nodeId: t.nodeId,
                status: t.status,
                evidence: t.evidence,
              })),
            }),
          },
        });
    }
  }
}


/** Recheck queued remediation against current permission and current service allowlist. */
export async function validateRemediationCommandForDispatch(command: {
  nodeId: string; command: string; args: string; timeoutSeconds: number;
  correlationId: string | null; executionDeadline: Date | null; environment: string;
  workingDirectory: string | null;
}): Promise<void> {
  if (!command.correlationId?.startsWith('remediation_')) return;
  const db = getDb(), id = command.correlationId.slice('remediation_'.length);
  const row = await db.remediationExecution.findUnique({ where: { id } });
  if (!row || !['approving', 'running'].includes(row.status)) throw new HttpError(403, 'TELEGRAM_APPROVAL_REQUIRED', 'Remediation admission is unavailable');
  const view = describeRemediationPlan(row), plan = JSON.parse(row.input) as Plan;
  const output = JSON.parse(row.output ?? '{}');
  const decision = typeof output.telegramDecisionId === 'string' ? await db.teamApprovalDecision.findUnique({ where: { decisionId: output.telegramDecisionId } }) : null;
  const current = buildRemediationPlan({ agentDefinitionId: plan.runbookVersion, input: JSON.stringify({ applicationId: plan.applicationId }) }, row.nodeId);
  if (!decision || decision.decision !== 'approve' || decision.planSha256 !== view.plan_sha256
    || decision.proposalId !== view.plan_id || decision.executionId !== output.telegramExecutionId
    || output.approvedBy !== `telegram:${decision.actorBindingSha256}` || output.telegramPlanSha256 !== decision.planSha256
    || output.telegramExpiresAt !== decision.expiresAt.getTime()
    || decision.expiresAt.getTime() <= Date.now() || command.executionDeadline?.getTime() !== decision.expiresAt.getTime()
    || current.command !== plan.command || JSON.stringify(current.args) !== JSON.stringify(plan.args)
    || current.catalogRunbookId !== plan.catalogRunbookId || current.catalogRunbookVersion !== plan.catalogRunbookVersion
    || current.catalogPlanSha256 !== plan.catalogPlanSha256
    || command.nodeId !== plan.nodeId || command.command !== plan.command || command.args !== JSON.stringify(plan.args)
    || command.timeoutSeconds !== plan.timeoutSeconds || command.workingDirectory !== null
    || Object.keys(JSON.parse(command.environment)).length)
    throw new HttpError(403, 'TELEGRAM_APPROVAL_REQUIRED', 'Queued remediation no longer matches current Telegram permission and runbook');
}
