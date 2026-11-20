import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { errorHandler } from '../middleware/error-handler.js';

vi.mock('../utils/env.js', () => ({
  JWT_SECRET: 'terminal-test-jwt-secret-that-is-at-least-32-characters',
  API_SECRET: 'terminal-test-api-secret-that-is-at-least-32-characters',
  IAM_CORE_URL: undefined,
  IAM_TOKEN_AUDIENCE: undefined,
  IAM_TOKEN_ISSUER: undefined,
  MAGNUS_COLLECTOR_TOKEN_SHA256: '',
  MAGNUS_PLUGIN_API_ENABLED: true, MAGNUS_APPROVAL_BRIDGE_CONSUMER: '',
  MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: '{}',
  MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: '',
  MAGNUS_FLEET_CHECK_TOKEN_SHA256: '',
}));
vi.mock('../services/credential-rotation-service.js', () => ({
  verifyWithRotation: (_name: string, configured: string, provided: string) => configured === provided,
}));

const { terminalTicketRouter } = await import('./terminal-ticket.js');

describe('retired Control API terminal', () => {
  afterEach(() => {
    delete process.env['API_SECRET'];
    vi.restoreAllMocks();
  });

  it('requires API authentication before returning the deterministic retirement response', async () => {
    const app = new Hono<AppVariables>();
    app.onError(errorHandler);
    app.route('/terminal', terminalTicketRouter);

    expect((await app.request('/terminal/ticket', { method: 'POST' })).status).toBe(401);
    const response = await app.request('/terminal/ticket', {
      method: 'POST',
      headers: { 'x-api-secret': 'terminal-test-api-secret-that-is-at-least-32-characters' },
    });
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'TERMINAL_RETIRED' } });
  });

  it('registers no upgrade listener, so Node answers upgrade requests as ordinary HTTP', async () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
          && /\.on\(\s*['"`]upgrade['"`]/.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    };
    walk(fileURLToPath(new URL('..', import.meta.url)));
    expect(offenders).toEqual([]);
  });

  it('answers or closes every upgrade request and survives a malformed Host header', async () => {
    const app = new Hono<AppVariables>();
    app.onError(errorHandler);
    app.route('/api/v1/terminal', terminalTicketRouter);
    app.get('/health', (c) => c.text('ok'));
    const server = await new Promise<ServerType>((resolvePromise) => {
      const started: ServerType = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolvePromise(started));
    });
    const { port } = server.address() as AddressInfo;
    const upgrade = (path: string, host: string) => new Promise<string>((resolvePromise, reject) => {
      const socket = connect(port, '127.0.0.1');
      let received = '';
      const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no response for ${path}`)); }, 2_000);
      socket.on('data', (chunk) => {
        received += chunk.toString('latin1');
        if (!received.includes('\r\n')) return;
        clearTimeout(timer);
        socket.destroy();
        resolvePromise(received.split('\r\n')[0]!);
      });
      socket.on('error', reject);
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n');
    });
    try {
      expect(await upgrade('/unrelated', 'magnus.example.com')).toBe('HTTP/1.1 404 Not Found');
      expect(await upgrade('/api/v1/terminal?apiSecret=retired', 'magnus.example.com')).toBe('HTTP/1.1 401 Unauthorized');
      expect(await upgrade('/api/v1/terminal', '[malformed')).toBe('HTTP/1.1 400 Bad Request');
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).text()).toBe('ok');
    } finally {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        (server as ServerType & { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    }
  });
});
