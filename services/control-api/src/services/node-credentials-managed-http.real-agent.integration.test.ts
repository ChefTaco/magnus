/**
 * Managed HTTP to an enrolled node whose agent has its own key: the real agent, the real server
 * client and PostgreSQL, with the network as Request objects handed across.
 *
 * Agents 2.10.0 and 2.10.1 ran their authentication twice on `POST /api/v1/commands/managed-http`
 * (once for /api/v1/*, once for the route itself). The second pass saw the nonce the first had just
 * claimed, so every signed managed request was refused as a replay (401 NODE_AUTH_REPLAY) before the
 * handler ran, and the server kept the lease `unknown`. Those agents are emulated here by the real
 * agent plus one more verification of the same signed bytes, which is what their second pass was,
 * and a ping that reports their version.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNodeBaseUrl } from '../utils/node-url.js';

const nodeKey = 'managed-http-node-fixture-at-least-32-characters';
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  NODE_MANAGER_SECRET: 'managed-http-node-fixture-at-least-32-characters', RESULT_SIGNING_SECRET: 'managed-http-result-fixture-at-least-32-characters',
  RESULT_SIGNING_PREVIOUS_SECRET: '', getNodeManagerSecret: () => 'managed-http-node-fixture-at-least-32-characters' }));
const auditLog = vi.hoisted(() => vi.fn(async (_event: { action: string }) => undefined));
vi.mock('./audit-service.js', async original => ({ ...await original<object>(), logAuditEvent: auditLog }));
const serverCall = vi.hoisted(() => ({ handle: null as null | ((url: string, init: RequestInit) => Promise<Response>) }));
vi.mock('../../../../packages/agent/src/tls.js', async original => ({ ...await original<object>(),
  controlApiFetch: (url: string, init: RequestInit) => serverCall.handle!(url, init) }));

const prefix = `mhttp-${randomUUID().slice(0, 8)}`;
const nodeId = prefix;
const nodeFqdn = `${prefix}.example.com`;
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

type Sent = { method: string; path: string; headers: Record<string, string> };

describe.skipIf(!process.env['TEST_DATABASE_URL'])('managed HTTP to a keyed agent: the real agent against the real server', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let root: string;
  let ledgerDir: string;
  let server: Hono;
  let agentApp: Hono;
  let sdk: typeof import('../sdk/node-api-client.js');
  let agentAuth: typeof import('../../../../packages/agent/src/node-auth.js');
  let agentIdentity: typeof import('../../../../packages/agent/src/security/node-identity.js');
  let target: string;
  const sent: Sent[] = [];
  let captured: Request | null = null;
  /** The agent version to emulate; null is this source tree's agent as it is. */
  let emulate: string | null = null;

  const client = () => new sdk.NodeApiClient({ baseUrl: getNodeBaseUrl('127.0.0.1', 41100), nodeToken: nodeKey, resourceNodeId: nodeId, resourceActorId: 'system:agent-upgrade', timeout: 60_000 });
  const upgrade = () => client().upgradeAgent({ version: target, integrity: INTEGRITY, requestId: randomUUID(), packageName: '@hivemagnus/magnus-agent' });
  const leasesOf = () => db.commandResourceLease.findMany({ where: { nodeId }, orderBy: { acquiredAt: 'asc' } });
  const managedPosts = () => sent.filter(request => request.method === 'POST' && request.path === '/api/v1/commands/managed-http');
  const errorCode = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code;
  const signedHeartbeat = () => {
    const pins = agentIdentity.boundNodeIdentity()!.binding.serverKeys.map(key => key.keyId);
    const body = JSON.stringify({ agentVersion: '2.10.0', fqdn: nodeFqdn, nodeAuth: { serverKeyIds: pins } });
    const { 'x-node-token': _legacy, ...signature } = agentAuth.controlApiAuthHeaders('POST', 'https://control.example.com/api/v1/heartbeat', body);
    return server.request('/api/v1/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', ...signature }, body });
  };

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    root = await mkdtemp(join(tmpdir(), 'magnus-managed-http-'));
    ledgerDir = join(root, '.magnus/command-receipts');
    for (const [name, value] of Object.entries({ DATABASE_URL: url, MAGNUS_RESOURCE_LEASES_ENABLED: 'true', AGENT_INSTALL_DIR: root,
      RESULT_SIGNING_SECRET: 'managed-http-result-fixture-at-least-32-characters', NODE_MANAGER_SECRET: nodeKey, HOST_FQDN: nodeFqdn,
      ENABLE_NODE_MANAGEMENT: 'true', CONTROL_API_URL: 'https://control.example.com', MAGNUS_EXECUTION_SUPERVISOR_ENABLED: 'false',
      MAGNUS_AGENT_LAUNCHER: '1', MAGNUS_AGENT_LAUNCHER_PROTOCOL: '1', MAGNUS_AGENT_NPM: join(root, 'fake-npm.sh'), MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE: 'false',
      MAGNUS_AGENT_PRIVILEGED: 'true', NODE_AUTH_MODE: 'compat',
      CREDENTIAL_ROTATION_KEY: 'managed-http-rotation-fixture-at-least-32-characters', CREDENTIAL_ROTATION_STATE_PATH: join(root, 'rotation.json'),
      NODE_AUTH_SERVER_KEY_PATH: join(root, 'server-state/server-signing-key.json') })) vi.stubEnv(name, value);
    (await import('./node-server-key.js')).allowServerKeyCreation();
    db = (await import('../db/index.js')).getDb();
    sdk = await import('../sdk/node-api-client.js');
    agentAuth = await import('../../../../packages/agent/src/node-auth.js');
    agentIdentity = await import('../../../../packages/agent/src/security/node-identity.js');
    const agentVersion = (await import('../../../../packages/agent/src/version.js')).AGENT_VERSION;
    target = `${agentVersion.split('.')[0]}.999.0`;
    const entry = join(root, 'versions', agentVersion, 'node_modules/@hivemagnus/magnus-agent/dist');
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, 'index.js'), '');
    await symlink(join('versions', agentVersion), join(root, 'current'), 'dir');
    await writeFile(join(root, 'fake-npm.sh'), '#!/bin/sh\necho "npm error code E404 not in this registry" >&2\nexit 1\n', { mode: 0o755 });
    agentApp = await (await import('../../../../packages/agent/src/server.js')).createApp();
    const { nodeAuthMiddleware } = await import('../../../../packages/agent/src/middleware.js');
    // What the second authentication pass of a 2.10.0 or 2.10.1 agent did on this route.
    const secondPass = new Hono().post('/api/v1/commands/managed-http', nodeAuthMiddleware, c => c.body(null, 204));
    const { heartbeatRouter } = await import('../routes/heartbeat.js');
    const { nodeEnrollmentRouter } = await import('../routes/node-enrollment.js');
    const { resourceLeasesRouter } = await import('../routes/resource-leases.js');
    const { errorHandler } = await import('../middleware/error-handler.js');
    server = new Hono().onError(errorHandler).route('/api/v1/heartbeat', heartbeatRouter).route('/api/v1/node-enrollment', nodeEnrollmentRouter)
      .route('/api/v1/resource-leases', resourceLeasesRouter);
    serverCall.handle = (address, init) => Promise.resolve(server.request(new URL(address).pathname + new URL(address).search,
      { ...init, headers: { ...(init.headers as Record<string, string>), 'x-forwarded-for': '127.0.0.1' } }));
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      sent.push({ method: request.method, path, headers: Object.fromEntries(request.headers) });
      if (request.method === 'POST' && path === '/api/v1/commands/managed-http') {
        captured = request.clone();
        if (emulate) {
          const first = await secondPass.request(request.clone());
          if (first.status !== 204) throw new Error('the emulated first pass must accept what the real agent accepts');
        }
      }
      const response = await agentApp.request(request);
      if (!emulate || path !== '/api/v1/ping') return response;
      const body = await response.json() as { data: { version: string } };
      return new Response(JSON.stringify({ ...body, data: { ...body.data, version: emulate } }), { status: response.status, headers: response.headers });
    });
    await db.node.create({ data: { id: nodeId, name: nodeId, hostname: nodeFqdn, ipAddress: '127.0.0.1', port: 41100, os: 'fixture', arch: 'fixture', token: randomUUID(),
      status: 'ONLINE', lastHeartbeatAt: new Date(), agent: { create: { version: '2.10.0', status: 'RUNNING' } } } });
    await db.resourceEnrollment.create({ data: { nodeId, nodeFqdn, state: 'enrolled', epoch: 1, barrierId: randomUUID(), enrolledAt: new Date() } });
  }, 120_000);

  beforeEach(async () => {
    sent.length = 0; captured = null; emulate = null;
    await db.commandResourceLease.deleteMany({ where: { nodeId } });
    await rm(join(ledgerDir, 'active.lock'), { force: true });
  });

  afterAll(async () => {
    if (db) {
      await db.commandResourceLease.deleteMany({ where: { nodeId } });
      await db.commandResourceFence.deleteMany({ where: { resourceKey: { startsWith: `node:${nodeId}` } } });
      await db.resourceEnrollment.deleteMany({ where: { nodeId } });
      await db.notification.deleteMany({ where: { nodeId } });
      await db.nodeLegacyCredentialUse.deleteMany({ where: { nodeId } });
      await db.healthSnapshot.deleteMany({ where: { nodeId } });
      await db.nodeCredential.deleteMany({ where: { nodeId } });
      await db.agent.deleteMany({ where: { nodeId } });
      await db.node.deleteMany({ where: { id: nodeId } });
      await (await import('../db/index.js')).disconnectDb();
    }
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });

  /** The agent answered the upgrade itself (npm is a script that fails), and the lease settled on its signed receipt. */
  async function expectAnsweredAndSettled(): Promise<void> {
    await expect(upgrade()).rejects.toMatchObject({ code: 'SELF_UPGRADE_FAILED' });
    expect(await leasesOf()).toEqual([expect.objectContaining({ state: 'released', settlement: 'signed-command-result' })]);
  }

  it('1. 2.9.1 without a key: managed HTTP works as before, with the shared secret beside the signature', async () => {
    emulate = '2.9.1';
    await expectAnsweredAndSettled();
    expect(managedPosts()).toEqual([expect.objectContaining({ headers: expect.objectContaining({ 'x-node-token': nodeKey, 'x-magnus-node-id': nodeId }) })]);
  });

  it('2. the agent binds its key and reports its pins in a signed heartbeat', async () => {
    const enrollment = await import('../../../../packages/agent/src/node-enrollment.js');
    expect(await enrollment.attemptLegacyUpgrade()).toEqual({ state: 'bound', nodeId });
    expect((await signedHeartbeat()).status).toBe(200);
  });

  it.each(['2.10.0', '2.10.1'])('3. %s with a key: upgraded through managed HTTP without first upgrading it', async version => {
    emulate = version;
    await expectAnsweredAndSettled();
    // The one request those agents can authenticate on this route: the shared secret, without a signature.
    const [post] = managedPosts();
    expect(post?.headers['x-node-token']).toBe(nodeKey);
    expect(post?.headers['x-magnus-signature']).toBeUndefined();
    await (await import('./node-legacy-use.js')).flushLegacyUse();
    expect(await db.nodeLegacyCredentialUse.count({ where: { nodeId, channel: 'outbound' } })).toBeGreaterThan(0);
  });

  it('4. this agent with a key: managed HTTP is signed only, verified once, and a replay of it is refused', async () => {
    expect((await signedHeartbeat()).status).toBe(200);
    await expectAnsweredAndSettled();
    const [post] = managedPosts();
    expect(post?.headers['x-node-token']).toBeUndefined();
    expect(post?.headers['x-magnus-signature']).toMatch(/^[A-Za-z0-9_-]{86}$/);
    // The same signed bytes again: a nonce is accepted once.
    const replay = await agentApp.request(captured!);
    expect(replay.status).toBe(401);
    expect(await errorCode(replay)).toBe('NODE_AUTH_REPLAY');
  });

  it('5. in enforce mode a 2.10.0 or 2.10.1 agent with a key is not sent managed HTTP at all, and its lease is released', async () => {
    emulate = '2.10.1';
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    try {
      await expect(upgrade()).rejects.toMatchObject({ code: 'AGENT_MANAGED_HTTP_NEEDS_UPGRADE', dispatched: false });
    } finally { vi.stubEnv('NODE_AUTH_MODE', 'compat'); }
    expect(managedPosts()).toEqual([]);
    expect(await leasesOf()).toEqual([expect.objectContaining({ state: 'released', settlement: 'not-dispatched' })]);
  });

  it('6. the lease a refused replay left unknown settles from the agent\'s signed ledger account, as on the affected node', async () => {
    emulate = '2.10.0';
    const leases = await import('./command-resource-leases.js');
    const commandId = `agent-upgrade-${randomUUID()}`;
    const admission = await leases.admitResourceCommand({ nodeId, actorId: 'system:agent-upgrade', baseUrl: getNodeBaseUrl('127.0.0.1', 41100) },
      (await import('../security/managed-http.js')).httpIdentity(commandId, 'POST', '/agent-upgrade', '{}', 900));
    await leases.markResourceDispatched(admission!);
    await leases.failResourceCommand(admission!);
    await db.$executeRaw`ALTER TABLE command_resource_leases DISABLE TRIGGER command_resource_leases_authority_immutable`;
    await db.commandResourceLease.update({ where: { commandId }, data: { deadline: new Date(Date.now() - 10 * 60_000) } });
    await db.$executeRaw`ALTER TABLE command_resource_leases ENABLE TRIGGER command_resource_leases_authority_immutable`;
    const fence = BigInt(admission!.payload.coordination!.fence);
    await writeFile(join(ledgerDir, `fence-${createHash('sha256').update(`node:${nodeId}`).digest('hex')}.json`),
      JSON.stringify({ resourceKey: `node:${nodeId}`, fence: String(fence - 1n) }), { mode: 0o600 });
    const { recoverNodeLeases } = await import('./agent-upgrade-preflight.js');
    expect(await recoverNodeLeases(nodeId, 'system:magnus-server-cli')).toEqual([{ commandId, outcome: 'settled' }]);
    expect(await leasesOf()).toEqual([expect.objectContaining({ commandId, state: 'released', settlement: 'not-dispatched' })]);
    // The trace is a signed GET: authenticated once by every agent version.
    expect(sent.find(request => request.path.endsWith('/trace'))?.headers['x-magnus-signature']).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });
});
