import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables } from '../types/index.js';

// Server-key rotation routes (docs/NODE_CREDENTIALS.md, "Rotating the server key"): ADMIN only, and promote waits for the agents' pins.
const MACHINE = vi.hoisted(() => ({
  pluginRead: 'fixture-plugin-read-credential', pluginOperator: 'fixture-plugin-operator-credential', fleetCheck: 'fixture-fleet-check-credential',
  sharedResource: 'fixture-shared-resource-credential', collector: 'fixture-collector-credential',
}));
vi.mock('../utils/env.js', async original => {
  const { createHash: hash } = await import('node:crypto');
  const digest = (value: string) => hash('sha256').update(value).digest('hex');
  return { ...await original<object>(), JWT_SECRET: 'fixture-node-keys-jwt-secret-at-least-32-chars', API_SECRET: 'fixture-node-keys-api-secret-at-least-32',
    IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '', NODE_MANAGER_SECRET: 'fixture-node-manager-secret-at-least-32-characters',
    MAGNUS_PLUGIN_API_ENABLED: true, MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: JSON.stringify({ hermes: digest(MACHINE.pluginRead) }),
    MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: digest(MACHINE.pluginOperator), MAGNUS_FLEET_CHECK_TOKEN_SHA256: digest(MACHINE.fleetCheck),
    MAGNUS_SHARED_RESOURCE_TOKEN_SHA256: digest(MACHINE.sharedResource), MAGNUS_COLLECTOR_TOKEN_SHA256: digest(MACHINE.collector) };
});
vi.mock('../services/credential-rotation-service.js', async original => ({ ...await original<object>(),
  verifyWithRotation: (_name: string, active: string, token: string) => token === active }));
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId.split('-').pop()!.toUpperCase() }),
  invalidateUserStatus: () => undefined,
}));
const fixture = vi.hoisted(() => ({ audit: [] as Array<{ action: string; actorId: string; targetId: string; details?: Record<string, unknown> }>,
  notifications: [] as Array<Record<string, unknown>>, redis: new Map<string, string>() }));
vi.mock('../services/audit-service.js', async original => ({ ...await original<object>(),
  logAuditEvent: async (event: { action: string; actorId: string; targetId: string }) => { fixture.audit.push(event); } }));
vi.mock('../services/notification-service.js', () => ({ createNotification: async (input: Record<string, unknown>) => { fixture.notifications.push(input); return 'n'; } }));
vi.mock('../queue/redis.js', () => ({
  getRedis: () => ({
    set: async (key: string, value: string) => (fixture.redis.has(key) ? null : (fixture.redis.set(key, value), 'OK')),
    eval: async (_script: string, _keys: number, key: string, token: string) => (fixture.redis.get(key) === token ? Number(fixture.redis.delete(key)) : 0),
  }),
}));
vi.mock('../services/node-credential-store.js', async () => {
  const { createFakeCredentialStore } = await import('../services/node-credential-test-fixture.js');
  const fake = createFakeCredentialStore();
  return { nodeCredentialStore: fake.store, fakeCredentialStore: fake };
});


const { fakeCredentialStore: fake } = await import('../services/node-credential-store.js') as unknown as
  { fakeCredentialStore: ReturnType<typeof import('../services/node-credential-test-fixture.js').createFakeCredentialStore> };
const { fixtureAgentKey, fixtureNode } = await import('../services/node-credential-test-fixture.js');
const { errorHandler } = await import('../middleware/error-handler.js');
const { signUserToken } = await import('../middleware/auth.js');
const { nodeCredentialsRouter } = await import('./node-credentials.js');
const { allowServerKeyCreation, resetServerSigningKeyCache, serverSigningKey } = await import('../services/node-server-key.js');
const { noteAgentServerKeyPins, resetAgentAuthState } = await import('../services/node-agent-auth.js');

const app = new Hono<AppVariables>().onError(errorHandler).route('/api/v1/node-credentials', nodeCredentialsRouter);
const dir = mkdtempSync(join(tmpdir(), 'magnus-server-key-routes-'));
let sequence = 0;

