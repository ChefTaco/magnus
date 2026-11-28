/**
 * A node that runs commands under its execution supervisor refuses a command
 * without registered completion evidence before anything starts: no ledger
 * claim, no receipt, no retained mutation record and no transient unit. A
 * managed request gets a signed `executed: false` refusal, which is what the
 * server needs to settle its lease as not dispatched instead of `unknown`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { commandRefusalSigningPayload, signCommandEvidence } from '../security/command-result-signature.js';

const fixture = vi.hoisted(() => ({ run: vi.fn(), status: vi.fn(), confirm: vi.fn() }));
vi.mock('./execution-supervisor.js', () => ({ ExecutionSupervisor: class { run = fixture.run; status = fixture.status; } }));
vi.mock('../tls.js', async original => ({ ...await original<object>(), controlApiFetch: fixture.confirm }));

const secret = 'unregistered-refusal-result-key-at-least-32';
let root: string;
const plain = (commandId: string) => ({ commandId, command: 'uptime -p', args: [], timeoutSeconds: 60,
  coordination: { version: 1 as const, resourceKey: 'node:fixture', fence: '7', expiresAt: Date.now() + 60_000 } });

beforeEach(async () => {
  vi.resetModules(); fixture.run.mockReset(); fixture.status.mockReset();
  root = await mkdtemp(join(tmpdir(), 'unregistered-refusal-'));
  vi.stubEnv('AGENT_INSTALL_DIR', root); vi.stubEnv('HOST_FQDN', 'fixture.example.com');
  vi.stubEnv('RESULT_SIGNING_SECRET', secret);
  vi.stubEnv('MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'true');
  fixture.confirm.mockReset().mockImplementation(async (_url: string, init: { body: string }) => new Response(JSON.stringify({ success: true,
    data: { ...JSON.parse(init.body), nodeId: 'fixture', enrolled: false, gateEnabled: false, allowedLegacy: true, admitted: true } })));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function agent() {
  const executor = await import('./command-executor.js');
  const { managedMutationGuard } = await import('./managed-http.js');
  const { mutationBarrier } = await import('./mutation-barrier.js');
  const { commandRequestDigest } = await import('./command-ledger.js');
  const { MANAGED_CLAIM_HEADER } = await import('../security/managed-http.js');
  const app = new Hono(); app.use('/api/v1/*', managedMutationGuard); app.route('/api/v1/commands', executor.commandRoutes);
  return { app, executor, barrier: mutationBarrier, commandRequestDigest, MANAGED_CLAIM_HEADER };
}
const receipts = async () => (await readdir(join(root, '.magnus/command-receipts')).catch(() => [] as string[]))
  .filter(name => name.startsWith('receipt-') || name === 'active.lock');

describe('an unregistered command on a supervised node', () => {
  it('answers a managed request with a signed certain refusal and leaves nothing behind', async () => {
    const { app, executor, commandRequestDigest, MANAGED_CLAIM_HEADER } = await agent();
    const input = plain('managed-plain');
    const claim = { leaseId: 'lease-managed-plain', nodeId: 'fixture', nodeFqdn: 'fixture.example.com' };
    const response = await app.request('/api/v1/commands/execute', { method: 'POST',
      headers: { 'content-type': 'application/json', [MANAGED_CLAIM_HEADER]: JSON.stringify(claim) }, body: JSON.stringify(input) });
    expect(response.status).toBe(409);
    const { error } = await response.json() as { error: Record<string, unknown> & { refusal: Record<string, unknown> } };
    expect(error).toMatchObject({ code: 'UNREGISTERED_COMMAND', dispatched: false, executed: false });
    const unsigned = { commandId: input.commandId, requestSha256: commandRequestDigest(input), code: 'UNREGISTERED_COMMAND',
      highWater: null, nodeFqdn: 'fixture.example.com', leaseId: claim.leaseId };
    expect(error.refusal).toMatchObject({ ...unsigned, signature: signCommandEvidence(commandRefusalSigningPayload(unsigned), secret) });
    expect(fixture.run).not.toHaveBeenCalled();
    // Refused before the claim is confirmed: the server is not asked about a request that will not run.
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(await receipts()).toEqual([]);
    expect(await executor.commandLedger.receipt(input.commandId)).toBeNull();
  });

  it('refuses a legacy request before the mutation barrier records an uncertain mutation', async () => {
    const { app, barrier } = await agent();
    const response = await app.request('/api/v1/commands/execute', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(plain('legacy-plain')) });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: unknown }).error).toMatchObject({ code: 'UNREGISTERED_COMMAND' });
    const identity = { nodeId: 'fixture', nodeFqdn: 'fixture.example.com', epoch: 1, barrierId: randomUUID() };
    await barrier.drain(identity);
    expect(await barrier.snapshot(identity)).toMatchObject({ activeCount: 0, unknownCount: 0 });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(await receipts()).toEqual([]);
  });

  it('still runs a registered command under the supervisor', async () => {
    const { executor, commandRequestDigest } = await agent();
    const { COMMAND_COMPLETION_REGISTRY_SHA256 } = await import('../security/command-completion-registry.js');
    const input = { ...plain('registered'), command: '/usr/bin/uptime' };
    const owner = { version: 1 as const, registrySha256: COMMAND_COMPLETION_REGISTRY_SHA256, descriptorId: 'diagnostics-uptime-v1' };
    fixture.run.mockResolvedValue({ state: 'completed', evidence: { requestSha256: commandRequestDigest(input), completionOwner: owner },
      result: { exitCode: 0, stdout: 'up 1 day', stderr: '', durationMs: 5, truncated: false } });
    expect(await executor.executeCommand(input)).toMatchObject({ exitCode: 0, stdout: 'up 1 day' });
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });
});
