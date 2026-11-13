/**
 * The agent's side of per-node credentials, against simulated peers:
 *   - an old server (no node credentials): ignores signature headers, has no enrollment route
 *   - a new server: binds a key, signs its requests, verifies ours
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as wire from './security/node-request-auth.js';

const SECRET = 'agent-node-auth-fixture-shared-secret-32-characters';
const dir = mkdtempSync(join(tmpdir(), 'agent-node-auth-'));
vi.stubEnv('AGENT_INSTALL_DIR', dir);
vi.stubEnv('NODE_MANAGER_SECRET', SECRET);
vi.stubEnv('RESULT_SIGNING_SECRET', 'agent-node-auth-fixture-result-secret-32-characters');
vi.stubEnv('CONTROL_API_URL', 'https://magnus.example.com:4000/fleet');
vi.stubEnv('HOST_FQDN', 'Node-A.example.com');

type Call = { url: string; init: RequestInit };
const peer = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, respond: null as null | ((url: string, init: RequestInit) => Response | Promise<Response>), trial: null as unknown }));
vi.mock('./tls.js', async original => ({ ...await original<object>(),
  controlApiFetch: async (url: string, init: RequestInit = {}) => { peer.calls.push({ url, init }); return peer.respond!(url, init); } }));
vi.mock('./upgrade/self-upgrade.js', async original => ({ ...await original<object>(), trialOf: () => peer.trial }));

const identity = await import('./security/node-identity.js');
const client = await import('./node-auth.js');
const enrollment = await import('./node-enrollment.js');
const { nodeAuthMiddleware } = await import('./middleware.js');
const { logger } = await import('./utils/logger.js');

const server = wire.generateSigningKey();
const serverPrivateKey = wire.privateKeyFromPem(server.privateKeyPem);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const headerOf = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];
const logged: string[] = [];
for (const level of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, level).mockImplementation((message: string) => { logged.push(`${level}: ${message}`); });

/** A new server's legacy-upgrade route: verifies the proof and binds the node. */
function newServer(nodeId = 'node-a', keys = [{ keyId: server.keyId, publicKey: server.publicKey, status: 'active' }]) {
  return (url: string, init: RequestInit): Response => {
    if (url.endsWith('/api/v1/node-enrollment/server-key')) return json(200, { success: true, data: { keys, mode: 'compat' } });
    const body = JSON.parse(String(init.body)) as { fqdn: string; publicKey: string; token?: string; proof: { timestamp: string; nonce: string; signature: string } };
    return json(200, { success: true, data: { nodeId, nodeName: nodeId, keyId: wire.keyIdOfSpki(body.publicKey), serverKeys: keys, mode: 'compat' } });
  };
}
async function settle(): Promise<void> { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); }
/** Bind this agent as `node-a` the way the migration does. */
async function bind(): Promise<void> {
  peer.respond = newServer();
  expect(await enrollment.attemptLegacyUpgrade()).toEqual({ state: 'bound', nodeId: 'node-a' });
  peer.calls = [];
}

