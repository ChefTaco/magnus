import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as evidence from './node-evidence.js';
import { generateSigningKey, privateKeyFromPem } from './node-request-auth.js';

type Signature = evidence.EvidenceSignature;
const vectors = JSON.parse(readFileSync(new URL('./node-evidence.vectors.json', import.meta.url), 'utf8')) as {
  nodeId: string;
  nodeKey: { publicKey: string; keyId: string };
  serverKey: { publicKey: string; keyId: string };
  evidence: Array<{ name: string; kind: evidence.NodeEvidenceKind; payload: string; signingInput: string; signature: Signature }>;
  authorizations: Array<{ name: string; kind: evidence.ServerAuthorizationKind; payload: string; signingInput: string; signature: Signature }>;
};

describe('node evidence signatures', () => {
  it('is the same file in the server and the agent', () => {
    const agentCopy = readFileSync(new URL('../../../../packages/agent/src/security/node-evidence.ts', import.meta.url), 'utf8');
    expect(agentCopy).toBe(readFileSync(new URL('./node-evidence.ts', import.meta.url), 'utf8'));
  });

  it('has a vector for every evidence and authorization kind', () => {
    expect(new Set(vectors.evidence.map(vector => vector.kind))).toEqual(new Set(evidence.NODE_EVIDENCE_KINDS.filter(kind => kind !== 'terminal-receipt'))); // its payload is managedTerminalReceiptPayload in @hivemagnus/magnus-contracts;
    expect(new Set(vectors.authorizations.map(vector => vector.kind))).toEqual(new Set(evidence.SERVER_AUTHORIZATION_KINDS));
  });

  it.each(vectors.evidence)('verifies the cross-wire evidence vector: $name', vector => {
    expect(evidence.nodeEvidenceSigningInput(vector.kind, vectors.nodeId, vectors.nodeKey.keyId, vector.payload)).toBe(vector.signingInput);
    expect(evidence.readEvidenceSignature(vector.signature)).toEqual(vector.signature);
    expect(evidence.verifyNodeEvidence(vector.kind, { signature: vector.signature, publicKey: vectors.nodeKey.publicKey,
      expectedNodeId: vectors.nodeId, payload: vector.payload })).toEqual({ ok: true });
  });

  it.each(vectors.authorizations)('verifies the cross-wire authorization vector: $name', vector => {
    expect(evidence.serverAuthorizationSigningInput(vector.kind, vectors.nodeId, vectors.serverKey.keyId, vector.payload)).toBe(vector.signingInput);
    expect(evidence.verifyServerAuthorization(vector.kind, { signature: vector.signature, publicKey: vectors.serverKey.publicKey,
      expectedNodeId: vectors.nodeId, payload: vector.payload })).toEqual({ ok: true });
  });

  it('binds evidence to its node, key, kind and payload', () => {
    const vector = vectors.evidence[0]!;
    const input = { signature: vector.signature, publicKey: vectors.nodeKey.publicKey, expectedNodeId: vectors.nodeId, payload: vector.payload };
    // Another node's evidence, even with a genuine signature, is not this node's.
    expect(evidence.verifyNodeEvidence(vector.kind, { ...input, expectedNodeId: 'node-b' })).toEqual({ ok: false, reason: 'NODE_MISMATCH' });
    // A different key (the server's) does not verify a node signature.
    expect(evidence.verifyNodeEvidence(vector.kind, { ...input, publicKey: vectors.serverKey.publicKey })).toEqual({ ok: false, reason: 'KEY_MISMATCH' });
    // A tampered payload, a moved signature or a changed claim of node id are all refused.
    expect(evidence.verifyNodeEvidence(vector.kind, { ...input, payload: vector.payload.replace('"exitCode":0', '"exitCode":1') }))
      .toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(evidence.verifyNodeEvidence('command-refusal', input)).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(evidence.verifyNodeEvidence(vector.kind, { ...input, expectedNodeId: 'node-b', signature: { ...vector.signature, nodeId: 'node-b' } }))
      .toEqual({ ok: false, reason: 'SIGNATURE' });
    // Node evidence is never a server authorization, nor the other way round.
    const authorization = vectors.authorizations[0]!;
    expect(evidence.verifyServerAuthorization(authorization.kind, { signature: vector.signature, publicKey: vectors.nodeKey.publicKey,
      expectedNodeId: vectors.nodeId, payload: vector.payload })).toEqual({ ok: false, reason: 'SIGNATURE' });
  });

  it('signs fresh evidence that only its own key verifies', () => {
    const node = generateSigningKey();
    const signature = evidence.signNodeEvidence(privateKeyFromPem(node.privateKeyPem), node.keyId, 'node-c', 'fence-proof', '{"a":1}');
    expect(evidence.verifyNodeEvidence('fence-proof', { signature, publicKey: node.publicKey, expectedNodeId: 'node-c', payload: '{"a":1}' })).toEqual({ ok: true });
    const other = generateSigningKey();
    expect(evidence.verifyNodeEvidence('fence-proof', { signature: { ...signature, keyId: other.keyId }, publicKey: other.publicKey,
      expectedNodeId: 'node-c', payload: '{"a":1}' })).toEqual({ ok: false, reason: 'SIGNATURE' });
  });

  it('reads only well-formed signatures', () => {
    const good = vectors.evidence[0]!.signature;
    expect(evidence.readEvidenceSignature(undefined)).toBeNull();
    expect(evidence.readEvidenceSignature(null)).toBeNull();
    for (const bad of ['x', [], { ...good, alg: 'hmac' }, { ...good, v: 2 }, { ...good, sig: 'short' }, { ...good, keyId: 'A'.repeat(64) },
      { ...good, extra: 1 }, { ...good, nodeId: 'bad id' }])
      expect(evidence.readEvidenceSignature(bad)).toBe('MALFORMED');
  });

  it('refuses unknown kinds and empty payloads', () => {
    expect(() => evidence.nodeEvidenceSigningInput('other' as evidence.NodeEvidenceKind, 'node-a', 'a'.repeat(64), 'x')).toThrow();
    expect(() => evidence.nodeEvidenceSigningInput('fence-proof', 'node-a', 'a'.repeat(64), '')).toThrow();
    expect(() => evidence.serverAuthorizationSigningInput('fence-proof' as evidence.ServerAuthorizationKind, 'node-a', 'a'.repeat(64), 'x')).toThrow();
  });
});
