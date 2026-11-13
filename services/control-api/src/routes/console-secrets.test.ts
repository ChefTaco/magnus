import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';

const ROLES = ['VIEWER', 'OPERATOR', 'ADMIN'] as const;
type Role = (typeof ROLES)[number];

const fixture = vi.hoisted(() => ({
  role: {} as Record<string, unknown>,
  cron: {} as Record<string, unknown>,
  node: {} as Record<string, unknown>,
  written: [] as Array<{ model: string; data: Record<string, unknown> }>,
  audit: [] as unknown[],
}));

vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId }),
  invalidateUserStatus: () => undefined,
}));
vi.mock('../utils/env.js', async (original) => ({ ...await original<object>(),
  JWT_SECRET: 'console-secrets-jwt-fixture-at-least-32-characters',
  API_SECRET: 'console-secrets-api-fixture-at-least-32-characters',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '',
  getNodeManagerSecret: () => 'console-secrets-node-fixture-at-least-32-characters',
}));
vi.mock('../services/audit-service.js', async (original) => ({ ...await original<object>(),
  logAuditEvent: vi.fn(async (event: unknown) => { fixture.audit.push(event); }) }));
vi.mock('../services/node-credential-store.js', () => ({ nodeCredentialStore: {
  nodeById: async () => ({ id: 'node-new', name: 'node-new', hostname: 'node-new.example.com', ipAddress: '192.0.2.11', port: 4100, status: 'PROVISIONING' }),
  createEnrollmentToken: async () => undefined, credentialsOfNode: async () => [], summaries: async () => new Map(), legacyUse: async () => [],
} }));
vi.mock('../services/managed-cron.js', async (original) => ({ ...await original<object>(), cronMutationMode: async () => 'legacy' }));
vi.mock('../sdk/index.js', () => ({ NodeApiClient: class {
  async syncCronJob() { return undefined; }
  async deleteCronJob() { return undefined; }
} }));
vi.mock('../db/index.js', () => ({ getDb: () => ({
  role: {
    findMany: async () => [{ ...fixture.role, _count: { nodes: 0 } }],
    findUnique: async ({ where }: { where: Record<string, string> }) => (where['name'] ? null : { ...fixture.role, nodes: [], _count: { nodes: 0 } }),
    create: async ({ data }: { data: Record<string, unknown> }) => { fixture.written.push({ model: 'role', data }); return { ...fixture.role, ...data }; },
    update: async ({ data }: { data: Record<string, unknown> }) => { fixture.written.push({ model: 'role', data }); return { ...fixture.role, ...data }; },
  },
  cronJob: {
    findMany: async () => [{ ...fixture.cron, node: { name: 'node-1' } }],
    findUnique: async () => ({ ...fixture.cron, node: fixture.node, executions: [] }),
    create: async ({ data }: { data: Record<string, unknown> }) => ({ ...fixture.cron, ...data }),
    update: async ({ data }: { data: Record<string, unknown> }) => { fixture.written.push({ model: 'cron', data }); return { ...fixture.cron, ...data, node: fixture.node }; },
  },
  node: {
    findUnique: async () => ({ ...fixture.node }),
    create: async ({ data }: { data: Record<string, unknown> }) => ({ ...fixture.node, ...data, id: 'node-new' }),
    update: async ({ data }: { data: Record<string, unknown> }) => ({ ...fixture.node, ...data }),
  },
  managedCronDefinition: { findMany: async () => [], findUnique: async () => null },
  agent: { create: async () => ({}) },
}) }));

const { rolesRouter } = await import('./roles.js');
const { cronRouter } = await import('./cron.js');
const { nodesRouter } = await import('./nodes.js');
const { signUserToken } = await import('../middleware/auth.js');

const app = new Hono().onError(errorHandler)
  .route('/roles', rolesRouter).route('/cron', cronRouter).route('/nodes', nodesRouter);

