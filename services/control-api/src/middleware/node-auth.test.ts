import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from './error-handler.js';

const SECRET = 'node-auth-fixture-shared-secret-at-least-32-characters';
const fixture = vi.hoisted(() => ({ audit: [] as Array<{ action: string; details?: Record<string, unknown> }>, notifications: [] as Array<Record<string, unknown>>,
  peer: '192.0.2.10', handled: [] as unknown[] }));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(), NODE_MANAGER_SECRET: 'node-auth-fixture-shared-secret-at-least-32-characters' }));
vi.mock('../services/credential-rotation-service.js', async original => ({ ...await original<object>(),
  verifyWithRotation: (_name: string, active: string, token: string) => token === active }));
vi.mock('../services/audit-service.js', async original => ({ ...await original<object>(),
  logAuditEvent: async (event: { action: string }) => { fixture.audit.push(event); } }));
vi.mock('../services/notification-service.js', () => ({ createNotification: async (input: Record<string, unknown>) => { fixture.notifications.push(input); return 'n'; } }));
vi.mock('../utils/heartbeat-peer.js', () => ({ heartbeatPeerAddress: () => fixture.peer }));
vi.mock('../services/node-credential-store.js', async () => {
  const { createFakeCredentialStore } = await import('../services/node-credential-test-fixture.js');
  const fake = createFakeCredentialStore();
  return { nodeCredentialStore: fake.store, fakeCredentialStore: fake };
});
vi.mock('../services/managed-cron.js', async original => ({ ...await original<object>(),
  cronOccurrenceStatus: async (nodeFqdn: string, occurrenceId: string) => { fixture.handled.push({ nodeFqdn, occurrenceId }); return { nodeFqdn }; } }));

const { fakeCredentialStore: fake } = await import('../services/node-credential-store.js') as unknown as
  { fakeCredentialStore: ReturnType<typeof import('../services/node-credential-test-fixture.js').createFakeCredentialStore> };
const { fixtureAgentKey, fixtureNode } = await import('../services/node-credential-test-fixture.js');
const { assertNodeClaims, nodeAuth, nodeAuthOf, resetNodeAuthState } = await import('./node-auth.js');
const { managedCronRouter } = await import('../routes/managed-cron.js');
const { nodeEnrollmentRouter } = await import('../routes/node-enrollment.js');
const { serverSigningKey } = await import('../services/node-server-key.js');
const { approvePendingBinding, issueEnrollmentToken, listPendingBindings, rejectPendingBinding, resetNodeCredentials, revokeNodeCredentials, resetNodeCredentialServiceState,
  peerMatchesNode } = await import('../services/node-credential-service.js');
const { generateSigningKey } = await import('../security/node-request-auth.js');

const app = new Hono().onError(errorHandler);
app.post('/api/v1/probe', nodeAuth(), async c => {
  const body = await c.req.json() as { nodeId?: string; nodeFqdn?: string };
  await assertNodeClaims(c, { nodeId: body.nodeId, fqdn: body.nodeFqdn });
  const auth = nodeAuthOf(c);
  return c.json({ method: auth.method, nodeId: auth.method === 'signature' ? auth.node.id : null });
});
app.route('/api/v1/cron/managed-occurrences', managedCronRouter);
app.route('/api/v1/node-enrollment', nodeEnrollmentRouter);

const serverKeyId = serverSigningKey().keyId;
const OCCURRENCE = 'a'.repeat(64);
type AgentKey = ReturnType<typeof fixtureAgentKey>;

function post(path: string, body: unknown, headers: Record<string, string> = {}, raw?: string) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body) });
}
async function code(response: Response): Promise<string> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code ?? '';
}
/** Bind `key` to an existing node the way an upgraded agent does. */
async function upgrade(key: AgentKey, fqdn: string, headers: Record<string, string> = { 'x-node-token': SECRET }) {
  return post('/api/v1/node-enrollment/legacy-upgrade', { fqdn, publicKey: key.publicKey, proof: key.proof('legacy-upgrade', fqdn, '-') }, headers);
}
function signedProbe(key: AgentKey, nodeId: string, body: unknown, options: { path?: string; now?: number; nonce?: string; serverKeyId?: string; extra?: Record<string, string> } = {}) {
  const path = options.path ?? '/api/v1/probe';
  const raw = JSON.stringify(body);
  return post(path, body, { ...key.sign({ nodeId, serverKeyId: options.serverKeyId ?? serverKeyId, path, body: raw,
    ...(options.now === undefined ? {} : { now: options.now }), ...(options.nonce === undefined ? {} : { nonce: options.nonce }) }), ...options.extra }, raw);
}

