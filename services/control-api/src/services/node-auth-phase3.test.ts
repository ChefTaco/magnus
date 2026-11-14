/**
 * Per-node credentials, phase 3 (3.0.0, docs/NODE_CREDENTIALS.md): enforce is the default, the
 * start-up guard, what enforce refuses on every path, and old (2.10.2) peers on either side.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error-handler.js';

const SECRET = 'node-auth-phase3-fixture-shared-secret-32-characters';
const fixture = vi.hoisted(() => ({ audit: [] as Array<{ action: string; details?: Record<string, unknown> }>, peer: '192.0.2.10' }));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(), NODE_MANAGER_SECRET: 'node-auth-phase3-fixture-shared-secret-32-characters' }));
vi.mock('../services/credential-rotation-service.js', async original => ({ ...await original<object>(),
  verifyWithRotation: (_name: string, active: string, token: string) => token === active }));
vi.mock('../services/audit-service.js', async original => ({ ...await original<object>(),
  logAuditEvent: async (event: { action: string }) => { fixture.audit.push(event); } }));
vi.mock('../services/notification-service.js', () => ({ createNotification: async () => 'n' }));
vi.mock('../utils/heartbeat-peer.js', () => ({ heartbeatPeerAddress: () => fixture.peer }));
vi.mock('../services/node-credential-store.js', async () => {
  const { createFakeCredentialStore } = await import('../services/node-credential-test-fixture.js');
  const fake = createFakeCredentialStore();
  return { nodeCredentialStore: fake.store, fakeCredentialStore: fake };
});

const { fakeCredentialStore: fake } = await import('../services/node-credential-store.js') as unknown as
  { fakeCredentialStore: ReturnType<typeof import('../services/node-credential-test-fixture.js').createFakeCredentialStore> };
const { fixtureAgentKey, fixtureNode } = await import('./node-credential-test-fixture.js');
const { assertNodeClaims, nodeAuth, nodeAuthOf, resetNodeAuthState } = await import('../middleware/node-auth.js');
const { nodeEnrollmentRouter } = await import('../routes/node-enrollment.js');
const { serverSigningKey, serverPublicKeys } = await import('./node-server-key.js');
const { nodeAuthStartupGuard } = await import('./node-auth-startup-guard.js');
const { nodeAuthMode, nodeAuthModeSetting, nodeAutoRegister } = await import('./node-auth-config.js');
const { nodeCredentialFleetSummary } = await import('./node-credential-summary.js');
const { evidencePolicyFor, resetEvidencePolicyState } = await import('./node-evidence-policy.js');
const { agentAuthHeaders, noteAgentServerKeyPins, resetAgentAuthState, unsignedAgentAuthHeaders } = await import('./node-agent-auth.js');
const { signNodeDecision, verifyNodeDecision } = await import('./server-authorization.js');
const { resetNodeCredentialServiceState } = await import('./node-credential-service.js');
const { resetLegacyUseState } = await import('./node-legacy-use.js');
const { getNodeManagerSecret, listMissingSecrets } = await import('../utils/env.js');
const { CONTROL_API_NODE_ID, DASHBOARD_NODE_ID } = await import('../utils/sentinel-nodes.js');
const wire = await import('../security/node-request-auth.js');
const evidence = await import('../security/node-evidence.js');

const app = new Hono().onError(errorHandler);
app.post('/api/v1/probe', nodeAuth(), async c => {
  const body = await c.req.json() as { nodeId?: string; nodeFqdn?: string };
  await assertNodeClaims(c, { nodeId: body.nodeId, fqdn: body.nodeFqdn });
  const auth = nodeAuthOf(c);
  return c.json({ method: auth.method, nodeId: auth.method === 'signature' ? auth.node.id : null });
});
app.route('/api/v1/node-enrollment', nodeEnrollmentRouter);

type AgentKey = ReturnType<typeof fixtureAgentKey>;
const serverKeyId = serverSigningKey().keyId;
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
async function code(response: Response): Promise<string> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code ?? '';
}
/** What a 2.10.2 agent sends: its signature and, beside it, the shared secret. */
function oldAgentHeaders(key: AgentKey, nodeId: string, body: unknown, path = '/api/v1/probe') {
  return { ...key.sign({ nodeId, serverKeyId, path, body: JSON.stringify(body) }), 'x-node-token': SECRET };
}
/** A node with an active key whose agent signs its evidence (what every node of a ready fleet looks like). */
function keyed(id: string, options: { signs?: boolean; version?: string } = {}): AgentKey {
  const key = fixtureAgentKey();
  fake.state.nodes.push(fixtureNode(id, `${id}.example.com`, '192.0.2.10'));
  void fake.store.bindFirst({ nodeId: id, keyId: key.keyId, publicKey: key.publicKey, boundFqdn: `${id}.example.com` }, 'LEGACY_UPGRADE');
  const row = fake.state.credentials.find(entry => entry.keyId === key.keyId)!;
  row.evidenceSigning = options.signs ?? true;
  fake.state.agentVersions.set(id, options.version ?? '2.10.2');
  return key;
}

