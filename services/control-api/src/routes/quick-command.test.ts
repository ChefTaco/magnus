import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler, HttpError } from '../middleware/error-handler.js';

const { execute, randomId, clientCreated } = vi.hoisted(() => ({ execute: vi.fn(), randomId: vi.fn(), clientCreated: vi.fn() }));
vi.mock('nanoid', () => ({ nanoid: randomId }));
vi.mock('../db/index.js', () => ({ getDb: () => ({ node: { findUnique: async () => ({ id: 'node', status: 'ONLINE', ipAddress: 'node.example', port: 4100 }) } }) }));
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(), requireRole: () => async (_c: unknown, next: () => Promise<void>) => next(), getUser: () => ({ userId: 'operator' }) }));
vi.mock('../utils/env.js', () => ({ getNodeManagerSecret: () => 'test-secret' }));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: async () => {} }));
vi.mock('../sdk/node-api-client.js', () => ({ NodeApiClient: class { constructor() { clientCreated(); } executeCommand = execute; } }));
const { quickCommandRouter } = await import('./quick-command.js');
const app = () => new Hono().onError(errorHandler).route('/quick-command', quickCommandRouter);
const send = (body: unknown) => app().request('/quick-command/node/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const status = () => ({ command: 'systemctl', args: ['status', 'magnus-agent', '--no-pager'], timeoutSeconds: 15 });
beforeEach(() => { vi.clearAllMocks(); randomId.mockReturnValue('fixture-id'); });

describe('quick command identifiers', () => {
  it.each(['_random-id', '-random-id'])('accepts a random ID beginning with punctuation: %s', async random => {
    randomId.mockReturnValue(random);
    execute.mockImplementation(async payload => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(payload.commandId)) throw Error('Agent rejects identifier');
      return { success: true, data: { commandId: payload.commandId, exitCode: 0, stdout: '', stderr: '', durationMs: 1, truncated: false, signature: 'a'.repeat(64) } };
    });
    const response = await send({ command: '/usr/bin/uptime', timeoutSeconds: 60 });
    expect(response.status).toBe(200);
    expect((await response.json()).data.exitCode).toBe(0);
  });

  it('canonicalizes only the exact existing status button before normal managed dispatch', async () => {
    execute.mockResolvedValue({ success: true, data: { commandId: 'cmd-fixture-id', exitCode: 0, stdout: 'active', stderr: '', durationMs: 1, truncated: false, signature: 'a'.repeat(64) } });
    expect((await send(status())).status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ commandId: 'cmd-fixture-id', command: '/usr/bin/systemctl', args: ['status', 'magnus-agent', '--no-pager'], timeoutSeconds: 15 });
  });

  it.each([
    { command: 'sudo', args: ['apt', 'update'] },
    { command: 'sudo', args: ['apt', 'upgrade', '-y'] },
    { command: 'sudo', args: ['systemctl', 'restart', 'magnus-agent'] },
    { command: 'sudo', args: ['reboot'] },
    { command: '/bin/sh', args: ['-c', '/usr/bin/uptime'], timeoutSeconds: 60 },
    { ...status(), command: 'systemctl; /bin/false' },
    { ...status(), args: ['status', 'other-service', '--no-pager'] },
    { ...status(), args: ['status', 'magnus-agent'] },
    { ...status(), timeoutSeconds: 16 },
    { ...status(), workingDirectory: '/tmp' },
    { command: '/usr/bin/uptime', args: ['--pretty'], timeoutSeconds: 60 },
    { command: '/usr/bin/uptime' },
  ])('refuses unsupported quick commands before creating an identifier or dispatch client: %o', async body => {
    const response = await send(body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'QUICK_COMMAND_UNAVAILABLE', message: expect.stringContaining('No command was registered or executed') } });
    expect(randomId).not.toHaveBeenCalled(); expect(clientCreated).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it('preserves actionable admission errors instead of wrapping them as gateway failures', async () => {
    execute.mockRejectedValue(new HttpError(409, 'RESOURCE_LEASE_HELD', 'Review the existing command receipt'));
    const response = await send(status());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'RESOURCE_LEASE_HELD' } });
  });
});
