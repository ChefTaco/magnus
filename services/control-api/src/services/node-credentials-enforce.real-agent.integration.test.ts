/**
 * Per-node credentials, phase 3 (3.0.0), with the real agent against the real server and PostgreSQL:
 * NODE_AUTH_MODE is unset on both sides (enforce, the default), and neither holds a shared node
 * secret or a shared result key. A node is registered, its agent enrolls with a one-time token, the
 * start-up guard is satisfied once the agent signs its evidence, the server reaches the agent with
 * signatures only, and the server key is rotated (stage, the agent pins it, promote, retire) while
 * the agent keeps working, including an agent that missed the promotion.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const auditLog = vi.hoisted(() => vi.fn(async (_event: { action: string }) => undefined));
vi.mock('./audit-service.js', async original => ({ ...await original<object>(), logAuditEvent: auditLog }));
const serverCall = vi.hoisted(() => ({ handle: null as null | ((url: string, init: RequestInit) => Promise<Response>) }));
vi.mock('../../../../packages/agent/src/tls.js', async original => ({ ...await original<object>(),
  controlApiFetch: (url: string, init: RequestInit) => serverCall.handle!(url, init) }));

const prefix = `enf-${randomUUID().slice(0, 8)}`;
const nodeId = `${prefix}-node`;
const nodeFqdn = `${prefix}-node.example.com`;

describe.skipIf(!process.env['TEST_DATABASE_URL'])('per-node credentials in enforce mode: the real agent against the real server', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let root: string;
  let server: Hono;
  let agentApp: Hono;
  let agentAuth: typeof import('../../../../packages/agent/src/node-auth.js');
  let agentEnrollment: typeof import('../../../../packages/agent/src/node-enrollment.js');
  let agentIdentity: typeof import('../../../../packages/agent/src/security/node-identity.js');
  let serverKey: typeof import('./node-server-key.js');
  const toAgent: Array<Record<string, string>> = [];

  /** One heartbeat as the agent sends it (signed, advertising its pins and evidence signing), and the agent's handling of the reply. */
  const heartbeat = async () => {
    const binding = agentIdentity.boundNodeIdentity()!.binding;
    const body = JSON.stringify({ agentVersion: '3.0.0', fqdn: nodeFqdn,
      nodeAuth: { serverKeyIds: binding.serverKeys.map(key => key.keyId), ...(binding.serverEvidence ? { evidence: 1 } : {}) } });
    const response = await server.request('/api/v1/heartbeat', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', ...agentAuth.controlApiAuthHeaders('POST', 'https://control.example.com/api/v1/heartbeat', body) }, body });
    const json = await response.json() as { data?: { nodeAuth?: Parameters<typeof agentEnrollment.onHeartbeatAcknowledged>[0] }; error?: { code?: string } };
    // Each heartbeat here stands for one a minute apart: the agent's re-read of the server keys is throttled to one a minute.
    agentEnrollment.resetNodeEnrollmentState();
    if (response.status === 200) agentEnrollment.onHeartbeatAcknowledged(json.data?.nodeAuth);
    await new Promise(resolve => setTimeout(resolve, 20));
    agentIdentity.resetNodeIdentityCache();
    return { status: response.status, json };
  };
  /** The server's real signing path to the agent's authenticated health check; the status it answers. */
  const callAgent = async () => {
    const { agentFetch } = await import('./node-agent-auth.js');
    return (await agentFetch({ nodeId }, 'https://agent.example.com:41100/api/v1/health/check')).status;
  };

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    root = await mkdtemp(join(tmpdir(), 'magnus-node-credentials-enforce-'));
    // No NODE_AUTH_MODE, no NODE_MANAGER_SECRET, no RESULT_SIGNING_SECRET: what a 3.0.0 installation has.
    for (const name of ['NODE_AUTH_MODE', 'NODE_MANAGER_SECRET', 'RESULT_SIGNING_SECRET', 'COMMAND_RECONCILIATION_SECRET', 'NODE_AUTO_REGISTER']) vi.stubEnv(name, '');
    for (const [name, value] of Object.entries({ DATABASE_URL: url, AGENT_INSTALL_DIR: join(root, 'agent'), HOST_FQDN: nodeFqdn, ENABLE_NODE_MANAGEMENT: 'true',
      CONTROL_API_URL: 'https://control.example.com', MAGNUS_EXECUTION_SUPERVISOR_ENABLED: 'false', MAGNUS_AGENT_PRIVILEGED: 'false',
      NODE_AUTH_SERVER_KEY_PATH: join(root, 'server-state/server-signing-key.json') })) vi.stubEnv(name, value);
    for (const name of ['NODE_AUTH_MODE', 'NODE_MANAGER_SECRET', 'RESULT_SIGNING_SECRET', 'COMMAND_RECONCILIATION_SECRET', 'NODE_AUTO_REGISTER']) delete process.env[name];
    serverKey = await import('./node-server-key.js');
    serverKey.allowServerKeyCreation();
    db = (await import('../db/index.js')).getDb();
    agentAuth = await import('../../../../packages/agent/src/node-auth.js');
    agentEnrollment = await import('../../../../packages/agent/src/node-enrollment.js');
    agentIdentity = await import('../../../../packages/agent/src/security/node-identity.js');
    agentApp = await (await import('../../../../packages/agent/src/server.js')).createApp();
    const { heartbeatRouter } = await import('../routes/heartbeat.js');
    const { nodeEnrollmentRouter } = await import('../routes/node-enrollment.js');
    const { errorHandler } = await import('../middleware/error-handler.js');
    server = new Hono().onError(errorHandler).route('/api/v1/heartbeat', heartbeatRouter).route('/api/v1/node-enrollment', nodeEnrollmentRouter);
    serverCall.handle = (target, init) => Promise.resolve(server.request(new URL(target).pathname + new URL(target).search,
      { ...init, headers: { ...(init.headers as Record<string, string>), 'x-forwarded-for': '127.0.0.1' } }));
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      toAgent.push(Object.fromEntries(request.headers));
      return agentApp.request(request);
    });
    // Registered by an administrator; nothing on the shared secret.
    await db.node.create({ data: { id: nodeId, name: nodeId, hostname: nodeFqdn, ipAddress: '127.0.0.1', port: 41100, os: 'fixture', arch: 'fixture',
      token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date(), agent: { create: { version: '3.0.0', status: 'RUNNING' } } } });
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await db.notification.deleteMany({ where: { nodeId } });
      await db.nodeLegacyCredentialUse.deleteMany({ where: { nodeId } });
      await db.healthSnapshot.deleteMany({ where: { nodeId } });
      await db.agent.deleteMany({ where: { nodeId } });
      await db.node.deleteMany({ where: { id: nodeId } });
      await (await import('../db/index.js')).disconnectDb();
    }
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });

  it('1. enforce is the default: the guard refuses to start while the registered node has no key', async () => {
    const { nodeAuthStartupGuard } = await import('./node-auth-startup-guard.js');
    const guard = await nodeAuthStartupGuard();
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.message).toContain(`${nodeId} (${nodeId})`);
    // The agent has no secret to speak with; the server refuses it, and the legacy upgrade is closed.
    expect(agentAuth.controlApiAuthHeaders('POST', 'https://control.example.com/api/v1/heartbeat', '{}')).toEqual({});
    const upgrade = await server.request('/api/v1/node-enrollment/legacy-upgrade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(upgrade.status).toBe(410);
  });

  it('2. the agent enrolls with a one-time token and signs its heartbeats; the guard lets the server start once it signs evidence', async () => {
    const { issueEnrollmentToken } = await import('./node-credential-service.js');
    const { token } = await issueEnrollmentToken(nodeId, 'admin');
    expect(await agentEnrollment.enrollWithToken(token)).toMatchObject({ ok: true, nodeId });
    agentIdentity.resetNodeIdentityCache();
    expect(agentAuth.agentEnforcesNodeAuth()).toBe(true);
    const first = await heartbeat();
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.data?.nodeAuth).toMatchObject({ mode: 'enforce', method: 'signature', evidence: 1, serverKeyIds: [serverKey.serverSigningKey().keyId] });
    // The reply told the agent the server verifies node evidence; its next heartbeat says it signs it.
    expect((await heartbeat()).status).toBe(200);
    await expect.poll(async () => (await db.nodeCredential.findFirst({ where: { nodeId, status: 'ACTIVE' } }))?.evidenceSigning).toBe(true);
    // This node no longer blocks the start in enforce mode (other suites leave nodes of their own in this database).
    const { nodeAuthStartupGuard } = await import('./node-auth-startup-guard.js');
    const guard = await nodeAuthStartupGuard();
    if (!guard.ok) expect(guard.blockers.flatMap(blocker => blocker.nodes.map(node => node.id))).not.toContain(nodeId);
    const { fleetBlockers } = await import('./node-credential-summary.js');
    const { nodeCredentialStore } = await import('./node-credential-store.js');
    expect(fleetBlockers((await nodeCredentialStore.fleet()).filter(node => node.id === nodeId), true)).toEqual([]);
  });

  it('3. the server reaches the agent with signatures only, and a shared-secret request is refused both ways', async () => {
    toAgent.length = 0;
    expect(await callAgent()).toBe(200);
    expect(toAgent.at(-1)).toMatchObject({ 'x-magnus-node-id': nodeId });
    expect(toAgent.at(-1)!['x-node-token']).toBeUndefined();
    const refused = await agentApp.request('/api/v1/health/check', { headers: { 'x-node-token': 'a-shared-secret-nobody-should-have-any-more' } });
    expect(refused.status).toBe(401);
    const tokenHeartbeat = await server.request('/api/v1/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json',
      'x-node-token': 'a-shared-secret-nobody-should-have-any-more', 'x-forwarded-for': '127.0.0.1' }, body: JSON.stringify({ fqdn: nodeFqdn }) });
    expect(tokenHeartbeat.status).toBe(401);
  });

  it('4. server-key rotation: the agent pins the staged key, the promoted key signs, and after the retirement everything still works', async () => {
    const before = serverKey.serverSigningKey().keyId;
    const staged = serverKey.stageNextServerKey().next!.keyId;
    // The heartbeat reply lists the staged key; the agent reads the keys again and pins both.
    expect((await heartbeat()).status).toBe(200);
    await expect.poll(() => { agentIdentity.resetNodeIdentityCache(); return agentIdentity.boundNodeIdentity()!.binding.serverKeys.map(key => key.keyId); })
      .toEqual([before, staged]);
    serverKey.promoteNextServerKey({ graceMs: 60 * 60 * 1000 });
    expect(await callAgent()).toBe(200);
    expect(toAgent.at(-1)!['x-magnus-key-id']).toBe(staged);
    // The agent still signs for the old audience until the next reply lists the promoted key first; both are accepted now.
    expect((await heartbeat()).status).toBe(200);
    await expect.poll(() => { agentIdentity.resetNodeIdentityCache(); return agentIdentity.boundNodeIdentity()!.binding.serverKeys[0]!.keyId; }).toBe(staged);
    serverKey.retirePreviousServerKey({ force: true });
    expect((await heartbeat()).status).toBe(200);
    expect(await callAgent()).toBe(200);
  });

  it('5. an agent that missed a promotion recovers: one refused request, then it pins the new key by itself', async () => {
    const current = serverKey.serverSigningKey().keyId;
    serverKey.stageNextServerKey();
    const next = serverKey.promoteNextServerKey({ graceMs: 60 * 60 * 1000 }).active.keyId;
    serverKey.retirePreviousServerKey({ force: true });
    expect(next).not.toBe(current);
    // The agent never heard of `next` (and has not read the keys for a while): the server's request is refused once,
    // and the agent reads the keys again.
    agentEnrollment.resetNodeEnrollmentState();
    expect(await callAgent()).toBe(401);
    await expect.poll(() => { agentIdentity.resetNodeIdentityCache(); return agentIdentity.boundNodeIdentity()!.binding.serverKeys.map(key => key.keyId); })
      .toEqual([next]);
    expect(await callAgent()).toBe(200);
    expect((await heartbeat()).status).toBe(200);
  });
});
