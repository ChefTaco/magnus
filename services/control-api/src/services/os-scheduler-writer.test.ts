import { createHash, createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const secret = 'dedicated-result-signing-secret-for-owner-proof';
vi.mock('../utils/env.js', () => ({ RESULT_SIGNING_SECRET: secret,
  getNodeManagerSecret: () => 'node-token' }));
const { verifyOsSchedulerWriterProof } = await import('./os-scheduler-writer.js');
const { canonical } = await import('./resource-enrollment.js');
const DOMAIN = 'magnus.os-scheduler-writer.v1\n';

function signed(overrides: Record<string, unknown> = {}) {
  const identity = { nodeId: 'node-1', nodeFqdn: 'magnus.example.test', epoch: 2, barrierId: randomUUID() };
  const receipt = { version: 1, sourceClass: 'os-schedulers', ...identity, nonce: randomUUID(),
    observedAt: 1_000_000, active: 0, unknown: 0, scheduleInventorySha256: 'a'.repeat(64),
    admissionFenceSha256: createHash('sha256').update(canonical({ sourceClass: 'os-schedulers', ...identity })).digest('hex'),
    ...overrides };
  return { ...receipt, signature: createHmac('sha256', secret).update(DOMAIN + canonical(receipt)).digest('hex') };
}

describe('owner-signed OS scheduler proof', () => {
  it('accepts only fresh zero-work evidence for the exact node, nonce, and fence', () => {
    const proof = signed();
    const expected = { nodeId: proof.nodeId, nodeFqdn: proof.nodeFqdn, nonce: proof.nonce,
      epoch: proof.epoch, barrierId: proof.barrierId };
    expect(verifyOsSchedulerWriterProof(proof, expected, 1_001_000)).toMatchObject({
      scheduleInventorySha256: proof.scheduleInventorySha256,
      admissionFenceSha256: proof.admissionFenceSha256,
      ownerReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(verifyOsSchedulerWriterProof(proof, { ...expected, nonce: randomUUID() }, 1_001_000)).toBeNull();
    expect(verifyOsSchedulerWriterProof(proof, { ...expected, epoch: 3 }, 1_001_000)).toBeNull();
    expect(verifyOsSchedulerWriterProof(proof, expected, 1_021_000)).toBeNull();
    expect(verifyOsSchedulerWriterProof({ ...proof, scheduleInventorySha256: 'b'.repeat(64) }, expected, 1_001_000)).toBeNull();
    expect(verifyOsSchedulerWriterProof(signed({ admissionFenceSha256: 'b'.repeat(64),
      nonce: proof.nonce, barrierId: proof.barrierId }), expected, 1_001_000)).toBeNull();
    expect(verifyOsSchedulerWriterProof(signed({ unknown: 1, nonce: proof.nonce,
      barrierId: proof.barrierId }), expected, 1_001_000)).toBeNull();
  });
});
