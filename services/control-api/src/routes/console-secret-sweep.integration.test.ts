import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../queue/workers.js', () => ({ enqueueCommand: vi.fn(async () => undefined) }));
// A 429 would hide a leak: this suite reads every route once per role.
vi.mock('../middleware/rate-limit.js', () => ({
  rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getRateLimitHealth: () => ({ status: 'pass', message: 'not limited in this suite', lastErrorAt: null }),
}));

/**
 * Plants a recognizable value in every sensitive column, then reads every
 * browser-facing GET route in docs/console-api.md as each role. A new route, or
 * a new `include: { node: true }`, that carries a planted value fails here
 * without anyone having to remember to write a test for it.
 */
const CANARY = {
  nodeToken: 'canary-node-token-value',
  roleEnvValue: 'canary-role-env-value',
  cronEnvValue: 'canary-cron-env-value',
  commandEnvValue: 'canary-command-env-value',
  observedFingerprint: 'canaryobservedfingerprint',
  hermesKeyFingerprint: 'canaryhermeskeyfingerprint',
  webhookSecret: 'canary-webhook-secret-value',
  webhookHeader: 'canary-webhook-header-value',
  userPassword: 'canary-user-password-value',
} as const;

/** What ADMIN alone may read. Everything else in CANARY reaches nobody. */
const ADMIN_MAY_SEE = new Set<string>([CANARY.roleEnvValue, CANARY.cronEnvValue, CANARY.observedFingerprint, CANARY.hermesKeyFingerprint]);
const ROLES = ['VIEWER', 'OPERATOR', 'ADMIN'] as const;

/**
 * The fixture node's agent address: a local port nothing listens on, so a route that calls the agent
 * gets its unreachable-agent answer at once. An address that drops packets makes that answer depend
 * on the network, and makes each such route wait out its timeouts: 32 seconds for a Codex read.
 */
