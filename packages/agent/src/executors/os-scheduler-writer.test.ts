import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ inventory: vi.fn() }));
const secret = 'independent-result-signing-key-for-drain-proof';
vi.mock('../env.js', () => ({ HOST_FQDN: 'fixture.lab', NODE_MANAGER_SECRET: 'node-auth',
  NODE_MANAGER_SECRET_PREVIOUS: '', RESULT_SIGNING_SECRET: secret,
  CONTROL_API_URL: 'https://control.fixture', MAGNUS_EXECUTION_SUPERVISOR_ENABLED: true }));
vi.mock('./scheduler-inventory.js', () => ({ schedulerInventory: fixture.inventory }));
const { cronRoutes, OS_SCHEDULER_WRITER_DOMAIN } = await import('./cron-manager.js');
const { canonicalSchedulerEvidence } = await import('./scheduler-drain.js');
const { nodeAuthMiddleware } = await import('../middleware.js');
const { managedMutationGuard } = await import('./managed-http.js');
const barrier = { nodeId: 'node-1', nodeFqdn: 'fixture.lab', epoch: 2, barrierId: randomUUID() };
const clear = { version: 1, barrier, sources: { source: 'a'.repeat(64) }, supported: true, quiescent: true,
  activeCount: 0, unknownCount: 0, blockers: [], issues: [], managedJobs: [], occurrences: [] };
const app = new Hono(); app.use('*', nodeAuthMiddleware); app.use('*', managedMutationGuard); app.route('/cron', cronRoutes);
const path = (nonce = randomUUID()) => '/cron/os-scheduler-writer-proof?' +
  new URLSearchParams({ nodeFqdn: 'fixture.lab', nonce });
const request = (url: string) => app.request(url, { headers: { 'x-node-token': 'node-auth' } });

beforeEach(() => { fixture.inventory.mockReset().mockResolvedValue(clear); });

describe('OS scheduler owner proof route', () => {
  it('requires node auth, two stable complete inventories, and signs the exact drain', async () => {
    const url = path();
    expect((await app.request(url)).status).toBe(401);
    const result = await request(url);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const { signature, ...receipt } = (await result.json()).data;
    expect(receipt).toMatchObject({ sourceClass: 'os-schedulers', ...barrier,
      nonce: new URL('http://fixture' + url).searchParams.get('nonce'), active: 0, unknown: 0,
      scheduleInventorySha256: createHash('sha256').update(canonicalSchedulerEvidence(clear)).digest('hex') });
    expect(signature).toBe(createHmac('sha256', secret)
      .update(OS_SCHEDULER_WRITER_DOMAIN + canonicalSchedulerEvidence(receipt)).digest('hex'));
    expect(fixture.inventory).toHaveBeenCalledTimes(2);
  });

  it('rejects foreign sources, unsettled work, missing barrier, and changed inventory', async () => {
    for (const blocked of [
      { ...clear, supported: false, quiescent: false, blockers: [{ kind: 'SYSTEM_CRONTAB', sourceSha256: 'b'.repeat(64), count: 1 }] },
      { ...clear, unknownCount: 1, quiescent: false },
      { ...clear, barrier: null },
      { ...clear, issues: ['UNREADABLE_SCHEDULER_SOURCE'], supported: false },
    ]) {
      fixture.inventory.mockReset().mockResolvedValue(blocked);
      expect((await request(path())).status).toBe(409);
    }
    fixture.inventory.mockReset().mockResolvedValueOnce(clear).mockResolvedValueOnce({ ...clear, sources: { source: 'b'.repeat(64) } });
    expect((await request(path())).status).toBe(409);
  });
});
