import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { execute, randomId } = vi.hoisted(() => ({ execute: vi.fn(), randomId: vi.fn() }));
vi.mock('nanoid', () => ({ nanoid: randomId }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ node: { findUnique: async () => ({ id: 'node', status: 'ONLINE', ipAddress: 'node.example', port: 4100 }) } }) }));
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(), requireRole: () => async (_c: unknown, next: () => Promise<void>) => next(), getUser: () => ({ userId: 'operator' }) }));
vi.mock('../utils/env.js', () => ({ getNodeManagerSecret: () => 'test-secret' }));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: async () => {} }));
vi.mock('../sdk/node-api-client.js', () => ({ NodeApiClient: class { executeCommand = execute; } }));
const { quickCommandRouter } = await import('./quick-command.js');

describe('quick command identifiers', () => {
  it.each(['_random-id', '-random-id'])('accepts a random ID beginning with punctuation: %s', async random => {
    randomId.mockReturnValue(random);
    execute.mockImplementation(async payload => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(payload.commandId)) throw Error('Agent rejects identifier');
      return { success: true, data: { commandId: payload.commandId, exitCode: 0, stdout: '', stderr: '', durationMs: 1, truncated: false, signature: 'a'.repeat(64) } };
    });
    const app = new Hono().route('/quick-command', quickCommandRouter);
    const response = await app.request('/quick-command/node/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: '/usr/bin/true' }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data.exitCode).toBe(0);
  });
});
