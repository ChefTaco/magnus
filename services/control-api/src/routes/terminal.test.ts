import { afterEach, describe, expect, it, vi } from 'vitest';
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

const { setupTerminalWebSocket } = await import('./terminal.js');
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

  it('rejects terminal upgrades without parsing query credentials and leaves unrelated upgrades alone', () => {
    let upgrade: ((request: { url?: string; headers: { host?: string } }, socket: { end: ReturnType<typeof vi.fn> }) => void) | undefined;
    const server = { on: vi.fn((_event: string, listener: typeof upgrade) => { upgrade = listener; }) };
    setupTerminalWebSocket(server as never);
    const socket = { end: vi.fn() };

    upgrade?.({ url: '/unrelated', headers: { host: 'example.test' } }, socket);
    expect(socket.end).not.toHaveBeenCalled();
    upgrade?.({ url: '/api/v1/terminal?apiSecret=retired', headers: { host: 'example.test' } }, socket);
    expect(socket.end).toHaveBeenCalledWith(expect.stringContaining('410 Gone'));
  });
});
