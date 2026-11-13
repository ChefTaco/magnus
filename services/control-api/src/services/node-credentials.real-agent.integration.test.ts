/**
 * Per-node credentials with the real agent against the real server and PostgreSQL: the agent's own
 * binding, signing and verification code talks to the server's real routes, and the server's real
 * client calls the agent's real management API. The network is Request objects handed across.
 *
 * Mixed versions are covered from this side: an "old agent" is a caller that only knows the shared
 * secret; the "old server" cases live in packages/agent/src/node-auth.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const nodeKey = 'node-credentials-node-fixture-at-least-32-characters';
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  NODE_MANAGER_SECRET: 'node-credentials-node-fixture-at-least-32-characters', RESULT_SIGNING_SECRET: 'node-credentials-result-fixture-at-least-32-characters',
  RESULT_SIGNING_PREVIOUS_SECRET: '', getNodeManagerSecret: () => 'node-credentials-node-fixture-at-least-32-characters' }));
const auditLog = vi.hoisted(() => vi.fn(async (_event: { action: string }) => undefined));
vi.mock('./audit-service.js', async original => ({ ...await original<object>(), logAuditEvent: auditLog }));
const serverCall = vi.hoisted(() => ({ handle: null as null | ((url: string, init: RequestInit) => Promise<Response>) }));
vi.mock('../../../../packages/agent/src/tls.js', async original => ({ ...await original<object>(),
  controlApiFetch: (url: string, init: RequestInit) => serverCall.handle!(url, init) }));

const prefix = `cred-${randomUUID().slice(0, 8)}`;
const nodeId = `${prefix}-new`;
const nodeFqdn = `${prefix}-new.example.com`;
const oldNodeId = `${prefix}-old`;
const oldFqdn = `${prefix}-old.example.com`;

describe.skipIf(!process.env['TEST_DATABASE_URL'])('per-node credentials: the real agent against the real server', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let root: string;
  let server: Hono;
  let agentApp: Hono;
  let agentAuth: typeof import('../../../../packages/agent/src/node-auth.js');
  let agentEnrollment: typeof import('../../../../packages/agent/src/node-enrollment.js');
  let agentIdentity: typeof import('../../../../packages/agent/src/security/node-identity.js');
  const toAgent: Array<Record<string, string>> = [];

  const heartbeat = (fqdn: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ agentVersion: '2.10.0', fqdn, ...extra });
    return { body, send: (auth: Record<string, string> = headers) => server.request('/api/v1/heartbeat', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', ...auth }, body }) };
  };
  const signedHeartbeat = (fqdn = nodeFqdn) => {
    const pins = agentIdentity.boundNodeIdentity()!.binding.serverKeys.map(key => key.keyId);
    const beat = heartbeat(fqdn, {}, { nodeAuth: { serverKeyIds: pins } });
    const { 'x-node-token': _legacy, ...signature } = agentAuth.controlApiAuthHeaders('POST', 'https://control.example.com/api/v1/heartbeat', beat.body);
    return beat.send(signature);
  };
  const errorCode = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code;

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    root = await mkdtemp(join(tmpdir(), 'magnus-node-credentials-'));
    for (const [name, value] of Object.entries({ DATABASE_URL: url, AGENT_INSTALL_DIR: root, RESULT_SIGNING_SECRET: 'node-credentials-result-fixture-at-least-32-characters',
      NODE_MANAGER_SECRET: nodeKey, HOST_FQDN: nodeFqdn, ENABLE_NODE_MANAGEMENT: 'true', CONTROL_API_URL: 'https://control.example.com',
      MAGNUS_EXECUTION_SUPERVISOR_ENABLED: 'false', MAGNUS_AGENT_PRIVILEGED: 'false', NODE_AUTH_MODE: 'compat',
      CREDENTIAL_ROTATION_KEY: 'node-credentials-rotation-fixture-at-least-32-characters', CREDENTIAL_ROTATION_STATE_PATH: join(root, 'rotation.json'),
      NODE_AUTH_SERVER_KEY_PATH: join(root, 'server-state/server-signing-key.json') })) vi.stubEnv(name, value);
    db = (await import('../db/index.js')).getDb();
    agentAuth = await import('../../../../packages/agent/src/node-auth.js');
    agentEnrollment = await import('../../../../packages/agent/src/node-enrollment.js');
    agentIdentity = await import('../../../../packages/agent/src/security/node-identity.js');
    agentApp = await (await import('../../../../packages/agent/src/server.js')).createApp();
    const { heartbeatRouter } = await import('../routes/heartbeat.js');
    const { nodeEnrollmentRouter } = await import('../routes/node-enrollment.js');
    const { resourceLeasesRouter } = await import('../routes/resource-leases.js');
    const { errorHandler } = await import('../middleware/error-handler.js');
    server = new Hono().onError(errorHandler).route('/api/v1/heartbeat', heartbeatRouter).route('/api/v1/node-enrollment', nodeEnrollmentRouter)
      .route('/api/v1/resource-leases', resourceLeasesRouter);
    // The agent runs on this host: its requests arrive from loopback, where the nodes are recorded.
    serverCall.handle = (url, init) => Promise.resolve(server.request(new URL(url).pathname + new URL(url).search,
      { ...init, headers: { ...(init.headers as Record<string, string>), 'x-forwarded-for': '127.0.0.1' } }));
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      toAgent.push(Object.fromEntries(request.headers));
      return agentApp.request(request);
    });
    for (const [id, hostname] of [[nodeId, nodeFqdn], [oldNodeId, oldFqdn]] as const)
      await db.node.create({ data: { id, name: id, hostname, ipAddress: '127.0.0.1', port: 41100, os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE',
        lastHeartbeatAt: new Date(), agent: { create: { version: '2.10.0', status: 'RUNNING' } } } });
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await db.notification.deleteMany({ where: { nodeId: { in: [nodeId, oldNodeId] } } });
      await db.healthSnapshot.deleteMany({ where: { nodeId: { in: [nodeId, oldNodeId] } } });
      await db.agent.deleteMany({ where: { nodeId: { in: [nodeId, oldNodeId] } } });
      await db.node.deleteMany({ where: { id: { in: [nodeId, oldNodeId] } } });
      await (await import('../db/index.js')).disconnectDb();
    }
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });

  it('1. before any key: the shared secret works in both directions and the server announces node credentials', async () => {
    const response = await heartbeat(nodeFqdn, { 'x-node-token': nodeKey }).send();
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { nodeAuth: unknown } }).data.nodeAuth).toMatchObject({ supported: true, mode: 'compat', method: 'legacy', nodeId });
    const { agentFetch } = await import('./node-agent-auth.js');
    toAgent.length = 0;
    const ping = await agentFetch({ nodeId }, 'https://127.0.0.1:41100/api/v1/ping');
    expect(((await ping.json()) as { data: { features: { nodeAuth: number } } }).data.features.nodeAuth).toBe(0);
    // The server already signs, and still sends the shared secret the unbound agent needs.
    expect(toAgent[0]).toMatchObject({ 'x-node-token': nodeKey, 'x-magnus-node-id': nodeId });
    expect((await agentFetch({ nodeId }, 'https://127.0.0.1:41100/api/v1/commands/mutation-inventory')).status).not.toBe(401);
  });

  it('2. the agent binds its key with the shared secret; the key file is private and the event is audited without secrets', async () => {
    expect(await agentEnrollment.attemptLegacyUpgrade()).toEqual({ state: 'bound', nodeId });
    const key = join(root, 'identity/node.key');
    expect((await stat(key)).mode & 0o777).toBe(0o600);
    const rows = await db.nodeCredential.findMany({ where: { nodeId } });
    expect(rows).toEqual([expect.objectContaining({ status: 'ACTIVE', origin: 'LEGACY_UPGRADE', boundFqdn: nodeFqdn, keyId: agentIdentity.boundNodeIdentity()!.keyId })]);
    const bind = auditLog.mock.calls.map(call => call[0]).find(event => event.action === 'node.credential.bind');
    expect(bind).toBeDefined();
    const pem = await readFile(key, 'utf8');
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain(nodeKey);
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain(pem.split('\n')[1]);
    expect(await db.notification.count({ where: { nodeId, type: 'node.credential' } })).toBe(1);
    // A second agent that holds the shared secret cannot take the node over.
    const { fixtureAgentKey } = await import('./node-credential-test-fixture.js');
    const intruder = fixtureAgentKey();
    const second = await server.request('/api/v1/node-enrollment/legacy-upgrade', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-node-token': nodeKey, 'x-forwarded-for': '127.0.0.1' },
      body: JSON.stringify({ fqdn: nodeFqdn, publicKey: intruder.publicKey, proof: intruder.proof('legacy-upgrade', nodeFqdn, '-') }) });
    expect(second.status).toBe(409);
    expect(await db.nodeCredential.count({ where: { nodeId } })).toBe(1);
  });

  it('3. a signed heartbeat is accepted without the shared secret and identifies the node by its key', async () => {
    const response = await signedHeartbeat();
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { nodeAuth: unknown } }).data.nodeAuth).toMatchObject({ method: 'signature', nodeId });
    await vi.waitFor(async () => expect((await db.nodeCredential.findFirstOrThrow({ where: { nodeId } })).lastUsedAt).not.toBeNull());
    const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(node.hostname).toBe(nodeFqdn);
  });

  it('4. the ratchet: the shared secret can no longer report as that node, by name or through its address', async () => {
    const refused = await heartbeat(nodeFqdn, { 'x-node-token': nodeKey }).send();
    expect(refused.status).toBe(401);
    expect(await errorCode(refused)).toBe('NODE_CREDENTIAL_REQUIRED');
    const before = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const claim = await server.request('/api/v1/resource-leases/legacy-admission', { method: 'POST', headers: { 'content-type': 'application/json', 'x-node-token': nodeKey },
      body: JSON.stringify({ nodeFqdn, nonce: randomUUID() }) });
    expect(await errorCode(claim)).toBe('NODE_CREDENTIAL_REQUIRED');
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).updatedAt).toEqual(before.updatedAt);
  });

  it('5. an old agent on another node keeps working with the shared secret', async () => {
    const response = await heartbeat(oldFqdn, { 'x-node-token': nodeKey }).send();
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { nodeAuth: unknown } }).data.nodeAuth).toMatchObject({ method: 'legacy', nodeId: oldNodeId });
    const admission = await server.request('/api/v1/resource-leases/legacy-admission', { method: 'POST', headers: { 'content-type': 'application/json', 'x-node-token': nodeKey },
      body: JSON.stringify({ nodeFqdn: oldFqdn, nonce: randomUUID() }) });
    expect(admission.status).toBe(200);
  });

  it('6. a signed heartbeat that names another host is refused and renames nothing', async () => {
    const response = await signedHeartbeat(oldFqdn);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('NODE_IDENTITY_MISMATCH');
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).hostname).toBe(nodeFqdn);
    expect((await db.node.findUniqueOrThrow({ where: { id: oldNodeId } })).hostname).toBe(oldFqdn);
  });

  it('7. the agent\'s own senders are signed and bound: its claim for another node is refused', async () => {
    const mine = await agentAuth.nodeApiFetch('https://control.example.com/api/v1/resource-leases/legacy-admission', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeFqdn, nonce: randomUUID() }) });
    expect(mine.status).toBe(200);
    const other = await agentAuth.nodeApiFetch('https://control.example.com/api/v1/resource-leases/legacy-admission', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeFqdn: oldFqdn, nonce: randomUUID() }) });
    expect(other.status).toBe(403);
    expect(await errorCode(other)).toBe('NODE_IDENTITY_MISMATCH');
  });

  it('8. once the agent reported its pins in a signed heartbeat, the server calls it with signatures only', async () => {
    const { agentFetch } = await import('./node-agent-auth.js');
    toAgent.length = 0;
    const ping = await agentFetch({ nodeId }, 'https://127.0.0.1:41100/api/v1/ping');
    expect(((await ping.json()) as { data: { features: { nodeAuth: number; nodeAuthServerKeys: string[] } } }).data.features).toMatchObject({ nodeAuth: 1 });
    const inventory = await agentFetch({ nodeId }, 'https://127.0.0.1:41100/api/v1/commands/mutation-inventory');
    expect(inventory.status).not.toBe(401);
    expect(toAgent.every(headers => headers['x-node-token'] === undefined && headers['x-magnus-node-id'] === nodeId)).toBe(true);
    // The typed client takes the same path.
    const { NodeApiClient } = await import('../sdk/node-api-client.js');
    toAgent.length = 0;
    await new NodeApiClient({ baseUrl: 'https://127.0.0.1:41100', nodeToken: nodeKey, resourceNodeId: nodeId }).ping();
    expect(toAgent[0]!['x-node-token']).toBeUndefined();
    expect(toAgent[0]!['x-magnus-signature']).toMatch(/^[A-Za-z0-9_-]{86}$/);
    // A request signed for the other node is refused by this agent even though the key is the server's.
    toAgent.length = 0;
    const wrongNode = await agentFetch({ nodeId: oldNodeId }, 'https://127.0.0.1:41100/api/v1/commands/mutation-inventory');
    expect(toAgent[0]!['x-node-token']).toBe(nodeKey);
    expect(wrongNode.status).toBe(401);
  });

  it('9. revocation locks the node out until a one-time token enrolls a new key', async () => {
    const { issueEnrollmentToken, revokeNodeCredentials } = await import('./node-credential-service.js');
    await revokeNodeCredentials(nodeId, null, 'admin');
    expect(await errorCode(await signedHeartbeat())).toBe('NODE_CREDENTIAL_REVOKED');
    expect(await errorCode(await heartbeat(nodeFqdn, { 'x-node-token': nodeKey }).send())).toBe('NODE_CREDENTIAL_REQUIRED');
    const { token } = await issueEnrollmentToken(nodeId, 'admin');
    expect(await db.nodeEnrollmentToken.count({ where: { nodeId, tokenSha256: token } })).toBe(0);
    const enrolled = await agentEnrollment.enrollWithToken(token);
    expect(enrolled).toMatchObject({ ok: true, nodeId });
    agentIdentity.resetNodeIdentityCache();
    expect((await signedHeartbeat()).status).toBe(200);
    expect(await agentEnrollment.enrollWithToken(token)).toMatchObject({ ok: false, reason: expect.stringContaining('ENROLLMENT_TOKEN_USED') });
    expect((await db.nodeCredential.findMany({ where: { nodeId }, orderBy: { createdAt: 'asc' } })).map(row => [row.status, row.origin]))
      .toEqual([['REVOKED', 'LEGACY_UPGRADE'], ['ACTIVE', 'ENROLLMENT_TOKEN']]);
  });

  it('10. the agent rotates its key; the old one works until its grace ends', async () => {
    const before = agentIdentity.boundNodeIdentity()!.keyId;
    const rotated = await agentEnrollment.rotateNodeKey();
    expect(rotated).toMatchObject({ ok: true });
    agentIdentity.resetNodeIdentityCache();
    expect(agentIdentity.boundNodeIdentity()!.keyId).not.toBe(before);
    expect((await signedHeartbeat()).status).toBe(200);
    expect((await db.nodeCredential.findUniqueOrThrow({ where: { keyId: before } })).status).toBe('RETIRING');
  });

  it('11. database rules: one ACTIVE key per node, and concurrent first bindings have one winner', async () => {
    const { nodeCredentialStore } = await import('./node-credential-store.js');
    const { fixtureAgentKey } = await import('./node-credential-test-fixture.js');
    const keys = Array.from({ length: 6 }, () => fixtureAgentKey());
    const outcomes = await Promise.all(keys.map(key => nodeCredentialStore.bindFirst({ nodeId: oldNodeId, keyId: key.keyId, publicKey: key.publicKey, boundFqdn: oldFqdn }, 'LEGACY_UPGRADE')));
    expect(outcomes.filter(outcome => outcome === 'bound')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome === 'exists')).toHaveLength(5);
    const extra = fixtureAgentKey();
    await expect(db.nodeCredential.create({ data: { nodeId: oldNodeId, keyId: extra.keyId, publicKey: extra.publicKey, origin: 'ROTATION', status: 'ACTIVE' } })).rejects.toThrow();
    await expect(db.nodeCredential.create({ data: { nodeId: oldNodeId, keyId: extra.keyId, publicKey: extra.publicKey, origin: 'OTHER', status: 'REVOKED' } })).rejects.toThrow();
    const first = await nodeCredentialStore.legacyUpgradeStartedAt();
    expect(await nodeCredentialStore.legacyUpgradeStartedAt()).toEqual(first);
    // Deleting a node removes its credentials and tokens.
    const temporary = `${prefix}-temporary`;
    await db.node.create({ data: { id: temporary, name: temporary, hostname: `${temporary}.example.com`, ipAddress: '192.0.2.77', os: 'fixture', arch: 'fixture', token: randomUUID() } });
    const key = fixtureAgentKey();
    expect(await nodeCredentialStore.bindFirst({ nodeId: temporary, keyId: key.keyId, publicKey: key.publicKey, boundFqdn: '' }, 'LEGACY_UPGRADE')).toBe('bound');
    await db.node.delete({ where: { id: temporary } });
    expect(await db.nodeCredential.count({ where: { keyId: key.keyId } })).toBe(0);
  });
});