async function call(role: Role, method: string, path: string, body?: unknown) {
  const token = await signUserToken({ userId: role, email: 'alice@example.com', role });
  const response = await app.request(path, { method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const ENV_VALUE = 'fixture-env-value';
const NOW = new Date('2026-01-01T00:00:00.000Z');

beforeEach(() => {
  fixture.written = [];
  fixture.audit = [];
  fixture.role = {
    id: 'role-1', name: 'web', description: '', status: 'active', libraryFileIds: '[]', skillNames: '[]', aptPackages: '[]', npmPackages: '[]',
    envConfig: JSON.stringify({ B_KEY: ENV_VALUE, A_KEY: `${ENV_VALUE}-2` }), dockerEnabled: false, dockerNonRoot: false, dockerImage: null,
    dockerVolumes: '[]', firewallEnabled: false, firewallMode: 'restrictive', firewallAllowRules: '[]', createdAt: NOW, updatedAt: NOW,
  };
  fixture.node = { id: 'node-1', name: 'node-1', hostname: 'node-1.example.com', ipAddress: '192.0.2.10', port: 4100, status: 'ONLINE', token: 'node-fixture-token',
    lastHeartbeatAt: NOW, metadata: JSON.stringify({ nodeManagerSecretFingerprint: 'fixture-fingerprint', nodeManagerSecretState: 'active' }), tags: '[]' };
  fixture.cron = { id: 'cron-1', nodeId: 'node-1', name: 'backup', description: '', schedule: '0 * * * *', command: '/usr/bin/true', args: '[]', workingDirectory: null,
    environment: JSON.stringify({ CRON_KEY: ENV_VALUE }), timeoutSeconds: 60, status: 'ACTIVE' };
});

describe('role environment values', () => {
  const below = ['VIEWER', 'OPERATOR'] as const;
  const paths = ['/roles', '/roles/role-1'];

  it.each(below.flatMap((role) => paths.map((path) => [role, path] as const)))('%s reading %s gets key names only', async (role, path) => {
    const { status, text } = await call(role, 'GET', path);
    expect(status).toBe(200);
    expect(text).not.toContain(ENV_VALUE);
    expect(text).not.toContain('"envConfig"');
    expect(text).toContain('"envConfigKeys":["A_KEY","B_KEY"]');
  });

  it.each(paths)('ADMIN reading %s gets the values and the keys', async (path) => {
    const { text } = await call('ADMIN', 'GET', path);
    expect(text).toContain(ENV_VALUE);
    expect(text).toContain('"envConfigKeys":["A_KEY","B_KEY"]');
  });

  it('does not echo values to an OPERATOR who creates or edits a role', async () => {
    const created = await call('OPERATOR', 'POST', '/roles', { name: 'new-role', envConfig: { NEW_KEY: ENV_VALUE } });
    expect(created.status).toBe(201);
    expect(created.text).not.toContain(ENV_VALUE);
    expect(created.text).toContain('"envConfigKeys":["NEW_KEY"]');
    const edited = await call('OPERATOR', 'PATCH', '/roles/role-1', { description: 'edited' });
    expect(edited.text).not.toContain(ENV_VALUE);
  });

  it('refuses a VIEWER edit', async () => {
    expect((await call('VIEWER', 'PATCH', '/roles/role-1', { envConfig: {} })).status).toBe(403);
    expect(fixture.written).toEqual([]);
  });

  it.each<[string, Record<string, string>]>([
    ['an empty object', {}],
    ['keys with blank values', { A_KEY: '', B_KEY: '' }],
  ])('keeps values when an OPERATOR round-trips a redacted role as %s', async (_name, envConfig) => {
    expect((await call('OPERATOR', 'PATCH', '/roles/role-1', { envConfig })).status).toBe(200);
    expect(JSON.parse(fixture.written[0]!.data['envConfig'] as string)).toEqual({ A_KEY: `${ENV_VALUE}-2`, B_KEY: ENV_VALUE });
  });

  it('lets an OPERATOR set or add a value, without removing the others', async () => {
    await call('OPERATOR', 'PATCH', '/roles/role-1', { envConfig: { A_KEY: 'changed', C_KEY: 'added' } });
    expect(JSON.parse(fixture.written[0]!.data['envConfig'] as string)).toEqual({ A_KEY: 'changed', B_KEY: ENV_VALUE, C_KEY: 'added' });
  });

  it('keeps replacement semantics for ADMIN, who can see what is removed', async () => {
    await call('ADMIN', 'PATCH', '/roles/role-1', { envConfig: { ONLY: 'value' } });
    expect(JSON.parse(fixture.written[0]!.data['envConfig'] as string)).toEqual({ ONLY: 'value' });
  });
});

describe('cron environment values', () => {
  it.each(['/cron', '/cron/cron-1'])('hides values on %s below ADMIN', async (path) => {
    for (const role of ['VIEWER', 'OPERATOR'] as const) {
      const { status, text } = await call(role, 'GET', path);
      expect(status).toBe(200);
      expect(text).not.toContain(ENV_VALUE);
      expect(text).toContain('"environmentKeys":["CRON_KEY"]');
    }
    expect((await call('ADMIN', 'GET', path)).text).toContain(ENV_VALUE);
  });

  it('does not echo values or the node secrets on an OPERATOR update', async () => {
    const { status, text } = await call('OPERATOR', 'PATCH', '/cron/cron-1', { description: 'edited' });
    expect(status).toBe(200);
    for (const value of [ENV_VALUE, 'node-fixture-token', 'fixture-fingerprint']) expect(text).not.toContain(value);
    expect(text).toContain('nodeManagerSecretState');
  });

  it('keeps values when an OPERATOR round-trips a redacted job', async () => {
    await call('OPERATOR', 'PATCH', '/cron/cron-1', { environment: {} });
    expect(JSON.parse(fixture.written[0]!.data['environment'] as string)).toEqual({ CRON_KEY: ENV_VALUE });
    fixture.written = [];
    await call('OPERATOR', 'PATCH', '/cron/cron-1', { environment: { CRON_KEY: '' } });
    expect(JSON.parse(fixture.written[0]!.data['environment'] as string)).toEqual({ CRON_KEY: ENV_VALUE });
  });

  it('gives ADMIN the fingerprint on the embedded node, but never the token', async () => {
    const { text } = await call('ADMIN', 'PATCH', '/cron/cron-1', { description: 'edited' });
    expect(text).toContain('fixture-fingerprint');
    expect(text).not.toContain('node-fixture-token');
  });
});

describe('node registration token', () => {
  const body = { name: 'node-new', hostname: 'node-new.example.com', ipAddress: '192.0.2.11' };

  it('refuses a VIEWER', async () => {
    expect((await call('VIEWER', 'POST', '/nodes/register', body)).status).toBe(403);
  });

  it.each(['OPERATOR', 'ADMIN'] as const)('shows %s the token with no-store and audits no trace of it', async (role) => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(capture));
    const { status, headers, text } = await call(role, 'POST', '/nodes/register', body);
    spies.forEach((spy) => spy.mockRestore());
    expect(status).toBe(201);
    expect(headers.get('Cache-Control')).toBe('no-store');
    const { data } = JSON.parse(text) as { data: { token: string; enrollmentToken: string; enrollmentTokenExpiresAt: string } };
    expect(data.token).toMatch(/^node-/);
    expect(data.enrollmentToken).toMatch(/^mne_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(data.enrollmentTokenExpiresAt)).toBeGreaterThan(Date.now());
    for (const secret of [data.token, data.enrollmentToken]) {
      expect(JSON.stringify(fixture.audit)).not.toContain(secret);
      expect(logged.join('\n')).not.toContain(secret);
    }
    expect((fixture.audit as Array<{ action: string }>).map((event) => event.action).sort()).toEqual(['node.enrollment_token.issue', 'node.register']);
  });

  it.each(['VIEWER', 'OPERATOR'] as const)('hides secret fingerprints in node metadata from %s', async (role) => {
    const { status, text } = await call(role, 'GET', '/nodes/node-1');
    expect(status).toBe(200);
    expect(text).not.toContain('fixture-fingerprint');
    expect(text).not.toContain('node-fixture-token');
    expect(text).toContain('nodeManagerSecretState');
  });

  it('shows ADMIN the fingerprint in node metadata, never the token', async () => {
    const { text } = await call('ADMIN', 'GET', '/nodes/node-1');
    expect(text).toContain('fixture-fingerprint');
    expect(text).not.toContain('node-fixture-token');
  });
});
