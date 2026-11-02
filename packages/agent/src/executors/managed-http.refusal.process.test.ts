/**
 * The real ledger, the real execution slot and the real HTTP route, on a ledger
 * as older builds left it: a node fence far above what the server hands out.
 * The refusal must be reported as what it is, not as an uncertain mutation.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandAbsenceSigningPayload, commandRefusalSigningPayload, fenceProofSigningPayload, signCommandEvidence } from '../security/command-result-signature.js';
import { httpIdentity } from '../security/managed-http.js';

const secret = 'managed-refusal-signing-key-at-least-32-bytes';
const nodeKey = 'managed-refusal-node-key-at-least-32-bytes';
const FENCE = '1789962351090';
const AGENT_MAJOR = (await import('../version.js')).AGENT_VERSION.split('.')[0];
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
    const unsigned = { commandId: input.commandId, requestSha256: digest(input), code: 'STALE_FENCE', highWater: FENCE, nodeFqdn: 'fixture.example.com', leaseId: input.claim.leaseId };
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

describe('a failed self-upgrade over the real route, ledger and managed-http', () => {
  // Same major as the running version: a major change is refused before anything else happens.
  const VERSION_TARGET = `${AGENT_MAJOR}.999.0`;
  async function installation(npmScript: string) {
    const { AGENT_VERSION } = await import('../version.js');
    const entry = join(root, 'versions', AGENT_VERSION, 'node_modules/@hivemagnus/magnus-agent/dist');
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, 'index.js'), '');
    await symlink(join('versions', AGENT_VERSION), join(root, 'current'), 'dir');
    const npm = join(root, 'fake-npm.sh');
    await writeFile(npm, `#!/bin/sh\n${npmScript}\n`, { mode: 0o755 });
    vi.stubEnv('MAGNUS_AGENT_LAUNCHER', '1');
    vi.stubEnv('MAGNUS_AGENT_LAUNCHER_PROTOCOL', '1');
    vi.stubEnv('MAGNUS_AGENT_NPM', npm);
    vi.stubEnv('MAGNUS_AGENT_UPGRADE_REQUIRE_PROVENANCE', 'false');
    const { agentUpgradeRoutes } = await import('../upgrade/routes.js');
    app.route('/api/v1/agent-upgrade', agentUpgradeRoutes);
  }
  const upgrade = (id: string, fence: string) => ({ claim: { leaseId: `lease-${id}`, nodeId: 'fixture', nodeFqdn: 'fixture.example.com' }, commandId: id, method: 'POST', path: '/agent-upgrade',
    body: JSON.stringify({ version: VERSION_TARGET, integrity: `sha512-${'A'.repeat(86)}==`, requestId: id, packageName: '@hivemagnus/magnus-agent' }), timeoutSeconds: 900,
    coordination: { version: 1, resourceKey: 'node:fixture', fence, expiresAt: Date.now() + 60_000 } });
  const settledBody = async (response: Response) => {
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: { response: { status: number; body: string }; receipt: { signature: string; exitCode: number } } };
    return { status: data.response.status, error: (JSON.parse(data.response.body) as { error: { code: string; message: string } }).error, receipt: data.receipt };
  };

  it('settles a bad package as a signed result, with the lock and receipt cleared, so the real code reaches the server', async () => {
    await installation('echo "npm error code E404: this version is broken" >&2; exit 1');
    const first = await settledBody(await send(upgrade('bad-release', '5') as never));
    expect(first.status).toBeLessThan(500);
    expect(first.error).toMatchObject({ code: 'SELF_UPGRADE_FAILED', message: expect.stringMatching(/npm pack failed/) });
    expect(first.receipt.exitCode).toBe(1);
    const { commandLedger } = await import('./command-executor.js');
    expect(await commandLedger.health()).toMatchObject({ activeLock: null, nonTerminalReceipts: 0, unresolvedReceipts: 0 });
    expect((await commandLedger.receipt('bad-release'))?.state).toBe('completed');
    // The next request on this node is not blocked by what the last one left behind.
    const second = await settledBody(await send(upgrade('next-request', '6') as never));
    expect(second.error.code).toBe('SELF_UPGRADE_FAILED');
  });

  it('keeps the generic rule: an unexpected handler failure stays uncertain', async () => {
    effect.mockResolvedValue(new Response(JSON.stringify({ success: false, error: { code: 'SELF_UPGRADE_FAILED', message: 'x' } }), { status: 500, headers: { 'content-type': 'application/json' } }));
    const response = await send(request('5', 'generic-500'));
    expect(response.status).toBe(409);
    const { error } = await response.json() as { error: Record<string, unknown> };
    expect(error['code']).toBe('MANAGED_MUTATION_UNCERTAIN');
    const { commandLedger } = await import('./command-executor.js');
    expect(await commandLedger.health()).toMatchObject({ unresolvedReceipts: 1, activeLock: { commandId: 'generic-500', receipt: 'unknown' } });
  });

  it('names an environment cause with its own code, not a release failure', async () => {
    await installation('echo "npm error code ENOSPC: no space left on device" >&2; exit 1');
    expect((await settledBody(await send(upgrade('disk', '5') as never))).error.code).toBe('SELF_UPGRADE_ENV_DISK');
  });

  it('names a network cause as such', async () => {
    await installation('echo "npm error code ENOTFOUND: registry.example.com" >&2; exit 1');
    expect((await settledBody(await send(upgrade('network', '5') as never))).error.code).toBe('SELF_UPGRADE_ENV_NETWORK');
  });

  it('names an access cause as such', async () => {
    await installation('echo "npm error code EACCES: permission denied" >&2; exit 1');
    expect((await settledBody(await send(upgrade('access', '5') as never))).error.code).toBe('SELF_UPGRADE_ENV_ACCESS');
  });

  it('keeps a corrupt package a release failure, whatever else the output says', async () => {
    await installation('echo "npm error code EINTEGRITY: sha512 mismatch" >&2; exit 1');
    expect((await settledBody(await send(upgrade('corrupt', '5') as never))).error.code).toBe('SELF_UPGRADE_FAILED');
  });
});

describe('a machine-readable reason for why self-upgrade is off', () => {
  it('tells an operator switch-off from a problem', async () => {
    const { selfUpgradeStatus } = await import('../upgrade/self-upgrade.js');
    expect(selfUpgradeStatus('1.1.7', { MAGNUS_AGENT_SELF_UPGRADE: 'false', AGENT_INSTALL_DIR: root })).toMatchObject({ enabled: false, reasonCode: 'SWITCHED_OFF' });
    expect(selfUpgradeStatus('1.1.7', { MAGNUS_AGENT_CONTAINER: '1', AGENT_INSTALL_DIR: root })).toMatchObject({ enabled: false, reasonCode: 'CONTAINER' });
    expect(selfUpgradeStatus('1.1.7', { AGENT_INSTALL_DIR: root })).toMatchObject({ enabled: false, reasonCode: 'LEGACY_LAYOUT' });
    await symlink('versions/1.1.7', join(root, 'current'), 'dir');
    await mkdir(join(root, 'versions'), { recursive: true });
    const launcher = { AGENT_INSTALL_DIR: root, MAGNUS_AGENT_LAUNCHER: '1' };
    expect(selfUpgradeStatus('1.1.7', { ...launcher, PATH: '/nonexistent' }, '/nonexistent/deep/bin/node')).toMatchObject({ enabled: false, reasonCode: 'NPM' });
    await chmod(join(root, 'versions'), 0o500);
    try {
      if (process.getuid?.() !== 0) expect(selfUpgradeStatus('1.1.7', { ...launcher, MAGNUS_AGENT_NPM: '/bin/true' })).toMatchObject({ enabled: false, reasonCode: 'NOT_WRITABLE' });
    } finally { await chmod(join(root, 'versions'), 0o700); }
    expect(selfUpgradeStatus('1.1.7', { ...launcher, MAGNUS_AGENT_NPM: '/bin/true' })).toMatchObject({ enabled: true, reasonCode: null });
  });
});

describe('what the agent signs about a command it holds nothing for', () => {
  const trace = async (id: string, query = 'nonce=nonce-of-sixteen-chars&resourceKey=node:fixture') => {
    const { commandRoutes } = await import('./command-executor.js');
    const response = await commandRoutes.request(`/receipts/${id}/trace?${query}`);
    return { status: response.status, data: (await response.json() as { data: Record<string, unknown> }).data };
  };

  it('finding 3: signs that the ledger is missing, instead of an absence that reads as proof', async () => {
    const { status, data } = await trace('agent-upgrade-x');
    expect(status).toBe(200);
    expect(data).toMatchObject({ commandId: 'agent-upgrade-x', nodeFqdn: 'fixture.example.com', ledgerExists: false, receipt: false, activeLock: false, fenceHighWater: null, markerState: 'absent' });
    // Asking must not bring the ledger into being.
    await expect(readdir(receiptsDir())).rejects.toThrow();
  });

  it('finding 3: signs the fence high-water and the enrollment marker along with the absence', async () => {
    await seedFence('node:fixture', FENCE);
    await writeFile(join(receiptsDir(), 'managed-enrollment.json'), JSON.stringify({ version: 1, nodeId: 'fixture', nodeFqdn: 'fixture.example.com' }), { mode: 0o600 });
    const { data } = await trace('agent-upgrade-x');
    const { signature, ...unsigned } = data as Record<string, unknown> & { signature: string };
    expect(unsigned).toMatchObject({ ledgerExists: true, receipt: false, activeLock: false, resourceKey: 'node:fixture', fenceHighWater: FENCE, markerState: 'present', markerNodeId: 'fixture' });
    expect(signature).toBe(signCommandEvidence(commandAbsenceSigningPayload(unsigned as never), secret));
  });

  it('reports an unreadable marker as unknown, not absent', async () => {
    await seedFence('node:fixture', FENCE);
    await writeFile(join(receiptsDir(), 'managed-enrollment.json'), 'not json', { mode: 0o600 });
    expect((await trace('agent-upgrade-x')).data).toMatchObject({ markerState: 'unknown', markerNodeId: null });
  });

  it('rejects a trace without a nonce or with a malformed key', async () => {
    expect((await trace('x', 'resourceKey=node:fixture')).status).toBe(400);
    expect((await trace('x', 'nonce=nonce-of-sixteen-chars&resourceKey=../../etc')).status).toBe(400);
  });
});

describe('a claim without a receipt', () => {
  it('never started: the callback runs only after the receipt is durable, and the next holder clears the claim', async () => {
    await mkdir(receiptsDir(), { recursive: true, mode: 0o700 });
    // What a crash between active.lock and the receipt leaves behind.
    await writeFile(join(receiptsDir(), 'active.lock'), JSON.stringify({ commandId: 'crashed', nonce: '6f9619ff-8b86-4d11-b42d-00c04fc964ff', pid: 1 }), { mode: 0o600 });
    const { commandLedger } = await import('./command-executor.js');
    expect(await commandLedger.commandTrace('crashed')).toMatchObject({ receipt: false, activeLock: true });
    expect((await commandLedger.health()).activeLock).toEqual({ commandId: 'crashed', receipt: 'none' });
    expect((await send(request('5', 'after-crash'))).status).toBe(200);
    expect(await commandLedger.commandTrace('crashed')).toMatchObject({ receipt: false, activeLock: false });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('does not sign non-execution while this very command holds the claim', async () => {
    const { refusalError } = await import('./command-refusal.js');
    await mkdir(receiptsDir(), { recursive: true, mode: 0o700 });
    await writeFile(join(receiptsDir(), 'active.lock'), JSON.stringify({ commandId: 'mine', nonce: '6f9619ff-8b86-4d11-b42d-00c04fc964ff', pid: 1 }), { mode: 0o600 });
    const error = await refusalError({ commandId: 'mine', requestSha256: 'a'.repeat(64), leaseId: 'lease-1' }, 'RESOURCE_BUSY', 'busy', { notStarted: true });
    expect(error).not.toHaveProperty('executed');
    expect(error).not.toHaveProperty('refusal');
  });

  it('finding 9: binds a refusal to this node and this lease, and signs nothing without a lease', async () => {
    const { refusalError } = await import('./command-refusal.js');
    const signed = await refusalError({ commandId: 'free', requestSha256: 'a'.repeat(64), leaseId: 'lease-1' }, 'RESOURCE_BUSY', 'busy', { notStarted: true }) as { refusal: Record<string, unknown> };
    expect(signed.refusal).toMatchObject({ nodeFqdn: 'fixture.example.com', leaseId: 'lease-1' });
    expect(await refusalError({ commandId: 'free', requestSha256: 'a'.repeat(64) }, 'RESOURCE_BUSY', 'busy', { notStarted: true })).not.toHaveProperty('refusal');
  });
});

describe('the preflight is strictly read only', () => {
  it('creates nothing on a node without a ledger, and signs its fences under the nonce it was given', async () => {
    const { agentUpgradeRoutes } = await import('../upgrade/routes.js');
    const response = await agentUpgradeRoutes.request('/preflight?target=1.1.9&nonce=nonce-of-sixteen-chars');
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: { managedEnrollmentState: string } };
    expect(data.managedEnrollmentState).toBe('absent');
    await expect(readdir(join(root, '.magnus'))).rejects.toThrow();
  });

  it('finding 9: proves its fence high-water with the nonce, the node and the values', async () => {
    await seedFence('node:fixture', FENCE);
    const { agentUpgradeRoutes } = await import('../upgrade/routes.js');
    const { data } = await (await agentUpgradeRoutes.request('/preflight?nonce=nonce-of-sixteen-chars')).json() as { data: { fenceHighWater: Record<string, string>; fenceProof: { nonce: string; nodeFqdn: string; signature: string } } };
    expect(data.fenceHighWater).toEqual({ 'node:fixture': FENCE });
    expect(data.fenceProof).toEqual({ nonce: 'nonce-of-sixteen-chars', nodeFqdn: 'fixture.example.com',
      signature: signCommandEvidence(fenceProofSigningPayload({ nonce: 'nonce-of-sixteen-chars', nodeFqdn: 'fixture.example.com', fenceHighWater: data.fenceHighWater }), secret) });
    const unproven = await (await agentUpgradeRoutes.request('/preflight')).json() as { data: Record<string, unknown> };
    expect(unproven.data).not.toHaveProperty('fenceProof');
  });

  it('reports an unreadable marker as unknown, so it cannot hide a mismatch', async () => {
    await mkdir(receiptsDir(), { recursive: true, mode: 0o700 });
    await writeFile(join(receiptsDir(), 'managed-enrollment.json'), '{"version":2}', { mode: 0o600 });
    const { agentUpgradeRoutes } = await import('../upgrade/routes.js');
    const { data } = await (await agentUpgradeRoutes.request('/preflight')).json() as { data: Record<string, unknown> };
    expect(data).toMatchObject({ managedEnrollmentState: 'unknown', managedEnrollment: null });
  });
});
