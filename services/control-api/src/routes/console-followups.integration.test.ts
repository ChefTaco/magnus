import { randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONTROL_API_NODE_ID } from '../utils/sentinel-nodes.js';

vi.mock('../queue/workers.js', () => ({ enqueueCommand: vi.fn(async () => undefined) }));
vi.mock('../middleware/rate-limit.js', () => ({
  rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
  ardentRateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getRateLimitHealth: () => ({ status: 'pass', message: 'not limited in this suite', lastErrorAt: null }),
}));

const ROLES = ['VIEWER', 'OPERATOR', 'ADMIN'] as const;
type Role = (typeof ROLES)[number];
const RAW_DATABASE_TEXT = /prisma|invocation|unique constraint|\.ts:|\.js:|remediation_rules|magnus_ideas/iu;

/** Real responses from real rows for the fixes that only a database can prove. */
describe.skipIf(!process.env['TEST_DATABASE_URL'])('console API follow-ups', () => {
  const prefix = `followup-${randomUUID()}`;
  const nodeId = prefix;
  const bareNodeId = `${prefix}-bare`;
  let home: string;
  let createdSentinel = false;
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let app: typeof import('../server.js')['app'];
  let tokens: Record<Role, string>;

  async function call(role: Role, method: string, path: string, body?: unknown) {
    const response = await app.request(`/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${tokens[role]}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* a non-JSON body stays in text */ }
    return { status: response.status, text, json };
  }

  const snapshot = (id: string, timestamp: Date, disks: unknown[]) => ({
    nodeId: id, timestamp, cpuUsagePercent: 12.5, cpuCores: 4, cpuLoadAverage: '[]', memoryTotalBytes: 8_000_000_000n, memoryUsedBytes: 4_000_000_000n,
    memoryPercent: 50, swapTotalBytes: 0n, swapUsedBytes: 0n, disks: JSON.stringify(disks), network: '[]', services: '[]',
  });

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    process.env['DATABASE_URL'] = url;
    home = mkdtempSync(join(tmpdir(), 'magnus-followups-'));
    vi.stubEnv('MAGNUS_HOME', home);
    vi.stubEnv('JWT_SECRET', 'fixture-followups-jwt-secret-at-least-32');
    vi.stubEnv('API_SECRET', 'fixture-followups-api-secret-at-least-32');
    vi.stubEnv('AUDIT_HMAC_SECRET', 'fixture-followups-audit-at-least-32');
    vi.stubEnv('CREDENTIAL_ROTATION_KEY', 'fixture-followups-rotation-at-least-32');
    vi.stubEnv('NODE_MANAGER_SECRET', 'fixture-followups-node-manager-at-least-32');
    vi.stubEnv('WEBHOOK_ENCRYPTION_KEY', 'fixture-followups-webhook-key-at-least-32');
    db = (await import('../db/index.js')).getDb();
    app = (await import('../server.js')).app;
    const { signUserToken } = await import('../middleware/auth.js');

    tokens = {} as typeof tokens;
    for (const role of ROLES) {
      const id = `${prefix}-${role}`;
      await db.user.create({ data: { id, email: `${id}@example.com`, name: role, role, password: 'fixture-password-hash' } });
      tokens[role] = await signUserToken({ userId: id, email: `${id}@example.com`, role });
    }

    if (!(await db.node.findUnique({ where: { id: CONTROL_API_NODE_ID } }))) {
      createdSentinel = true;
      await db.node.create({ data: { id: CONTROL_API_NODE_ID, name: 'Control API', hostname: 'control-api', ipAddress: '127.0.0.1', os: 'internal', arch: 'internal', token: `sentinel-${prefix}`, status: 'ONLINE', metadata: '{"sentinel":true}' } });
    }
    // Rapid growth, so a sentinel the at-risk scan looked at would be listed.
    const day = 86_400_000;
    await db.healthSnapshot.createMany({ data: [0, 1, 2].map((age) => snapshot(CONTROL_API_NODE_ID, new Date(Date.now() - age * day), [{ mountPoint: '/', usedBytes: 900 - age * 100, totalBytes: 1000 }])) });

    const now = new Date();
    await db.node.create({ data: { id: nodeId, name: prefix, hostname: `${prefix}.example.com`, ipAddress: '192.0.2.30', os: 'linux', arch: 'x64', token: `node-${randomUUID()}`, status: 'ONLINE', lastHeartbeatAt: now, tags: '[]', metadata: '{}' } });
    await db.node.create({ data: { id: bareNodeId, name: bareNodeId, hostname: `${prefix}-bare.example.com`, ipAddress: '192.0.2.31', os: 'linux', arch: 'x64', token: `node-${randomUUID()}`, status: 'PROVISIONING', tags: '[]', metadata: '{}' } });
    // A burst of heartbeats reporting a flat disk.
    const mounts = Array.from({ length: 40 }, (_, index) => ({ mountPoint: `/srv/volume-${index}`, usedBytes: 100_000_000_000 + index * 37_000_000_019, totalBytes: 2_000_000_000_000 }));
    await db.healthSnapshot.createMany({ data: Array.from({ length: 12 }, (_, index) => snapshot(nodeId, new Date(now.getTime() - 60_000 + index * 7 + (index % 3)), mounts)) });
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.aiConversation.deleteMany({ where: { title: { startsWith: prefix } } });
      await db.remediationRule.deleteMany({ where: { name: { startsWith: prefix } } });
      await db.node.deleteMany({ where: { id: { in: [nodeId, bareNodeId] } } });
      if (createdSentinel) await db.node.deleteMany({ where: { id: CONTROL_API_NODE_ID } });
      else await db.healthSnapshot.deleteMany({ where: { nodeId: CONTROL_API_NODE_ID } });
      await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
      await (await import('../db/index.js')).disconnectDb();
    }
    if (home) rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('sentinel records', () => {
    const excluded = (body: string) => expect(body).not.toMatch(/__control-api__|__dashboard__/u);

    it('stay out of the topology map', async () => {
      const { status, text, json } = await call('OPERATOR', 'POST', '/topology/scan', { probeTimeoutMs: 50 });
      expect(status).toBe(200);
      expect(json.data.nodes.map((node: { id: string }) => node.id)).toContain(nodeId);
      excluded(text);
      excluded((await call('VIEWER', 'GET', '/topology')).text);
    });

    it.each(['/ops/readiness', '/predictions', '/health/forecast/at-risk?days=3650'])('stay out of %s', async (path) => {
      const { status, text } = await call('ADMIN', 'GET', path);
      expect(status).toBe(200);
      excluded(text);
    });

    it('stay out of the assistant fleet tools', async () => {
      const { executeAiTool } = await import('../services/ai-tools.js');
      for (const name of ['getFleetStatus', 'getWazuhFleetStatus', 'getSystemUpdateFleetStatus']) {
        const result = await executeAiTool({ name, arguments: {} });
        expect(result.success, name).toBe(true);
        expect(JSON.stringify(result.result), name).toContain(prefix);
        excluded(JSON.stringify(result.result));
      }
      const search = await executeAiTool({ name: 'searchNodes', arguments: { query: 'control' } });
      excluded(JSON.stringify(search.result));
    });
  });

  it('answers a forecast for a flat disk reported in a burst', async () => {
    const { status, json } = await call('VIEWER', 'GET', `/health/${nodeId}/forecast`);
    expect(status).toBe(200);
    expect(json.data.forecasts).toHaveLength(40);
    expect(json.data.forecasts.every((forecast: { daysUntilFull: unknown }) => forecast.daysUntilFull === null)).toBe(true);
  });

  describe('latest health in the node list', () => {
    it('carries the newest snapshot, as plain numbers', async () => {
      const { status, json } = await call('VIEWER', 'GET', '/nodes?pageSize=100');
      expect(status).toBe(200);
      const row = json.data.find((node: { id: string }) => node.id === nodeId);
      expect(row.health).toMatchObject({ cpuUsagePercent: 12.5, cpuCores: 4, memoryTotalBytes: 8_000_000_000, memoryPercent: 50, swapUsedBytes: 0 });
      expect(JSON.parse(row.health.disks)).toHaveLength(40);
      const latest = await db.healthSnapshot.findFirst({ where: { nodeId }, orderBy: { timestamp: 'desc' }, select: { timestamp: true } });
      expect(row.health.timestamp).toBe(latest!.timestamp.toISOString());
      expect(row.health).not.toHaveProperty('nodeId');
    });

    it('is null, not an error, for a node with no snapshot', async () => {
      const { status, json } = await call('VIEWER', 'GET', '/nodes?pageSize=100');
      expect(status).toBe(200);
      expect(json.data.find((node: { id: string }) => node.id === bareNodeId).health).toBeNull();
      // The per-node route keeps its documented answer.
      expect((await call('VIEWER', 'GET', `/nodes/${bareNodeId}/health`)).status).toBe(404);
    });

    it('survives an empty page', async () => {
      const { status, json } = await call('VIEWER', 'GET', `/nodes?query=${randomUUID()}`);
      expect(status).toBe(200);
      expect(json.data).toEqual([]);
    });
  });

  describe('database errors', () => {
    const rule = (name: string) => ({ name, agentDefinitionId: 'diagnostics.v1' });

    it('answers a duplicate rule name with a clean 409', async () => {
      const name = `${prefix}-duplicate`;
      expect((await call('ADMIN', 'POST', '/remediation/rules', rule(name))).status).toBe(201);
      const { status, text, json } = await call('ADMIN', 'POST', '/remediation/rules', rule(name));
      expect(status).toBe(409);
      expect(json).toEqual({ success: false, error: { code: 'CONFLICT', message: 'A remediation rule with this name already exists.' } });
      expect(text).not.toMatch(RAW_DATABASE_TEXT);
    });

    it('answers a rename onto a taken name the same way', async () => {
      const taken = `${prefix}-taken`;
      await call('ADMIN', 'POST', '/remediation/rules', rule(taken));
      const other = await call('ADMIN', 'POST', '/remediation/rules', rule(`${prefix}-other`));
      const { status, json } = await call('ADMIN', 'PATCH', `/remediation/rules/${other.json.data.id}`, { name: taken });
      expect(status).toBe(409);
      expect(json.error.message).toBe('A remediation rule with this name already exists.');
    });

    it('answers a missing record with a clean 404', async () => {
      const { status, text } = await call('ADMIN', 'DELETE', `/remediation/rules/${randomUUID()}`);
      expect(status).toBe(404);
      expect(text).not.toMatch(RAW_DATABASE_TEXT);
    });

    it('answers a value the database rejects with a clean 400', async () => {
      const { status, text, json } = await call('VIEWER', 'GET', '/nodes?status=not-a-status');
      expect(status).toBe(400);
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(text).not.toMatch(RAW_DATABASE_TEXT);
    });
  });

  describe('storage evidence', () => {
    it('explains a failure without the address, the URL or the node secret', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 192.0.2.30:4100'), { code: 'ECONNREFUSED' }),
      }));
      const { status, text, json } = await call('OPERATOR', 'GET', `/ops/storage-evidence/${nodeId}?mount=/srv`);
      const [target] = fetchMock.mock.calls[0]!;
      fetchMock.mockRestore();
      expect(status).toBe(502);
      expect(json.error.code).toBe('NODE_UNREACHABLE');
      expect(json.error.message).toContain(prefix);
      expect(json.error.message).toContain('the connection was refused (ECONNREFUSED)');
      expect(text).not.toMatch(/fetch failed|192\.0\.2\.30|4100|http|fixture-followups-node-manager/u);
      // A server without TLS reaches its agents over HTTP, like every other agent call.
      expect(String(target)).toMatch(/^http:\/\/192\.0\.2\.30:4100\/api\/v1\/storage-evidence\?/u);
    });

    it('explains an answer that is not a report', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>not found</html>', { status: 404 }));
      const { status, json } = await call('OPERATOR', 'GET', `/ops/storage-evidence/${nodeId}?mount=/srv`);
      fetchMock.mockRestore();
      expect(status).toBe(502);
      expect(json.error).toMatchObject({ code: 'NODE_BAD_RESPONSE' });
      expect(json.error.message).toContain('HTTP 404');
    });

    it('still relays the agent answer', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: false, error: 'mount not found' }, { status: 404 }));
      const { status, json } = await call('OPERATOR', 'GET', `/ops/storage-evidence/${nodeId}?mount=/srv`);
      fetchMock.mockRestore();
      expect(status).toBe(502);
      expect(json).toEqual({ success: false, error: 'mount not found' });
    });
  });

  describe('assistant conversations', () => {
    const conversationOf = (role: Role, suffix = role) => `${prefix}-conversation-${suffix}`;

    beforeAll(async () => {
      for (const role of ROLES) {
        await db.aiConversation.create({ data: {
          id: conversationOf(role), title: `${prefix} ${role}`, type: 'chat', createdBy: `${prefix}-${role}@example.com`,
          messages: { create: [{ id: `${conversationOf(role)}-message`, role: 'assistant', content: `private to ${role}` }] },
        } });
      }
      await db.aiConversation.create({ data: { id: conversationOf('ADMIN', 'heartbeat'), title: `${prefix} heartbeat`, type: 'heartbeat', createdBy: 'system', messages: { create: [{ role: 'assistant', content: 'fleet heartbeat' }] } } });
      await db.aiConversation.create({ data: { id: conversationOf('ADMIN', 'analysis'), title: `${prefix} analysis`, type: 'analysis', createdBy: 'system' } });
    });

    const listed = async (role: Role, query = '') => {
      const { status, json } = await call(role, 'GET', `/assistant/conversations?pageSize=50&status=all${query}`);
      expect(status).toBe(200);
      return (json.data.conversations as Array<{ id: string }>).map((conversation) => conversation.id).filter((id) => id.startsWith(prefix));
    };

    it.each(ROLES)('lists only the conversations of %s and the shared heartbeat', async (role) => {
      expect((await listed(role)).sort()).toEqual([conversationOf(role), conversationOf('ADMIN', 'heartbeat')].sort());
    });

    it('still lets any role find the heartbeat for the anomaly page', async () => {
      expect(await listed('VIEWER', '&type=heartbeat')).toEqual([conversationOf('ADMIN', 'heartbeat')]);
    });

    it('matches a caller known by user ID as well as email', async () => {
      const id = conversationOf('VIEWER', 'by-id');
      await db.aiConversation.create({ data: { id, title: `${prefix} by id`, type: 'chat', createdBy: `${prefix}-VIEWER` } });
      expect(await listed('VIEWER')).toContain(id);
    });

    it.each([
      ['GET', ''], ['GET', '/export'], ['GET', '/scratchpad'], ['POST', '/read'],
    ])('hides %s of another person, for any role', async (method, suffix) => {
      for (const role of ['VIEWER', 'ADMIN'] as const) {
        const other = role === 'ADMIN' ? 'VIEWER' : 'ADMIN';
        const { status, text } = await call(role, method, `/assistant/conversations/${conversationOf(other)}${suffix}`);
        expect(status).toBe(404);
        expect(text).not.toContain('private to');
      }
    });

    it.each([
      ['POST', '/archive'], ['DELETE', ''], ['POST', '/share'], ['POST', '/fork'], ['DELETE', '/scratchpad'],
    ])('refuses %s of another person, even for ADMIN', async (method, suffix) => {
      const { status } = await call('ADMIN', method, `/assistant/conversations/${conversationOf('OPERATOR')}${suffix}`);
      expect(status).toBe(404);
      expect(await db.aiConversation.findUnique({ where: { id: conversationOf('OPERATOR') } })).toMatchObject({ status: 'active' });
    });

    it('refuses to continue the conversation of another person', async () => {
      for (const path of ['/assistant/chat', '/assistant/chat/stream']) {
        const { status } = await call('ADMIN', 'POST', path, { message: 'hello', conversationId: conversationOf('OPERATOR') });
        expect(status).toBe(404);
      }
    });

    it('lets a caller read their own and the heartbeat, but not change the heartbeat', async () => {
      const own = await call('VIEWER', 'GET', `/assistant/conversations/${conversationOf('VIEWER')}`);
      expect(own.status).toBe(200);
      expect(own.text).toContain('private to VIEWER');
      expect((await call('VIEWER', 'GET', `/assistant/conversations/${conversationOf('ADMIN', 'heartbeat')}`)).status).toBe(200);
      expect((await call('OPERATOR', 'DELETE', `/assistant/conversations/${conversationOf('ADMIN', 'heartbeat')}`)).status).toBe(404);
      expect((await call('ADMIN', 'POST', `/assistant/conversations/${conversationOf('ADMIN')}/archive`)).status).toBe(200);
      await db.aiConversation.update({ where: { id: conversationOf('ADMIN') }, data: { status: 'active' } });
    });

    it('scopes the unread count and marking messages read', async () => {
      const before = await db.aiMessage.count({ where: { isRead: false, role: 'assistant', conversation: { OR: [{ createdBy: `${prefix}-VIEWER@example.com` }, { createdBy: 'system', type: 'heartbeat' }] } } });
      const unread = await call('VIEWER', 'GET', '/assistant/unread');
      expect(unread.json.data.unread).toBe(before);
      const refused = await call('VIEWER', 'POST', '/assistant/messages/read', { messageIds: [`${conversationOf('ADMIN')}-message`] });
      expect(refused.json.data.marked).toBe(0);
      expect((await db.aiMessage.findUnique({ where: { id: `${conversationOf('ADMIN')}-message` } }))?.isRead).toBe(false);
      const own = await call('VIEWER', 'POST', '/assistant/messages/read', { messageIds: [`${conversationOf('VIEWER')}-message`] });
      expect(own.json.data.marked).toBe(1);
    });
  });

  describe('webhook target refusals', () => {
    const create = () => call('ADMIN', 'POST', '/webhooks', { name: `${prefix}-hook`, url: 'https://hooks.example.com/path?token=fixture-value' });

    it('names the setting when the allowlist is empty, and creates nothing', async () => {
      vi.stubEnv('WEBHOOK_ALLOWED_ORIGINS', '');
      const { status, text, json } = await create();
      expect(status).toBe(400);
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain('WEBHOOK_ALLOWED_ORIGINS');
      expect(text).not.toContain('fixture-value');
      expect(await db.webhookEndpoint.count({ where: { name: `${prefix}-hook` } })).toBe(0);
    });

    it('names the setting for an origin that is not listed, and reveals no entry', async () => {
      vi.stubEnv('WEBHOOK_ALLOWED_ORIGINS', 'https://approved-only.example.com');
      const { status, text, json } = await create();
      expect(status).toBe(400);
      expect(json.error.message).toContain('Add its exact HTTPS origin to WEBHOOK_ALLOWED_ORIGINS');
      expect(text).not.toContain('approved-only');
    });

    it('keeps every other refusal generic, so it cannot probe addresses', async () => {
      vi.stubEnv('WEBHOOK_ALLOWED_ORIGINS', 'https://hooks.example.com');
      const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
      const { status, json } = await create();
      lookup.mockRestore();
      expect(status).toBe(400);
      expect(json.error.message).toBe('Webhook target is not an approved public HTTPS endpoint');
      expect(await db.webhookEndpoint.count({ where: { name: `${prefix}-hook` } })).toBe(0);
    });

    it('still accepts a listed origin with a public answer', async () => {
      vi.stubEnv('WEBHOOK_ALLOWED_ORIGINS', 'https://hooks.example.com');
      const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
      const { status, json } = await create();
      lookup.mockRestore();
      expect(status).toBe(201);
      await db.webhookEndpoint.delete({ where: { id: json.data.endpoint.id } });
    });
  });
});
