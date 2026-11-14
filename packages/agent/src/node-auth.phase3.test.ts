/**
 * Per-node credentials, phase 3 (3.0.0) on the agent: enforce by default, no shared secrets needed,
 * node-local keys for its own records with old records still readable, and server-key rotation
 * (pinning a staged key, recovering after a missed promotion, keeping recorded decisions readable).
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as wire from './security/node-request-auth.js';
import * as evidence from './security/node-evidence.js';

const dir = mkdtempSync(join(tmpdir(), 'agent-node-auth-phase3-'));
vi.stubEnv('AGENT_INSTALL_DIR', dir);
// A 3.0.0 agent installed fresh: no shared node secret, no shared result or reconciliation key.
vi.stubEnv('NODE_MANAGER_SECRET', '');
vi.stubEnv('RESULT_SIGNING_SECRET', '');
vi.stubEnv('COMMAND_RECONCILIATION_SECRET', '');
vi.stubEnv('NODE_AUTH_MODE', '');
vi.stubEnv('CONTROL_API_URL', 'https://magnus.example.com:4000');
vi.stubEnv('HOST_FQDN', 'node-a.example.com');

const peer = vi.hoisted(() => ({ respond: null as null | ((url: string, init: RequestInit) => Response), calls: [] as string[] }));
vi.mock('./tls.js', async original => ({ ...await original<object>(),
  controlApiFetch: async (url: string, init: RequestInit = {}) => { peer.calls.push(url); return peer.respond!(url, init); } }));
vi.mock('./upgrade/self-upgrade.js', async original => ({ ...await original<object>(), trialOf: () => null }));

const identity = await import('./security/node-identity.js');
const client = await import('./node-auth.js');
const enrollment = await import('./node-enrollment.js');
const { nodeAuthMiddleware } = await import('./middleware.js');
const signing = await import('./security/evidence-signing.js');
const keys = await import('./security/local-evidence-keys.js');
const { signCommandResult } = await import('./security/command-result-signature.js');
const { CommandLedger } = await import('./executors/command-ledger.js');
const { configurationErrors } = await import('./env.js');
const { logger } = await import('./utils/logger.js');
for (const level of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(() => undefined);

const oldServer = wire.generateSigningKey();
const newServer = wire.generateSigningKey();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const keyList = (...entries: Array<[ReturnType<typeof wire.generateSigningKey>, string]>) => entries.map(([key, status]) => ({ keyId: key.keyId, publicKey: key.publicKey, status }));
async function settle(): Promise<void> { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); }

/** Enroll with a token, as a new 3.0.0 agent does (it has no shared secret to upgrade with). */
async function enroll(serverKeys = keyList([oldServer, 'active'])): Promise<void> {
  peer.respond = (_url, init) => {
    const body = JSON.parse(String(init.body)) as { publicKey: string };
    return json(200, { success: true, data: { nodeId: 'node-a', nodeName: 'node-a', keyId: wire.keyIdOfSpki(body.publicKey), serverKeys, mode: 'enforce' } });
  };
  expect(await enrollment.enrollWithToken(`mne_${'A'.repeat(43)}`)).toMatchObject({ ok: true, nodeId: 'node-a' });
  identity.resetNodeIdentityCache();
}
function signedBy(key: ReturnType<typeof wire.generateSigningKey>, path = '/api/v1/files') {
  return wire.signNodeRequest({ privateKey: wire.privateKeyFromPem(key.privateKeyPem), keyId: key.keyId, nodeId: 'node-a', audience: wire.nodeAudience('node-a'),
    method: 'GET', pathWithQuery: path, body: '' });
}
function agentApp(): Hono {
  const app = new Hono();
  app.use('/api/v1/*', nodeAuthMiddleware);
  app.get('/api/v1/files', c => c.json({ success: true }));
  return app;
}

