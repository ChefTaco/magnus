/**
 * The real ledger, the real execution slot and the real HTTP route, on a ledger
 * as older builds left it: a node fence far above what the server hands out.
 * The refusal must be reported as what it is, not as an uncertain mutation.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandRefusalSigningPayload, signCommandEvidence } from '../security/command-result-signature.js';
import { httpIdentity } from '../security/managed-http.js';

const secret = 'managed-refusal-signing-key-at-least-32-bytes';
const nodeKey = 'managed-refusal-node-key-at-least-32-bytes';
const FENCE = '1789962351090';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../tls.js', async original => ({ ...await original<object>(), controlApiFetch: fetchMock }));

let root: string;
let app: Hono;
let effect: ReturnType<typeof vi.fn>;
let ledger: typeof import('./command-ledger.js');

const request = (fence: string, id = 'native-refused', extra: Partial<{ expiresAt: number }> = {}) => ({
  claim: { leaseId: `lease-${id}`, nodeId: 'fixture', nodeFqdn: 'fixture.example.com' }, commandId: id, method: 'POST', path: '/files/write',
  body: '{"path":"/tmp/x"}', timeoutSeconds: 10,
  coordination: { version: 1, resourceKey: 'node:fixture', fence, expiresAt: extra.expiresAt ?? Date.now() + 60_000 } });
type Request = ReturnType<typeof request>;
const send = (value: Request) => app.request('http://localhost/api/v1/commands/managed-http', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-node-token': nodeKey }, body: JSON.stringify(value) });
const digest = (value: Request) => ledger.commandRequestDigest({ ...httpIdentity(value.commandId, value.method as 'POST', value.path, value.body, value.timeoutSeconds), coordination: value.coordination as never });
const receiptsDir = () => join(root, '.magnus/command-receipts');

async function seedFence(resourceKey: string, fence: string): Promise<void> {
  await mkdir(receiptsDir(), { recursive: true, mode: 0o700 });
  await writeFile(join(receiptsDir(), `fence-${createHash('sha256').update(resourceKey).digest('hex')}.json`), JSON.stringify({ resourceKey, fence }), { mode: 0o600 });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'magnus-refusal-'));
  vi.resetModules();
  vi.stubEnv('AGENT_INSTALL_DIR', root);
  vi.stubEnv('RESULT_SIGNING_SECRET', secret);
  vi.stubEnv('NODE_MANAGER_SECRET', nodeKey);
  vi.stubEnv('HOST_FQDN', 'fixture.example.com');
  fetchMock.mockReset().mockImplementation(async (_url: string, init: { body: string }) =>
    new Response(JSON.stringify({ success: true, data: { admitted: true, ...JSON.parse(init.body) } }), { status: 200 }));
  ledger = await import('./command-ledger.js');
  const { managedMutationGuard, registerManagedHttp } = await import('./managed-http.js');
  const { nodeAuthMiddleware } = await import('../middleware.js');
  effect = vi.fn(async () => new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } }));
  app = new Hono();
  app.use('/api/v1/*', nodeAuthMiddleware);
  app.use('/api/v1/*', managedMutationGuard);
  app.post('/api/v1/files/write', () => effect());
  registerManagedHttp(app);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('a certain refusal on a ledger with a pre-seeded high fence', () => {
  it('answers STALE_FENCE with the high-water and a signed no-execution statement, and leaves nothing behind', async () => {
    await seedFence('node:fixture', FENCE);
    const input = request('1');
    const response = await send(input);
    expect(response.status).toBe(409);
    const { error } = await response.json() as { error: Record<string, unknown> & { refusal: { signature: string } } };
    expect(error).toMatchObject({ code: 'STALE_FENCE', dispatched: false, executed: false, highWater: FENCE, resourceKey: 'node:fixture' });
    expect(error['code']).not.toBe('MANAGED_MUTATION_UNCERTAIN');
    const unsigned = { commandId: input.commandId, requestSha256: digest(input), code: 'STALE_FENCE', highWater: FENCE };
    expect(error.refusal).toEqual({ ...unsigned, signature: signCommandEvidence(commandRefusalSigningPayload(unsigned), secret) });
    expect(effect).not.toHaveBeenCalled();
    const names = await readdir(receiptsDir());
    expect(names.filter(name => name.startsWith('receipt-'))).toEqual([]);
    expect(names).not.toContain('active.lock');
  });

  it('executes once the server moved past the high-water', async () => {
    await seedFence('node:fixture', FENCE);
    expect((await send(request('1', 'first'))).status).toBe(409);
    const healed = request(String(BigInt(FENCE) + 2n), 'second');
    expect((await send(healed)).status).toBe(200);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('reports a lease that expired before the ledger as LEASE_EXPIRED, and certain', async () => {
    const response = await send(request('5', 'expired', { expiresAt: Date.now() - 1_000 }));
    expect(response.status).toBe(409);
    expect((await response.json() as { error: unknown }).error).toMatchObject({ code: 'LEASE_EXPIRED', executed: false });
    expect(effect).not.toHaveBeenCalled();
  });

  it('reports a claim the server would not confirm as certain, before the ledger', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 409 }));
    const response = await send(request('5', 'unconfirmed'));
    expect(response.status).toBe(409);
    expect((await response.json() as { error: unknown }).error).toMatchObject({ code: 'RESOURCE_CLAIM_INVALID', executed: false });
    expect(effect).not.toHaveBeenCalled();
  });

  it('keeps reporting a callback that failed after it started as uncertain, without any statement about execution', async () => {
    effect.mockRejectedValue(new Error('lost after effect'));
    const response = await send(request('5', 'started'));
    expect(response.status).toBe(409);
    const { error } = await response.json() as { error: Record<string, unknown> };
    expect(error['code']).toBe('MANAGED_MUTATION_UNCERTAIN');
    expect(error).not.toHaveProperty('executed');
    expect(error).not.toHaveProperty('refusal');
  });

  it('does not claim non-execution for an id that already has a receipt', async () => {
    const first = request('5', 'twice');
    expect((await send(first)).status).toBe(200);
    const other = { ...request('6', 'twice'), body: '{"path":"/tmp/other"}' };
    const response = await send(other);
    const { error } = await response.json() as { error: Record<string, unknown> };
    expect(error['code']).toBe('IDEMPOTENCY_CONFLICT');
    expect(error).not.toHaveProperty('executed');
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
