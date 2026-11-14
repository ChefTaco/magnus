/**
 * Per-node credentials, phase 2 on the agent: NODE_AUTH_MODE=enforce on the agent's own API, the
 * in-process dispatch and the acceptance probe without the shared secret, signed evidence, and
 * decisions signed by the server key.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as wire from './security/node-request-auth.js';
import * as evidence from './security/node-evidence.js';

const SECRET = 'agent-phase2-fixture-shared-secret-32-characters!';
const dir = mkdtempSync(join(tmpdir(), 'agent-node-auth-phase2-'));
vi.stubEnv('AGENT_INSTALL_DIR', dir);
vi.stubEnv('NODE_MANAGER_SECRET', SECRET);
vi.stubEnv('RESULT_SIGNING_SECRET', 'agent-phase2-fixture-result-secret-32-characters!');
vi.stubEnv('CONTROL_API_URL', 'https://magnus.example.com:4000');
vi.stubEnv('HOST_FQDN', 'node-a.example.com');

const peer = vi.hoisted(() => ({ respond: null as null | ((url: string, init: RequestInit) => Response) }));
vi.mock('./tls.js', async original => ({ ...await original<object>(),
  controlApiFetch: async (url: string, init: RequestInit = {}) => peer.respond!(url, init) }));
vi.mock('./upgrade/self-upgrade.js', async original => ({ ...await original<object>(), trialOf: () => null }));

const identity = await import('./security/node-identity.js');
const client = await import('./node-auth.js');
const enrollment = await import('./node-enrollment.js');
const { markLocalDispatch, nodeAuthMiddleware } = await import('./middleware.js');
const signing = await import('./security/evidence-signing.js');
const { probeAgentAcceptance, selfSignedHealthCheckHeaders } = await import('./acceptance.js');
const { logger } = await import('./utils/logger.js');
for (const level of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(() => undefined);

const server = wire.generateSigningKey();
const serverPrivateKey = wire.privateKeyFromPem(server.privateKeyPem);
const otherServer = wire.generateSigningKey();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function bind(nodeId = 'node-a'): Promise<void> {
  const keys = [{ keyId: server.keyId, publicKey: server.publicKey, status: 'active' }];
  peer.respond = (_url, init) => {
    const body = JSON.parse(String(init.body)) as { publicKey: string };
    return json(200, { success: true, data: { nodeId, nodeName: nodeId, keyId: wire.keyIdOfSpki(body.publicKey), serverKeys: keys, mode: 'compat' } });
  };
  expect(await enrollment.attemptLegacyUpgrade()).toEqual({ state: 'bound', nodeId });
}

/** The agent's API as server.ts mounts it: node authentication on every /api/v1/* route. */
function agentApp(): Hono {
  const app = new Hono();
  app.use('/api/v1/*', nodeAuthMiddleware);
  app.get('/api/v1/health/check', c => c.json({ success: true, data: { service: 'magnus-agent', status: 'healthy', version: '9.9.9',
    heartbeat: { running: true, lastAcceptedAt: new Date().toISOString(), consecutiveFailures: 0 } } }));
  for (const path of ['/api/v1/files', '/api/v1/commands/execute', '/api/v1/cron', '/api/v1/users']) {
    app.get(path, c => c.json({ success: true }));
    app.post(path, c => c.json({ success: true }));
  }
  return app;
}

function serverSigned(method: string, path: string, body = '', nodeId = 'node-a', key = { keyId: server.keyId, privateKey: serverPrivateKey }) {
  return wire.signNodeRequest({ privateKey: key.privateKey, keyId: key.keyId, nodeId, audience: wire.nodeAudience(nodeId), method, pathWithQuery: path, body });
}