beforeEach(() => {
  rmSync(join(dir, 'identity'), { recursive: true, force: true });
  identity.resetNodeIdentityCache(); client.resetNodeAuthClientState(); enrollment.resetNodeEnrollmentState();
  peer.calls = []; peer.respond = null; peer.trial = null; logged.length = 0;
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('agent to server', () => {
  it('sends only the shared secret while it has no node key (unchanged for an old server)', async () => {
    peer.respond = () => json(200, { success: true });
    await client.nodeApiFetch('https://magnus.example.com:4000/fleet/api/v1/resource-leases/claim', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(peer.calls[0]!.init.headers).toEqual({ 'content-type': 'application/json', 'x-node-token': SECRET });
    expect(existsSync(join(dir, 'identity'))).toBe(false);
  });

  it('signs for the pinned server key and still sends the shared secret, so either server accepts it', async () => {
    await bind();
    peer.respond = () => json(200, { success: true });
    const url = 'https://magnus.example.com:4000/fleet/api/v1/cron/managed-occurrences/status?x=1';
    const body = JSON.stringify({ nodeFqdn: 'node-a.example.com' });
    await client.nodeApiFetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    const call = peer.calls[0]!;
    expect(headerOf(call, 'x-node-token')).toBe(SECRET);
    const headers = wire.readNodeAuthHeaders(name => headerOf(call, name));
    if (!headers || headers === 'MALFORMED') throw new Error('unsigned');
    const key = identity.loadNodeIdentity(0)!;
    // The server sees the path without the reverse-proxy prefix of CONTROL_API_URL.
    const verify = (change: Partial<wire.VerifyNodeRequestInput> = {}) => wire.verifyNodeRequest({ headers, publicKey: key.publicKey, expectedNodeId: 'node-a',
      audiences: [wire.serverAudience(server.keyId)], method: 'POST', pathWithQuery: '/api/v1/cron/managed-occurrences/status?x=1', body, ...change });
    expect(verify()).toEqual({ ok: true });
    expect(verify({ body: body + ' ' })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verify({ audiences: [wire.serverAudience(wire.generateSigningKey().keyId)] })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(client.controlApiPath('https://magnus.example.com:4000/fleet/api/v1/heartbeat')).toBe('/api/v1/heartbeat');
    expect(client.controlApiPath('https://magnus.example.com:4000/api/v1/heartbeat')).toBe('/api/v1/heartbeat');
  });

  it('corrects a wrong clock from the server time header, refusals included', async () => {
    await bind();
    const serverNow = Date.now() + 10 * 60_000;
    peer.respond = () => json(401, { success: false, error: { code: 'NODE_AUTH_SKEW' } }, { 'x-magnus-server-time': String(serverNow) });
    await client.nodeApiFetch('https://magnus.example.com:4000/fleet/api/v1/heartbeat', { method: 'POST', body: '{}' });
    expect(Math.abs(client.nodeAuthNow() - serverNow)).toBeLessThan(2000);
    await client.nodeApiFetch('https://magnus.example.com:4000/fleet/api/v1/heartbeat', { method: 'POST', body: '{}' });
    expect(Math.abs(Number(headerOf(peer.calls[1]!, 'x-magnus-timestamp')) - serverNow)).toBeLessThan(2000);
    client.noteServerTime(String(Date.now() + 1500));
    expect(Math.abs(client.nodeAuthNow() - Date.now())).toBeLessThan(50);
    client.noteServerTime('not-a-time');
    expect(Math.abs(client.nodeAuthNow() - Date.now())).toBeLessThan(50);
  });
});

describe('automatic upgrade of an existing node', () => {
  it('does nothing against a server that does not announce node credentials', async () => {
    peer.respond = () => { throw new Error('must not be called'); };
    enrollment.onHeartbeatAcknowledged(undefined);
    enrollment.onHeartbeatAcknowledged({});
    await settle();
    expect(peer.calls).toEqual([]);
    expect(existsSync(join(dir, 'identity'))).toBe(false);
  });

  it('binds after an acknowledged heartbeat, proves possession, and never logs the key or the secret', async () => {
    peer.respond = newServer();
    enrollment.onHeartbeatAcknowledged({ supported: true, mode: 'compat', method: 'legacy' });
    await settle();
    expect(peer.calls).toHaveLength(1);
    const call = peer.calls[0]!;
    expect(call.url).toBe('https://magnus.example.com:4000/fleet/api/v1/node-enrollment/legacy-upgrade');
    expect(headerOf(call, 'x-node-token')).toBe(SECRET);
    const sent = JSON.parse(String(call.init.body)) as { fqdn: string; publicKey: string; proof: { timestamp: string; nonce: string; signature: string } };
    expect(sent.fqdn).toBe('node-a.example.com');
    expect(wire.verifyEnrollmentProof({ purpose: 'legacy-upgrade', publicKey: sent.publicKey, fqdn: sent.fqdn, binding: '-', ...sent.proof })).toEqual({ ok: true });
    expect(String(call.init.body)).not.toContain('PRIVATE');
    const bound = identity.boundNodeIdentity()!;
    expect(bound.binding).toMatchObject({ nodeId: 'node-a', origin: 'legacy-upgrade', serverKeys: [{ keyId: server.keyId, publicKey: server.publicKey }] });
    const pem = readFileSync(join(dir, 'identity/node.key'), 'utf8');
    const everything = logged.join('\n');
    expect(everything).toContain(`Node key bound: this agent is node node-a with key ${wire.keyFingerprint(bound.keyId)}`);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(pem.split('\n')[1]!);
    // Bound and accepted by signature: no further calls.
    enrollment.onHeartbeatAcknowledged({ supported: true, mode: 'compat', method: 'signature' });
    await settle();
    expect(peer.calls).toHaveLength(1);
  });

  it('waits while a self-upgrade is on trial, so a version that may be reverted never closes the node', async () => {
    peer.respond = newServer();
    peer.trial = { state: 'trial' };
    enrollment.onHeartbeatAcknowledged({ supported: true, mode: 'compat', method: 'legacy' });
    await settle();
    expect(peer.calls).toEqual([]);
    peer.trial = null;
    enrollment.onHeartbeatAcknowledged({ supported: true, mode: 'compat', method: 'legacy' });
    await settle();
    expect(identity.boundNodeIdentity()?.binding.nodeId).toBe('node-a');
  });

  it('retries with a backoff after 404 (older server or unknown node) and when the server is unreachable', async () => {
    peer.respond = () => json(404, { success: false, error: { code: 'NOT_FOUND' } });
    expect(await enrollment.attemptLegacyUpgrade()).toMatchObject({ state: 'retry', reason: 'NOT_FOUND', retryInMs: 5 * 60_000 });
    const keyId = identity.loadNodeIdentity(0)!.keyId;
    peer.respond = () => { throw new Error('connect ECONNREFUSED'); };
    expect(await enrollment.attemptLegacyUpgrade()).toMatchObject({ state: 'retry', retryInMs: 60_000 });
    // The loop spaces its attempts: a second acknowledgement inside the backoff makes no call.
    peer.calls = [];
    peer.respond = () => json(404, {});
    const now = Date.now();
    enrollment.onHeartbeatAcknowledged({ supported: true, method: 'legacy' }, now);
    await settle();
    enrollment.onHeartbeatAcknowledged({ supported: true, method: 'legacy' }, now + 30_000);
    await settle();
    expect(peer.calls).toHaveLength(1);
    peer.respond = newServer();
    enrollment.onHeartbeatAcknowledged({ supported: true, method: 'legacy' }, Date.now() + 61 * 60_000);
    await settle();
    // The key made for the first attempt is the one that gets bound.
    expect(identity.boundNodeIdentity()?.keyId).toBe(keyId);
    expect(identity.boundNodeIdentity()?.binding.nodeId).toBe('node-a');
  });

  it('logs one clear error when another key already holds the node (409), and keeps the agent running', async () => {
    peer.respond = () => json(409, { success: false, error: { code: 'NODE_CREDENTIAL_EXISTS', message: 'exists' } });
    expect(await enrollment.attemptLegacyUpgrade()).toMatchObject({ state: 'retry', reason: 'NODE_CREDENTIAL_EXISTS', retryInMs: 60 * 60_000 });
    expect(await enrollment.attemptLegacyUpgrade()).toMatchObject({ state: 'retry' });
    const errors = logged.filter(line => line.startsWith('error: '));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Node key NOT bound (NODE_CREDENTIAL_EXISTS)');
    expect(errors[0]).toContain('magnus-agent enroll --token');
    expect(identity.boundNodeIdentity()).toBeNull();
  });

  it('explains a peer-address refusal and a closed window, and rejects a reply for another key', async () => {
    peer.respond = () => json(403, { success: false, error: { code: 'PEER_ADDRESS_MISMATCH' } });
    expect(await enrollment.attemptLegacyUpgrade()).toMatchObject({ reason: 'PEER_ADDRESS_MISMATCH', retryInMs: 60 * 60_000 });
    peer.respond = () => json(410, { success: false, error: { code: 'LEGACY_UPGRADE_CLOSED' } });
    expect(await enrollment.attemptLegacyUpgrade()).toMatchObject({ reason: 'LEGACY_UPGRADE_CLOSED', retryInMs: 6 * 60 * 60_000 });
    expect(logged.filter(line => line.startsWith('warn: '))).toHaveLength(2);
    peer.respond = () => json(200, { success: true, data: { nodeId: 'node-a', keyId: wire.generateSigningKey().keyId, serverKeys: [{ publicKey: server.publicKey }] } });
    expect(await enrollment.attemptLegacyUpgrade()).toMatchObject({ state: 'retry', reason: 'INVALID_REPLY' });
    peer.respond = () => json(200, { success: true, data: { nodeId: 'node-a', keyId: identity.loadNodeIdentity(0)!.keyId, serverKeys: [] } });
    expect(await enrollment.attemptLegacyUpgrade()).toMatchObject({ state: 'retry', reason: 'INVALID_REPLY' });
    expect(identity.boundNodeIdentity()).toBeNull();
  });

  it('binds the same key again when the server no longer knows it', async () => {
    await bind();
    const keyId = identity.boundNodeIdentity()!.keyId;
    peer.respond = newServer('node-a-recreated');
    enrollment.onHeartbeatAcknowledged({ supported: true, mode: 'compat', method: 'legacy', problem: 'UNKNOWN_KEY' });
    await settle();
    expect(peer.calls).toHaveLength(1);
    expect(identity.boundNodeIdentity()).toMatchObject({ keyId, binding: { nodeId: 'node-a-recreated' } });
  });

  it('enrolls with a one-time token using a new key, and reports refusals', async () => {
    await bind();
    const before = identity.boundNodeIdentity()!.keyId;
    expect(await enrollment.enrollWithToken('not-a-token')).toMatchObject({ ok: false });
    peer.respond = () => json(409, { success: false, error: { code: 'ENROLLMENT_TOKEN_USED', message: 'The enrollment token was already used' } });
    const token = `mne_${'T'.repeat(43)}`;
    expect(await enrollment.enrollWithToken(token)).toEqual({ ok: false, reason: 'ENROLLMENT_TOKEN_USED: The enrollment token was already used' });
    expect(identity.boundNodeIdentity()!.keyId).toBe(before);
    peer.respond = newServer('node-b');
    const result = await enrollment.enrollWithToken(token);
    expect(result).toMatchObject({ ok: true, nodeId: 'node-b', serverKeyFingerprint: wire.keyFingerprint(server.keyId) });
    const call = peer.calls.at(-1)!;
    expect(headerOf(call, 'x-node-token')).toBeUndefined();
    expect(String(call.init.body)).not.toContain('PRIVATE');
    identity.resetNodeIdentityCache();
    expect(identity.boundNodeIdentity()).toMatchObject({ binding: { nodeId: 'node-b', origin: 'enrollment-token' } });
    expect(identity.boundNodeIdentity()!.keyId).not.toBe(before);
    expect(enrollment.describeNodeIdentity()).toMatchObject({ state: 'bound', nodeId: 'node-b' });
    expect(JSON.stringify(enrollment.describeNodeIdentity())).not.toContain('PRIVATE');
  });

  it('pins a replaced server key when asked, at most once per interval', async () => {
    await bind();
    const replacement = wire.generateSigningKey();
    peer.respond = newServer('node-a', [{ keyId: replacement.keyId, publicKey: replacement.publicKey, status: 'active' }, { keyId: server.keyId, publicKey: server.publicKey, status: 'next' }]);
    expect(await enrollment.refreshPinnedServerKeys(60_000)).toBe(true);
    expect(await enrollment.refreshPinnedServerKeys(60_000)).toBe(false);
    expect(identity.boundNodeIdentity()!.binding.serverKeys.map(key => key.keyId)).toEqual([replacement.keyId, server.keyId]);
    expect(peer.calls).toHaveLength(1);
    expect(logged.some(line => line.startsWith('warn: Pinned server key changed'))).toBe(true);
  });
});

describe('server to agent (nodeAuthMiddleware)', () => {
  const app = new Hono();
  app.use('/api/v1/*', nodeAuthMiddleware);
  app.all('/api/v1/echo', async c => c.json({ ok: true, body: c.req.method === 'GET' ? '' : await c.req.text() }));
  const sign = (options: { nodeId?: string; method?: string; path?: string; body?: string; now?: number; nonce?: string; key?: typeof server } = {}) => {
    const key = options.key ?? server;
    return wire.signNodeRequest({ privateKey: key === server ? serverPrivateKey : wire.privateKeyFromPem(key.privateKeyPem), keyId: key.keyId,
      nodeId: options.nodeId ?? 'node-a', audience: wire.nodeAudience(options.nodeId ?? 'node-a'), method: options.method ?? 'POST',
      pathWithQuery: options.path ?? '/api/v1/echo', body: options.body ?? '{"a":1}',
      ...(options.now === undefined ? {} : { now: options.now }), ...(options.nonce === undefined ? {} : { nonce: options.nonce }) });
  };
  const call = (headers: Record<string, string>, options: { method?: string; path?: string; body?: string } = {}) => app.request(`http://node-a.example.com:4100${options.path ?? '/api/v1/echo'}`,
    { method: options.method ?? 'POST', headers, ...((options.method ?? 'POST') === 'GET' ? {} : { body: options.body ?? '{"a":1}' }) });
  const code = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code;

  it('keeps accepting an old server: the shared secret alone, before and after this agent has a key', async () => {
    expect((await call({ 'x-node-token': SECRET })).status).toBe(200);
    expect((await call({})).status).toBe(401);
    expect((await call({ 'x-node-token': 'wrong' })).status).toBe(401);
    await bind();
    expect((await call({ 'x-node-token': SECRET })).status).toBe(200);
  });

  it('accepts a request signed by the pinned server key without the shared secret, and hands the handler the body', async () => {
    await bind();
    const response = await call(sign());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, body: '{"a":1}' });
    expect((await call(sign({ method: 'GET', path: '/api/v1/echo?mount=%2Fvar', body: '' }), { method: 'GET', path: '/api/v1/echo?mount=%2Fvar' })).status).toBe(200);
  });

  it('refuses a request made for another node, even with a valid shared secret beside it', async () => {
    await bind();
    const other = await call({ ...sign({ nodeId: 'node-b' }), 'x-node-token': SECRET });
    expect(other.status).toBe(401);
    expect(await code(other)).toBe('NODE_SIGNATURE_INVALID');
    // The header names this node but the signature was made for node-b.
    const relabelled = { ...sign({ nodeId: 'node-b' }), 'x-magnus-node-id': 'node-a' };
    expect(await code(await call(relabelled))).toBe('NODE_SIGNATURE_INVALID');
  });

  it('refuses a tampered body, path, query or method', async () => {
    await bind();
    expect(await code(await call(sign(), { body: '{"a":2}' }))).toBe('NODE_SIGNATURE_INVALID');
    expect(await code(await call(sign({ path: '/api/v1/other' })))).toBe('NODE_SIGNATURE_INVALID');
    expect(await code(await call(sign(), { path: '/api/v1/echo?force=true' }))).toBe('NODE_SIGNATURE_INVALID');
    expect(await code(await call(sign({ method: 'GET', body: '' })))).toBe('NODE_SIGNATURE_INVALID');
  });

  it('refuses a replay and a timestamp outside the clock window', async () => {
    await bind();
    const headers = sign();
    expect((await call(headers)).status).toBe(200);
    expect(await code(await call(headers))).toBe('NODE_AUTH_REPLAY');
    expect(await code(await call(sign({ now: Date.now() - 61_000 })))).toBe('NODE_AUTH_SKEW');
    expect(await code(await call(sign({ now: Date.now() + 61_000 })))).toBe('NODE_AUTH_SKEW');
    expect(await code(await call({ ...sign(), 'x-magnus-signature': 'short' }))).toBe('NODE_SIGNATURE_INVALID');
  });

  it('judges a request signed by an unpinned key by the shared secret, and reads the server keys again', async () => {
    await bind();
    const rotated = wire.generateSigningKey();
    peer.respond = newServer('node-a', [{ keyId: rotated.keyId, publicKey: rotated.publicKey, status: 'active' }]);
    expect((await call(sign({ key: rotated }))).status).toBe(401);
    expect((await call({ ...sign({ key: rotated }), 'x-node-token': SECRET })).status).toBe(200);
    await settle();
    expect(peer.calls.map(entry => entry.url)).toEqual(['https://magnus.example.com:4000/fleet/api/v1/node-enrollment/server-key']);
    expect((await call(sign({ key: rotated }))).status).toBe(200);
  });

  it('an agent without a key ignores signature headers and uses the shared secret (new server, not yet bound)', async () => {
    expect((await call({ ...sign(), 'x-node-token': SECRET })).status).toBe(200);
    expect((await call(sign())).status).toBe(401);
    expect(peer.calls).toEqual([]);
  });
});
