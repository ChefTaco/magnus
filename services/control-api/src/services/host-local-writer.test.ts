import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// These cases exercise shared-secret paths, which 3.0.0 keeps only under an explicit NODE_AUTH_MODE=compat (or warn).
beforeEach(() => { process.env['NODE_AUTH_MODE'] = 'compat'; });
afterEach(() => { delete process.env['NODE_AUTH_MODE']; });
// The policy below is built at load time, so the mode has to be set before it too.
process.env['NODE_AUTH_MODE'] = 'compat';

const secret = 'dedicated-result-signing-secret-for-owner-proof';
vi.mock('../utils/env.js', () => ({ RESULT_SIGNING_SECRET: secret,
  getNodeManagerSecret: () => 'node-token' }));
const { evidencePolicyFor } = await import('./node-evidence-policy.js');
const { createFakeCredentialStore, fixtureAgentKey } = await import('./node-credential-test-fixture.js');
const policy = evidencePolicyFor('node-1', []);
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
    expect(verifyHostLocalWriterProof(proof, expected, 1_001_000, policy)).toMatchObject({
      mutationInventorySha256: proof.mutationInventorySha256,
      admissionFenceSha256: proof.admissionFenceSha256,
      ownerReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(verifyHostLocalWriterProof(proof, { ...expected, nonce: randomUUID() }, 1_001_000, policy)).toBeNull();
    expect(verifyHostLocalWriterProof(proof, { ...expected, epoch: 3 }, 1_001_000, policy)).toBeNull();
    expect(verifyHostLocalWriterProof(proof, expected, 1_021_000, policy)).toBeNull();
    expect(verifyHostLocalWriterProof({ ...proof, admissionFenceSha256: 'c'.repeat(64) }, expected, 1_001_000, policy)).toBeNull();
    expect(verifyHostLocalWriterProof(signed({ admissionFenceSha256: 'c'.repeat(64),
      nonce: proof.nonce, barrierId: proof.barrierId }), expected, 1_001_000, policy)).toBeNull();
    expect(verifyHostLocalWriterProof(signed({ unknown: 1, nonce: proof.nonce,
      barrierId: proof.barrierId }), expected, 1_001_000, policy)).toBeNull();
  });
  it('verifies the node key signature, binds it to the node, and refuses HMAC-only proofs once the node signs its evidence', () => {
    const agent = fixtureAgentKey();
    const fake = createFakeCredentialStore();
    fake.state.credentials.push({ id: 'c1', nodeId: 'node-1', keyId: agent.keyId, publicKey: agent.publicKey, status: 'ACTIVE', origin: 'LEGACY_UPGRADE',
      boundFqdn: 'magnus.example.test', createdAt: new Date(), lastUsedAt: null, retireAt: null, revokedAt: null, revokedBy: null,
      evidenceSigning: false, evidenceSigningAt: null });
    const proof = signed();
    const { signature: _hmac, ...receipt } = proof;
    const nodeSignature = agent.evidence('node-1', 'host-local-writer', 'magnus.host-local-writer.v1\n' + canonical(receipt));
    const expected = { nodeId: proof.nodeId, nodeFqdn: proof.nodeFqdn, nonce: proof.nonce, epoch: proof.epoch, barrierId: proof.barrierId };
    const keyed = evidencePolicyFor('node-1', fake.state.credentials);
    // A valid node signature verifies, even with a wrong HMAC next to it.
    expect(verifyHostLocalWriterProof({ ...proof, signature: 'f'.repeat(64), nodeSignature }, expected, 1_001_000, keyed)).not.toBeNull();
    // Tampered payload and another node's identity are refused whatever the HMAC says; a key this node does not hold
    // counts as no signature, so only a valid HMAC (and no ratchet) could carry it.
    expect(verifyHostLocalWriterProof({ ...proof, observedAt: 1_000_500, nodeSignature }, expected, 1_001_000, keyed)).toBeNull();
    expect(verifyHostLocalWriterProof({ ...proof, nodeSignature: { ...nodeSignature, nodeId: 'node-2' } }, expected, 1_001_000, keyed)).toBeNull();
    const other = fixtureAgentKey();
    fake.state.credentials.push({ ...fake.state.credentials[0]!, id: 'c2', nodeId: 'node-2', keyId: other.keyId, publicKey: other.publicKey });
    expect(verifyHostLocalWriterProof({ ...proof, signature: 'f'.repeat(64), nodeSignature: other.evidence('node-1', 'host-local-writer', 'magnus.host-local-writer.v1\n' + canonical(receipt)) }, expected, 1_001_000,
      evidencePolicyFor('node-1', fake.state.credentials.filter(row => row.nodeId === 'node-1')))).toBeNull();
    // A policy loaded for another node never accepts this node's proof.
    expect(verifyHostLocalWriterProof({ ...proof, nodeSignature }, expected, 1_001_000, evidencePolicyFor('node-2', []))).toBeNull();
    // HMAC fallback: accepted while the node's agent does not sign evidence, refused once it does.
    expect(verifyHostLocalWriterProof(proof, expected, 1_001_000, keyed)).not.toBeNull();
    fake.state.credentials[0]!.evidenceSigning = true;
    expect(verifyHostLocalWriterProof(proof, expected, 1_001_000, evidencePolicyFor('node-1', fake.state.credentials))).toBeNull();
    expect(verifyHostLocalWriterProof({ ...proof, nodeSignature }, expected, 1_001_000, evidencePolicyFor('node-1', fake.state.credentials))).not.toBeNull();
  });
});