beforeEach(() => {
  rmSync(join(dir, 'identity'), { recursive: true, force: true });
  identity.resetNodeIdentityCache(); client.resetNodeAuthClientState(); enrollment.resetNodeEnrollmentState();
  peer.respond = null;
  vi.stubEnv('NODE_AUTH_MODE', '');
});
afterEach(() => { vi.stubEnv('NODE_AUTH_MODE', ''); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('agent-side enforce', () => {
  it('stays compat by default: a bound node still accepts the shared secret', async () => {
    await bind();
    expect(client.nodeAuthMode()).toBe('compat');
    expect((await agentApp().request('/api/v1/files', { headers: { 'x-node-token': SECRET } })).status).toBe(200);
  });

  it('refuses a request carrying only the shared secret on every /api/v1 route once bound', async () => {
    await bind();
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    expect(client.agentEnforcesNodeAuth()).toBe(true);
    const app = agentApp();
    for (const [method, path] of [['GET', '/api/v1/health/check'], ['GET', '/api/v1/files'], ['POST', '/api/v1/commands/execute'],
      ['POST', '/api/v1/cron'], ['POST', '/api/v1/users']] as const) {
      const response = await app.request(path, { method, headers: { 'x-node-token': SECRET, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'NODE_SIGNATURE_REQUIRED' } });
    }
  });

  it('still accepts the server it pins, for this node only, once', async () => {
    await bind();
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    const app = agentApp();
    const headers = serverSigned('POST', '/api/v1/commands/execute', '{"a":1}');
    expect((await app.request('/api/v1/commands/execute', { method: 'POST', headers, body: '{"a":1}' })).status).toBe(200);
    // Replayed, made for another node, or signed by a server key this agent does not pin: refused.
    expect((await app.request('/api/v1/commands/execute', { method: 'POST', headers, body: '{"a":1}' })).status).toBe(401);
    expect((await app.request('/api/v1/files', { headers: serverSigned('GET', '/api/v1/files', '', 'node-b') })).status).toBe(401);
    const stranger = serverSigned('GET', '/api/v1/files', '', 'node-a', { keyId: otherServer.keyId, privateKey: wire.privateKeyFromPem(otherServer.privateKeyPem) });
    peer.respond = () => json(200, { success: true, data: { keys: [{ keyId: server.keyId, publicKey: server.publicKey, status: 'active' }] } });
    expect((await app.request('/api/v1/files', { headers: { ...stranger, 'x-node-token': SECRET } })).status).toBe(401);
  });

  it('stays compat while the node has no key, even when enforce is requested', async () => {
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    expect(client.agentEnforcesNodeAuth()).toBe(false);
    expect(client.effectiveNodeAuthMode()).toBe('compat');
    expect((await agentApp().request('/api/v1/files', { headers: { 'x-node-token': SECRET } })).status).toBe(200);
  });

  it('lets the in-process dispatch through without the shared secret, and nothing from outside as local', async () => {
    await bind();
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    const app = agentApp();
    // The managed HTTP dispatch hands its own Request object to the app: no credential needed.
    const local = markLocalDispatch(new Request('http://localhost/api/v1/commands/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect((await app.request(local)).status).toBe(200);
    // The same request built anywhere else (or arriving from the network) is not local.
    expect((await app.request(new Request('http://localhost/api/v1/commands/execute', { method: 'POST', body: '{}' }))).status).toBe(401);
    expect((await app.request('/api/v1/commands/execute', { method: 'POST', body: '{}', headers: { 'x-magnus-local-dispatch': '1' } })).status).toBe(401);
  });

  it('accepts the acceptance probe signed with the node key, on the health check only', async () => {
    await bind();
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    const app = agentApp();
    const headers = selfSignedHealthCheckHeaders();
    expect(Object.keys(headers)).toContain('x-magnus-signature');
    expect((await app.request('/api/v1/health/check', { headers })).status).toBe(200);
    expect((await app.request('/api/v1/health/check', { headers })).status).toBe(401);
    const other = wire.signNodeRequest({ privateKey: identity.boundNodeIdentity()!.privateKey, keyId: identity.boundNodeIdentity()!.keyId, nodeId: 'node-a',
      audience: client.selfAudience('node-a'), method: 'GET', pathWithQuery: '/api/v1/files', body: '' });
    expect((await app.request('/api/v1/files', { headers: other })).status).toBe(401);
    // A self-signature made for the server's audience is not a self-signature.
    const wrongAudience = wire.signNodeRequest({ privateKey: identity.boundNodeIdentity()!.privateKey, keyId: identity.boundNodeIdentity()!.keyId, nodeId: 'node-a',
      audience: wire.nodeAudience('node-a'), method: 'GET', pathWithQuery: '/api/v1/health/check', body: '' });
    expect((await app.request('/api/v1/health/check', { headers: wrongAudience })).status).toBe(401);
  });

  it('passes the real acceptance probe against an agent in enforce mode', async () => {
    await bind();
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    const app = agentApp();
    const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => app.request(new URL(String(input)).pathname, init)) as typeof globalThis.fetch;
    const options = { selfUrl: 'https://node-a.example.com:4100/', credential: SECRET, expectedVersion: '9.9.9', waitSeconds: 0 };
    expect(await probeAgentAcceptance(options, { fetch, selfSign: () => selfSignedHealthCheckHeaders() })).toMatchObject({ ok: true });
    // Without its key the probe has only the shared secret, which enforce refuses.
    expect(await probeAgentAcceptance(options, { fetch })).toEqual({ ok: false, reason: 'PROBE_FAILED' });
  });
});

describe('signed evidence on the agent', () => {
  const result = { commandId: 'cmd-1', exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, truncated: false, signature: 'a'.repeat(64) };

  it('signs evidence only once the server says it verifies it, and stops after a server downgrade', async () => {
    await bind();
    expect(signing.nodeEvidenceFields('fence-proof', '{"x":1}')).toEqual({});
    expect(signing.withResultEvidence(result)).toEqual(result);
    enrollment.onHeartbeatAcknowledged({ supported: true, mode: 'compat', method: 'signature', evidence: 1 });
    identity.resetNodeIdentityCache();
    expect(signing.signsNodeEvidence()).toBe(true);
    const bound = identity.boundNodeIdentity()!;
    const signed = signing.withResultEvidence(result);
    expect(signed.signature).toBe(result.signature);
    expect(evidence.verifyNodeEvidence('command-result', { signature: signed.nodeSignature!, publicKey: bound.publicKey, expectedNodeId: 'node-a',
      payload: evidence.commandResultSigningPayload(result) })).toEqual({ ok: true });
    // A phase-1 server acknowledges without `evidence`: back to HMAC only, so it never sees an unknown field.
    enrollment.onHeartbeatAcknowledged({ supported: true, mode: 'compat', method: 'signature' });
    identity.resetNodeIdentityCache();
    expect(signing.withResultEvidence(result)).toEqual(result);
    // A server without node credentials at all.
    enrollment.onHeartbeatAcknowledged({ supported: true, mode: 'compat', method: 'signature', evidence: 1 });
    enrollment.onHeartbeatAcknowledged(undefined);
    identity.resetNodeIdentityCache();
    expect(signing.signsNodeEvidence()).toBe(false);
  });

  it('accepts a decision signed by the pinned server key for this node only', async () => {
    await bind();
    const payload = evidence.commandReconciliationSigningPayload({ nodeFqdn: 'node-a.example.com', commandId: 'cmd-1', requestSha256: 'a'.repeat(64),
      disposition: 'no_effect_verified', evidenceSha256: 'b'.repeat(64), approvalRef: 'user:admin', decisionId: 'd-1', expiresAt: Date.now() + 60_000 });
    const forUs = evidence.signServerAuthorization(serverPrivateKey, server.keyId, 'node-a', 'command-reconciliation', payload);
    const forOther = evidence.signServerAuthorization(serverPrivateKey, server.keyId, 'node-b', 'command-reconciliation', payload);
    const byStranger = evidence.signServerAuthorization(wire.privateKeyFromPem(otherServer.privateKeyPem), otherServer.keyId, 'node-a', 'command-reconciliation', payload);
    const hmacOk = () => true;
    const hmacBad = () => false;
    expect(signing.verifyServerDecision('command-reconciliation', payload, forUs, hmacBad)).toBe(true);
    expect(signing.verifyServerDecision('command-reconciliation', payload, forOther, hmacOk)).toBe(false);
    expect(signing.verifyServerDecision('command-reconciliation', payload.replace('no_effect', 'effects'), forUs, hmacOk)).toBe(false);
    expect(signing.verifyServerDecision('cron-enrollment-stage', payload, forUs, hmacOk)).toBe(false);
    expect(signing.verifyServerDecision('command-reconciliation', payload, { ...forUs, sig: 'bad' }, hmacOk)).toBe(false);
    // A key this agent does not pin, or none: the HMAC decides outside enforce mode, and nothing does in it.
    expect(signing.verifyServerDecision('command-reconciliation', payload, byStranger, hmacOk)).toBe(true);
    expect(signing.verifyServerDecision('command-reconciliation', payload, undefined, hmacOk)).toBe(true);
    expect(signing.verifyServerDecision('command-reconciliation', payload, undefined, hmacBad)).toBe(false);
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    expect(signing.verifyServerDecision('command-reconciliation', payload, undefined, hmacOk)).toBe(false);
    expect(signing.verifyServerDecision('command-reconciliation', payload, byStranger, hmacOk)).toBe(false);
    expect(signing.verifyServerDecision('command-reconciliation', payload, forUs, hmacBad)).toBe(true);
  });
});

describe('one signed request is verified once, wherever the middleware is mounted', () => {
  /** As server.ts mounts managed HTTP: authenticated by v1's `*` and again by the route's own mount. */
  function managedHttpMount(): Hono {
    const v1 = new Hono();
    v1.use('*', nodeAuthMiddleware);
    const app = new Hono();
    app.route('/api/v1', v1);
    app.use('/api/v1/commands/managed-http', nodeAuthMiddleware);
    app.post('/api/v1/commands/managed-http', c => c.json({ success: true }));
    return app;
  }
  const body = '{"commandId":"fixture"}';
  const post = (app: Hono, headers: Record<string, string>) => app.request('http://localhost/api/v1/commands/managed-http',
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  it('accepts a signed managed request through both mounts (2.10.0 and 2.10.1 refused it as NODE_AUTH_REPLAY), and refuses its replay', async () => {
    await bind();
    const app = managedHttpMount();
    const headers = serverSigned('POST', '/api/v1/commands/managed-http', body);
    const first = await post(app, headers);
    expect(first.status).toBe(200);
    const replay = await post(app, headers);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('NODE_AUTH_REPLAY');
  });

  it('still refuses a bad signature and, in enforce mode, the shared secret on that route', async () => {
    await bind();
    const app = managedHttpMount();
    const headers = serverSigned('POST', '/api/v1/commands/managed-http', '{"commandId":"other"}');
    expect((await post(app, headers)).status).toBe(401);
    expect((await post(app, { 'x-node-token': SECRET })).status).toBe(200);
    vi.stubEnv('NODE_AUTH_MODE', 'enforce');
    expect((await post(app, { 'x-node-token': SECRET })).status).toBe(401);
  });
});
