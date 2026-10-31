import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApprovalPayload } from '../security/approval-assertion.js';
import { approvalSignerPublicKeyB64, signApprovalAssertion } from '../security/approval-assertion-test-fixture.js';
const prefix = `approval-${randomUUID()}`;
vi.mock('../queue/workers.js', () => ({ enqueueCommand: vi.fn() }));
describe.skipIf(!process.env['TEST_DATABASE_URL'])('native Telegram decisions on disposable PostgreSQL', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let service: typeof import('./team-approvals.js');
  let remediation: typeof import('./remediation-service.js');
  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    process.env['DATABASE_URL'] = url; vi.stubEnv('APPROVAL_SIGNER_PUBLIC_KEY_B64', approvalSignerPublicKeyB64); vi.stubEnv('APPROVAL_TELEGRAM_ACTOR_SHA256', 'b'.repeat(64));
    db = (await import('../db/index.js')).getDb(); service = await import('./team-approvals.js'); remediation = await import('./remediation-service.js');
    await db.node.create({ data: { id: prefix, name: prefix, hostname: `${prefix}.invalid`, ipAddress: '127.0.0.1', os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date() } });
    await db.remediationRule.create({ data: { id: prefix, name: prefix, agentDefinitionId: 'diagnostics.v1' } });
  });
  afterAll(async () => {
    if (db) {
      await db.teamApprovalDecision.deleteMany({ where: { proposalId: { startsWith: `remediation:${prefix}` } } });
      await db.executionRun.deleteMany({ where: { id: { startsWith: `remediation_${prefix}` } } });
      await db.remediationRule.delete({ where: { id: prefix } }); await db.node.delete({ where: { id: prefix } });
      await (await import('../db/index.js')).disconnectDb();
    }
    vi.unstubAllEnvs();
  });
  async function proposal() {
    const id = `${prefix}-${randomUUID()}`;
    await db.remediationExecution.create({ data: { id, ruleId: prefix, nodeId: prefix, anomalyEventId: 'fixture-anomaly', status: 'pending_approval', input: JSON.stringify({ runbookVersion: 'diagnostics.v1', nodeId: prefix, command: '/usr/bin/uptime', args: [], timeoutSeconds: 60, expiresAt: new Date(Date.now()+10*60_000).toISOString() }) } });
    return service.getTeamApprovalPlan(`remediation:${id}`);
  }
  function assertion(plan: Awaited<ReturnType<typeof proposal>>, decision: 'approve' | 'reject' = 'approve') {
    const payload: ApprovalPayload = { version: 2, proposal_id: plan.plan_id, proposal_revision: plan.revision,
      plan_sha256: plan.plan_sha256, decision, decision_id: randomUUID(), decided_at: Date.now(), expires_at: plan.expires_at,
      actor_binding_sha256: 'b'.repeat(64), execution_id: decision === 'approve' ? randomUUID() : null };
    return signed(payload);
  }
  function signed(payload: ApprovalPayload) { return signApprovalAssertion(payload); }
  it('atomically accepts concurrent identical deliveries once and rejects changed consent', async () => {
    const plan = await proposal(), a = assertion(plan);
    const results = await Promise.all([service.recordTeamApproval(a), service.recordTeamApproval(a)]);
    expect(results.map(r => r.replay).sort()).toEqual([false, true]);
    expect(await db.teamApprovalDecision.count({ where: { proposalId: plan.plan_id } })).toBe(1);
    expect((await db.remediationExecution.findUnique({ where: { id: plan.plan_id.slice(12) } }))?.status).toBe('approving');
    await expect(service.recordTeamApproval(assertion(plan, 'reject'))).rejects.toThrow('different decision');
    // Reconciliation can acknowledge an already committed decision after expiry.
    vi.spyOn(Date, 'now').mockReturnValue(plan.expires_at+1000);
    expect((await service.recordTeamApproval(a)).replay).toBe(true); vi.restoreAllMocks();
  });
  it('denies changed plan, wrong identity, expired permission, and legacy approval bypass', async () => {
    const plan = await proposal(), a = assertion(plan), id = plan.plan_id.slice(12);
    await expect(remediation.approveRemediation(id, 'service:automatic')).rejects.toThrow('signed approval bridge');
    await expect(service.recordTeamApproval(signed({ ...a.payload, actor_binding_sha256: 'c'.repeat(64) }))).rejects.toThrow('authentication');
    await expect(service.recordTeamApproval(signed({ ...a.payload, expires_at: Date.now()-1 }))).rejects.toThrow('expired');
    const row = await db.remediationExecution.findUniqueOrThrow({ where: { id } });
    await db.remediationExecution.update({ where: { id }, data: { input: JSON.stringify({ ...JSON.parse(row.input), args: ['changed'] }) } });
    await expect(service.recordTeamApproval(a)).rejects.toThrow('immutable plan');
    expect(await db.teamApprovalDecision.count({ where: { proposalId: plan.plan_id } })).toBe(0);
  });
  it('records rejection without admitting a run and rejects later approval', async () => {
    const plan = await proposal(); await service.recordTeamApproval(assertion(plan, 'reject'));
    expect((await db.remediationExecution.findUnique({ where: { id: plan.plan_id.slice(12) } }))?.status).toBe('skipped');
    await expect(service.recordTeamApproval(assertion(plan))).rejects.toThrow('different decision');
    expect(await db.executionRun.count({ where: { id: `remediation_${plan.plan_id.slice(12)}` } })).toBe(0);
  });
  it('rechecks exact approved content at rollout admission', async () => {
    const plan = await proposal(), id = plan.plan_id.slice(12); await service.recordTeamApproval(assertion(plan));
    const row = await db.remediationExecution.findUniqueOrThrow({ where: { id } });
    await db.remediationExecution.update({ where: { id }, data: { input: JSON.stringify({ ...JSON.parse(row.input), timeoutSeconds: 90 }) } });
    await remediation.reconcileRemediation();
    expect(await db.executionRun.count({ where: { id: `remediation_${id}` } })).toBe(0);
    expect((await db.remediationExecution.findUnique({ where: { id } }))?.status).toBe('failed');
  });
});