beforeEach(() => {
  fake.reset();
  fake.state.nodes.push(fixtureNode('node-a', 'node-a.example.com', '192.0.2.10'), fixtureNode('node-b', 'node-b.example.com', '192.0.2.20'));
  fixture.audit = []; fixture.notifications = []; fixture.handled = []; fixture.peer = '192.0.2.10';
  resetNodeAuthState(); resetNodeCredentialServiceState();
  process.env['NODE_AUTH_MODE'] = 'compat'; delete process.env['NODE_AUTH_LEGACY_UPGRADE_UNTIL'];
});
afterEach(() => { process.env['NODE_AUTH_MODE'] = 'compat'; delete process.env['NODE_AUTH_LEGACY_UPGRADE_UNTIL']; });

describe('legacy upgrade: an existing node binds its first key', () => {
  it('binds once, audits and notifies with fingerprints only, and answers a retry of the same key', async () => {
    const key = fixtureAgentKey();
    const first = await upgrade(key, 'node-a.example.com');
    expect(first.status).toBe(200);
    const data = ((await first.json()) as { data: { nodeId: string; keyId: string; serverKeys: Array<{ keyId: string; status: string }>; mode: string } }).data;
    expect(data).toMatchObject({ nodeId: 'node-a', keyId: key.keyId, mode: 'compat' });
    expect(data.serverKeys).toEqual([expect.objectContaining({ keyId: serverKeyId, status: 'active' })]);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(fixture.audit.map(event => event.action)).toEqual(['node.credential.bind']);
    expect(fixture.audit[0]!.details).toMatchObject({ origin: 'LEGACY_UPGRADE', peerAddress: '192.0.2.10' });
    expect(fixture.notifications).toHaveLength(1);
    expect(JSON.stringify([fixture.audit, fixture.notifications])).not.toContain(SECRET);
    // The response to the first call was lost: the same key is answered again without a second event.
    expect((await upgrade(key, 'node-a.example.com')).status).toBe(200);
    expect(fake.state.credentials).toHaveLength(1);
    expect(fixture.audit).toHaveLength(1);
  });

  it('refuses the second caller with 409 and raises a critical notification (first writer wins)', async () => {
    const [genuine, second] = [fixtureAgentKey(), fixtureAgentKey()];
    const responses = await Promise.all([upgrade(genuine, 'node-a.example.com'), upgrade(second, 'node-a.example.com')]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const refused = responses.find(response => response.status === 409)!;
    expect(await code(refused)).toBe('NODE_CREDENTIAL_EXISTS');
    expect(fake.state.credentials.map(entry => entry.keyId)).toEqual([genuine.keyId]);
    expect(fixture.audit.map(event => event.action)).toContain('node.credential.bind_refused');
    expect(fixture.notifications.some(entry => entry['severity'] === 'critical')).toBe(true);
  });

  it('refuses a key that already belongs to another node (a cloned host)', async () => {
    const key = fixtureAgentKey();
    expect((await upgrade(key, 'node-a.example.com')).status).toBe(200);
    fixture.peer = '192.0.2.20';
    const clone = await upgrade(key, 'node-b.example.com');
    expect(clone.status).toBe(409);
    expect(await code(clone)).toBe('NODE_KEY_IN_USE');
  });

  it('refuses a caller whose socket address is not the address recorded for the node', async () => {
    fixture.peer = '192.0.2.20';
    const response = await upgrade(fixtureAgentKey(), 'node-a.example.com');
    expect(response.status).toBe(403);
    expect(await code(response)).toBe('PEER_ADDRESS_MISMATCH');
    expect(fake.state.credentials).toHaveLength(0);
    expect(fixture.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'node.credential.bind_refused',
      details: expect.objectContaining({ reason: 'PEER_ADDRESS_MISMATCH', peerAddress: '192.0.2.20' }) })]));
  });

  it('keeps a binding refused for its address for an administrator, who can approve it once', async () => {
    fixture.peer = '192.0.2.20';
    const key = fixtureAgentKey();
    expect((await upgrade(key, 'node-a.example.com')).status).toBe(403);
    expect((await upgrade(key, 'node-a.example.com')).status).toBe(403);
    const [pending] = await listPendingBindings({ status: 'PENDING' });
    expect(pending).toMatchObject({ nodeId: 'node-a', nodeName: 'node-a.example.com', keyId: key.keyId, peerAddress: '192.0.2.20',
      recordedAddress: '192.0.2.10', status: 'PENDING', attempts: 2 });
    expect(fixture.audit.filter(event => event.action === 'node.credential.binding_pending')).toHaveLength(1);
    expect(fixture.notifications[0]).toMatchObject({ metadata: expect.objectContaining({ pendingBindingId: pending!.id }) });
    // Approved: the key is the node's first credential, and the agent's next attempt learns its binding.
    expect(await approvePendingBinding(pending!.id, 'admin-1')).toMatchObject({ status: 'APPROVED', decidedBy: 'admin-1' });
    expect(fake.state.credentials).toEqual([expect.objectContaining({ nodeId: 'node-a', keyId: key.keyId, status: 'ACTIVE', origin: 'LEGACY_UPGRADE' })]);
    expect(fixture.audit.map(event => event.action)).toEqual(expect.arrayContaining(['node.credential.binding_approve', 'node.credential.bind']));
    const retry = await upgrade(key, 'node-a.example.com');
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { data: { nodeId: string } }).data.nodeId).toBe('node-a');
    // A decision is made once; another agent's key is not bound by it.
    await expect(approvePendingBinding(pending!.id, 'admin-1')).rejects.toMatchObject({ code: 'PENDING_BINDING_DECIDED' });
    expect((await upgrade(fixtureAgentKey(), 'node-a.example.com')).status).toBe(403);
  });

  it('rejects a pending binding, refuses approval when the node has a key by now, and in enforce mode', async () => {
    fixture.peer = '192.0.2.20';
    const [first, second] = [fixtureAgentKey(), fixtureAgentKey()];
    await upgrade(first, 'node-a.example.com');
    await upgrade(second, 'node-a.example.com');
    const pending = await listPendingBindings({ status: 'PENDING' });
    const byKey = (key: AgentKey) => pending.find(entry => entry.keyId === key.keyId)!;
    expect(await rejectPendingBinding(byKey(first).id, 'admin-1', 'not this host')).toMatchObject({ status: 'REJECTED', decisionReason: 'not this host' });
    await expect(approvePendingBinding(byKey(first).id, 'admin-1')).rejects.toMatchObject({ code: 'PENDING_BINDING_DECIDED' });
    process.env['NODE_AUTH_MODE'] = 'enforce';
    await expect(approvePendingBinding(byKey(second).id, 'admin-1')).rejects.toMatchObject({ code: 'NODE_AUTH_ENFORCED' });
    process.env['NODE_AUTH_MODE'] = 'compat';
    fixture.peer = '192.0.2.10';
    expect((await upgrade(fixtureAgentKey(), 'node-a.example.com')).status).toBe(200);
    await expect(approvePendingBinding(byKey(second).id, 'admin-1')).rejects.toMatchObject({ code: 'NODE_CREDENTIAL_EXISTS' });
    expect(fixture.audit.map(event => event.action)).toContain('node.credential.binding_reject');
  });

  it('answers an approved binding even after the upgrade window closed', async () => {
    fixture.peer = '192.0.2.20';
    const key = fixtureAgentKey();
    await upgrade(key, 'node-a.example.com');
    await approvePendingBinding((await listPendingBindings())[0]!.id, 'admin-1');
    process.env['NODE_AUTH_LEGACY_UPGRADE_UNTIL'] = '2000-01-01T00:00:00Z';
    resetNodeCredentialServiceState();
    expect((await upgrade(key, 'node-a.example.com')).status).toBe(200);
    expect(await code(await upgrade(fixtureAgentKey(), 'node-b.example.com'))).toBe('LEGACY_UPGRADE_CLOSED');
  });

  it('matches a peer to a recorded host name through DNS, and a loopback peer only to this host', async () => {
    const dns = async (recorded: string) => recorded === 'node-a.example.com' ? ['198.51.100.7'] : [recorded];
    const local = () => ['203.0.113.5', '127.0.0.1'];
    expect(await peerMatchesNode('198.51.100.7', 'node-a.example.com', dns, local)).toBe(true);
    expect(await peerMatchesNode('::ffff:198.51.100.7', 'node-a.example.com', dns, local)).toBe(true);
    expect(await peerMatchesNode('198.51.100.8', 'node-a.example.com', dns, local)).toBe(false);
    expect(await peerMatchesNode('127.0.0.1', '203.0.113.5', dns, local)).toBe(true);
    expect(await peerMatchesNode('::1', '127.0.0.1', dns, local)).toBe(true);
    expect(await peerMatchesNode('127.0.0.1', '198.51.100.7', dns, local)).toBe(false);
    expect(await peerMatchesNode('', '198.51.100.7', dns, local)).toBe(false);
    expect(await peerMatchesNode('not-an-address', 'not-an-address', dns, local)).toBe(false);
  });

  it('closes after the persisted 30-day window, at the configured date, and in enforce mode', async () => {
    fake.state.startedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const expired = await upgrade(fixtureAgentKey(), 'node-a.example.com');
    expect(expired.status).toBe(410);
    expect(await code(expired)).toBe('LEGACY_UPGRADE_CLOSED');
    process.env['NODE_AUTH_LEGACY_UPGRADE_UNTIL'] = new Date(Date.now() + 60_000).toISOString();
    expect((await upgrade(fixtureAgentKey(), 'node-a.example.com')).status).toBe(200);
    fake.reset(); fake.state.nodes.push(fixtureNode('node-a', 'node-a.example.com', '192.0.2.10'));
    resetNodeCredentialServiceState();
    process.env['NODE_AUTH_LEGACY_UPGRADE_UNTIL'] = new Date(Date.now() - 1000).toISOString();
    expect((await upgrade(fixtureAgentKey(), 'node-a.example.com')).status).toBe(410);
    delete process.env['NODE_AUTH_LEGACY_UPGRADE_UNTIL'];
    process.env['NODE_AUTH_MODE'] = 'enforce';
    expect((await upgrade(fixtureAgentKey(), 'node-a.example.com')).status).toBe(410);
    const state = await (await app.request('/api/v1/node-enrollment/server-key')).json() as { data: { mode: string; legacyUpgrade: { open: boolean } } };
    expect(state.data).toMatchObject({ mode: 'enforce', legacyUpgrade: { open: false } });
  });

  it('needs the shared secret, a known node, an unambiguous match and a proof made with the submitted key', async () => {
    const key = fixtureAgentKey();
    expect((await upgrade(key, 'node-a.example.com', {})).status).toBe(401);
    expect((await upgrade(key, 'node-a.example.com', { 'x-node-token': 'wrong' })).status).toBe(401);
    fixture.peer = '192.0.2.99';
    expect(await code(await upgrade(key, 'unknown.example.com'))).toBe('NODE_NOT_FOUND');
    fixture.peer = '192.0.2.10';
    const other = fixtureAgentKey();
    const forged = await post('/api/v1/node-enrollment/legacy-upgrade', { fqdn: 'node-a.example.com', publicKey: key.publicKey,
      proof: other.proof('legacy-upgrade', 'node-a.example.com', '-') }, { 'x-node-token': SECRET });
    expect(await code(forged)).toBe('NODE_KEY_PROOF_INVALID');
    const stale = await post('/api/v1/node-enrollment/legacy-upgrade', { fqdn: 'node-a.example.com', publicKey: key.publicKey,
      proof: key.proof('legacy-upgrade', 'node-a.example.com', '-', Date.now() - 120_000) }, { 'x-node-token': SECRET });
    expect(await code(stale)).toBe('NODE_AUTH_SKEW');
    const proof = key.proof('legacy-upgrade', 'node-b.example.com', '-');
    fixture.peer = '192.0.2.20';
    const body = { fqdn: 'node-b.example.com', publicKey: key.publicKey, proof };
    expect((await post('/api/v1/node-enrollment/legacy-upgrade', body, { 'x-node-token': SECRET })).status).toBe(200);
    fake.state.credentials = [];
    expect(await code(await post('/api/v1/node-enrollment/legacy-upgrade', body, { 'x-node-token': SECRET }))).toBe('NODE_AUTH_REPLAY');
    fake.state.nodes.push(fixtureNode('node-a-duplicate', 'node-a', '192.0.2.10'));
    fixture.peer = '192.0.2.10';
    expect(await code(await upgrade(fixtureAgentKey(), 'node-a.example.com'))).toBe('NODE_AMBIGUOUS');
    expect(fake.state.credentials).toHaveLength(0);
  });

  it('finds a node recorded under another name by the caller address, as the heartbeat does', async () => {
    fake.state.nodes = [fixtureNode('node-c', 'gpu-box', '192.0.2.30')];
    fixture.peer = '192.0.2.30';
    expect((await upgrade(fixtureAgentKey(), 'host-c.example.net')).status).toBe(200);
    expect(fake.state.credentials[0]).toMatchObject({ nodeId: 'node-c', boundFqdn: 'host-c.example.net' });
  });
});

