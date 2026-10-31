import { z } from 'zod';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { approvalDigest, requireFreshApproval, verifyApprovalAssertion } from '../security/approval-assertion.js';
import { forwardSecurityFusionApproval, getSecurityFusionApprovalPlan, listSecurityFusionApprovalPlans } from './security-fusion-approvals.js';

const planSchema = z.object({
  runbookVersion: z.enum(['diagnostics.v1', 'restart-service.v1']), nodeId: z.string().min(1).max(160),
  applicationId: z.string().min(1).max(160).optional(), command: z.string().min(1).max(500),
  args: z.array(z.string().max(500)).max(16), expiresAt: z.string().datetime(), timeoutSeconds: z.number().int().min(1).max(3600),
  catalogRunbookId: z.string().min(1).max(160).optional(), catalogRunbookVersion: z.string().min(1).max(160).optional(),
  catalogPlanSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((value, ctx) => {
  const catalogFields = [value.catalogRunbookId, value.catalogRunbookVersion, value.catalogPlanSha256];
  if (catalogFields.some(Boolean) && !catalogFields.every(Boolean))
    ctx.addIssue({ code: 'custom', message: 'Catalog plan identity must be complete', path: ['catalogPlanSha256'] });
});
function remediationId(planId: string) {
  const match = /^remediation:([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})$/.exec(planId);
  if (!match) throw new HttpError(400, 'PLAN_TYPE_UNAVAILABLE', 'Select an existing versioned Magnus remediation plan; containment belongs to Security Fusion');
  return match[1]!;
}
export function describeRemediationPlan(row: { id: string; input: string; nodeId: string; anomalyEventId: string }) {
  let raw: unknown; try { raw = JSON.parse(row.input); } catch { throw new HttpError(409, 'INVALID_PLAN', 'Stored remediation plan is invalid'); }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success || parsed.data.nodeId !== row.nodeId) throw new HttpError(409, 'INVALID_PLAN', 'Stored remediation plan is invalid');
  const p = parsed.data;
  const view = {
    plan_id: `remediation:${row.id}`, revision: 1, action: 'remediation.runbook', targets: [p.nodeId],
    steps: [`Runbook: ${p.runbookVersion}`, `Command: ${JSON.stringify([p.command, ...p.args])}`,
      `Timeout: ${p.timeoutSeconds} seconds`, ...(p.applicationId ? [`Application: ${p.applicationId}`] : []),
      ...(p.catalogPlanSha256 ? [`Catalog: ${p.catalogRunbookId}@${p.catalogRunbookVersion}`, `Catalog plan: ${p.catalogPlanSha256}`] : [])],
    risk: p.runbookVersion === 'diagnostics.v1' ? 'Read-only host uptime diagnostic.' : 'Service restart interrupts availability and can lose in-memory work.',
    rollback: p.runbookVersion === 'diagnostics.v1' ? 'No target state change; retain the result.' : 'A restart cannot be undone. Verify service/application health; any further recovery needs a new approved plan.',
    evidence: [`anomaly:${row.anomalyEventId}`], expires_at: Date.parse(p.expiresAt),
  };
  return { ...view, plan_sha256: approvalDigest(view) };
}
/** Bounded discovery exposes only validated, unexpired backend-owned pending plans. */
export async function listTeamApprovalPlans() {
  const rows = await getDb().remediationExecution.findMany({
    where: { status: 'pending_approval', triggeredAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
    orderBy: { triggeredAt: 'desc' }, take: 100,
  });
  const plans: ReturnType<typeof describeRemediationPlan>[] = [];
  for (const row of rows) {
    try {
      const plan = describeRemediationPlan(row);
      if (plan.expires_at > Date.now()) plans.push(plan);
    } catch (error) { if (!(error instanceof HttpError)) throw error; }
    if (plans.length === 20) break;
  }
  const containment = await listSecurityFusionApprovalPlans();
  return { plans: [...plans, ...containment].sort((a, b) => Number(a.expires_at) - Number(b.expires_at)).slice(0, 20) };
}
export async function getTeamApprovalPlan(planId: string) {
  if (planId.startsWith('containment:')) return getSecurityFusionApprovalPlan(planId);
  const row = await getDb().remediationExecution.findUnique({ where: { id: remediationId(planId) } });
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Remediation plan not found');
  if (row.status !== 'pending_approval') throw new HttpError(409, 'PLAN_ALREADY_HANDLED', 'Plan is no longer awaiting permission');
  const plan = describeRemediationPlan(row);
  if (plan.expires_at <= Date.now()) throw new HttpError(409, 'PLAN_EXPIRED', 'Create a fresh remediation proposal');
  return plan;
}
export async function recordTeamApproval(raw: unknown) {
  const { payload: p, assertionSha256 } = verifyApprovalAssertion(raw);
  if (p.proposal_id.startsWith('containment:')) return forwardSecurityFusionApproval(raw);
  const id = remediationId(p.proposal_id);
  return getDb().$transaction(async tx => {
    // Locks are scoped to immutable proposal identity and survive API replicas.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`team-approval:${p.proposal_id}`}, 0))`;
    const prior = await tx.teamApprovalDecision.findUnique({ where: { proposalId: p.proposal_id } });
    if (prior) {
      if (prior.decisionId !== p.decision_id || prior.assertionSha256 !== assertionSha256)
        throw new HttpError(409, 'APPROVAL_CONFLICT', 'Proposal already has a different decision');
      return { decision_id: prior.decisionId, proposal_id: prior.proposalId, decision: prior.decision, execution_id: prior.executionId, accepted: true, replay: true };
    }
    requireFreshApproval(p);
    const row = await tx.remediationExecution.findUnique({ where: { id } });
    if (!row || row.status !== 'pending_approval') throw new HttpError(409, 'PLAN_ALREADY_HANDLED', 'Plan is not awaiting permission');
    const plan = describeRemediationPlan(row);
    if (plan.revision !== p.proposal_revision || plan.plan_sha256 !== p.plan_sha256 || p.expires_at > plan.expires_at)
      throw new HttpError(409, 'APPROVAL_PLAN_CHANGED', 'Telegram permission does not match the current immutable plan');
    const actor = `telegram:${p.actor_binding_sha256}`;
    const changed = await tx.remediationExecution.updateMany({
      where: { id, status: 'pending_approval', input: row.input },
      data: p.decision === 'approve' ? { status: 'approving', output: JSON.stringify({ approvedBy: actor,
        telegramDecisionId: p.decision_id, telegramPlanSha256: p.plan_sha256, telegramExpiresAt: p.expires_at,
        telegramExecutionId: p.execution_id }) } : { status: 'skipped', completedAt: new Date(), output: 'Operator rejected the exact proposal through Telegram' },
    });
    if (changed.count !== 1) throw new HttpError(409, 'APPROVAL_PLAN_CHANGED', 'Plan changed before permission could be recorded');
    await tx.teamApprovalDecision.create({ data: { decisionId: p.decision_id, proposalId: p.proposal_id,
      proposalRevision: p.proposal_revision, planSha256: p.plan_sha256, decision: p.decision, assertionSha256,
      actorBindingSha256: p.actor_binding_sha256, executionId: p.execution_id, decidedAt: new Date(p.decided_at), expiresAt: new Date(p.expires_at) } });
    return { decision_id: p.decision_id, proposal_id: p.proposal_id, decision: p.decision, execution_id: p.execution_id, accepted: true, replay: false };
  });
}
