import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as auth from './node-request-auth.js';

const vectors = JSON.parse(readFileSync(new URL('../../../../services/control-api/src/security/node-request-auth.vectors.json', import.meta.url), 'utf8')) as {
  nodeKey: { publicKey: string; keyId: string; fingerprint: string };
  requests: Array<{ name: string; publicKey: string; keyId: string; audience: string; nodeId: string; method: string;
    pathWithQuery: string; body: string; bodySha256: string; now: number; canonical: string; headers: Record<string, string> }>;
  enrollment: Array<{ name: string; purpose: auth.EnrollmentPurpose; publicKey: string; fqdn: string; binding: string;
    timestamp: string; nonce: string; signature: string; now: number; payload: string }>;
};

function signed(overrides: Partial<auth.SignNodeRequestInput> = {}) {
  const key = auth.generateSigningKey();
  const input: auth.SignNodeRequestInput = { privateKey: auth.privateKeyFromPem(key.privateKeyPem), keyId: key.keyId, nodeId: 'node-a',
    audience: auth.serverAudience('a'.repeat(64)), method: 'POST', pathWithQuery: '/api/v1/heartbeat?x=1', body: '{"fqdn":"node-a.example.com"}',
    now: 1_794_000_000_000, ...overrides };
  const wire = auth.signNodeRequest(input);
  const headers = auth.readNodeAuthHeaders(name => wire[name]);
  if (!headers || headers === 'MALFORMED') throw new Error('fixture');
  const verify = (change: Partial<auth.VerifyNodeRequestInput> = {}) => auth.verifyNodeRequest({ headers, publicKey: key.publicKey,
    expectedNodeId: 'node-a', audiences: [auth.serverAudience('a'.repeat(64))], method: 'POST', pathWithQuery: '/api/v1/heartbeat?x=1',
    body: '{"fqdn":"node-a.example.com"}', now: 1_794_000_000_000, ...change });
  return { key, headers, verify };
}

