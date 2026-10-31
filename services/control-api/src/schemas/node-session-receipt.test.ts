import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalNodeSessionReceipt, nodeSessionReceiptSchema, nodeSessionReceiptUnsignedSchema, nodeSessionReceiptSigningPayload,
  verifyNodeSessionReceiptSignature } from './node-session-receipt.js';

const secret = 'node-session-receipt-test-secret-at-least-32-characters';
const unsigned = () => nodeSessionReceiptUnsignedSchema.parse({
  version: 1, workId: randomUUID(), nodeId: 'node-1', nodeFqdn: 'node-1.lab', participant: 'api', ownerId: randomUUID(),
  kind: 'ssh-command', operationSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64), fence: '7',
  deadline: Date.now() + 60_000, bootId: randomUUID(), unit: `magnus-exec-${'c'.repeat(64)}.service`,
  invocationId: 'd'.repeat(32), cgroup: `/system.slice/magnus-exec-${'c'.repeat(64)}.service`,
  startedAt: Date.now(), terminalAt: Date.now() + 1, disposition: 'succeeded', resultSha256: 'e'.repeat(64),
  completionRegistrySha256: '4'.repeat(64), completionDescriptorId: 'diagnostics-uptime-v1',
  groupEmpty: true, effectBoundary: 'bounded-node-process',
});
const signed = () => { const value = unsigned(); return { ...value,
  signature: createHmac('sha256', secret).update(nodeSessionReceiptSigningPayload(value)).digest('hex') }; };

describe('node session terminal receipt', () => {
  it('verifies a domain-separated exact supervised terminal envelope', () => {
    const value = signed();
    expect(verifyNodeSessionReceiptSignature(value, secret)).toBe(true);
    expect(canonicalNodeSessionReceipt(value)).toContain('magnus.node-session-terminal.v1');
  });

  it.each(['workId', 'nodeFqdn', 'participant', 'kind', 'operationSha256', 'requestSha256', 'fence', 'deadline',
    'bootId', 'unit', 'invocationId', 'cgroup', 'startedAt', 'terminalAt', 'disposition', 'resultSha256',
    'completionRegistrySha256', 'completionDescriptorId'] as const)(
    'rejects signed identity tampering of %s', key => {
      const value = signed();
      const replacements: Record<string, unknown> = { workId: randomUUID(), nodeFqdn: 'other.lab', participant: 'dashboard',
        kind: 'agent-deploy', operationSha256: 'f'.repeat(64), requestSha256: '0'.repeat(64), fence: '8',
        deadline: value.deadline - 1, bootId: randomUUID(), unit: `magnus-exec-${'1'.repeat(64)}.service`,
        invocationId: '2'.repeat(32), cgroup: `/system.slice/magnus-exec-${'1'.repeat(64)}.service`,
        startedAt: value.startedAt - 1, terminalAt: value.terminalAt + 1, disposition: 'failed', resultSha256: '3'.repeat(64),
        completionRegistrySha256: '5'.repeat(64), completionDescriptorId: 'other-v1' };
      expect(verifyNodeSessionReceiptSignature({ ...value, [key]: replacements[key] }, secret)).toBe(false);
    });

  it('rejects absent group-empty proof, external effects, and mismatched cgroups', () => {
    const value = signed();
    expect(nodeSessionReceiptSchema.safeParse({ ...value, groupEmpty: false }).success).toBe(false);
    expect(nodeSessionReceiptSchema.safeParse({ ...value, effectBoundary: 'external-unverified' }).success).toBe(false);
    expect(nodeSessionReceiptSchema.safeParse({ ...value, cgroup: '/system.slice/other.service' }).success).toBe(false);
  });
});
