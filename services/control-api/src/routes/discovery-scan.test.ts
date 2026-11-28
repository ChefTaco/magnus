import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { apiErrorSchema, discoveryScanResponseSchema } from '@hivemagnus/magnus-contracts/browser';
import { errorHandler } from '../middleware/error-handler.js';

const SECRET = 'discovery-scan-fixture-secret-at-least-32-characters';
const state = { enabled: true };

vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId }),
  invalidateUserStatus: () => undefined,
}));
vi.mock('../utils/env.js', async (original) => ({ ...await original<object>(),
  JWT_SECRET: 'discovery-scan-jwt-fixture-at-least-32-characters', API_SECRET: 'discovery-scan-api-fixture-at-least-32-characters',
  IAM_CORE_URL: '', IAM_TOKEN_ISSUER: '', IAM_TOKEN_AUDIENCE: '',
  get ENABLE_AGENT_DISCOVERY() { return state.enabled; }, AGENT_DISCOVERY_SECRET: SECRET }));
vi.mock('../db/index.js', () => ({
  getDb: () => ({ node: { findMany: async () => [{ ipAddress: '192.0.2.10', hostname: 'node-1.example.com' }] } }),
}));

/** A UDP socket that answers the broadcast probe as two signed agents would. */
vi.mock('node:dgram', () => ({
  createSocket: () => {
    const socket = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const answer = (address: string, hostname: string, nonce: string) => {
      const unsigned = { type: 'MAGNUS_AGENT_RESPONSE', nonce, timestamp: Date.now(), hostname, fqdn: hostname, port: 4100, version: '3.6.0' };
      const signature = createHmac('sha256', SECRET).update(JSON.stringify(unsigned)).digest('base64url');
      socket.emit('message', Buffer.from(JSON.stringify({ ...unsigned, signature })), { address, port: 4199, family: 'IPv4', size: 0 });
    };
    Object.assign(socket, {
      bind: (_port: number, callback: () => void) => callback(),
      setBroadcast: () => undefined,
      close: () => undefined,
      send: (message: Buffer, _offset: number, _length: number, _port: number, _target: string, callback: (error?: Error) => void) => {
        const { nonce } = JSON.parse(message.toString('utf8')) as { nonce: string };
        callback();
        answer('192.0.2.10', 'node-1.example.com', nonce);
        answer('192.0.2.11', 'node-2.example.com', nonce);
      },
    });
    return socket;
  },
}));

const { discoveryRouter } = await import('./discovery.js');
const { signUserToken } = await import('../middleware/auth.js');
const app = new Hono().onError(errorHandler).route('/discovery', discoveryRouter);

const scan = async (role: 'ADMIN' | 'OPERATOR' | 'VIEWER', body?: unknown) => app.request('/discovery/scan', {
  method: 'POST',
  headers: { authorization: `Bearer ${await signUserToken({ userId: role, email: 'alice@example.com', role })}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('POST /discovery/scan', () => {
  it.each(['ADMIN', 'OPERATOR'] as const)('lists the signed answers for %s, in the browser contract shape', async (role) => {
    state.enabled = true;
    const response = await scan(role, { timeoutMs: 250 });
    expect(response.status).toBe(200);
    const body = discoveryScanResponseSchema.parse(await response.json());
    expect(body.data.map((agent) => [agent.ip, agent.registered])).toEqual([['192.0.2.10', true], ['192.0.2.11', false]]);
    expect(body.meta).toEqual({ total: 2, newAgents: 1 });
  });

  it('accepts an empty body', async () => {
    state.enabled = true;
    const response = await scan('ADMIN');
    expect(response.status).toBe(200);
  }, 10_000);

  it('refuses VIEWER', async () => {
    state.enabled = true;
    expect((await scan('VIEWER', { timeoutMs: 250 })).status).toBe(403);
  });

  it('answers 503 DISCOVERY_DISABLED when discovery is not configured', async () => {
    state.enabled = false;
    const response = await scan('ADMIN', { timeoutMs: 250 });
    expect(response.status).toBe(503);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('DISCOVERY_DISABLED');
  });
});