beforeEach(() => {
  fake.reset();
  fixture.audit = []; fixture.peer = '192.0.2.10';
  resetNodeAuthState(); resetNodeCredentialServiceState(); resetEvidencePolicyState(); resetAgentAuthState(); resetLegacyUseState();
  delete process.env['NODE_AUTH_MODE']; delete process.env['NODE_AUTO_REGISTER']; delete process.env['NODE_AUTH_LEGACY_UPGRADE_UNTIL'];
  // The internal log sources are inventory rows without an agent or a key.
  fake.state.nodes.push(fixtureNode(CONTROL_API_NODE_ID, CONTROL_API_NODE_ID, '127.0.0.1'), fixtureNode(DASHBOARD_NODE_ID, DASHBOARD_NODE_ID, '127.0.0.1'));
});
afterEach(() => { delete process.env['NODE_AUTH_MODE']; delete process.env['NODE_AUTO_REGISTER']; });

describe('enforce is the default', () => {
  it('reads an unset or unknown NODE_AUTH_MODE as enforce, and says whether it was set', () => {
    expect(nodeAuthModeSetting()).toEqual({ mode: 'enforce', explicit: false, deprecated: false });
    expect(nodeAuthModeSetting({ NODE_AUTH_MODE: 'compat' })).toEqual({ mode: 'compat', explicit: true, deprecated: true });
    expect(nodeAuthModeSetting({ NODE_AUTH_MODE: ' Warn ' })).toEqual({ mode: 'warn', explicit: true, deprecated: true });
    expect(nodeAuthModeSetting({ NODE_AUTH_MODE: 'enforce' })).toEqual({ mode: 'enforce', explicit: true, deprecated: false });
  });

  it('turns auto-registration off with enforce, and keeps it for an explicit compat', () => {
    expect(nodeAutoRegister()).toBe(false);
    expect(nodeAutoRegister({ NODE_AUTH_MODE: 'compat' })).toBe(true);
    expect(nodeAutoRegister({ NODE_AUTH_MODE: 'compat', NODE_AUTO_REGISTER: 'false' })).toBe(false);
    expect(nodeAutoRegister({ NODE_AUTH_MODE: 'enforce', NODE_AUTO_REGISTER: 'true' })).toBe(true);
  });

  it('needs the shared node credentials at boot only under an explicit compat or warn', () => {
    expect(listMissingSecrets().some(entry => entry.startsWith('NODE_MANAGER_SECRET') || entry.startsWith('RESULT_SIGNING_SECRET'))).toBe(false);
    process.env['NODE_AUTH_MODE'] = 'compat';
    // This test's NODE_MANAGER_SECRET is mocked in, the result key is not set.
    expect(listMissingSecrets().some(entry => entry.startsWith('RESULT_SIGNING_SECRET'))).toBe(true);
  });
});