async function send(path: string, role: 'ADMIN' | 'OPERATOR' | null, body: unknown = {}, method: 'GET' | 'POST' = 'POST') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (role) headers['Authorization'] = `Bearer ${await signUserToken({ userId: `fixture-${role.toLowerCase()}`, email: 'alice@example.com', role })}`;
  const response = await app.request(`/api/v1/node-credentials${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, json: await response.json() as { data: Record<string, unknown> & { agents?: unknown }; error?: { code: string } } };
}

beforeEach(() => {
  fake.reset(); fixture.audit = [];
  vi.stubEnv('NODE_AUTH_SERVER_KEY_PATH', join(dir, `key-${++sequence}`, 'server-signing-key.json'));
  resetServerSigningKeyCache(); allowServerKeyCreation(); resetAgentAuthState();
  for (const id of ['node-a', 'node-b']) {
    fake.state.nodes.push(fixtureNode(id, `${id}.example.com`, '192.0.2.10'));
    const key = fixtureAgentKey();
    void fake.store.bindFirst({ nodeId: id, keyId: key.keyId, publicKey: key.publicKey, boundFqdn: `${id}.example.com` }, 'LEGACY_UPGRADE');
  }
});
afterEach(() => { vi.unstubAllEnvs(); resetServerSigningKeyCache(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('server-key rotation routes', () => {
  it('are ADMIN only', async () => {
    expect((await send('/server-key/stage', 'OPERATOR')).status).toBe(403);
    expect((await send('/server-key/stage', null)).status).toBe(401);
  });

  it('stage, wait for every keyed agent to pin the staged key, promote, then retire; each step audited and shown in the summary', async () => {
    const active = serverSigningKey().keyId;
    const staged = await send('/server-key/stage', 'ADMIN');
    expect(staged.status).toBe(200);
    const next = (staged.json.data['next'] as { keyId: string }).keyId;
    // Only one agent has said it pins the staged key: promote waits, unless forced.
    noteAgentServerKeyPins('node-a', [active, next]);
    noteAgentServerKeyPins('node-b', [active]);
    const early = await send('/server-key/promote', 'ADMIN', {});
    expect(early.status).toBe(409);
    expect(early.json.error?.code).toBe('SERVER_KEY_NOT_PINNED');
    const summary = await send('/summary', 'ADMIN', undefined, 'GET');
    expect(summary.json.data['serverKeyRotation']).toMatchObject({ active: { keyId: active }, next: { keyId: next },
      agents: { keyedNodes: 2, reporting: 2, pinningActive: 2, pinningNext: 1 } });
    noteAgentServerKeyPins('node-b', [active, next]);
    const promoted = await send('/server-key/promote', 'ADMIN', { graceHours: 1 });
    expect(promoted.status).toBe(200);
    expect(promoted.json.data).toMatchObject({ active: { keyId: next }, previous: { keyId: active, inGrace: true } });
    expect(serverSigningKey().keyId).toBe(next);
    const early_retire = await send('/server-key/retire', 'ADMIN', {});
    expect(early_retire.json.error?.code).toBe('SERVER_KEY_GRACE_PENDING');
    const retired = await send('/server-key/retire', 'ADMIN', { force: true });
    expect(retired.json.data).toMatchObject({ previous: null, retired: [{ keyId: active }] });
    expect(fixture.audit.map(event => event.action)).toEqual(['node-auth.server-key.stage', 'node-auth.server-key.promote', 'node-auth.server-key.retire']);
    expect(JSON.stringify(fixture.audit)).not.toContain('PRIVATE');
  });

  it('promotes with force while agents have not reported, and refuses steps out of order', async () => {
    expect((await send('/server-key/promote', 'ADMIN', { force: true })).json.error?.code).toBe('SERVER_KEY_NO_NEXT');
    await send('/server-key/stage', 'ADMIN');
    expect((await send('/server-key/stage', 'ADMIN')).json.error?.code).toBe('SERVER_KEY_NEXT_EXISTS');
    expect((await send('/server-key/promote', 'ADMIN', { force: true })).status).toBe(200);
    expect((await send('/server-key/promote', 'ADMIN', { graceHours: 0 })).status).toBe(400);
  });
});
