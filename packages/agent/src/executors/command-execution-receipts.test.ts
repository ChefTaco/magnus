import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signCommandResult } from '../security/command-result-signature.js';
const secret = 'command-receipts-fixture-secret-at-least-32-characters';
vi.mock('../env.js', async (original) => ({ ...await original<object>(), RESULT_SIGNING_SECRET: 'command-receipts-fixture-secret-at-least-32-characters' }));
let root: string;
let routes: typeof import('./command-executor.js').commandRoutes;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'command-execution-'));
  vi.stubEnv('AGENT_INSTALL_DIR', root);
  routes = (await import('./command-executor.js')).commandRoutes;
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const submit = (body: object) => routes.request('/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('real process execution and HTTP receipts', () => {
  it('executes once and returns the original signed result on repeat and receipt lookup', async () => {
    const body = { commandId: 'actual-once', command: 'printf x >> marker; printf done', workingDirectory: root };
    const first = await (await submit(body)).json();
    expect(first.success).toBe(true); expect(first.data.stdout).toBe('done');
    expect(first.data.signature).toBe(signCommandResult(first.data, secret));
    expect(await (await submit(body)).json()).toEqual(first);
    expect(await readFile(join(root, 'marker'), 'utf8')).toBe('x');
    const receipt = await (await routes.request('/receipts/actual-once')).json();
    expect(receipt.data.state).toBe('completed'); expect(receipt.data.result).toEqual(first.data);
    expect((await submit({ ...body, command: 'printf twice >> marker' })).status).toBe(409);
  });
  it('does not spawn expired or active fenced commands when the supervisor is disabled', async () => {
    const coordination = { version: 1, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() - 1 };
    const rejected = await submit({ commandId: 'expired', command: 'touch forbidden', workingDirectory: root, coordination });
    expect(rejected.status).toBe(503); expect((await rejected.json()).error.code).toBe('LEDGER_UNAVAILABLE');
    await expect(readFile(join(root, 'forbidden'))).rejects.toMatchObject({ code: 'ENOENT' });
    coordination.expiresAt = Date.now() + 60_000;
    const active = await submit({ commandId: 'fenced', command: 'touch active-forbidden', workingDirectory: root, coordination });
    expect(active.status).toBe(503); expect((await active.json()).error.code).toBe('LEDGER_UNAVAILABLE');
    await expect(readFile(join(root, 'active-forbidden'))).rejects.toMatchObject({ code: 'ENOENT' });
    const receipt = await routes.request('/receipts/fenced'); expect(receipt.status).toBe(404);
    expect((await receipt.json()).error.code).toBe('NOT_FOUND');
  });
});
