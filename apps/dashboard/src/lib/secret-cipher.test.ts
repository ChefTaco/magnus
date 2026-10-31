/**
 * Unit tests for secret-cipher — AES-256-GCM encrypt/decrypt helpers.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// Set independent deterministic keys before importing the module.
beforeAll(() => {
  process.env['SESSION_SECRET'] = 'legacy-session-secret-for-unit-tests';
  process.env['CONTROL_NODE_CREDENTIAL_KEY'] = 'dedicated-control-node-key-for-unit-tests';
});

const { encryptSecret, decryptSecret } = await import('@/lib/secret-cipher');

describe('encryptSecret', () => {
  it('returns empty string unchanged', () => {
    expect(encryptSecret('')).toBe('');
  });

  it('returns enc:-prefixed string for non-empty input', () => {
    const result = encryptSecret('my-api-secret');
    expect(result).toMatch(/^enc2:/);
  });

  it('produces different ciphertext each call (random IV)', () => {
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    expect(a).not.toBe(b);
  });

  it('is idempotent — does not double-encrypt already-encrypted values', () => {
    const encrypted = encryptSecret('my-secret');
    expect(encryptSecret(encrypted)).toBe(encrypted);
  });
});

describe('decryptSecret', () => {
  it('returns empty string unchanged', () => {
    expect(decryptSecret('')).toBe('');
  });

  it('returns plaintext values unchanged (no enc: prefix)', () => {
    expect(decryptSecret('plain-text-secret')).toBe('plain-text-secret');
  });

  it('correctly decrypts an encrypted value', () => {
    const original = 'super-secret-api-key';
    const encrypted = encryptSecret(original);
    expect(decryptSecret(encrypted)).toBe(original);
  });

  it('round-trips values with special characters', () => {
    const original = 'a$b!c@d#e%f^g&h*i(j)k=l+m/n;o:p"q\'r';
    expect(decryptSecret(encryptSecret(original))).toBe(original);
  });

  it('fails closed for malformed ciphertext', () => {
    expect(() => decryptSecret('enc2:baddata')).toThrow(/malformed/);
  });

  it('rejects a dedicated key reused from an authentication purpose', () => {
    const dedicated = process.env['CONTROL_NODE_CREDENTIAL_KEY'];
    process.env['API_SECRET'] = dedicated;
    expect(() => encryptSecret('must-not-encrypt')).toThrow(/distinct from API_SECRET/);
    delete process.env['API_SECRET'];
  });
});
