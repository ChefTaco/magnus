/**
 * The enforce-mode equivalent of the reviewer's COMMAND_RECONCILIATION_SECRET signature on a
 * scheduler-source settlement: two different ADMIN people, and a decision the server signs for the node.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  enrollment: { state: 'draining', epoch: 3, barrierId: '' } as { state: string; epoch: number; barrierId: string | null },
  serverSigned: true,
  sent: [] as Array<Record<string, unknown>>,
}));
vi.mock('../db/index.js', () => {
  const tx = {
    node: { findUnique: async () => ({ id: 'node-a', hostname: 'node-a.example.com', ipAddress: '192.0.2.10', port: 4100 }) },
    resourceEnrollment: { findUnique: async () => ({ nodeId: 'node-a', ...fixture.enrollment }) },
  };
  return { getDb: () => ({ $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) }) };
});
// Under an explicit compat the server holds a shared node secret; in enforce it has none.
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  getNodeManagerSecret: () => (process.env['NODE_AUTH_MODE'] === 'compat' ? 'fixture-node-secret-at-least-32-characters-long' : '') }));
vi.mock('./resource-node-lock.js', () => ({ lockResourceNode: async () => undefined }));
vi.mock('./node-evidence-policy.js', async original => ({ ...await original<object>(),
  nodeEvidencePolicy: async () => ({ verify: () => true }) }));
vi.mock('../sdk/node-api-client.js', async original => ({ ...await original<object>(),
  NodeApiClient: class {
    async acceptsServerSignedSchedulerSettlement() { return fixture.serverSigned; }
    async reconcileSchedulerSource(assertion: Record<string, unknown>) {
      fixture.sent.push(assertion);
      const { signature: _signature, serverSignature: _serverSignature, ...unsigned } = assertion;
      return { success: true, data: { ...unsigned, settled: true, replayed: false, receiptSignature: 'c'.repeat(64) } };
    }
  } }));

const service = await import('./managed-cron.js');
const { serverSigningKey } = await import('./node-server-key.js');
const { verifyServerAuthorization } = await import('../security/node-evidence.js');
const { schedulerSourceSettlementSigningPayload } = await import('../schemas/managed-cron.js');

const input = { nodeId: 'node-a', kind: 'USER_CRONTAB', sourceSha256: '9'.repeat(64), count: 2, disposition: 'no_effect_verified' as const,
  reason: 'Checked the crontab by hand; the entries were removed last week.' };
// A synthetic key (low entropy on purpose, so no scanner mistakes it for a real one).
const RECONCILIATION_KEY = 'reconcile'.repeat(5);

beforeEach(() => {
  fixture.enrollment = { state: 'draining', epoch: 3, barrierId: randomUUID() };
  fixture.serverSigned = true; fixture.sent = [];
  service.resetSchedulerReconcileRequests();
  delete process.env['NODE_AUTH_MODE'];
});
afterEach(() => { vi.unstubAllEnvs(); delete process.env['NODE_AUTH_MODE']; });

describe('two-ADMIN scheduler-source settlement', () => {
  it('takes a request from one ADMIN and the approval of another, then hands the node a decision signed by the server key only', async () => {
    const request = await service.requestSchedulerSourceReconciliation(input, 'admin-1');
    expect(request).toMatchObject({ status: 'PENDING', nodeFqdn: 'node-a.example.com', epoch: 3, barrierId: fixture.enrollment.barrierId, requestedBy: 'admin-1' });
    expect(fixture.sent).toEqual([]);
    await expect(service.approveSchedulerSourceReconciliation(request.id, 'admin-1')).rejects.toMatchObject({ status: 403, code: 'SECOND_ADMIN_REQUIRED' });
    const result = await service.approveSchedulerSourceReconciliation(request.id, 'admin-2');
    expect(result).toMatchObject({ requestId: request.id, decisionId: request.id, settled: true, approvalRef: `magnus:scheduler-source-reconcile:${request.id}` });
    const sent = fixture.sent[0]! as Parameters<typeof schedulerSourceSettlementSigningPayload>[0] & { signature?: string; serverSignature: never };
    // Enforce (the default): no HMAC at all, the server key's signature for this node.
    expect(sent.signature).toBeUndefined();
    expect(verifyServerAuthorization('scheduler-source-settlement', { signature: sent.serverSignature, publicKey: serverSigningKey().publicKey,
      expectedNodeId: 'node-a', payload: schedulerSourceSettlementSigningPayload(sent) })).toEqual({ ok: true });
    // The evidence digest binds both people and the reason.
    expect(sent.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.approveSchedulerSourceReconciliation(request.id, 'admin-3')).rejects.toMatchObject({ code: 'RECONCILIATION_REQUEST_DECIDED' });
  });

  it('refuses an agent that only knows the HMAC in enforce mode, and serves it the HMAC under an explicit compat', async () => {
    fixture.serverSigned = false;
    const request = await service.requestSchedulerSourceReconciliation(input, 'admin-1');
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', RECONCILIATION_KEY);
    await expect(service.approveSchedulerSourceReconciliation(request.id, 'admin-2')).rejects.toMatchObject({ status: 409, code: 'AGENT_UPGRADE_REQUIRED' });
    expect(fixture.sent).toEqual([]);
    process.env['NODE_AUTH_MODE'] = 'compat';
    await service.approveSchedulerSourceReconciliation(request.id, 'admin-2');
    const sent = fixture.sent[0]! as Parameters<typeof schedulerSourceSettlementSigningPayload>[0] & { signature: string; serverSignature?: unknown };
    expect(sent.serverSignature).toBeUndefined();
    expect(sent.signature).toBe(createHmac('sha256', RECONCILIATION_KEY).update(schedulerSourceSettlementSigningPayload(sent)).digest('hex'));
  });

  it('refuses a request whose drain barrier moved, an expired request, and a node that is not draining', async () => {
    const request = await service.requestSchedulerSourceReconciliation(input, 'admin-1');
    fixture.enrollment.barrierId = randomUUID();
    await expect(service.approveSchedulerSourceReconciliation(request.id, 'admin-2')).rejects.toMatchObject({ code: 'SCHEDULER_AUTHORITY_CONFLICT' });
    const late = await service.requestSchedulerSourceReconciliation(input, 'admin-1');
    await expect(service.approveSchedulerSourceReconciliation(late.id, 'admin-2', Date.now() + service.SCHEDULER_RECONCILE_REQUEST_TTL_MS + 1))
      .rejects.toMatchObject({ code: 'RECONCILIATION_REQUEST_DECIDED' });
    fixture.enrollment.state = 'enrolled';
    await expect(service.requestSchedulerSourceReconciliation(input, 'admin-1')).rejects.toMatchObject({ code: 'SCHEDULER_AUTHORITY_CONFLICT' });
    expect(fixture.sent).toEqual([]);
  });

  it('lets a request be withdrawn, and keeps the reviewer-signed path for an explicit compat only', async () => {
    const request = await service.requestSchedulerSourceReconciliation(input, 'admin-1');
    expect(await service.rejectSchedulerSourceReconciliation(request.id, 'admin-1')).toMatchObject({ status: 'REJECTED', decidedBy: 'admin-1' });
    await expect(service.approveSchedulerSourceReconciliation(request.id, 'admin-2')).rejects.toMatchObject({ code: 'RECONCILIATION_REQUEST_DECIDED' });
    const assertion = { version: 1 as const, sourceIdentityVersion: 2 as const, nodeId: 'node-a', nodeFqdn: 'node-a.example.com', epoch: 3,
      barrierId: fixture.enrollment.barrierId!, kind: 'USER_CRONTAB', sourceSha256: '9'.repeat(64), count: 2, disposition: 'no_effect_verified' as const,
      evidenceSha256: 'a'.repeat(64), approvalRef: 'change-1', decisionId: randomUUID(), expiresAt: Date.now() + 60_000 };
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', RECONCILIATION_KEY);
    const signature = createHmac('sha256', RECONCILIATION_KEY).update(schedulerSourceSettlementSigningPayload(assertion)).digest('hex');
    await expect(service.reconcileForeignSchedulerSource({ ...assertion, signature })).rejects.toMatchObject({ status: 409, code: 'NODE_AUTH_ENFORCED' });
    process.env['NODE_AUTH_MODE'] = 'compat';
    expect(await service.reconcileForeignSchedulerSource({ ...assertion, signature })).toMatchObject({ decisionId: assertion.decisionId, settled: true });
  });
});