async function refusingPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe.skipIf(!process.env['TEST_DATABASE_URL'])('secrets in browser-facing responses', () => {
  const prefix = `sweep-${randomUUID()}`;
  const nodeId = prefix;
  const ids: Record<string, string> = {};
  let home: string;
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let app: typeof import('../server.js')['app'];
  let tokens: Record<(typeof ROLES)[number], string>;

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    process.env['DATABASE_URL'] = url;
    home = mkdtempSync(join(tmpdir(), 'magnus-sweep-'));
    vi.stubEnv('MAGNUS_HOME', home);
    vi.stubEnv('JWT_SECRET', 'fixture-secret-sweep-jwt-secret-at-least-32');
    vi.stubEnv('API_SECRET', 'fixture-secret-sweep-api-secret-at-least-32');
    vi.stubEnv('AUDIT_HMAC_SECRET', 'fixture-secret-sweep-audit-at-least-32');
    vi.stubEnv('CREDENTIAL_ROTATION_KEY', 'fixture-secret-sweep-rotation-at-least-32');
    vi.stubEnv('NODE_MANAGER_SECRET', 'fixture-secret-sweep-node-manager-at-least-32');
    db = (await import('../db/index.js')).getDb();
    app = (await import('../server.js')).app;
    const { signUserToken } = await import('../middleware/auth.js');

    tokens = {} as typeof tokens;
    for (const role of ROLES) {
      const id = `${prefix}-${role}`;
      await db.user.create({ data: { id, email: `${id}@example.com`, name: role, role, password: CANARY.userPassword } });
      tokens[role] = await signUserToken({ userId: id, email: `${id}@example.com`, role });
    }
    await db.node.create({ data: {
      id: nodeId, name: prefix, hostname: `${prefix}.example.com`, ipAddress: '127.0.0.1', port: await refusingPort(), os: 'linux', arch: 'x64', token: CANARY.nodeToken,
      status: 'ONLINE', lastHeartbeatAt: new Date(), tags: '[]',
      metadata: JSON.stringify({ nodeManagerSecretFingerprint: CANARY.observedFingerprint, nodeManagerSecretState: 'previous' }),
    } });
    await db.agent.create({ data: { nodeId, version: '1.2.3', status: 'RUNNING', capabilities: '[]' } });
    await db.healthSnapshot.create({ data: { nodeId, cpuUsagePercent: 1, cpuCores: 1, cpuLoadAverage: '[]', memoryTotalBytes: 1n, memoryUsedBytes: 1n, memoryPercent: 1, swapTotalBytes: 0n, swapUsedBytes: 0n, disks: '[]', network: '[]', services: '[]' } });
    await db.remoteCommand.create({ data: { id: `${prefix}-command`, nodeId, command: '/usr/bin/true', args: '[]', environment: JSON.stringify({ KEY: CANARY.commandEnvValue }), idempotencyKey: prefix, createdBy: 'alice', status: 'COMPLETED' } });
    await db.commandResult.create({ data: { commandId: `${prefix}-command`, exitCode: 0, stdout: '', stderr: '', durationMs: 1 } });
    await db.cronJob.create({ data: { id: `${prefix}-cron`, nodeId, name: prefix, schedule: '0 * * * *', command: '/usr/bin/true', args: '[]', environment: JSON.stringify({ CRON_KEY: CANARY.cronEnvValue }), createdBy: 'alice' } });
    await db.role.create({ data: { id: `${prefix}-role`, name: prefix, description: '', envConfig: JSON.stringify({ ROLE_KEY: CANARY.roleEnvValue }), nodes: { connect: { id: nodeId } } } });
    const installation = await db.hermesInstallation.create({ data: { hostname: `${prefix}.example.com`, nodeId, metadata: '{}', rawStatus: '{}', dashboardHost: '127.0.0.1' } });
    const profile = await db.hermesProfile.create({ data: { installationId: installation.id, name: 'default', profileHome: '/opt/hermes', capabilities: '{}', envStatus: '{}', metadata: '{}', apiServerKeyFingerprint: CANARY.hermesKeyFingerprint } });
    await db.webhookEndpoint.create({ data: { id: `${prefix}-webhook`, name: prefix, url: 'https://hooks.example.com/fixture', secret: CANARY.webhookSecret, headers: JSON.stringify({ 'x-fixture': CANARY.webhookHeader }), events: '[]', createdBy: 'alice' } });
    await db.executionRun.create({ data: { id: `${prefix}-run`, type: 'rollout', status: 'completed', totalNodes: 1, createdBy: 'alice', metadata: '{}', targets: { create: [{ nodeId, status: 'completed' }] } } });
    Object.assign(ids, { installation: installation.id, profile: profile.id });
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.webhookEndpoint.deleteMany({ where: { id: `${prefix}-webhook` } });
      await db.executionRun.deleteMany({ where: { id: `${prefix}-run` } });
      await db.hermesInstallation.deleteMany({ where: { nodeId } });
      await db.role.deleteMany({ where: { id: `${prefix}-role` } });
      await db.node.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
      await (await import('../db/index.js')).disconnectDb();
    }
    if (home) rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function browserGets(): string[] {
    const markdown = readFileSync(new URL('../../../../docs/console-api.md', import.meta.url), 'utf8');
    // `exclude` rows stay in the sweep: the ingress denies them, but the API port still answers a user token.
    return [...markdown.matchAll(/^\| GET \| `([^`]+)` \| (?:browser|exclude) \|/gmu)].map((match) => match[1]!);
  }

  /** Concrete values for path parameters, by router. */
  function concrete(path: string): string {
    return path
      .replace(/\/\*$/u, '/fixture')
      .replace('/roles/:roleId', `/roles/${prefix}-role`)
      .replace('/cron/:cronId', `/cron/${prefix}-cron`)
      .replace('/commands/:commandId', `/commands/${prefix}-command`)
      .replace('/webhooks/:id', `/webhooks/${prefix}-webhook`)
      .replace('/rollouts/:id', `/rollouts/${prefix}-run`)
      .replace('/hermes/installations/:id', `/hermes/installations/${ids['installation']}`)
      .replace(/:(?:nodeId|id|token|fileId|name|artifactId|sessionId)\b/gu, nodeId);
  }

  async function read(path: string, role: (typeof ROLES)[number]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await app.request(path, { headers: { Authorization: `Bearer ${tokens[role]}` }, signal: controller.signal });
      if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        void response.body?.cancel();
        return { status: response.status, body: '' };
      }
      return { status: response.status, body: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  it.each(ROLES)('no user-token GET route leaks a secret to %s', async (role) => {
    const leaks: string[] = [];
    const answered: string[] = [];
    for (const path of browserGets()) {
      const { status, body } = await read(concrete(path), role);
      expect(status, path).not.toBe(429);
      if (status === 200) answered.push(path);
      for (const value of Object.values(CANARY)) {
        if (role === 'ADMIN' && ADMIN_MAY_SEE.has(value)) continue;
        if (body.includes(value)) leaks.push(`${path} (${status}) carries ${value}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(answered.length).toBeGreaterThan(role === 'ADMIN' ? 40 : 30);
  }, 120_000);

  it('still gives ADMIN the values an editor needs', async () => {
    expect((await read(`/api/v1/roles/${prefix}-role`, 'ADMIN')).body).toContain(CANARY.roleEnvValue);
    expect((await read(`/api/v1/cron/${prefix}-cron`, 'ADMIN')).body).toContain(CANARY.cronEnvValue);
    expect((await read('/api/v1/ops/readiness', 'ADMIN')).body).toContain(CANARY.observedFingerprint);
    expect((await read('/api/v1/hermes/profiles', 'ADMIN')).body).toContain(CANARY.hermesKeyFingerprint);
  });

  it('shows the state of a credential without its fingerprint below ADMIN', async () => {
    for (const role of ['VIEWER', 'OPERATOR'] as const) {
      const body = JSON.parse((await read('/api/v1/ops/readiness', role)).body) as { data: { nodes: Array<{ id: string; secretFingerprint: Record<string, unknown> }> } };
      expect(body.data).not.toHaveProperty('expectedFingerprints');
      expect(body.data.nodes.find((node) => node.id === nodeId)?.secretFingerprint).toEqual({ match: 'mismatch', state: 'previous' });
    }
  });

  it('registers a node showing its token once, with no-store, and records it nowhere', async () => {
    const denied = await app.request('/api/v1/nodes/register', { method: 'POST', headers: { Authorization: `Bearer ${tokens.VIEWER}`, 'content-type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(403);

    for (const role of ['OPERATOR', 'ADMIN'] as const) {
      const name = `${prefix}-registered-${role}`;
      const response = await app.request('/api/v1/nodes/register', { method: 'POST',
        headers: { Authorization: `Bearer ${tokens[role]}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, hostname: `${name}.example.com`, ipAddress: '192.0.2.21' }) });
      expect(response.status).toBe(201);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const { data } = await response.json() as { data: { nodeId: string; token: string } };
      expect(data.token).toMatch(/^node-/);

      // Shown once: no read path returns it again, to any role.
      for (const reader of ROLES) {
        for (const path of [`/api/v1/nodes/${data.nodeId}`, '/api/v1/nodes?pageSize=100', '/api/v1/ops/readiness', '/api/v1/stats/overview']) {
          expect((await read(path, reader)).body).not.toContain(data.token);
        }
      }

      // Recorded nowhere: not in the audit chain, and not in the stored request log.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const logged = await db.logEntry.findMany({ where: { OR: [{ message: { contains: data.token } }, { metadata: { contains: data.token } }] } });
      expect(logged).toEqual([]);
      const auditDirectories = [join(home, 'audit-logs'), join(home, 'audit')];
      for (const directory of auditDirectories) {
        let files: string[] = [];
        try { files = readdirSync(directory); } catch { continue; }
        for (const file of files) expect(readFileSync(join(directory, file), 'utf8')).not.toContain(data.token);
      }
    }
  }, 60_000);
});
