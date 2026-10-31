import { createHash, createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const secret = 'dedicated-result-signing-secret-for-owner-proof';
vi.mock('../utils/env.js', () => ({ RESULT_SIGNING_SECRET: secret,
  getNodeManagerSecret: () => 'node-token' }));
const { verifyHostLocalWriterProof } = await import('./host-local-writer.js');
const { canonical } = await import('./resource-enrollment.js');
const DOMAIN = 'magnus.host-local-writer.v1\n';

function signed(overrides: Record<string, unknown> = {}) {
  const identity = { nodeId: 'node-1', nodeFqdn: 'magnus.example.test', epoch: 2, barrierId: randomUUID() };
  const receipt = { version: 1, sourceClass: 'host-local-mutations', ...identity,
    nonce: randomUUID(),
    observedAt: 1_000_000, active: 0, unknown: 0,
    mutationInventorySha256: 'a'.repeat(64),
    admissionFenceSha256: createHash('sha256').update(canonical(identity)).digest('hex'), ...overrides };
  return { ...receipt, signature: createHmac('sha256', secret).update(DOMAIN + canonical(receipt)).digest('hex') };
}

describe('owner-signed host-local writer proof', () => {
  it('accepts only fresh zero-work evidence for the exact node, nonce, and drain', () => {
    const proof = signed();
    const expected = { nodeId: proof.nodeId, nodeFqdn: proof.nodeFqdn, nonce: proof.nonce,
      epoch: proof.epoch, barrierId: proof.barrierId };
    expect(verifyHostLocalWriterProof(proof, expected, 1_001_000)).toMatchObject({
      mutationInventorySha256: proof.mutationInventorySha256,
      admissionFenceSha256: proof.admissionFenceSha256,
      ownerReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(verifyHostLocalWriterProof(proof, { ...expected, nonce: randomUUID() }, 1_001_000)).toBeNull();
    expect(verifyHostLocalWriterProof(proof, { ...expected, epoch: 3 }, 1_001_000)).toBeNull();
    expect(verifyHostLocalWriterProof(proof, expected, 1_021_000)).toBeNull();
    expect(verifyHostLocalWriterProof({ ...proof, admissionFenceSha256: 'c'.repeat(64) }, expected, 1_001_000)).toBeNull();
    expect(verifyHostLocalWriterProof(signed({ admissionFenceSha256: 'c'.repeat(64),
      nonce: proof.nonce, barrierId: proof.barrierId }), expected, 1_001_000)).toBeNull();
    expect(verifyHostLocalWriterProof(signed({ unknown: 1, nonce: proof.nonce,
      barrierId: proof.barrierId }), expected, 1_001_000)).toBeNull();
  });
});
