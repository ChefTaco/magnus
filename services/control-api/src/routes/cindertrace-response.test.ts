import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { bridgeSignature } from '../security/cindertrace-response.js';
const state = vi.hoisted(() => ({ row: null as any, effects: 0, loseReply: false }));
const db = vi.hoisted(() => ({
  node: {
    findUnique: vi.fn(async () => ({
      id: 'node-1',
      ipAddress: 'node.example.com',
      port: 4100,
      status: 'ONLINE',
      lastHeartbeatAt: new Date(),
      tags: '[]',
      metadata: '{}',
    })),
  },
  cindertraceResponse: {
    findUnique: vi.fn(async () => state.row),
    create: vi.fn(async ({ data }: any) => {
      if (state.row) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
      state.row = { ...data, status: 'claimed' };
      return state.row;
    }),
    update: vi.fn(async ({ data }: any) => {
      Object.assign(state.row, data);
      return state.row;
    }),
  },
}));
vi.mock('../db/index.js', () => ({ getDb: () => db }));
vi.mock('../utils/env.js', () => ({ getNodeManagerSecret: () => 'fixture-node-credential' }));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../sdk/node-api-client.js', () => ({
  NodeApiClient: class {
    async securityResponse() {
      state.effects++;
      if (state.loseReply) throw new Error('Synthetic lost reply after the effect');
      return {
        response: { success: true, data: { exitCode: 0 } },
        evidence: { receiptSha256: 'a'.repeat(64) },
      };
    }
  },
}));
import { cindertraceResponseRouter } from './cindertrace-response.js';
const app = new Hono();
app.onError((e, c) => c.json({ error: e.message }, (e as any).status ?? 500));
app.route('/api/v1/security-integration/response', cindertraceResponseRouter);
const secret = 'fixture-bridge-secret-'.repeat(3);
function plan() {
  return {
    version: 1,
    executionId: '00000000-0000-4000-8000-000000000001',
    actionId: 'action-1',
    caseId: 'case-1',
    operation: 'execute',
    nodeId: 'node-1',
    kind: 'service_restart',
    serviceName: 'fixture.service',
    isolationMinutes: null,
    previewSha256: 'b'.repeat(64),
    planSha256: 'c'.repeat(64),
    approvalId: 'approval-1',
    approvedBy: 'fixture-admin',
    expiresAt: Date.now() + 60000,
  };
}
function request(body: unknown, signature = true) {
  const raw = JSON.stringify(body),
    path = '/api/v1/security-integration/response/execute',
    time = String(Date.now()),
    nonce = 'a'.repeat(32);
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cindertrace-time': time,
      'x-cindertrace-nonce': nonce,
      'x-cindertrace-signature': signature
        ? bridgeSignature(secret, 'POST', path, time, nonce, raw)
        : '0'.repeat(64),
    },
    body: raw,
  });
}
beforeEach(() => {
  state.row = null;
  state.effects = 0;
  state.loseReply = false;
  vi.stubEnv('CINDERTRACE_RESPONSE_SECRET', secret);
  vi.stubEnv('CINDERTRACE_RESTART_ALLOWLIST', 'fixture.service');
});
afterEach(() => vi.unstubAllEnvs());
it('requires a dedicated signed request before creating an execution', async () => {
  expect((await request(plan(), false)).status).toBe(401);
  expect(state.effects).toBe(0);
});
it('binds one durable claim and returns its verified completion on exact replay', async () => {
  const p = plan();
  const first = await request(p);
  expect(first.status).toBe(200);
  expect(first.headers.get('x-cindertrace-signature')).toMatch(/^[a-f0-9]{64}$/);
  expect((await request(p)).status).toBe(200);
  expect(state.effects).toBe(1);
  expect((await request({ ...p, nodeId: 'other' })).status).toBe(409);
  expect(state.effects).toBe(1);
});
it('refuses expired approval and unknown prior effects without replay', async () => {
  expect((await request({ ...plan(), expiresAt: Date.now() - 1 })).status).toBe(409);
  const p = plan();
  await request(p);
  state.row.status = 'unknown';
  expect((await request(p)).status).toBe(409);
  expect(state.effects).toBe(1);
});
it('enforces the independent service allowlist', async () => {
  expect((await request({ ...plan(), serviceName: 'unreviewed.service' })).status).toBe(403);
  expect(state.effects).toBe(0);
});
it('never redispatches a lost reply after an admitted effect', async () => {
  state.loseReply = true;
  const p = plan();
  expect((await request(p)).status).toBe(409);
  expect(state.row.status).toBe('unknown');
  expect((await request(p)).status).toBe(409);
  expect(state.effects).toBe(1);
});
it('admits only one concurrent claim', async () => {
  const replies = await Promise.all([
    request(plan()),
    request({ ...plan(), executionId: 'another-execution' }),
  ]);
  expect(replies.map((x) => x.status).sort()).toEqual([200, 409]);
  expect(state.effects).toBe(1);
});
