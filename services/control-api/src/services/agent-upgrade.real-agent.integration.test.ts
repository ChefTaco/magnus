/**
 * The real agent against the real server. Nothing between them is faked: the
 * agent's app, execution slot, ledger and self-upgrade route answer the server's
 * real client, whose leases and fences live in PostgreSQL, and the agent's claims
 * go to the server's real /claim route. Only npm is a script, and the network is
 * Request objects handed straight across. Only failing upgrades can run here:
 * a successful one ends by exiting the process.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNodeBaseUrl } from '../utils/node-url.js';

const nodeKey = 'real-agent-node-auth-fixture-at-least-32-characters';
const resultKey = 'real-agent-result-fixture-at-least-32-characters';
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  NODE_MANAGER_SECRET: 'real-agent-node-auth-fixture-at-least-32-characters', RESULT_SIGNING_SECRET: 'real-agent-result-fixture-at-least-32-characters',
  RESULT_SIGNING_PREVIOUS_SECRET: '', getNodeManagerSecret: () => 'real-agent-node-auth-fixture-at-least-32-characters' }));
const auditLog = vi.hoisted(() => vi.fn(async (_event: unknown) => undefined));
vi.mock('./audit-service.js', async original => ({ ...await original<object>(), logAuditEvent: auditLog }));
const serverCall = vi.hoisted(() => ({ handle: null as null | ((url: string, init: RequestInit) => Promise<Response>) }));
vi.mock('../../../../packages/agent/src/tls.js', async original => ({ ...await original<object>(),
  controlApiFetch: (url: string, init: RequestInit) => serverCall.handle!(url, init) }));

const prefix = `real-${randomUUID().slice(0, 8)}`;
const nodeId = prefix;
const nodeFqdn = `${prefix}.example.com`;
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

describe.skipIf(!process.env['TEST_DATABASE_URL'])('the real agent against the real server', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let root: string;
  let ledgerDir: string;
  let agentVersion: string;
  let target: string;
  let agentApp: Hono;
  let service: typeof import('./agent-upgrade-service.js');
  let sdk: typeof import('../sdk/node-api-client.js');
  let leases: typeof import('./command-resource-leases.js');

  const setNpm = (script: string) => writeFile(join(root, 'fake-npm.sh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const client = () => new sdk.NodeApiClient({ baseUrl: getNodeBaseUrl('127.0.0.1', 41100), nodeToken: nodeKey, resourceNodeId: nodeId, resourceActorId: 'system:agent-upgrade', timeout: 60_000 });
  const fenceFile = (key: string) => join(ledgerDir, `fence-${createHash('sha256').update(key).digest('hex')}.json`);
  const seedFence = async (fence: bigint | string) => {
    await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
    await writeFile(fenceFile(`node:${nodeId}`), JSON.stringify({ resourceKey: `node:${nodeId}`, fence: String(fence) }), { mode: 0o600 });
  };
  const generation = async () => (await db.commandResourceFence.findUnique({ where: { resourceKey: `node:${nodeId}` } }))?.generation ?? 0n;
  const fastDeps = () => {
    let clock = Date.now();
    return { ...service.defaultDeps(service.memoryRunStore()), pollMs: 5, confirmTimeoutMs: 100, retryBackoffMs: [1], now: () => clock,
      sleep: async (ms: number) => { clock += ms; await new Promise(resolve => setTimeout(resolve, 1)); } };
  };
  const wave = async () => {
    const store = service.memoryRunStore();
    const { done } = await service.startUpgradeRun({ version: target, integrity: INTEGRITY, nodeIds: [nodeId], actorId: 'admin', store, deps: fastDeps() });
    return done;
  };

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    root = await mkdtemp(join(tmpdir(), 'magnus-real-agent-'));
    ledgerDir = join(root, '.magnus/command-receipts');
    for (const [name, value] of Object.entries({ DATABASE_URL: url, MAGNUS_RESOURCE_LEASES_ENABLED: 'true', AGENT_INSTALL_DIR: root, RESULT_SIGNING_SECRET: resultKey, NODE_MANAGER_SECRET: nodeKey,
      HOST_FQDN: nodeFqdn, ENABLE_NODE_MANAGEMENT: 'true', CONTROL_API_URL: 'https://control.example.com', MAGNUS_EXECUTION_SUPERVISOR_ENABLED: 'false',
      MAGNUS_AGENT_LAUNCHER: '1', MAGNUS_AGENT_LAUNCHER_PROTOCOL: '1', MAGNUS_AGENT_NPM: join(root, 'fake-npm.sh'), MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE: 'false', MAGNUS_AGENT_PRIVILEGED: 'true',
      CREDENTIAL_ROTATION_KEY: 'real-agent-rotation-fixture-at-least-32-characters', CREDENTIAL_ROTATION_STATE_PATH: join(root, 'rotation.json') })) vi.stubEnv(name, value);
    db = (await import('../db/index.js')).getDb();
    service = await import('./agent-upgrade-service.js');
    sdk = await import('../sdk/node-api-client.js');
    leases = await import('./command-resource-leases.js');
    agentVersion = (await import('../../../../packages/agent/src/version.js')).AGENT_VERSION;
    target = `${agentVersion.split('.')[0]}.999.0`;
    const entry = join(root, 'versions', agentVersion, 'node_modules/@hivemagnus/magnus-agent/dist');
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, 'index.js'), '');
    await symlink(join('versions', agentVersion), join(root, 'current'), 'dir');
    agentApp = await (await import('../../../../packages/agent/src/server.js')).createApp();
    const { resourceLeasesRouter } = await import('../routes/resource-leases.js');
    const server = new Hono().route('/api/v1/resource-leases', resourceLeasesRouter);
    serverCall.handle = (url, init) => Promise.resolve(server.request(new URL(url).pathname, init));
    vi.stubGlobal('fetch', async (input: Request) => agentApp.request(input));
    await db.node.create({ data: { id: nodeId, name: nodeId, hostname: nodeFqdn, ipAddress: '127.0.0.1', port: 41100, os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date(),
      metadata: JSON.stringify({ agentSelfUpgrade: { protocol: 1, launcherProtocol: 1, layout: 'versioned', enabled: true, upgrade: { state: 'idle', to: agentVersion }, observedAt: new Date().toISOString() } }), agent: { create: { version: agentVersion, status: 'RUNNING' } } } });
    await db.resourceEnrollment.create({ data: { nodeId, nodeFqdn, state: 'enrolled', epoch: 1, barrierId: randomUUID(), enrolledAt: new Date() } });
  }, 120_000);

  beforeEach(async () => {
    auditLog.mockClear();
    await db.commandResourceLease.deleteMany({ where: { nodeId } });
    await db.remoteCommand.deleteMany({ where: { nodeId } });
    await db.commandResourceFence.deleteMany({ where: { resourceKey: `node:${nodeId}` } });
    await db.node.update({ where: { id: nodeId }, data: { lastHeartbeatAt: new Date() } });
    await rm(ledgerDir, { recursive: true, force: true });
    await setNpm('exit 1');
  });

  afterAll(async () => {
    if (db) {
      await db.commandResourceLease.deleteMany({ where: { nodeId } });
      await db.remoteCommand.deleteMany({ where: { nodeId } });
      await db.commandResourceFence.deleteMany({ where: { resourceKey: `node:${nodeId}` } });
      await db.resourceEnrollment.deleteMany({ where: { nodeId } });
      await db.agent.deleteMany({ where: { nodeId } });
      await db.node.deleteMany({ where: { id: nodeId } });
      await (await import('../db/index.js')).disconnectDb();
    }
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });

  it('finding 1: a bad package reaches the server as release evidence, and clears the lock and the lease', async () => {
    await setNpm('echo "npm error code E404 not in this registry" >&2; exit 1');
    const run = await wave();
    expect(run.nodes[0]).toMatchObject({ state: 'failed', code: 'SELF_UPGRADE_FAILED', failureClass: 'release', detail: expect.stringMatching(/npm pack failed/) });
    expect(run.status).toBe('failed');
    expect(await db.commandResourceLease.findMany({ where: { nodeId } })).toEqual([expect.objectContaining({ state: 'released', settlement: 'signed-command-result' })]);
    expect(existsSync(join(ledgerDir, 'active.lock'))).toBe(false);
    // Nothing was left behind for the next request on this node.
    await db.node.update({ where: { id: nodeId }, data: { lastHeartbeatAt: new Date() } });
    await expect(client().upgradeAgent({ version: target, integrity: INTEGRITY, requestId: randomUUID(), packageName: '@hivemagnus/magnus-agent' })).rejects.toMatchObject({ code: 'SELF_UPGRADE_FAILED' });
  });

  it('finding 8: a network failure is a node problem, tried again, and each attempt settles', async () => {
    await setNpm('echo "npm error code ENOTFOUND registry.example.com" >&2; exit 1');
    const run = await wave();
    expect(run.nodes[0]).toMatchObject({ state: 'refused', code: 'SELF_UPGRADE_ENV_NETWORK', failureClass: 'node', attempts: 2 });
    expect(run.status).toBe('partial');
    const rows = await db.commandResourceLease.findMany({ where: { nodeId } });
    expect(rows.map(row => row.state)).toEqual(['released', 'released']);
  });

  /** A lease stuck unknown, past its deadline, as the failure this recovery exists for leaves it. */
  async function stuckLease() {
    const commandId = `cmd-${randomUUID()}`;
    const context = { nodeId, actorId: 'admin', baseUrl: getNodeBaseUrl('127.0.0.1', 41100) };
    const admission = await leases.admitResourceCommand(context, { commandId, command: '/usr/bin/true', args: [], timeoutSeconds: 5 });
    await leases.markResourceDispatched(admission!);
    await leases.failResourceCommand(admission!);
    await db.$executeRaw`ALTER TABLE command_resource_leases DISABLE TRIGGER command_resource_leases_authority_immutable`;
    await db.commandResourceLease.update({ where: { commandId }, data: { deadline: new Date(Date.now() - 10 * 60_000) } });
    await db.$executeRaw`ALTER TABLE command_resource_leases ENABLE TRIGGER command_resource_leases_authority_immutable`;
    return { commandId, fence: BigInt(admission!.payload.coordination!.fence) };
  }
  const recover = () => leases.recoverAbsentLeases(nodeId, nodeFqdn, (id, nonce, resourceKey) => client().getCommandTrace(id, nonce, resourceKey));
  const leaseState = async (commandId: string) => (await db.commandResourceLease.findUniqueOrThrow({ where: { commandId } })).state;

  it('finding 3: a missing ledger proves nothing, and the lease stays held with a code', async () => {
    const { commandId } = await stuckLease();
    expect(await recover()).toEqual([expect.objectContaining({ commandId, outcome: 'unverified', code: 'LEDGER_MISSING' })]);
    expect(await leaseState(commandId)).toBe('unknown');
  });

  it('finding 3: an empty ledger with no fence file proves nothing either', async () => {
    const { commandId } = await stuckLease();
    await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
    expect(await recover()).toEqual([expect.objectContaining({ commandId, outcome: 'unverified', code: 'LEDGER_NO_FENCE' })]);
    expect(await leaseState(commandId)).toBe('unknown');
  });

  it('finding 3: settles when the high-water is below the lease fence: it never passed admission', async () => {
    await db.commandResourceFence.create({ data: { resourceKey: `node:${nodeId}`, generation: 10n } });
    const { commandId, fence } = await stuckLease();
    await seedFence(fence - 1n);
    expect(await recover()).toEqual([{ commandId, outcome: 'settled' }]);
  });

  it('finding 3: settles when the high-water is above it with no receipt: the stale-refusal case', async () => {
    const { commandId, fence } = await stuckLease();
    await seedFence(fence + 100n);
    expect(await recover()).toEqual([{ commandId, outcome: 'settled' }]);
    expect(await db.commandResourceLease.findUniqueOrThrow({ where: { commandId } })).toMatchObject({ state: 'released', settlement: 'not-dispatched' });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.lease.recovered', targetId: nodeId }));
  });

  it('finding 3: high-water equal to the lease fence with no lock is inconsistent: the receipt should be there', async () => {
    const { commandId, fence } = await stuckLease();
    await seedFence(fence);
    expect(await recover()).toEqual([expect.objectContaining({ commandId, outcome: 'unverified', code: 'LEDGER_EVIDENCE_INCONSISTENT' })]);
  });

  it('a crash between the claim and the receipt settles: a lock without a receipt never started', async () => {
    const { commandId, fence } = await stuckLease();
    await seedFence(fence);
    await writeFile(join(ledgerDir, 'active.lock'), JSON.stringify({ commandId, nonce: randomUUID(), pid: 1 }), { mode: 0o600 });
    expect(await recover()).toEqual([{ commandId, outcome: 'settled' }]);
  });

  it('finding 3: a marker for another node, or one it cannot read, stays held', async () => {
    const { commandId, fence } = await stuckLease();
    await seedFence(fence + 1n);
    await writeFile(join(ledgerDir, 'managed-enrollment.json'), JSON.stringify({ version: 1, nodeId: 'another-node', nodeFqdn: 'other.example.com' }), { mode: 0o600 });
    expect(await recover()).toEqual([expect.objectContaining({ outcome: 'unverified', code: 'ENROLLMENT_MARKER_MISMATCH' })]);
    await writeFile(join(ledgerDir, 'managed-enrollment.json'), 'garbage', { mode: 0o600 });
    expect(await recover()).toEqual([expect.objectContaining({ outcome: 'unverified', code: 'ENROLLMENT_MARKER_UNKNOWN' })]);
    expect(await leaseState(commandId)).toBe('unknown');
  });

  it('finding 9: a real stale fence reply settles and heals through the bound signature', async () => {
    await seedFence(1789962351090n);
    await expect(client().upgradeAgent({ version: target, integrity: INTEGRITY, requestId: randomUUID(), packageName: '@hivemagnus/magnus-agent' })).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(await db.commandResourceLease.findMany({ where: { nodeId } })).toEqual([expect.objectContaining({ state: 'released', settlement: 'not-dispatched' })]);
    expect(await generation()).toBe(1789962351091n);
  });

  it('finding 9: the preflight heals a fence only through its signed proof', async () => {
    await seedFence(1789962351090n);
    await setNpm('echo "npm error code E404" >&2; exit 1');
    const run = await wave();
    // The fence never got in the way: the real failure came through on the first attempt.
    expect(run.nodes[0]).toMatchObject({ code: 'SELF_UPGRADE_FAILED', attempts: 1 });
    expect(await generation()).toBe(1789962351092n);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.fence.advanced', details: expect.objectContaining({ source: 'preflight' }) }));
  });

  it('finding 9: a preflight whose proof does not verify moves nothing', async () => {
    await seedFence(1789962351090n);
    const preflight = await import('./agent-upgrade-preflight.js');
    const target_ = { nodeId, hostname: nodeFqdn, managed: true };
    const result = await preflight.preflightNode(target_, { target });
    expect(result.fencesVerified).toBe(true);
    const healed = await preflight.healNode(target_, { ...result, fencesVerified: false });
    expect(healed.healed).toEqual([]);
    expect(await generation()).toBe(0n);
    const wrongNode = await preflight.preflightNode({ ...target_, hostname: 'another.example.com' }, { target });
    expect(wrongNode.fencesVerified).toBe(false);
  });

  it('the console check changes nothing, however much it finds', async () => {
    await seedFence(1789962351090n);
    const { commandId } = await stuckLease();
    await seedFence(1789962351090n);
    const before = await generation();
    const report = await service.checkUpgrade({ version: target, integrity: INTEGRITY, nodeIds: [nodeId], deps: fastDeps() });
    expect(report.nodes[0]?.preflight?.problems.map(problem => problem.code)).toContain('FENCE_AHEAD');
    expect(await generation()).toBe(before);
    expect(await leaseState(commandId)).toBe('unknown');
  });

  describe('finding 7: the readiness monitor', () => {
    const monitor = () => import('./agent-upgrade-readiness.js');
    const setAgent = (version: string) => db.agent.update({ where: { nodeId }, data: { version } });

    it('settles a lease stuck past its deadline, audited, on an agent with the trace route', async () => {
      const { commandId, fence } = await stuckLease();
      await seedFence(fence + 5n);
      const { checkUpgradeReadiness, resetLeaseRecoveryLimits } = await monitor();
      resetLeaseRecoveryLimits();
      await checkUpgradeReadiness();
      expect(await db.commandResourceLease.findUniqueOrThrow({ where: { commandId } })).toMatchObject({ state: 'released', settlement: 'not-dispatched' });
      expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.lease.recovered', targetId: nodeId, details: expect.objectContaining({ commandId }) }));
    });

    it('never settles without ledger evidence', async () => {
      const { commandId } = await stuckLease();
      const { checkUpgradeReadiness, resetLeaseRecoveryLimits } = await monitor();
      resetLeaseRecoveryLimits();
      await checkUpgradeReadiness();
      expect(await leaseState(commandId)).toBe('unknown');
    });

    it('is rate-limited per node, and asks nothing of an agent older than the route', async () => {
      const { commandId, fence } = await stuckLease();
      const { checkUpgradeReadiness, resetLeaseRecoveryLimits, LEASE_RECOVERY_INTERVAL_MS } = await monitor();
      resetLeaseRecoveryLimits();
      const now = Date.now();
      await checkUpgradeReadiness(now);
      await seedFence(fence + 5n);
      await checkUpgradeReadiness(now + 1000);
      expect(await leaseState(commandId)).toBe('unknown');
      await setAgent('1.1.7');
      await checkUpgradeReadiness(now + LEASE_RECOVERY_INTERVAL_MS + 1000);
      expect(await leaseState(commandId)).toBe('unknown');
      await setAgent(agentVersion);
      await checkUpgradeReadiness(now + 2 * LEASE_RECOVERY_INTERVAL_MS + 2000);
      expect(await leaseState(commandId)).toBe('released');
    });

    it('a run reaches a held lease on a node already on the target', async () => {
      const { commandId, fence } = await stuckLease();
      await seedFence(fence + 5n);
      const store = service.memoryRunStore();
      await expect(service.startUpgradeRun({ version: agentVersion, integrity: INTEGRITY, nodeIds: [nodeId], actorId: 'admin', store, deps: fastDeps() })).rejects.toMatchObject({ code: 'NO_ELIGIBLE_AGENTS' });
      expect(await leaseState(commandId)).toBe('released');
    });
  });
});