describe('start-up guard (NODE_AUTH_MODE unset)', () => {
  it('starts enforcing when every real node has an active key and signs its evidence', async () => {
    keyed('node-a'); keyed('node-b');
    const result = await nodeAuthStartupGuard();
    expect(result).toMatchObject({ ok: true, setting: { mode: 'enforce', explicit: false }, warnings: [] });
    expect(nodeAuthMode()).toBe('enforce');
  });

  it('refuses to start while a real node has no key, naming it and both ways out', async () => {
    keyed('node-a');
    fake.state.nodes.push(fixtureNode('node-old', 'web-1.example.com', '192.0.2.30', { name: 'web-1' }));
    const result = await nodeAuthStartupGuard();
    if (result.ok) throw new Error('started');
    expect(result.blockers.map(blocker => blocker.code)).toEqual(['NODES_WITHOUT_KEY']);
    expect(result.message).toContain('NODE_AUTH_MODE is not set');
    expect(result.message).toContain('1 node(s) without a node key');
    expect(result.message).toContain('web-1 (node-old)');
    expect(result.message).toContain('magnus-agent enroll --token');
    expect(result.message).toContain('set NODE_AUTH_MODE=compat');
    // Only the unkeyed real node: neither the keyed one nor the internal log sources.
    expect(result.message).not.toContain('node-a');
    expect(result.message).not.toContain(CONTROL_API_NODE_ID);
  });

  it('refuses to start while an agent does not sign its evidence, or is a 2.10.0/2.10.1 agent enforce cannot reach', async () => {
    keyed('node-a', { signs: false });
    keyed('node-b', { version: '2.10.1' });
    const result = await nodeAuthStartupGuard();
    if (result.ok) throw new Error('started');
    expect(result.blockers.map(blocker => [blocker.code, blocker.nodes.map(node => node.id)])).toEqual([
      ['NODES_NOT_SIGNING_EVIDENCE', ['node-a']], ['AGENTS_NEED_UPGRADE', ['node-b']]]);
    expect(result.message).toContain('does not sign its evidence');
  });

  it('refuses a node whose keys were all revoked, and ignores decommissioned nodes', async () => {
    keyed('node-a');
    await fake.store.revoke('node-a', null, 'admin', new Date());
    fake.state.nodes.push(fixtureNode('node-gone', 'gone.example.com', '192.0.2.40', { status: 'DECOMMISSIONED' }));
    const result = await nodeAuthStartupGuard();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers.map(blocker => blocker.code)).toEqual(['NODES_REVOKED']);
  });

  it('never counts the internal pseudo-nodes: a fleet of only them starts', async () => {
    expect(fake.state.nodes.map(node => node.id)).toEqual([CONTROL_API_NODE_ID, DASHBOARD_NODE_ID]);
    expect(await nodeAuthStartupGuard()).toMatchObject({ ok: true });
    const summary = await nodeCredentialFleetSummary();
    expect(summary.nodes.total).toBe(0);
    expect(summary.blockers).toEqual([]);
  });

  it('starts an explicit compat or warn whatever the fleet looks like, with a deprecation warning', async () => {
    fake.state.nodes.push(fixtureNode('node-old', 'old.example.com', '192.0.2.30'));
    for (const mode of ['compat', 'warn']) {
      const result = await nodeAuthStartupGuard({ NODE_AUTH_MODE: mode });
      expect(result).toMatchObject({ ok: true, setting: { mode, explicit: true, deprecated: true } });
      if (result.ok) expect(result.warnings).toEqual([expect.stringContaining(`NODE_AUTH_MODE=${mode} is deprecated`)]);
    }
    // An explicit enforce is the operator's decision too: it starts, without a warning.
    expect(await nodeAuthStartupGuard({ NODE_AUTH_MODE: 'enforce' })).toMatchObject({ ok: true, warnings: [] });
  });

  it('reports the mode, whether it was set, and the deprecation in the fleet summary', async () => {
    keyed('node-a');
    expect(await nodeCredentialFleetSummary()).toMatchObject({ mode: 'enforce', modeExplicit: false, modeDeprecated: false, deprecationNotice: null,
      enforceReady: true, serverKeyRotation: { active: { keyId: serverKeyId }, next: null, previous: null } });
    process.env['NODE_AUTH_MODE'] = 'compat';
    expect(await nodeCredentialFleetSummary()).toMatchObject({ mode: 'compat', modeExplicit: true, modeDeprecated: true,
      deprecationNotice: expect.stringContaining('deprecated') });
  });
});

