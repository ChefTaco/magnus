/**
 * One wave through the real client, admission, leases and fence rows in
 * PostgreSQL. Only the agents are fake, answering at the HTTP boundary: one
 * holds a fence its preflight reports, one is too old for a preflight and
 * refuses with a signed STALE_FENCE, one sits behind a stuck enrollment.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { commandRequestDigest } from '../security/command-request.js';
import { commandRefusalSigningPayload, commandResultSigningPayload } from '../security/command-result-signature.js';
import { httpIdentity, httpReceiptBody } from '../security/managed-http.js';

const secret = 'upgrade-wave-result-fixture-at-least-32-characters';
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  NODE_MANAGER_SECRET: 'upgrade-wave-node-auth-fixture-at-least-32-characters',
  RESULT_SIGNING_SECRET: 'upgrade-wave-result-fixture-at-least-32-characters', RESULT_SIGNING_PREVIOUS_SECRET: '',
  getNodeManagerSecret: () => 'upgrade-wave-node-auth-fixture-at-least-32-characters' }));
const auditLog = vi.hoisted(() => vi.fn(async (_event: unknown) => undefined));
vi.mock('./audit-service.js', async original => ({ ...await original<object>(), logAuditEvent: auditLog }));

const prefix = `wave-${randomUUID().slice(0, 8)}`;
const HIGH = 1789962351090n;
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const TARGET = '1.1.8';

describe.skipIf(!process.env['TEST_DATABASE_URL'])('an upgrade wave over real leases and fences', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  const nodes = { reports: { id: `${prefix}-reports`, port: 41001 }, old: { id: `${prefix}-old`, port: 41002 }, stuck: { id: `${prefix}-stuck`, port: 41003 } };
  const ids = Object.values(nodes).map(node => node.id);
  const metadata = () => JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, upgrade: { state: 'idle', to: '1.1.7' }, observedAt: new Date().toISOString() } });

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    vi.stubEnv('DATABASE_URL', url); vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'true');
    db = (await import('../db/index.js')).getDb();
    for (const node of Object.values(nodes)) {
      await db.node.create({ data: { id: node.id, name: node.id, hostname: `${node.id}.invalid`, ipAddress: '127.0.0.1', port: node.port, os: 'fixture', arch: 'fixture', token: randomUUID(),
        status: 'ONLINE', lastHeartbeatAt: new Date(), metadata: metadata(), agent: { create: { version: '1.1.7', status: 'RUNNING' } } } });
      await db.resourceEnrollment.create({ data: { nodeId: node.id, nodeFqdn: `${node.id}.invalid`, state: node === nodes.stuck ? 'draining' : 'enrolled', epoch: 1, barrierId: randomUUID(),
        ...(node === nodes.stuck ? { startedAt: new Date('2026-06-03T10:00:00Z') } : { enrolledAt: new Date() }) } });
    }
  });

  afterAll(async () => {
    if (db) {
      await db.commandResourceLease.deleteMany({ where: { nodeId: { in: ids } } });
      await db.remoteCommand.deleteMany({ where: { nodeId: { in: ids } } });
      await db.commandResourceFence.deleteMany({ where: { resourceKey: { in: ids.map(id => `node:${id}`) } } });
      await db.resourceEnrollment.deleteMany({ where: { nodeId: { in: ids } } });
      await db.agent.deleteMany({ where: { nodeId: { in: ids } } });
      await db.node.deleteMany({ where: { id: { in: ids } } });
      await (await import('../db/index.js')).disconnectDb();
    }
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });

  it('heals what it can, retries what it may, excludes what it must, and leaves no lease held', async () => {
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    const ledger = new Map([[nodes.reports.id, HIGH], [nodes.old.id, HIGH]]);
    const accepted: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      const node = Object.values(nodes).find(entry => String(entry.port) === url.port)!;
      if (url.pathname.endsWith('/ping')) return json({ success: true, data: { features: { managedMutations: 1 } } });
      if (url.pathname.endsWith('/agent-upgrade/preflight')) return node === nodes.old ? json({ success: false, error: { code: 'NOT_FOUND' } }, 404)
        : json({ success: true, data: { preflightProtocol: 1, version: '1.1.7', layout: 'versioned', enabled: true, writable: { ok: true, blocked: [] }, fromVersionComplete: true,
          fenceHighWater: { [`node:${node.id}`]: String(ledger.get(node.id)) } } });
      if (url.pathname.endsWith('/receipts/') || url.pathname.includes('/trace')) return json({ success: false }, 404);
      const value = await req.json() as { commandId: string; method: 'POST'; path: string; body: string; timeoutSeconds: number; coordination: { resourceKey: string; fence: string; expiresAt: number; version: 1 } };
      const identity = { ...httpIdentity(value.commandId, value.method, value.path, value.body, value.timeoutSeconds), coordination: value.coordination };
      const digest = commandRequestDigest(identity);
      if (BigInt(value.coordination.fence) <= ledger.get(node.id)!) {
        const unsigned = { commandId: value.commandId, requestSha256: digest, code: 'STALE_FENCE', highWater: String(ledger.get(node.id)) };
        return json({ success: false, error: { code: 'STALE_FENCE', message: 'Stale resource fence cannot execute', executed: false, dispatched: false, highWater: unsigned.highWater, resourceKey: value.coordination.resourceKey,
          refusal: { ...unsigned, signature: createHmac('sha256', secret).update(commandRefusalSigningPayload(unsigned)).digest('hex') } } }, 409);
      }
      ledger.set(node.id, BigInt(value.coordination.fence));
      accepted.push(node.id);
      const body = JSON.stringify({ success: true, data: { accepted: true } });
      const result = { commandId: value.commandId, exitCode: 0, stdout: httpReceiptBody(value.method, value.path, 200, body), stderr: '', durationMs: 1, truncated: false,
        coordination: { ...value.coordination, requestSha256: digest } };
      const requestId = (JSON.parse(value.body) as { requestId: string }).requestId;
      await db.node.update({ where: { id: node.id }, data: { metadata: JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true,
        upgrade: { state: 'confirmed', from: '1.1.7', to: TARGET, requestId }, observedAt: new Date().toISOString() } }) } });
      return json({ success: true, data: { response: { status: 200, body }, receipt: { ...result, signature: createHmac('sha256', secret).update(commandResultSigningPayload(result)).digest('hex') } } });
    }));
    const service = await import('./agent-upgrade-service.js');
    const store = service.memoryRunStore();
    const deps = { ...service.defaultDeps(store), pollMs: 5, confirmTimeoutMs: 5_000, retryBackoffMs: [1], sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(ms, 5))) };
    const { run: started, done } = await service.startUpgradeRun({ version: TARGET, integrity: INTEGRITY, nodeIds: ids, actorId: 'admin', store, deps });
    const run = await done;

    const fence = async (id: string) => (await db.commandResourceFence.findUniqueOrThrow({ where: { resourceKey: `node:${id}` } })).generation;
    // The preflight healed this one before anything was sent: it passed on its first request.
    expect(run.nodes.find(node => node.nodeId === nodes.reports.id)).toMatchObject({ state: 'confirmed', attempts: 1 });
    expect(await fence(nodes.reports.id)).toBe(HIGH + 2n);
    // This one could only say so by refusing: signed, settled, healed, and tried again with a new request.
    expect(run.nodes.find(node => node.nodeId === nodes.old.id)).toMatchObject({ state: 'confirmed', attempts: 2 });
    expect(await fence(nodes.old.id)).toBe(HIGH + 2n);
    expect(started.excluded).toEqual([expect.objectContaining({ nodeId: nodes.stuck.id, code: 'ENROLLMENT_DRAINING' })]);
    expect(run.status).toBe('partial');
    expect(run.attention?.map(item => item.code)).toEqual(['ENROLLMENT_DRAINING']);
    const leases = await db.commandResourceLease.findMany({ where: { nodeId: { in: ids } } });
    expect(leases.filter(lease => lease.state !== 'released')).toEqual([]);
    expect(leases.filter(lease => lease.nodeId === nodes.old.id).map(lease => lease.settlement).sort()).toEqual(['not-dispatched', 'signed-command-result']);
    expect(accepted.sort()).toEqual([nodes.reports.id, nodes.old.id].sort());
    const advanced = auditLog.mock.calls.map(([event]) => event as { action: string; details: { source: string } }).filter(event => event.action === 'agent.fence.advanced');
    expect(advanced.map(event => event.details.source).sort()).toEqual(['preflight', 'stale-fence-reply']);
  });
});