describe('agent-to-server authentication', () => {
  async function bound(nodeId = 'node-a', fqdn = 'node-a.example.com'): Promise<AgentKey> {
    const key = fixtureAgentKey();
    fixture.peer = fake.state.nodes.find(node => node.id === nodeId)!.ipAddress;
    expect((await upgrade(key, fqdn)).status).toBe(200);
    return key;
  }

  it('accepts a valid signature without the shared secret and records the use', async () => {
    const key = await bound();
    const response = await signedProbe(key, 'node-a', { nodeId: 'node-a', nodeFqdn: 'node-a.example.com' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: 'signature', nodeId: 'node-a' });
    expect(Number(response.headers.get('x-magnus-server-time'))).toBeGreaterThan(Date.now() - 5000);
    expect(fake.state.touched).toEqual([key.keyId]);
    await signedProbe(key, 'node-a', {});
    expect(fake.state.touched).toHaveLength(1);
  });

  it('keeps accepting the shared secret from a node that has no key (an old agent)', async () => {
    await bound('node-a');
    const response = await post('/api/v1/probe', { nodeId: 'node-b', nodeFqdn: 'node-b.example.com' }, { 'x-node-token': SECRET });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: 'legacy', nodeId: null });
    expect((await post('/api/v1/probe', {}, {})).status).toBe(401);
    expect((await post('/api/v1/probe', {}, { 'x-node-token': 'wrong' })).status).toBe(401);
  });

  it('refuses the shared secret for a node that has a key, by id, host name, name or bound name (the ratchet)', async () => {
    await bound('node-a');
    fake.state.nodes[0]!.name = 'alias-a';
    for (const claim of [{ nodeId: 'node-a' }, { nodeFqdn: 'node-a.example.com' }, { nodeFqdn: 'NODE-A.example.com' }, { nodeFqdn: 'alias-a' },
      { nodeId: 'node-b', nodeFqdn: 'node-a.example.com' }]) {
      const response = await post('/api/v1/probe', claim, { 'x-node-token': SECRET });
      expect(response.status).toBe(401);
      expect(await code(response)).toBe('NODE_CREDENTIAL_REQUIRED');
    }
    fake.state.nodes[0]!.hostname = 'renamed.example.com';
    expect(await code(await post('/api/v1/probe', { nodeFqdn: 'node-a.example.com' }, { 'x-node-token': SECRET }))).toBe('NODE_CREDENTIAL_REQUIRED');
  });

  it('applies the ratchet on a route that names its node only in the body', async () => {
    const key = await bound('node-a');
    const path = '/api/v1/cron/managed-occurrences/status';
    const mine = { nodeFqdn: 'node-a.example.com', occurrenceId: OCCURRENCE };
    expect(await code(await post(path, mine, { 'x-node-token': SECRET }))).toBe('NODE_CREDENTIAL_REQUIRED');
    expect((await post(path, { nodeFqdn: 'node-b.example.com', occurrenceId: OCCURRENCE }, { 'x-node-token': SECRET })).status).toBe(200);
    expect((await signedProbe(key, 'node-a', mine, { path })).status).toBe(200);
    const other = await signedProbe(key, 'node-a', { nodeFqdn: 'node-b.example.com', occurrenceId: OCCURRENCE }, { path });
    expect(other.status).toBe(403);
    expect(await code(other)).toBe('NODE_IDENTITY_MISMATCH');
    expect(fixture.handled).toEqual([{ nodeFqdn: 'node-b.example.com', occurrenceId: OCCURRENCE }, mine]);
  });

  it('refuses a signed body that names another node, and audits it once', async () => {
    const key = await bound('node-a');
    fixture.audit = []; fixture.notifications = [];
    for (const claim of [{ nodeId: 'node-b' }, { nodeFqdn: 'node-b.example.com' }, { nodeId: 'node-a', nodeFqdn: 'node-b.example.com' }]) {
      const response = await signedProbe(key, 'node-a', claim);
      expect(response.status).toBe(403);
      expect(await code(response)).toBe('NODE_IDENTITY_MISMATCH');
    }
    expect(fixture.audit.map(event => event.action)).toEqual(['node.credential.identity_mismatch']);
    expect(fixture.notifications).toHaveLength(1);
    // A name of its own node that another node also holds as host name is ambiguous, so refused.
    fake.state.nodes[1]!.hostname = 'node-a';
    expect((await signedProbe(key, 'node-a', { nodeFqdn: 'node-a' })).status).toBe(403);
  });

  it('refuses a tampered body, path or query', async () => {
    const key = await bound();
    const raw = JSON.stringify({ nodeId: 'node-a' });
    const headers = key.sign({ nodeId: 'node-a', serverKeyId, path: '/api/v1/probe', body: raw });
    const tampered = await post('/api/v1/probe', null, headers, JSON.stringify({ nodeId: 'node-a', extra: 1 }));
    expect(tampered.status).toBe(401);
    expect(await code(tampered)).toBe('NODE_SIGNATURE_INVALID');
    expect(await code(await post('/api/v1/probe?as=node-b', null, key.sign({ nodeId: 'node-a', serverKeyId, path: '/api/v1/probe', body: raw }), raw))).toBe('NODE_SIGNATURE_INVALID');
    const elsewhere = key.sign({ nodeId: 'node-a', serverKeyId, path: '/api/v1/cron/managed-occurrences/status', body: raw });
    expect(await code(await post('/api/v1/probe', null, elsewhere, raw))).toBe('NODE_SIGNATURE_INVALID');
  });

  it('refuses a request signed for another control plane (wrong audience)', async () => {
    const key = await bound();
    const response = await signedProbe(key, 'node-a', {}, { serverKeyId: generateSigningKey().keyId });
    expect(response.status).toBe(401);
    expect(await code(response)).toBe('NODE_SIGNATURE_INVALID');
  });

  it('refuses a replayed nonce', async () => {
    const key = await bound();
    const raw = JSON.stringify({});
    const headers = key.sign({ nodeId: 'node-a', serverKeyId, path: '/api/v1/probe', body: raw });
    expect((await post('/api/v1/probe', null, headers, raw)).status).toBe(200);
    const replay = await post('/api/v1/probe', null, headers, raw);
    expect(replay.status).toBe(401);
    expect(await code(replay)).toBe('NODE_AUTH_REPLAY');
  });

  it('refuses a timestamp outside the clock window and tells the agent the server time', async () => {
    const key = await bound();
    for (const now of [Date.now() - 61_000, Date.now() + 61_000]) {
      const response = await signedProbe(key, 'node-a', {}, { now });
      expect(response.status).toBe(401);
      expect(await code(response)).toBe('NODE_AUTH_SKEW');
      expect(Math.abs(Number(response.headers.get('x-magnus-server-time')) - Date.now())).toBeLessThan(5000);
    }
  });

  it('refuses malformed signature headers even when a valid shared secret is also sent', async () => {
    await bound('node-a');
    const response = await post('/api/v1/probe', { nodeId: 'node-b' }, { 'x-node-token': SECRET, 'x-magnus-node-id': 'node-b', 'x-magnus-signature': 'AAAA' });
    expect(response.status).toBe(401);
    expect(await code(response)).toBe('NODE_SIGNATURE_INVALID');
  });

  it('refuses a key presented under another node id', async () => {
    const key = await bound('node-a');
    const response = await signedProbe(key, 'node-b', { nodeId: 'node-b' });
    expect(response.status).toBe(401);
    expect(await code(response)).toBe('NODE_SIGNATURE_INVALID');
  });

  it('falls back to the shared secret for an unknown key, but never past the ratchet', async () => {
    const known = await bound('node-a');
    const unknown = fixtureAgentKey();
    // node-b's records were lost on the server: its agent still signs, and also sends the secret.
    const recovered = await signedProbe(unknown, 'node-b', { nodeId: 'node-b' }, { extra: { 'x-node-token': SECRET } });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ method: 'legacy', nodeId: null });
    expect(await code(await signedProbe(unknown, 'node-b', { nodeId: 'node-b' }))).toBe('NODE_CREDENTIAL_UNKNOWN');
    expect(await code(await signedProbe(unknown, 'node-a', { nodeId: 'node-a' }, { extra: { 'x-node-token': SECRET } }))).toBe('NODE_CREDENTIAL_REQUIRED');
    expect((await signedProbe(known, 'node-a', { nodeId: 'node-a' })).status).toBe(200);
  });

  it('refuses a revoked key, and keeps the node closed to the shared secret until it is re-enrolled', async () => {
    const key = await bound('node-a');
    expect(await revokeNodeCredentials('node-a', key.keyId, 'admin')).toMatchObject({ revoked: 1, agentRefused: true });
    const response = await signedProbe(key, 'node-a', { nodeId: 'node-a' }, { extra: { 'x-node-token': SECRET } });
    expect(response.status).toBe(401);
    expect(await code(response)).toBe('NODE_CREDENTIAL_REVOKED');
    expect(await code(await post('/api/v1/probe', { nodeId: 'node-a' }, { 'x-node-token': SECRET }))).toBe('NODE_CREDENTIAL_REQUIRED');
    expect(await code(await upgrade(fixtureAgentKey(), 'node-a.example.com'))).toBe('NODE_CREDENTIAL_EXISTS');
    expect(fixture.audit.map(event => event.action)).toContain('node.credential.revoke');
    await expect(revokeNodeCredentials('node-a', key.keyId, 'admin')).rejects.toMatchObject({ status: 404 });
  });

  it('accepts a retiring key until its grace ends, then refuses it', async () => {
    const key = await bound('node-a');
    const next = fixtureAgentKey();
    const body = { fqdn: 'node-a.example.com', publicKey: next.publicKey, proof: next.proof('rotate', 'node-a.example.com', 'node-a') };
    const path = '/api/v1/node-enrollment/rotate';
    expect((await post(path, body, { 'x-node-token': SECRET })).status).toBe(401);
    const stolen = { ...body, proof: fixtureAgentKey().proof('rotate', 'node-a.example.com', 'node-a') };
    expect(await code(await signedProbe(key, 'node-a', stolen, { path }))).toBe('NODE_KEY_PROOF_INVALID');
    const rotated = await signedProbe(key, 'node-a', body, { path });
    expect(rotated.status).toBe(200);
    expect(fake.state.credentials.map(entry => [entry.keyId, entry.status, entry.origin])).toEqual([
      [key.keyId, 'RETIRING', 'LEGACY_UPGRADE'], [next.keyId, 'ACTIVE', 'ROTATION']]);
    expect((await signedProbe(key, 'node-a', {})).status).toBe(200);
    expect((await signedProbe(next, 'node-a', {})).status).toBe(200);
    fake.state.credentials[0]!.retireAt = new Date(Date.now() - 1000);
    expect(await code(await signedProbe(key, 'node-a', {}))).toBe('NODE_CREDENTIAL_EXPIRED');
    expect(await code(await signedProbe(key, 'node-a', { ...body, proof: next.proof('rotate', 'node-a.example.com', 'node-a') }, { path }))).toBe('NODE_CREDENTIAL_EXPIRED');
    expect(fixture.audit.map(event => event.action)).toContain('node.credential.rotate');
  });

  it('refuses a decommissioned node even with a valid signature', async () => {
    const key = await bound('node-a');
    fake.state.nodes[0]!.status = 'DECOMMISSIONED';
    const response = await signedProbe(key, 'node-a', {});
    expect(response.status).toBe(403);
    expect(await code(response)).toBe('NODE_DECOMMISSIONED');
  });

  it('enforce mode refuses the shared secret and unknown keys, and still accepts signatures', async () => {
    const key = await bound('node-a');
    process.env['NODE_AUTH_MODE'] = 'enforce';
    expect(await code(await post('/api/v1/probe', { nodeId: 'node-b' }, { 'x-node-token': SECRET }))).toBe('NODE_SIGNATURE_REQUIRED');
    expect(await code(await signedProbe(fixtureAgentKey(), 'node-b', {}, { extra: { 'x-node-token': SECRET } }))).toBe('NODE_CREDENTIAL_UNKNOWN');
    expect((await signedProbe(key, 'node-a', { nodeId: 'node-a' })).status).toBe(200);
    await expect(resetNodeCredentials('node-a', 'admin')).rejects.toMatchObject({ code: 'NODE_AUTH_ENFORCED' });
  });

  it('warn mode behaves as compat and logs the use of the shared secret once per route', async () => {
    process.env['NODE_AUTH_MODE'] = 'warn';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await post('/api/v1/probe', { nodeId: 'node-b' }, { 'x-node-token': SECRET })).status).toBe(200);
    expect((await post('/api/v1/probe', { nodeId: 'node-b' }, { 'x-node-token': SECRET })).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain(SECRET);
    warn.mockRestore();
  });

  it('an administrator reset returns the node to the shared secret (rollback)', async () => {
    const key = await bound('node-a');
    expect(await resetNodeCredentials('node-a', 'admin')).toMatchObject({ removed: 1, sharedSecretAccepted: true });
    expect((await post('/api/v1/probe', { nodeId: 'node-a' }, { 'x-node-token': SECRET })).status).toBe(200);
    expect(await code(await signedProbe(key, 'node-a', {}))).toBe('NODE_CREDENTIAL_UNKNOWN');
    expect((await upgrade(key, 'node-a.example.com')).status).toBe(200);
  });
});

