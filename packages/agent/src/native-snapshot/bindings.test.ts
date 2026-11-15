import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindingRecord, tlsAncestry, type BindingStat } from './bindings.js';
import { canonical, sha256 } from './files.js';
const operator: BindingStat = { uid: 20002, gid: 20002, mode: 0o644, nlink: 1, regular: true };
let base: string;
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'magnus-bindings-')); await chmod(base, 0o700); });
afterEach(async () => { await rm(base, { recursive: true, force: true }); });
describe('configured TLS ownership and retained manager authority', () => {
  it('accepts installation-operator certificate/key ownership without broadening root manager authority', () => {
    expect(bindingRecord('TLS_CERT_PATH', '/etc/example/tls/console.crt', operator, '0'.repeat(64))).toMatchObject({ uid: 20002, gid: 20002, mode: 0o644 });
    expect(bindingRecord('TLS_KEY_PATH', '/etc/example/tls/console.key', { ...operator, mode: 0o600 }, '0'.repeat(64))).toMatchObject({ uid: 20002, mode: 0o600 });
    for (const role of ['configuration', 'identity/node.key', 'identity/local-result.key', 'MAGNUS_AGENT_RENEWAL_CONFIG'])
      expect(() => bindingRecord(role, '/opt/magnus-agent/fixture', operator, '0'.repeat(64))).toThrow('unsafe');
  });
  it('rejects shared-writable TLS, exposed keys, hardlinks, special files and symlink metadata', () => {
    for (const change of [{ mode: 0o664 }, { mode: 0o666 }, { mode: 0o4600 }, { nlink: 2 }, { regular: false }])
      expect(() => bindingRecord('TLS_CERT_PATH', '/etc/example/tls/console.crt', { ...operator, ...change }, '0'.repeat(64))).toThrow('unsafe');
    for (const mode of [0o644, 0o640, 0o660, 0o400])
      expect(() => bindingRecord('TLS_KEY_PATH', '/etc/example/tls/console.key', { ...operator, mode }, '0'.repeat(64))).toThrow('unsafe');
  });
  it('binds original owner/group/mode/path as well as bytes, so ownership or metadata drift cannot match an old snapshot', () => {
    const original = bindingRecord('TLS_CERT_PATH', '/etc/example/tls/console.crt', operator, '0'.repeat(64));
    for (const change of [{ uid: 0 }, { gid: 20003 }, { mode: 0o640 }]) {
      const changed = bindingRecord('TLS_CERT_PATH', original.path, { ...operator, ...change }, original.sha256);
      expect(sha256(canonical(changed))).not.toBe(sha256(canonical(original)));
    }
    const moved = bindingRecord('TLS_CERT_PATH', '/etc/example/tls/other.crt', operator, original.sha256);
    expect(sha256(canonical(moved))).not.toBe(sha256(canonical(original)));
  });
  it('accepts a protected operator directory below trusted ancestors and rejects writable or symlink ancestry', async () => {
    const directory = join(base, 'tls'); await mkdir(directory, { mode: 0o700 });
    const certificate = join(directory, 'console.crt'); await writeFile(certificate, 'fixture certificate', { mode: 0o644 });
    await expect(tlsAncestry(certificate, process.getuid!())).resolves.toBeUndefined();
    await chmod(directory, 0o777); await expect(tlsAncestry(certificate, process.getuid!())).rejects.toThrow('ancestry'); await chmod(directory, 0o700);
    await symlink(directory, join(base, 'alias'));
    await expect(tlsAncestry(join(base, 'alias/console.crt'), process.getuid!())).rejects.toThrow('symlink');
  });
});
