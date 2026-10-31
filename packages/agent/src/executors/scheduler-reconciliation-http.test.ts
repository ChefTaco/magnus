import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';

const nodeSecret = 'scheduler-http-node-secret-at-least-32-characters';
const resultSecret = 'scheduler-http-result-secret-at-least-32-characters';
const reconciliationSecret = 'scheduler-http-reconciliation-secret-at-least-32-characters';
const host = 'scheduler-http.fixture.invalid';
const root = await mkdtemp(join(tmpdir(), 'scheduler-http-'));
process.env['AGENT_INSTALL_DIR'] = root;
process.env['COMMAND_RECONCILIATION_SECRET'] = reconciliationSecret;
vi.mock('../env.js', () => ({ CONTROL_API_URL: 'https://control.fixture.invalid', HOST_FQDN: host,
  NODE_MANAGER_SECRET: nodeSecret, NODE_MANAGER_SECRET_PREVIOUS: '', RESULT_SIGNING_SECRET: resultSecret,
  RESULT_SIGNING_PREVIOUS_SECRET: '', MAGNUS_EXECUTION_SUPERVISOR_ENABLED: true }));
const authority = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../tls.js', () => ({ controlApiFetch: authority.call }));
const { cronRoutes } = await import('./cron-manager.js');
const { ManagedScheduler, cronEnrollmentStageSigningPayload, schedulerSourceSettlementReceiptPayload,
  schedulerSourceSettlementSigningPayload } = await import('./managed-scheduler.js');
const { managedMutationGuard } = await import('./managed-http.js');
const { nodeAuthMiddleware } = await import('../middleware.js');

describe('scheduler reconciliation control message', () => {
  const identity = { nodeId: 'scheduler-http-node', nodeFqdn: host, epoch: 1, barrierId: randomUUID() };
  const source = { kind: 'SYSTEM_CRONTAB', sourceSha256: 'a'.repeat(64), count: 1 };
  let app: Hono;
  beforeAll(async () => {
    const scheduler = new ManagedScheduler(join(root, '.magnus/managed-scheduler'), host);
    await scheduler.drain(identity); await scheduler.observeDiscovery([], [source]);
    app = new Hono(); app.use('/api/v1/*', nodeAuthMiddleware); app.use('/api/v1/*', managedMutationGuard);
    app.route('/api/v1/cron', cronRoutes);
  });
  afterAll(async () => {
    delete process.env['AGENT_INSTALL_DIR']; delete process.env['COMMAND_RECONCILIATION_SECRET'];
    await rm(root, { recursive: true, force: true });
  });
  function assertion(signature = true) {
    const unsigned = { version: 1 as const, sourceIdentityVersion: 2 as const, ...identity, ...source, disposition: 'no_effect_verified' as const,
      evidenceSha256: 'b'.repeat(64), approvalRef: 'telegram:fixture', decisionId: randomUUID(), expiresAt: Date.now() + 60_000 };
    return { ...unsigned, signature: signature
      ? createHmac('sha256', reconciliationSecret).update(schedulerSourceSettlementSigningPayload(unsigned)).digest('hex')
      : 'c'.repeat(64) };
  }
  it('lets the exact signed control message reach its handler while the scheduler is draining', async () => {
    const decision = assertion();
    const response = await app.request('/api/v1/cron/source-reconciliation', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-node-token': nodeSecret }, body: JSON.stringify(decision) });
    expect(response.status).toBe(200); const body = await response.json() as { data: Record<string, unknown> };
    expect(body).toMatchObject({ success: true, data: { settled: true, replayed: false } });
    const { receiptSignature, ...receipt } = body.data;
    expect(receiptSignature).toBe(createHmac('sha256', resultSecret)
      .update(schedulerSourceSettlementReceiptPayload(receipt as Parameters<typeof schedulerSourceSettlementReceiptPayload>[0])).digest('hex'));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(decision.expiresAt + 1);
    const replay = await app.request('/api/v1/cron/source-reconciliation', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-node-token': nodeSecret }, body: JSON.stringify(decision) });
    clock.mockRestore();
    expect(replay.status).toBe(200); expect((await replay.json() as { data: unknown }).data).toEqual(body.data);
    const lookup = await app.request('/api/v1/cron/source-reconciliation/' + decision.decisionId,
      { headers: { 'x-node-token': nodeSecret } });
    expect(lookup.status).toBe(200); expect((await lookup.json() as { data: unknown }).data).toEqual(body.data);
    expect(authority.call).not.toHaveBeenCalled();
  });
  it('still denies an invalid signature at the application handler', async () => {
    const response = await app.request('/api/v1/cron/source-reconciliation', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-node-token': nodeSecret }, body: JSON.stringify(assertion(false)) });
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: { code: 'SCHEDULER_RECONCILIATION_INVALID' } });
    expect(authority.call).not.toHaveBeenCalled();
  });
  it('authenticates the disable-only staging control message and refuses it after drain begins', async () => {
    const spec = { nodeFqdn: host, name: 'legacy', revision: 1, schedule: '* * * * *', timezone: 'UTC' as const,
      environment: {}, command: '/usr/bin/true', args: [], timeoutSeconds: 60, expiresAt: Date.now() + 60_000 };
    const unsigned = { version: 1 as const, nodeId: identity.nodeId, nodeFqdn: host, spec,
      operationId: randomUUID(), expiresAt: Date.now() + 60_000 };
    const signed = { ...unsigned, signature: createHmac('sha256', reconciliationSecret)
      .update(cronEnrollmentStageSigningPayload(unsigned)).digest('hex') };
    const send = (value: typeof signed) => app.request('/api/v1/cron/enrollment-stage', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-node-token': nodeSecret }, body: JSON.stringify(value) });
    expect((await send({ ...signed, signature: 'f'.repeat(64) })).status).toBe(403);
    expect((await send(signed)).status).toBe(409);
    expect(authority.call).not.toHaveBeenCalled();
  });
});