describe('enrollment with a one-time token', () => {
  const enroll = (token: string, key: AgentKey, fqdn = 'node-b.example.com', proofToken = token) => post('/api/v1/node-enrollment/enroll', {
    token, fqdn, publicKey: key.publicKey, proof: key.proof('enroll', fqdn, createHash('sha256').update(proofToken).digest('hex')) });

  it('binds the key, stores only the token digest, and replaces a previous key', async () => {
    const old = fixtureAgentKey();
    fixture.peer = '192.0.2.20';
    expect((await upgrade(old, 'node-b.example.com')).status).toBe(200);
    const { token, expiresAt } = await issueEnrollmentToken('node-b', 'admin');
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    expect(JSON.stringify([fake.state.tokens, fixture.audit, fixture.notifications])).not.toContain(token);
    expect(fake.state.tokens[0]!.tokenSha256).toBe(createHash('sha256').update(token).digest('hex'));
    const key = fixtureAgentKey();
    const response = await enroll(token, key);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { nodeId: string } }).data.nodeId).toBe('node-b');
    expect(fake.state.credentials.map(entry => [entry.keyId, entry.status])).toEqual([[old.keyId, 'REVOKED'], [key.keyId, 'ACTIVE']]);
    expect(await code(await signedProbe(old, 'node-b', {}))).toBe('NODE_CREDENTIAL_REVOKED');
    expect((await signedProbe(key, 'node-b', { nodeId: 'node-b' })).status).toBe(200);
    // Peer address is not a condition here: the token is the administrator's authorization.
    expect(fixture.audit.at(-1)).toMatchObject({ action: 'node.credential.bind', details: { origin: 'ENROLLMENT_TOKEN' } });
  });

  it('refuses a reused token for another key, and answers the same key again', async () => {
    const { token } = await issueEnrollmentToken('node-b', 'admin');
    const key = fixtureAgentKey();
    expect((await enroll(token, key)).status).toBe(200);
    expect((await enroll(token, key)).status).toBe(200);
    const reuse = await enroll(token, fixtureAgentKey());
    expect(reuse.status).toBe(409);
    expect(await code(reuse)).toBe('ENROLLMENT_TOKEN_USED');
    expect(fake.state.credentials).toHaveLength(1);
  });

  it('refuses an expired, unknown or withdrawn token, and a proof made for another token', async () => {
    const { token } = await issueEnrollmentToken('node-b', 'admin', 60);
    const mismatched = await enroll(token, fixtureAgentKey(), 'node-b.example.com', 'mne_' + 'B'.repeat(43));
    expect(await code(mismatched)).toBe('NODE_KEY_PROOF_INVALID');
    fake.state.tokens[0]!.expiresAt = new Date(Date.now() - 1);
    expect(await code(await enroll(token, fixtureAgentKey()))).toBe('ENROLLMENT_TOKEN_EXPIRED');
    expect(await code(await enroll('mne_' + 'A'.repeat(43), fixtureAgentKey()))).toBe('ENROLLMENT_TOKEN_INVALID');
    const first = await issueEnrollmentToken('node-b', 'admin');
    const second = await issueEnrollmentToken('node-b', 'admin');
    expect(await code(await enroll(first.token, fixtureAgentKey()))).toBe('ENROLLMENT_TOKEN_INVALID');
    expect((await enroll(second.token, fixtureAgentKey())).status).toBe(200);
    await expect(issueEnrollmentToken('missing', 'admin')).rejects.toMatchObject({ status: 404 });
  });
});

