import { describe, expect, it } from 'vitest';
import { cachedControlNode, nodeFromCache, parseCachedControlNode } from './control-node-cache';

const node = { id: 'n1', name: 'Node', url: 'https://magnus.example.com', hasApiSecret: true, apiSecretFingerprint: 'fingerprint-fixture',
  hasToken: true, tokenFingerprint: 'token-fingerprint-fixture', createdAt: '2026-11-02T00:00:00.000Z' };
const safe = { id: 'n1', name: 'Node', url: 'https://magnus.example.com', createdAt: '2026-11-02T00:00:00.000Z' };

describe('control node browser cache', () => {
  it('never writes anything about credentials', () => {
    expect(cachedControlNode(node)).toEqual(safe);
    expect(JSON.stringify(cachedControlNode(node))).not.toMatch(/ingerprint|hasApiSecret|hasToken/);
  });

  it('drops plaintext and fingerprint fields from older copies', () => {
    const parsed = parseCachedControlNode(JSON.stringify({ ...node, apiSecret: 'fake-secret', token: 'fake-token' }));
    expect(parsed).toEqual(safe);
    expect(JSON.stringify(parsed)).not.toMatch(/fake-|ingerprint|hasApiSecret|hasToken/);
  });

  it('rejects a malformed copy and throws on broken JSON for the caller to handle', () => {
    expect(parseCachedControlNode(JSON.stringify({ id: 'n1' }))).toBeNull();
    expect(() => parseCachedControlNode('{')).toThrow();
  });

  it('restores a usable node until the server response replaces it', () => {
    expect(nodeFromCache(safe)).toEqual({ ...safe, hasApiSecret: false, apiSecretFingerprint: null, hasToken: false, tokenFingerprint: null });
  });
});
