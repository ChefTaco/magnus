import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'magnus-credential-rotation-'));
  process.env['CREDENTIAL_ROTATION_STATE_PATH'] = join(tempDir, 'credential-rotations.json');
  process.env['CREDENTIAL_ROTATION_KEY'] = 'unit-test-rotation-key-that-is-32-bytes';
  process.env['NODE_ENV'] = 'test';
});

afterEach(() => {
  delete process.env['CREDENTIAL_ROTATION_STATE_PATH'];
  delete process.env['CREDENTIAL_ROTATION_KEY'];
  rmSync(tempDir, { recursive: true, force: true });
});

describe('credential rotation service', () => {
  it('stores rotated secrets encrypted at rest and validates active plus previous secrets', async () => {
    const {
      getCredentialRotationStatePath,
      getCredentialStatus,
      resolveCredentialSecret,
      rotateCredential,
      verifyWithRotation,
    } = await import('./credential-rotation-service.js');

    const oldSecret = 'old-node-secret-that-is-at-least-32-chars';
    const rotation = rotateCredential('NODE_MANAGER_SECRET', oldSecret, 60_000);
    const rawStore = readFileSync(getCredentialRotationStatePath(), 'utf-8');

    expect(rawStore).not.toContain(oldSecret);
    expect(rawStore).not.toContain(rotation.newSecret);
    expect(rawStore).toContain(rotation.newFingerprint);

    expect(verifyWithRotation('NODE_MANAGER_SECRET', oldSecret, oldSecret)).toBe(true);
    expect(verifyWithRotation('NODE_MANAGER_SECRET', oldSecret, rotation.newSecret)).toBe(true);
    expect(verifyWithRotation('NODE_MANAGER_SECRET', oldSecret, 'definitely-wrong')).toBe(false);
    expect(resolveCredentialSecret('NODE_MANAGER_SECRET', oldSecret)).toBe(rotation.newSecret);

    const status = getCredentialStatus('NODE_MANAGER_SECRET', oldSecret);
    expect(status.activeFingerprint).toBe(rotation.newFingerprint);
    expect(status.previousFingerprint).toBe(rotation.previousFingerprint);
    expect(status.expiresAt).toBe(rotation.expiresAt);
  });

  it('drops the previous secret after its grace window expires', async () => {
    const {
      getCredentialStatus,
      rotateCredential,
      verifyWithRotation,
    } = await import('./credential-rotation-service.js');

    const oldSecret = 'old-node-secret-that-is-at-least-32-chars';
    const rotation = rotateCredential('NODE_MANAGER_SECRET', oldSecret, -1);

    expect(verifyWithRotation('NODE_MANAGER_SECRET', oldSecret, rotation.newSecret)).toBe(true);
    expect(verifyWithRotation('NODE_MANAGER_SECRET', oldSecret, oldSecret)).toBe(false);

    const status = getCredentialStatus('NODE_MANAGER_SECRET', oldSecret);
    expect(status.previousFingerprint).toBeNull();
  });

  it('caches decrypted state between verifications until the state file changes', async () => {
    const { chmodSync } = await import('node:fs');
    const { credentialRotationStoreReads, getCredentialRotationStatePath, rotateCredential, verifyWithRotation } =
      await import('./credential-rotation-service.js');
    const current = 'api-secret-that-is-at-least-32-characters';
    expect(verifyWithRotation('API_SECRET', current, current)).toBe(true);
    const reads = credentialRotationStoreReads();
    for (let i = 0; i < 50; i += 1) expect(verifyWithRotation('API_SECRET', current, `wrong-${i}`)).toBe(false);
    expect(verifyWithRotation('API_SECRET', current, current)).toBe(true);
    expect(credentialRotationStoreReads()).toBe(reads);

    // A rotation replaces the file, so the next verification sees the new secret at once.
    const rotation = rotateCredential('API_SECRET', current, 60_000);
    expect(verifyWithRotation('API_SECRET', current, rotation.newSecret)).toBe(true);
    expect(credentialRotationStoreReads()).toBe(reads + 1);
    expect(verifyWithRotation('API_SECRET', current, current)).toBe(true);

    // Loosened permissions are noticed on the next call, not hidden by the cache.
    chmodSync(getCredentialRotationStatePath(), 0o644);
    expect(() => verifyWithRotation('API_SECRET', current, current)).toThrow(/mode 0600/);
  });

  it('stops accepting a cached previous secret once its grace window ends', async () => {
    const { rotateCredential, verifyWithRotation } = await import('./credential-rotation-service.js');
    const oldSecret = 'old-node-secret-that-is-at-least-32-chars';
    const rotation = rotateCredential('NODE_MANAGER_SECRET', oldSecret, 200);
    expect(verifyWithRotation('NODE_MANAGER_SECRET', oldSecret, oldSecret)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(verifyWithRotation('NODE_MANAGER_SECRET', oldSecret, oldSecret)).toBe(false);
    expect(verifyWithRotation('NODE_MANAGER_SECRET', oldSecret, rotation.newSecret)).toBe(true);
  });

  it('fails closed on corrupt or weakly protected state instead of resetting it', async () => {
    const { chmodSync, writeFileSync } = await import('node:fs');
    const { getCredentialRotationStatePath, listActiveRotations } = await import('./credential-rotation-service.js');
    const statePath = getCredentialRotationStatePath();
    writeFileSync(statePath, '{not-json}\n', { mode: 0o600 });
    expect(() => listActiveRotations()).toThrow();
    writeFileSync(statePath, '{"version":1,"credentials":{}}\n');
    chmodSync(statePath, 0o644);
    expect(() => listActiveRotations()).toThrow(/mode 0600/);
  });

  it('requires a dedicated encryption key', async () => {
    const { resolveCredentialSecret } = await import('./credential-rotation-service.js');
    process.env['CREDENTIAL_ROTATION_KEY'] = 'short';
    expect(() => resolveCredentialSecret('API_SECRET', 'a'.repeat(32))).toThrow(/dedicated secret/);
  });

  it('keeps status reads byte-identical and never initializes an absent record', async () => {
    const {
      getCredentialRotationStatePath,
      getCredentialStatus,
      listActiveRotations,
      rotateCredential,
    } = await import('./credential-rotation-service.js');
    rotateCredential('API_SECRET', 'api-secret-that-is-at-least-32-characters', 60_000);
    const statePath = getCredentialRotationStatePath();
    const before = readFileSync(statePath);

    const status = getCredentialStatus(
      'RESULT_SIGNING_SECRET',
      'result-secret-that-is-at-least-32-characters',
    );
    expect(status.previousFingerprint).toBeNull();
    expect(listActiveRotations().map((entry) => entry.name)).toEqual(['API_SECRET']);
    expect(readFileSync(statePath)).toEqual(before);
  });

  it('rejects empty and undersized credentials before state can be created', async () => {
    const { getCredentialRotationStatePath, getCredentialStatus, resolveCredentialSecret } =
      await import('./credential-rotation-service.js');
    expect(() => getCredentialStatus('RESULT_SIGNING_SECRET', '')).toThrow(/at least 32/);
    expect(() => resolveCredentialSecret('NODE_MANAGER_SECRET', 'short')).toThrow(/at least 32/);
    expect(() => readFileSync(getCredentialRotationStatePath())).toThrow();
  });

  it('accepts a weak legacy value only as a one-hour previous retirement credential', async () => {
    const { getCredentialRotationStatePath, verifyWithRotation } =
      await import('./credential-rotation-service.js');
    const name = 'API_SECRET';
    const active = 'new-api-purpose-secret-that-is-at-least-32-characters';
    const legacy = 'legacy-shared-key';
    const encryptionKey = createHash('sha256')
      .update(process.env['CREDENTIAL_ROTATION_KEY']!)
      .digest();
    const makeVersion = (value: string, legacyRetirementOnly = false) => {
      const id = randomBytes(16).toString('base64url');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(Buffer.from(`magnus:credential:${name}:${id}`));
      const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
      const createdAt = new Date().toISOString();
      return {
        id,
        encryptedSecret: `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`,
        fingerprint: createHash('sha256').update(value).digest('hex').slice(0, 12),
        createdAt,
        ...(legacyRetirementOnly
          ? { legacyRetirementOnly: true, expiresAt: new Date(Date.parse(createdAt) + 60 * 60 * 1_000).toISOString() }
          : {}),
      };
    };
    writeFileSync(getCredentialRotationStatePath(), `${JSON.stringify({
      version: 1,
      credentials: {
        API_SECRET: {
          active: makeVersion(active),
          previous: makeVersion(legacy, true),
          gracePeriodMs: 60 * 60 * 1_000,
        },
      },
    })}\n`, { mode: 0o600 });

    expect(verifyWithRotation(name, active, active)).toBe(true);
    expect(verifyWithRotation(name, active, legacy)).toBe(true);

    const store = JSON.parse(readFileSync(getCredentialRotationStatePath(), 'utf8'));
    store.credentials.API_SECRET.previous.expiresAt = new Date(Date.now() + 61 * 60 * 1_000).toISOString();
    // Writers replace the file by rename, as the service itself does.
    writeFileSync(`${getCredentialRotationStatePath()}.tmp`, `${JSON.stringify(store)}\n`, { mode: 0o600 });
    renameSync(`${getCredentialRotationStatePath()}.tmp`, getCredentialRotationStatePath());
    expect(() => verifyWithRotation(name, active, legacy)).toThrow(/invalid one-time legacy/);
  });
});