beforeEach(() => {
  rmSync(join(dir, 'identity'), { recursive: true, force: true });
  identity.resetNodeIdentityCache(); client.resetNodeAuthClientState(); enrollment.resetNodeEnrollmentState(); keys.resetLocalEvidenceKeyCache();
  peer.respond = null; peer.calls = [];
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('a 3.0.0 agent without shared secrets', () => {
  it('passes its configuration check without NODE_MANAGER_SECRET or RESULT_SIGNING_SECRET, and needs them under an explicit compat', () => {
    expect(configurationErrors().filter(entry => /NODE_MANAGER_SECRET|RESULT_SIGNING_SECRET/.test(entry))).toEqual([]);
    vi.stubEnv('NODE_AUTH_MODE', 'compat');
    try { expect(configurationErrors().filter(entry => /NODE_MANAGER_SECRET|RESULT_SIGNING_SECRET/.test(entry))).toHaveLength(2); }
    finally { vi.stubEnv('NODE_AUTH_MODE', ''); }
  });

  it('refuses a shared-secret request before it is enrolled (it has no secret), and only server signatures after', async () => {
    const refused = await agentApp().request('/api/v1/files', { headers: { 'x-node-token': 'anything-at-all-anything-at-all-anything' } });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: { code: 'NODE_SIGNATURE_REQUIRED' } });
    await enroll();
    expect(client.agentEnforcesNodeAuth()).toBe(true);
    expect((await agentApp().request('/api/v1/files', { headers: signedBy(oldServer) })).status).toBe(200);
    // And it sends only its signature to the Control API.
    expect(Object.keys(client.controlApiAuthHeaders('POST', 'https://magnus.example.com:4000/api/v1/heartbeat', '{}'))).not.toContain('x-node-token');
  });

  it('MACs its own records with a node-local key it creates (0600) next to the node key, and never with an empty secret', () => {
    const key = keys.resultSigningKey();
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    const file = join(dir, 'identity', 'local-result.key');
    expect(readFileSync(file, 'utf8').trim()).toBe(key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A separate key for decisions about this host; never the result key.
    expect(keys.reconciliationSigningKey()).toMatch(/^[a-f0-9]{64}$/);
    expect(keys.reconciliationSigningKey()).not.toBe(key);
    expect(keys.resultVerificationKeys()).toEqual([key]);
    // A key rotation or re-enrollment replaces the node key only: the local key stays.
    identity.resetNodeIdentity();
    keys.resetLocalEvidenceKeyCache();
    expect(keys.resultSigningKey()).toBe(key);
  });

  it('reads a ledger result written by 2.10.x with the shared result key, once that key is kept as RESULT_SIGNING_PREVIOUS_SECRET', async () => {
    const shared = 'agent-phase3-retired-shared-result-key-32-chars!';
    const root = mkdtempSync(join(tmpdir(), 'agent-phase3-ledger-'));
    try {
      const request = { commandId: 'cmd-old', command: '/usr/bin/true', args: [], timeoutSeconds: 5 };
      // What a 2.10.x agent wrote: the result MAC made with the shared key.
      const writer = new CommandLedger(root, { nodeFqdn: 'node-a.example.com', resultSecret: shared, reconciliationSecret: '' });
      const result = await writer.execute(request, async () => {
        const unsigned = { commandId: 'cmd-old', exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, truncated: false };
        return { ...unsigned, signature: signCommandResult(unsigned, shared) };
      });
      // The 3.0.0 reader without the shared key: refused, and it says which key it needs.
      const reader = new CommandLedger(root, { nodeFqdn: 'node-a.example.com' });
      await expect(reader.receipt('cmd-old')).rejects.toThrow(/RESULT_SIGNING_PREVIOUS_SECRET/);
      vi.stubEnv('RESULT_SIGNING_PREVIOUS_SECRET', shared);
      try {
        expect(await reader.receipt('cmd-old')).toMatchObject({ state: 'completed', result: { signature: result.signature } });
        // A new result is MACed with the node-local key, and both verify.
        const fresh = { commandId: 'cmd-new', exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, truncated: false };
        const signed = { ...fresh, signature: signCommandResult(fresh, keys.resultSigningKey()) };
        expect(await reader.execute({ ...request, commandId: 'cmd-new' }, async () => signed)).toMatchObject({ signature: signed.signature });
        expect(await reader.receipt('cmd-new')).toMatchObject({ state: 'completed' });
      } finally { vi.stubEnv('RESULT_SIGNING_PREVIOUS_SECRET', ''); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('server-key rotation on the agent', () => {
  it('pins a staged next key from the heartbeat reply, active first, and never a retired one', async () => {
    await enroll();
    peer.respond = () => json(200, { success: true, data: { keys: [...keyList([oldServer, 'active'], [newServer, 'next']),
      { keyId: 'f'.repeat(64), publicKey: wire.generateSigningKey().publicKey, status: 'retired' }] } });
    enrollment.onHeartbeatAcknowledged({ supported: true, mode: 'enforce', method: 'signature', evidence: 1, serverKeyIds: [oldServer.keyId, newServer.keyId] });
    await settle();
    identity.resetNodeIdentityCache();
    expect(identity.boundNodeIdentity()!.binding.serverKeys.map(key => key.keyId)).toEqual([oldServer.keyId, newServer.keyId]);
    // Both verify, before and after the promotion.
    expect((await agentApp().request('/api/v1/files', { headers: signedBy(oldServer) })).status).toBe(200);
    expect((await agentApp().request('/api/v1/files', { headers: signedBy(newServer) })).status).toBe(200);
    // A reply that already matches the pins reads nothing.
    peer.calls = [];
    enrollment.onHeartbeatAcknowledged({ supported: true, mode: 'enforce', method: 'signature', evidence: 1, serverKeyIds: [oldServer.keyId, newServer.keyId] });
    await settle();
    expect(peer.calls).toEqual([]);
    // The promotion: the server lists the new key first; the agent reads the keys again and signs for it from now on.
    peer.respond = () => json(200, { success: true, data: { keys: keyList([newServer, 'active'], [oldServer, 'previous']) } });
    enrollment.onHeartbeatAcknowledged({ supported: true, mode: 'enforce', method: 'signature', evidence: 1, serverKeyIds: [newServer.keyId, oldServer.keyId] },
      Date.now() + 61_000);
    await settle();
    identity.resetNodeIdentityCache();
    expect(identity.boundNodeIdentity()!.binding.serverKeys.map(key => key.keyId)).toEqual([newServer.keyId, oldServer.keyId]);
    const headers = client.controlApiAuthHeaders('POST', 'https://magnus.example.com:4000/api/v1/heartbeat', '{}');
    const read = wire.readNodeAuthHeaders(name => headers[name]);
    expect(read && read !== 'MALFORMED' && read.keyId).toBe(identity.boundNodeIdentity()!.keyId);
    expect(wire.verifyNodeRequest({ headers: read as wire.NodeAuthHeaderValues, publicKey: identity.boundNodeIdentity()!.publicKey, expectedNodeId: 'node-a',
      audiences: [wire.serverAudience(newServer.keyId)], method: 'POST', pathWithQuery: '/api/v1/heartbeat', body: '{}' })).toEqual({ ok: true });
  });

  it('recovers after missing a promotion: one refused request, then it pins the new key and keeps the old one for recorded decisions', async () => {
    await enroll();
    // The server promoted and retired while this agent was away; it signs with the new key now.
    peer.respond = () => json(200, { success: true, data: { keys: keyList([newServer, 'active']) } });
    expect((await agentApp().request('/api/v1/files', { headers: signedBy(newServer) })).status).toBe(401);
    await settle();
    identity.resetNodeIdentityCache();
    const binding = identity.boundNodeIdentity()!.binding;
    expect(binding.serverKeys.map(key => key.keyId)).toEqual([newServer.keyId]);
    expect(binding.retiredServerKeys?.map(key => key.keyId)).toEqual([oldServer.keyId]);
    expect((await agentApp().request('/api/v1/files', { headers: signedBy(newServer) })).status).toBe(200);
    // The retired key opens nothing new...
    expect((await agentApp().request('/api/v1/files', { headers: signedBy(oldServer) })).status).toBe(401);
    // ...but a decision it signed and this agent recorded still verifies (a reconciled receipt in the ledger).
    const payload = evidence.commandReconciliationSigningPayload({ nodeFqdn: 'node-a.example.com', commandId: 'cmd-1', requestSha256: 'a'.repeat(64),
      disposition: 'no_effect_verified', evidenceSha256: 'b'.repeat(64), approvalRef: 'magnus:test', decisionId: 'd-1', expiresAt: Date.now() + 60_000 });
    const before = evidence.signServerAuthorization(wire.privateKeyFromPem(oldServer.privateKeyPem), oldServer.keyId, 'node-a', 'command-reconciliation', payload);
    expect(signing.verifyServerDecision('command-reconciliation', payload, before, () => false, { stored: true })).toBe(true);
    expect(signing.verifyServerDecision('command-reconciliation', payload, before, () => false)).toBe(false);
  });

  it('accepts a scheduler-source settlement signed by the pinned server key, and in enforce never the HMAC alone', async () => {
    await enroll();
    const payload = '{"domain":"magnus.scheduler-source-reconciliation.v2"}';
    const signature = evidence.signServerAuthorization(wire.privateKeyFromPem(oldServer.privateKeyPem), oldServer.keyId, 'node-a', 'scheduler-source-settlement', payload);
    expect(signing.verifyServerDecision('scheduler-source-settlement', payload, signature, () => false)).toBe(true);
    expect(signing.verifyServerDecision('command-reconciliation', payload, signature, () => true)).toBe(false);
    expect(signing.verifyServerDecision('scheduler-source-settlement', payload, undefined, () => true)).toBe(false);
  });
});

describe('a 2.10.2 server and a 3.0.0 agent in enforce', () => {
  it('accepts the old server\'s request by its signature, whatever shared secret travels beside it', async () => {
    await enroll();
    const headers = { ...signedBy(oldServer), 'x-node-token': 'a-2.10.2-server-still-sends-its-shared-secret' };
    expect((await agentApp().request('/api/v1/files', { headers })).status).toBe(200);
    // Its shared secret alone, as a 2.10.2 server sends to a node whose pins it has not heard yet, is refused.
    expect((await agentApp().request('/api/v1/files', { headers: { 'x-node-token': 'a-2.10.2-server-still-sends-its-shared-secret' } })).status).toBe(401);
  });

  it('accepts the old server\'s decision by its server signature next to the HMAC it also adds', async () => {
    await enroll();
    const payload = evidence.commandReconciliationSigningPayload({ nodeFqdn: 'node-a.example.com', commandId: 'cmd-2', requestSha256: 'a'.repeat(64),
      disposition: 'effects_verified', evidenceSha256: 'b'.repeat(64), approvalRef: 'magnus:test', decisionId: 'd-2', expiresAt: Date.now() + 60_000 });
    const serverSignature = evidence.signServerAuthorization(wire.privateKeyFromPem(oldServer.privateKeyPem), oldServer.keyId, 'node-a', 'command-reconciliation', payload);
    expect(signing.verifyServerDecision('command-reconciliation', payload, serverSignature, () => true)).toBe(true);
    expect(signing.verifyServerDecision('command-reconciliation', payload, undefined, () => true)).toBe(false);
  });
});