describe('what enforce refuses', () => {
  it('refuses a request that carries only the shared secret, from any node, keyed or not', async () => {
    keyed('node-a');
    fake.state.nodes.push(fixtureNode('node-old', 'old.example.com', '192.0.2.30'));
    for (const body of [{ nodeId: 'node-a' }, { nodeFqdn: 'old.example.com' }, {}]) {
      const response = await post('/api/v1/probe', body, { 'x-node-token': SECRET });
      expect(response.status).toBe(401);
      expect(await code(response)).toBe('NODE_SIGNATURE_REQUIRED');
    }
  });

  it('accepts a 2.10.2 agent by its signature and ignores the shared secret it also sends', async () => {
    const key = keyed('node-a');
    const response = await post('/api/v1/probe', { nodeId: 'node-a' }, oldAgentHeaders(key, 'node-a', { nodeId: 'node-a' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: 'signature', nodeId: 'node-a' });
    // A signature this server has no key for is refused, whatever secret comes with it.
    const stranger = fixtureAgentKey();
    const unknown = await post('/api/v1/probe', {}, oldAgentHeaders(stranger, 'node-a', {}));
    expect(await code(unknown)).toBe('NODE_CREDENTIAL_UNKNOWN');
  });

  it('closes the legacy upgrade with 410 inside the window, before it looks at any credential', async () => {
    fake.state.nodes.push(fixtureNode('node-old', 'old.example.com', '192.0.2.10'));
    process.env['NODE_AUTH_LEGACY_UPGRADE_UNTIL'] = new Date(Date.now() + 86_400_000).toISOString();
    const key = fixtureAgentKey();
    const body = { fqdn: 'old.example.com', publicKey: key.publicKey, proof: key.proof('legacy-upgrade', 'old.example.com', '-') };
    for (const headers of [{ 'x-node-token': SECRET }, {}, { 'x-node-token': 'wrong' }]) {
      const response = await post('/api/v1/node-enrollment/legacy-upgrade', body, headers);
      expect(response.status).toBe(410);
      expect(await code(response)).toBe('LEGACY_UPGRADE_CLOSED');
    }
    expect(fake.state.credentials).toEqual([]);
    process.env['NODE_AUTH_MODE'] = 'compat';
    expect((await post('/api/v1/node-enrollment/legacy-upgrade', body, { 'x-node-token': SECRET })).status).toBe(200);
  });

  it('refuses evidence that carries only the shared-key HMAC, and decides by the node signature', () => {
    const key = keyed('node-a');
    const rows = fake.state.credentials.filter(entry => entry.nodeId === 'node-a');
    const payload = '{"commandId":"cmd-1"}';
    const policy = evidencePolicyFor('node-a', rows);
    expect(policy.requiresNodeSignature).toBe(true);
    expect(policy.check('command-result', payload, undefined, () => true)).toEqual({ ok: false, reason: 'HMAC_REFUSED' });
    // Without any key at all (a node enforce should not have), the HMAC is refused too.
    expect(evidencePolicyFor('node-x', []).check('command-result', payload, undefined, () => true)).toEqual({ ok: false, reason: 'HMAC_REFUSED' });
    // A 2.10.2 agent's evidence: the node signature decides, the HMAC beside it is not needed.
    expect(policy.check('command-result', payload, key.evidence('node-a', 'command-result', payload), () => false)).toEqual({ ok: true, method: 'ed25519' });
  });

  it('signs decisions with the server key only, and refuses one that carries only the HMAC', () => {
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', 'reconcile'.repeat(5));
    try {
      const payload = '{"decision":1}';
      const signed = signNodeDecision('node-a', 'command-reconciliation', { a: 1 }, payload, { agentVerifiesServerSignatures: false })!;
      expect(signed.signature).toBeUndefined();
      expect(signed.serverSignature).toMatchObject({ alg: 'ed25519', nodeId: 'node-a', keyId: serverKeyId });
      expect(verifyNodeDecision('node-a', 'command-reconciliation', payload, signed)).toBe(true);
      process.env['NODE_AUTH_MODE'] = 'compat';
      const legacy = signNodeDecision('node-a', 'command-reconciliation', { a: 1 }, payload, { agentVerifiesServerSignatures: false })!;
      expect(legacy.signature).toMatch(/^[a-f0-9]{64}$/);
      expect(verifyNodeDecision('node-a', 'command-reconciliation', payload, { signature: legacy.signature })).toBe(true);
      delete process.env['NODE_AUTH_MODE'];
      expect(verifyNodeDecision('node-a', 'command-reconciliation', payload, { signature: legacy.signature })).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it('never sends the shared secret to an agent, signs for exactly one node, and refuses an unsigned request', () => {
    const headers = agentAuthHeaders({ nodeId: 'node-a' }, 'GET', 'https://node-a.example.com:4100/api/v1/files');
    expect(headers['x-node-token']).toBeUndefined();
    expect(wire.readNodeAuthHeaders(name => headers[name])).toMatchObject({ nodeId: 'node-a', keyId: serverKeyId });
    expect(() => agentAuthHeaders({}, 'GET', 'https://node-a.example.com:4100/api/v1/files')).toThrow(/must name its node/);
    expect(() => unsignedAgentAuthHeaders({ nodeId: 'node-a' }, 'POST', 'https://node-a.example.com:4100/api/v1/commands/managed-http', 'probe'))
      .toThrow(/refused/);
    // Under an explicit compat a node whose pins are not current still gets both.
    process.env['NODE_AUTH_MODE'] = 'compat';
    const target = { nodeId: 'node-a', legacyToken: SECRET };
    expect(agentAuthHeaders(target, 'GET', 'https://node-a.example.com:4100/api/v1/files')['x-node-token']).toBe(SECRET);
    noteAgentServerKeyPins('node-a', [serverKeyId]);
    expect(agentAuthHeaders(target, 'GET', 'https://node-a.example.com:4100/api/v1/files')['x-node-token']).toBeUndefined();
  });

  it('runs without a shared node secret at all; compat still needs one', () => {
    // (The secret this suite mocks in replaces the export only; the server's own reader sees none.)
    expect(getNodeManagerSecret()).toBe('');
    process.env['NODE_AUTH_MODE'] = 'compat';
    expect(() => getNodeManagerSecret()).toThrow();
  });

  it('serves the keys agents pin without a shared secret, and reports the mode', async () => {
    const response = await app.request('/api/v1/node-enrollment/server-key');
    expect(await response.json()).toMatchObject({ data: { mode: 'enforce', keys: serverPublicKeys() } });
  });
});