describe('shared-credential accounting and the fleet summary', () => {
  it('counts each shared-secret request per node it names, and once a node signs, nothing more', async () => {
    const { pendingLegacyUse, resetLegacyUseState } = await import('../services/node-legacy-use.js');
    resetLegacyUseState();
    expect((await post('/api/v1/probe', { nodeFqdn: 'node-b.example.com' }, { 'x-node-token': SECRET })).status).toBe(200);
    expect((await post('/api/v1/probe', { nodeId: 'node-b' }, { 'x-node-token': SECRET })).status).toBe(200);
    expect((await post('/api/v1/probe', {}, { 'x-node-token': SECRET })).status).toBe(200);
    expect(pendingLegacyUse()).toEqual([expect.objectContaining({ nodeId: 'node-b', channel: 'request', count: 2, detail: '/api/v1/probe' })]);
    const key = fixtureAgentKey();
    expect((await upgrade(key, 'node-a.example.com')).status).toBe(200);
    expect((await signedProbe(key, 'node-a', { nodeId: 'node-a' })).status).toBe(200);
    expect(pendingLegacyUse().some(entry => entry.nodeId === 'node-a')).toBe(false);
  });

  it('reports what blocks enforce mode, and nothing once every node signs and the shared secret is unused', async () => {
    const { nodeCredentialFleetSummary } = await import('../services/node-credential-summary.js');
    const { resetLegacyUseState } = await import('../services/node-legacy-use.js');
    resetLegacyUseState();
    await post('/api/v1/probe', { nodeId: 'node-b' }, { 'x-node-token': SECRET });
    const key = fixtureAgentKey();
    await upgrade(key, 'node-a.example.com');
    let summary = await nodeCredentialFleetSummary();
    expect(summary).toMatchObject({ mode: 'compat', enforceReady: false, nodes: { total: 2, active: 1, none: 1, revoked: 0, evidenceSigning: 0 },
      legacyUse: { nodes: 1, request: 1 } });
    expect(summary.serverKey?.keyId).toBe(serverKeyId);
    expect(summary.blockers.map(blocker => blocker.code)).toEqual(['NODES_WITHOUT_KEY', 'NODES_NOT_SIGNING_EVIDENCE', 'RECENT_SHARED_SECRET_USE']);
    expect(summary.blockers[0]).toMatchObject({ count: 1, nodes: [{ id: 'node-b', name: 'node-b.example.com' }] });
    // node-b binds and both agents sign evidence; the old use of the shared secret ages out of the window.
    fixture.peer = '192.0.2.20';
    const other = fixtureAgentKey();
    await upgrade(other, 'node-b.example.com');
    for (const entry of fake.state.credentials) entry.evidenceSigning = true;
    for (const entry of fake.state.legacy) entry.lastUsedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    summary = await nodeCredentialFleetSummary();
    expect(summary).toMatchObject({ enforceReady: true, blockers: [], nodes: { active: 2, evidenceSigning: 2 } });
  });

  it('fails the readiness check only in warn mode, while anything blocks enforce', async () => {
    const { nodeCredentialReadinessCheck, resetNodeCredentialSummaryState } = await import('../services/node-credential-summary.js');
    resetNodeCredentialSummaryState();
    expect(await nodeCredentialReadinessCheck()).toBe(true);
    process.env['NODE_AUTH_MODE'] = 'warn';
    expect(await nodeCredentialReadinessCheck()).toBe(false);
  });
});

describe('downgrade guard', () => {
  it('names the reset an older agent needs first, and nothing for a release that keeps the key', async () => {
    const { credentialDowngradeCheck } = await import('../services/node-credential-service.js');
    expect(await credentialDowngradeCheck('node-a', '2.9.1')).toMatchObject({ action: 'none', nodeHasCredentials: false });
    await upgrade(fixtureAgentKey(), 'node-a.example.com');
    expect(await credentialDowngradeCheck('node-a', '2.9.1')).toMatchObject({ action: 'reset-credentials', targetKnowsNodeKeys: false,
      nodeHasCredentials: true, resetPath: '/api/v1/nodes/node-a/credentials/reset' });
    expect(await credentialDowngradeCheck('node-a', '2.10.0')).toMatchObject({ action: 'none', targetKnowsNodeKeys: true });
    process.env['NODE_AUTH_MODE'] = 'enforce';
    expect(await credentialDowngradeCheck('node-a', '2.9.1')).toMatchObject({ action: 'enroll-instead', resetPath: null });
    await expect(credentialDowngradeCheck('node-a', 'latest')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(credentialDowngradeCheck('node-x', '2.9.1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