describe('node request signatures', () => {
  it('is the same file in the agent and the server', () => {
    const agentCopy = readFileSync(new URL('../../../../services/control-api/src/security/node-request-auth.ts', import.meta.url), 'utf8');
    expect(agentCopy).toBe(readFileSync(new URL('./node-request-auth.ts', import.meta.url), 'utf8'));
  });

  it.each(vectors.requests)('verifies the cross-wire vector: $name', vector => {
    expect(auth.sha256Hex(vector.body)).toBe(vector.bodySha256);
    expect(auth.keyIdOfSpki(vector.publicKey)).toBe(vector.keyId);
    const headers = auth.readNodeAuthHeaders(name => vector.headers[name]);
    if (!headers || headers === 'MALFORMED') throw new Error('vector headers');
    expect(auth.canonicalNodeRequest({ method: vector.method, pathWithQuery: vector.pathWithQuery, audience: vector.audience,
      nodeId: vector.nodeId, timestamp: headers.timestamp, nonce: headers.nonce, bodySha256: vector.bodySha256 })).toBe(vector.canonical);
    expect(auth.verifyNodeRequest({ headers, publicKey: vector.publicKey, expectedNodeId: vector.nodeId, audiences: ['other:x', vector.audience],
      method: vector.method, pathWithQuery: vector.pathWithQuery, body: Buffer.from(vector.body, 'utf8'), now: vector.now + 59_000 })).toEqual({ ok: true });
  });

  it.each(vectors.enrollment)('verifies the enrollment proof vector: $name', vector => {
    expect(auth.enrollmentProofPayload(vector)).toBe(vector.payload);
    expect(auth.verifyEnrollmentProof(vector, vector.now)).toEqual({ ok: true });
    expect(auth.verifyEnrollmentProof({ ...vector, fqdn: 'other.example.com' }, vector.now)).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(auth.verifyEnrollmentProof({ ...vector, purpose: 'rotate' }, vector.now)).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(auth.verifyEnrollmentProof({ ...vector, binding: 'b'.repeat(64) }, vector.now)).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(auth.verifyEnrollmentProof(vector, vector.now + 61_000)).toEqual({ ok: false, reason: 'SKEW' });
    expect(auth.keyFingerprint(vectors.nodeKey.keyId)).toBe(vectors.nodeKey.fingerprint);
  });

  it('refuses a tampered body, path, query, method, node or audience', () => {
    const { verify } = signed();
    expect(verify()).toEqual({ ok: true });
    expect(verify({ body: '{"fqdn":"node-b.example.com"}' })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verify({ pathWithQuery: '/api/v1/heartbeat/stream?x=1' })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verify({ pathWithQuery: '/api/v1/heartbeat?x=2' })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verify({ pathWithQuery: '/api/v1/heartbeat' })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verify({ method: 'PUT' })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verify({ audiences: [auth.serverAudience('b'.repeat(64))] })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verify({ audiences: [auth.nodeAudience('node-a')] })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verify({ audiences: [] })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(verify({ expectedNodeId: 'node-b' })).toEqual({ ok: false, reason: 'NODE_MISMATCH' });
  });

  it('refuses a request outside the clock window in either direction', () => {
    const { verify } = signed();
    expect(verify({ now: 1_794_000_060_000 })).toEqual({ ok: true });
    expect(verify({ now: 1_794_000_060_001 })).toEqual({ ok: false, reason: 'SKEW' });
    expect(verify({ now: 1_793_999_939_999 })).toEqual({ ok: false, reason: 'SKEW' });
  });

  it('refuses another key, even one presented under the signer\'s key id', () => {
    const { headers, verify } = signed();
    const other = auth.generateSigningKey();
    expect(verify({ publicKey: other.publicKey })).toEqual({ ok: false, reason: 'KEY_MISMATCH' });
    expect(auth.verifyNodeRequest({ headers: { ...headers, keyId: other.keyId }, publicKey: other.publicKey, expectedNodeId: 'node-a',
      audiences: [auth.serverAudience('a'.repeat(64))], method: 'POST', pathWithQuery: '/api/v1/heartbeat?x=1',
      body: '{"fqdn":"node-a.example.com"}', now: 1_794_000_000_000 })).toEqual({ ok: false, reason: 'SIGNATURE' });
  });

  it('tells an unsigned request from a malformed one', () => {
    const { headers } = signed();
    const wire: Record<string, string> = { 'x-magnus-node-id': headers.nodeId, 'x-magnus-key-id': headers.keyId,
      'x-magnus-timestamp': headers.timestamp, 'x-magnus-nonce': headers.nonce, 'x-magnus-signature': headers.signature };
    expect(auth.readNodeAuthHeaders(() => undefined)).toBeNull();
    expect(auth.readNodeAuthHeaders(name => wire[name])).toEqual(headers);
    for (const [name, bad] of [['x-magnus-signature', ''], ['x-magnus-timestamp', '12'], ['x-magnus-nonce', 'short'],
      ['x-magnus-key-id', 'A'.repeat(64)], ['x-magnus-node-id', 'a b']] as const)
      expect(auth.readNodeAuthHeaders(header => header === name ? bad : wire[header])).toBe('MALFORMED');
  });

  it('accepts only Ed25519 SPKI public keys and never signs a field with a line break', () => {
    expect(() => auth.publicKeyFromSpki('not-a-key')).toThrow();
    expect(() => auth.publicKeyFromSpki(Buffer.alloc(44).toString('base64'))).toThrow();
    const key = auth.generateSigningKey();
    expect(() => auth.signNodeRequest({ privateKey: auth.privateKeyFromPem(key.privateKeyPem), keyId: key.keyId, nodeId: 'n',
      audience: 'server:x\nnode:y', method: 'GET', pathWithQuery: '/', body: '' })).toThrow('audience');
    expect(() => auth.canonicalNodeRequest({ method: 'GET', pathWithQuery: 'api', audience: 'a', nodeId: 'n', timestamp: '1', nonce: 'n',
      bodySha256: 'a'.repeat(64) })).toThrow('pathWithQuery');
    expect(auth.pathWithQueryOf('https://magnus.example.com:4000/api/v1/x?a=%2F&b=1#f')).toBe('/api/v1/x?a=%2F&b=1');
  });

  it('accepts a nonce once per key inside the TTL and fails closed when full', () => {
    const cache = new auth.NonceCache(120_000, 2);
    expect(cache.claim('k1', 'n1', 1000)).toBe(true);
    expect(cache.claim('k1', 'n1', 2000)).toBe(false);
    expect(cache.claim('k2', 'n1', 2000)).toBe(true);
    expect(cache.claim('k3', 'n1', 3000)).toBe(false);
    expect(cache.claim('k1', 'n1', 121_001)).toBe(true);
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});
