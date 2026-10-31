import 'server-only';

/**
 * AES-256-GCM encryption helpers for secrets stored at rest on disk.
 *
 * New records use the dedicated CONTROL_NODE_CREDENTIAL_KEY. Legacy `enc:`
 * records are decrypted with the historical JWT/SESSION derivation and are
 * atomically rewritten by control-nodes-store as `enc2:` records.
 *
 * Encrypted format: `enc2:<iv_b64>:<authTag_b64>:<ciphertext_b64>`
 *   - iv        — 12-byte random IV (standard for GCM)
 *   - authTag   — 16-byte GCM authentication tag (integrity)
 *   - ciphertext — variable-length AES-256-GCM output
 *
 * Plaintext values are returned unchanged only so the protected store can
 * migrate pre-existing data in one authenticated atomic rewrite.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const MARKER = 'enc2:';
const LEGACY_MARKER = 'enc:';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function getDedicatedKey(): Buffer {
  const secret = process.env['CONTROL_NODE_CREDENTIAL_KEY'] ?? '';
  if (secret.length < 32) {
    throw new Error('CONTROL_NODE_CREDENTIAL_KEY must contain at least 32 characters');
  }
  for (const name of ['API_SECRET', 'SESSION_SECRET', 'JWT_SECRET'] as const) {
    if (process.env[name] && process.env[name] === secret) {
      throw new Error(`CONTROL_NODE_CREDENTIAL_KEY must be distinct from ${name}`);
    }
  }
  return deriveKey(secret);
}

function getLegacyKey(): Buffer {
  const secret = process.env['JWT_SECRET'] ?? process.env['SESSION_SECRET'] ?? '';
  if (!secret) throw new Error('Legacy control-node credential key is unavailable');
  return deriveKey(secret);
}

/**
 * Encrypt a plaintext secret string.
 * Returns the encrypted value in `enc2:<iv>:<tag>:<ct>` format.
 * Empty strings are returned unchanged (nothing to encrypt).
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return plaintext;
  // Skip re-encrypting already-encrypted values (idempotent writes)
  if (plaintext.startsWith(MARKER)) return plaintext;

  const key = getDedicatedKey();
  const iv = randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16-byte authentication tag

  return `${MARKER}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypt a value produced by `encryptSecret`.
 * If the value is plaintext, returns it unchanged solely for the protected
 * store's migration path. Wrong-key, corrupt, or malformed ciphertext throws.
 */
export function decryptSecret(value: string): string {
  if (!value || (!value.startsWith(MARKER) && !value.startsWith(LEGACY_MARKER))) return value;

  const legacy = value.startsWith(LEGACY_MARKER) && !value.startsWith(MARKER);
  const marker = legacy ? LEGACY_MARKER : MARKER;
  const parts = value.slice(marker.length).split(':');
  if (parts.length !== 3) throw new Error('Stored control-node credential ciphertext is malformed');

  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  try {
    const key = legacy ? getLegacyKey() : getDedicatedKey();
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct).toString('utf-8') + decipher.final('utf-8');
  } catch (error) {
    throw new Error('Stored control-node credential failed authenticated decryption', { cause: error });
  }
}

export function requiresCredentialMigration(value: string | undefined): boolean {
  return Boolean(value && !value.startsWith(MARKER));
}
