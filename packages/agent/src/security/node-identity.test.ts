import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as identity from './node-identity.js';
import { generateSigningKey } from './node-request-auth.js';

let dir: string;
const binding = (keyId: string, nodeId = 'node-a'): identity.NodeBinding => ({ version: 1, nodeId, keyId,
  serverKeys: [(({ keyId: id, publicKey }) => ({ keyId: id, publicKey }))(generateSigningKey())], origin: 'legacy-upgrade', boundAt: '2026-11-13T00:00:00.000Z' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'node-identity-'));
  vi.stubEnv('AGENT_INSTALL_DIR', dir);
  identity.resetNodeIdentityCache();
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('node identity storage', () => {
  it('has no identity until a key is created, then keeps it private', () => {
    expect(identity.loadNodeIdentity()).toBeNull();
    expect(identity.boundNodeIdentity()).toBeNull();
    const created = identity.ensureNodeKey();
    expect(statSync(join(dir, 'identity')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'identity/node.key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'identity/node.key'), 'utf8')).toContain('PRIVATE KEY');
    expect(created.binding).toBeNull();
    expect(identity.ensureNodeKey().keyId).toBe(created.keyId);
    expect(identity.boundNodeIdentity()).toBeNull();
  });

  it('is bound only by a binding made for its own key', () => {
    const key = identity.ensureNodeKey();
    identity.saveNodeBinding(binding('f'.repeat(64)));
    expect(identity.loadNodeIdentity(0)?.binding).toBeNull();
    identity.saveNodeBinding(binding(key.keyId));
    const bound = identity.boundNodeIdentity();
    expect(bound?.binding).toMatchObject({ nodeId: 'node-a', keyId: key.keyId });
    expect(statSync(join(dir, `identity/binding-${key.keyId.slice(0, 16)}.json`)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, `identity/binding-${key.keyId.slice(0, 16)}.json`), 'utf8')).not.toContain('PRIVATE');
  });

  it('refuses a key file that others can read or that is a symbolic link, without throwing at callers', () => {
    identity.ensureNodeKey();
    chmodSync(join(dir, 'identity/node.key'), 0o644);
    identity.resetNodeIdentityCache();
    expect(() => identity.loadNodeIdentity()).toThrow(/0600/);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(identity.boundNodeIdentity()).toBeNull();
    expect(identity.boundNodeIdentity()).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).not.toContain('PRIVATE');
    error.mockRestore();
    const elsewhere = join(dir, 'elsewhere.key');
    writeFileSync(elsewhere, generateSigningKey().privateKeyPem, { mode: 0o600 });
    rmSync(join(dir, 'identity/node.key'));
    symlinkSync(elsewhere, join(dir, 'identity/node.key'));
    identity.resetNodeIdentityCache();
    expect(() => identity.loadNodeIdentity()).toThrow(/regular file/);
  });

  it('replaces the key and its binding together and notices the change without a restart', () => {
    const first = identity.ensureNodeKey();
    identity.saveNodeBinding(binding(first.keyId));
    expect(identity.loadNodeIdentity(1_000_000)?.keyId).toBe(first.keyId);
    const next = generateSigningKey();
    identity.replaceNodeIdentity(next.privateKeyPem, { ...binding(next.keyId), origin: 'rotation' });
    identity.resetNodeIdentityCache();
    expect(identity.loadNodeIdentity(1_000_000)).toMatchObject({ keyId: next.keyId, binding: { origin: 'rotation' } });
    expect(readdirSync(join(dir, 'identity')).sort()).toEqual([`binding-${next.keyId.slice(0, 16)}.json`, 'node.key']);
    // A process that cached the old identity re-reads it once the files change (checked every few seconds).
    const third = generateSigningKey();
    writeFileSync(join(dir, 'identity/node.key'), third.privateKeyPem, { mode: 0o600 });
    expect(identity.loadNodeIdentity(1_000_000 + 1000)?.keyId).toBe(next.keyId);
    expect(identity.loadNodeIdentity(1_000_000 + 6000)?.keyId).toBe(third.keyId);
  });

  it('reset removes the key and bindings and reports whether there was one', () => {
    const key = identity.ensureNodeKey();
    identity.saveNodeBinding(binding(key.keyId));
    expect(identity.resetNodeIdentity()).toBe(true);
    expect(existsSync(join(dir, 'identity/node.key'))).toBe(false);
    expect(identity.loadNodeIdentity()).toBeNull();
    expect(identity.resetNodeIdentity()).toBe(false);
  });

  it('keeps pinned server keys with the binding, ignoring entries that are not keys', () => {
    const key = identity.ensureNodeKey();
    identity.saveNodeBinding(binding(key.keyId));
    const server = generateSigningKey();
    identity.savePinnedServerKeys([{ keyId: 'ignored-and-recomputed', publicKey: server.publicKey }, { keyId: 'x', publicKey: 'not-a-key' }]);
    expect(identity.loadNodeIdentity(0)?.binding?.serverKeys).toEqual([{ keyId: server.keyId, publicKey: server.publicKey }]);
  });
});
