import { randomUUID, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../env.js', () => ({ CONTROL_API_URL: 'https://control.fixture', NODE_MANAGER_SECRET: 'node-auth-secret',
  RESULT_SIGNING_SECRET: 'independent-session-result-signing-secret-at-least-32' }));
vi.mock('../tls.js', () => ({ controlApiFetch: fixture.fetch }));
const receipt = await import('./node-session-receipt.js');
const registry = await import('./command-completion-registry.js');

const authority = () => ({ workId: randomUUID(), nodeId: 'node-1', nodeFqdn: 'node-1.lab', participant: 'api' as const,
  ownerId: randomUUID(), kind: 'ssh-command' as const, operationSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64),
  fence: '9', deadline: Date.now() + 60_000 });
const completed = (value: ReturnType<typeof authority>) => ({ state: 'completed' as const, evidence: { version: 1 as const,
  commandId: 'bounded-one', requestSha256: value.operationSha256, unit: `magnus-exec-${'c'.repeat(64)}.service`,
  bootId: randomUUID(), deadline: value.deadline, invocationId: 'd'.repeat(32),
  cgroup: `/system.slice/magnus-exec-${'c'.repeat(64)}.service`, startedAt: Date.now(), terminalAt: Date.now() + 1, groupEmpty: true as const,
  completionOwner: { version: 1 as const, registrySha256: registry.COMMAND_COMPLETION_REGISTRY_SHA256,
    descriptorId: 'diagnostics-uptime-v1' } },
  result: { exitCode: 0, stdout: 'done', stderr: '', durationMs: 1, truncated: false } });

describe('node session receipt producer', () => {
  it('signs the exact authority and independently supervised terminal evidence', () => {
    const work = authority(); const result = receipt.issueNodeSessionReceipt(work, completed(work));
    const { signature, ...unsigned } = result;
    expect(signature).toBe(createHmac('sha256', 'independent-session-result-signing-secret-at-least-32')
      .update(receipt.nodeSessionReceiptSigningPayload(unsigned)).digest('hex'));
    expect(result).toMatchObject({ workId: work.workId, requestSha256: work.requestSha256, fence: work.fence,
      groupEmpty: true, effectBoundary: 'bounded-node-process', disposition: 'succeeded',
      completionRegistrySha256: registry.COMMAND_COMPLETION_REGISTRY_SHA256, completionDescriptorId: 'diagnostics-uptime-v1' });
    expect(receipt.issueNodeSessionReceipt(work, { ...completed(work), evidence: { ...completed(work).evidence,
      bootId: result.bootId, invocationId: result.invocationId, cgroup: result.cgroup,
      startedAt: result.startedAt, terminalAt: result.terminalAt } })).toEqual(result);
  });

  it.each([
    { state: 'running' as const },
    { evidence: { groupEmpty: false } },
    { evidence: { requestSha256: 'f'.repeat(64) } },
    { evidence: { deadline: Date.now() + 120_000 } },
    { evidence: { invocationId: undefined } },
    { evidence: { cgroup: '/system.slice/other.service' } },
    { evidence: { completionOwner: undefined } },
    { evidence: { completionOwner: { version: 1, registrySha256: 'f'.repeat(64), descriptorId: 'diagnostics-uptime-v1' } } },
  ])('fails closed for incomplete or mismatched supervisor evidence %#', patch => {
    const work = authority(); const status = completed(work);
    const changed = { ...status, ...patch, evidence: { ...status.evidence, ...('evidence' in patch ? patch.evidence : {}) } };
    expect(() => receipt.issueNodeSessionReceipt(work, changed as never)).toThrow();
  });

  it.each([
    { participant: 'api' as const, kind: 'agent-deploy' as const },
    { participant: 'dashboard' as const, kind: 'terminal-http' as const },
  ])('does not let the uptime descriptor attest participant effect $participant/$kind', patch => {
    const work = { ...authority(), ...patch };
    expect(() => receipt.issueNodeSessionReceipt(work, completed(work as ReturnType<typeof authority>)))
      .toThrow('approved bounded completion owner');
  });

  it('recovers the same supervisor ID, publishes one exact receipt, and never dispatches', async () => {
    const work = authority(); const status = completed(work);
    fixture.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { workId: work.workId, state: 'released' } }), { status: 200 }));
    const supervisor = { status: vi.fn(async () => status), run: vi.fn() };
    await expect(receipt.recoverAndPublishNodeSessionReceipt(work, 'bounded-one', supervisor as never)).resolves.toMatchObject({ workId: work.workId });
    expect(supervisor.status).toHaveBeenCalledWith('bounded-one', work.operationSha256);
    expect(supervisor.run).not.toHaveBeenCalled();
    expect(fixture.fetch).toHaveBeenCalledWith(expect.stringContaining(`/work/${work.workId}/node-receipt`), expect.objectContaining({ method: 'POST' }));
  });
});
