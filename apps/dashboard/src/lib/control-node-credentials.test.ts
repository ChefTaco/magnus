import { createCipheriv, createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  controlNodeStateFile,
  controlNodeStateLockFile,
  controlNodeStateOwner,
  lockTestHooks,
  withControlNodeStateLock,
  credentialsNeedReencryption,
  describeCredentialCounts,
  describeReencryption,
  inspectControlNodeCredentials,
  reencryptLegacyControlNodeCredentials,
} from '../../runtime-control-node-credentials.mjs';
import { commandCredentials, CREDENTIALS_NO_STATE_EXIT, credentialStorageWarnings, dropPrivilegesToOwner } from '../../bin/magnus-ui.mjs';

const KEY = 'fixture-dedicated-control-node-key-0123456789';
const JWT = 'fixture-legacy-jwt-secret-0123456789abcdef';
const SESSION = 'fixture-session-secret-0123456789abcdef';
const env = { CONTROL_NODE_CREDENTIAL_KEY: KEY, JWT_SECRET: JWT, SESSION_SECRET: SESSION };

function currentEncrypt(plaintext: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = Buffer.alloc(12, 5);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc2:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

function legacyEncrypt(plaintext: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

const roots: string[] = [];
let root: string;
let directory: string;
let file: string;

async function writeState(records: unknown[]): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const raw = `${JSON.stringify(records, null, 2)}\n`;
  await writeFile(file, raw, { mode: 0o600 });
  return raw;
}

function node(id: string, fields: Record<string, string>) {
  return { id, name: id, url: `https://${id}.example.test:4000`, createdAt: '2026-08-07T00:00:00.000Z', ...fields };
}

async function readWithStore() {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('MAGNUS_CONTROL_NODES_CONFIG_DIR', directory);
  vi.stubEnv('CONTROL_NODE_CREDENTIAL_KEY', KEY);
  // The store must read the result without any legacy key.
  vi.stubEnv('JWT_SECRET', '');
  vi.stubEnv('SESSION_SECRET', '');
  const store = await import('@/lib/control-nodes-store');
  return store.readNodes();
}

describe('control-node credential re-encryption', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'magnus-credential-reencrypt-'));
    roots.push(root);
    directory = path.join(root, '.magnus');
    file = controlNodeStateFile(root);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const entry of roots.splice(0)) await rm(entry, { recursive: true, force: true });
  });

  it('does nothing without a state file', () => {
    expect(inspectControlNodeCredentials(file)).toMatchObject({ present: false, legacy: 0 });
    expect(reencryptLegacyControlNodeCredentials(file, env)).toMatchObject({ status: 'absent', backup: null });
    expect(describeCredentialCounts(inspectControlNodeCredentials(file))).toBe('control-node credentials: no state file');
  });

  it('re-encrypts legacy values under the dedicated key, backs up the original and keeps every credential', async () => {
    const original = await writeState([
      node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT), token: legacyEncrypt('jwt-token-value', JWT) }),
      node('session', { apiSecret: legacyEncrypt('session-api-secret-value', SESSION) }),
      node('plain', { apiSecret: 'plain-api-secret-value', nodeManagerSecret: 'retired-node-manager-value' }),
    ]);
    const before = inspectControlNodeCredentials(file);
    expect(before).toMatchObject({ present: true, nodes: 3, current: 0, legacy: 3, plaintext: 1, retired: 1 });
    expect(credentialsNeedReencryption(before)).toBe(true);

    const result = reencryptLegacyControlNodeCredentials(file, env, { now: new Date('2026-11-28T10:11:12.345Z') });
    expect(result).toMatchObject({ status: 'reencrypted', reencrypted: 3, encrypted: 1, retired: 1 });
    expect(result.backup).toBe(`${file}.legacy-key-backup-20261128T101112Z`);
    expect(await readFile(result.backup!, 'utf8')).toBe(original);
    expect((await stat(result.backup!)).mode & 0o777).toBe(0o600);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const rewritten = await readFile(file, 'utf8');
    for (const secret of ['jwt-api-secret-value', 'jwt-token-value', 'session-api-secret-value', 'plain-api-secret-value', 'retired-node-manager-value']) {
      expect(rewritten).not.toContain(secret);
    }
    expect(rewritten).not.toMatch(/"enc:/);
    expect(rewritten).not.toContain('nodeManagerSecret');
    expect(inspectControlNodeCredentials(file)).toMatchObject({ current: 4, legacy: 0, plaintext: 0, retired: 0 });

    const message = describeReencryption(result)!;
    expect(message).toContain('3 from the legacy JWT_SECRET-derived key');
    expect(message).not.toMatch(/secret-value|token-value/);

    const nodes = await readWithStore();
    expect(nodes.map((entry) => [entry.id, entry.apiSecret, entry.token])).toEqual([
      ['jwt', 'jwt-api-secret-value', 'jwt-token-value'],
      ['session', 'session-api-secret-value', undefined],
      ['plain', 'plain-api-secret-value', undefined],
    ]);
  });

  it('is idempotent: a second run changes nothing and writes no backup', async () => {
    await writeState([node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT) })]);
    reencryptLegacyControlNodeCredentials(file, env);
    const once = await readFile(file, 'utf8');
    const entries = await readdir(directory);
    expect(reencryptLegacyControlNodeCredentials(file, env)).toMatchObject({ status: 'current', backup: null });
    expect(await readFile(file, 'utf8')).toBe(once);
    expect(await readdir(directory)).toEqual(entries);
  });

  it('changes nothing when a legacy value does not authenticate', async () => {
    const original = await writeState([
      node('good', { apiSecret: legacyEncrypt('good-api-secret-value', JWT) }),
      node('other', { apiSecret: legacyEncrypt('other-api-secret-value', 'fixture-unknown-secret-0123456789') }),
    ]);
    expect(() => reencryptLegacyControlNodeCredentials(file, env)).toThrow(/did not decrypt with JWT_SECRET or SESSION_SECRET/);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['control-nodes.json']);
  });

  it('refuses without a legacy key or with a dedicated key that reuses one', async () => {
    const original = await writeState([node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT) })]);
    expect(() => reencryptLegacyControlNodeCredentials(file, { CONTROL_NODE_CREDENTIAL_KEY: KEY }))
      .toThrow(/neither JWT_SECRET nor SESSION_SECRET/);
    expect(() => reencryptLegacyControlNodeCredentials(file, { ...env, CONTROL_NODE_CREDENTIAL_KEY: JWT }))
      .toThrow(/distinct from JWT_SECRET/);
    expect(() => reencryptLegacyControlNodeCredentials(file, { ...env, CONTROL_NODE_CREDENTIAL_KEY: 'short' }))
      .toThrow(/at least 32 characters/);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('fails closed on state that is not private', async () => {
    await writeState([node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT) })]);
    await chmod(file, 0o644);
    expect(() => inspectControlNodeCredentials(file)).toThrow(/mode 0600/);
    expect(() => reencryptLegacyControlNodeCredentials(file, env)).toThrow(/mode 0600/);
    await chmod(file, 0o600);
    await chmod(directory, 0o755);
    expect(() => reencryptLegacyControlNodeCredentials(file, env)).toThrow(/mode 0700/);
  });

  it('magnus-ui credentials reports, re-encrypts on request and exits 1 while legacy values remain', async () => {
    await writeState([node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT) })]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cliEnv = { ...env, MAGNUS_UI_DATA_DIR: root };

    expect(await credentialStorageWarnings(cliEnv)).toEqual([
      expect.stringContaining('1 under the legacy JWT_SECRET-derived key'),
    ]);
    expect(await commandCredentials(cliEnv, new Set())).toBe(1);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('0 under CONTROL_NODE_CREDENTIAL_KEY, 1 under the legacy'));
    expect(await commandCredentials(cliEnv, new Set(['--reencrypt']))).toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('1 under CONTROL_NODE_CREDENTIAL_KEY, 0 under the legacy'));
    expect(await credentialStorageWarnings(cliEnv)).toEqual([]);
    expect(await commandCredentials({ ...cliEnv, CONTROL_NODE_CREDENTIAL_KEY: '' }, new Set())).toBe(0);
    for (const call of [...log.mock.calls, ...error.mock.calls]) expect(String(call[0])).not.toContain('jwt-api-secret-value');
  });

  it('refuses a key that does not decrypt the values already under the dedicated key', async () => {
    const original = await writeState([
      node('saved', { apiSecret: currentEncrypt('saved-api-secret-value', KEY) }),
      node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT) }),
    ]);
    expect(() => reencryptLegacyControlNodeCredentials(file, { ...env, CONTROL_NODE_CREDENTIAL_KEY: 'fixture-stray-exported-key-0123456789abc' }))
      .toThrow(/does not decrypt control-node entry 0 apiSecret.*nothing was changed/);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['control-nodes.json']);
    // The right key re-encrypts the legacy value and keeps the one already stored.
    expect(reencryptLegacyControlNodeCredentials(file, env)).toMatchObject({ status: 'reencrypted', reencrypted: 1 });
    expect((await readWithStore()).map((entry) => entry.apiSecret)).toEqual(['saved-api-secret-value', 'jwt-api-secret-value']);
  });

  it('refuses to rewrite a file another account owns', async () => {
    const original = await writeState([node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT) })]);
    const owner = (await stat(file)).uid;
    expect(() => reencryptLegacyControlNodeCredentials(file, env, { euid: owner + 1 }))
      .toThrow(new RegExp(`belongs to uid ${owner}.*sudo -u magnus`));
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['control-nodes.json']);
  });

  it('refuses to rewrite as root too; magnus-ui credentials drops to the owner first', async () => {
    const original = await writeState([node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT) })]);
    const { uid, gid } = await stat(file);
    if (uid !== 0) {
      expect(() => reencryptLegacyControlNodeCredentials(file, env, { euid: 0 })).toThrow(new RegExp(`belongs to uid ${uid}`));
      expect(await readFile(file, 'utf8')).toBe(original);
    }
    const calls: string[] = [];
    const proc = (euid: number) => ({
      geteuid: () => euid,
      setgroups: (groups: number[]) => { calls.push(`setgroups ${groups.join(',')}`); },
      setgid: (id: number) => { calls.push(`setgid ${id}`); },
      setuid: (id: number) => { calls.push(`setuid ${id}`); },
    });
    expect(dropPrivilegesToOwner({ uid: 1001, gid: 1002 }, proc(0) as never)).toBe(true);
    // The group goes first: after setuid the process could no longer change it.
    expect(calls).toEqual(['setgroups 1002', 'setgid 1002', 'setuid 1001']);
    calls.length = 0;
    expect(dropPrivilegesToOwner({ uid: 1001, gid: 1002 }, proc(1001) as never)).toBe(false);
    expect(dropPrivilegesToOwner({ uid: 0, gid: 0 }, proc(0) as never)).toBe(false);
    expect(dropPrivilegesToOwner(null, proc(0) as never)).toBe(false);
    expect(calls).toEqual([]);
    expect(controlNodeStateOwner(file)).toEqual({ uid, gid });
  });

  it('waits for the state lock another process holds and changes nothing', async () => {
    const original = await writeState([node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT) })]);
    // The parent process is alive, so its lock is held, however old it is.
    const lock = controlNodeStateLockFile(file);
    await writeFile(lock, `${process.ppid} fixture-nonce\n`, { mode: 0o600 });
    expect(() => reencryptLegacyControlNodeCredentials(file, env, { lockWaitMs: 100 })).toThrow(/locked by another process/);
    await utimes(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    expect(() => reencryptLegacyControlNodeCredentials(file, env, { lockWaitMs: 100 })).toThrow(/locked by another process/);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readFile(lock, 'utf8')).toBe(`${process.ppid} fixture-nonce\n`);
  });

  it('takes over a lock whose holder is gone, or one left by an earlier process with our pid', async () => {
    const lock = controlNodeStateLockFile(file);
    for (const holder of ['2147483646 dead-nonce', `${process.pid} reused-pid-nonce`]) {
      await writeState([node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT) })]);
      await writeFile(lock, `${holder}\n`, { mode: 0o600 });
      expect(reencryptLegacyControlNodeCredentials(file, env, { lockWaitMs: 100 }).status).toBe('reencrypted');
      expect(await readdir(directory)).not.toContain(path.basename(lock));
    }
  });

  it('judges an unidentifiable lock by its age only', async () => {
    const lock = controlNodeStateLockFile(file);
    await writeState([node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT) })]);
    // Unreadable to us, as another account's lock is (root bypasses modes, so skip the check then).
    await writeFile(lock, 'x', { mode: 0o000 });
    if ((await stat(file)).uid !== 0) {
      expect(() => reencryptLegacyControlNodeCredentials(file, env, { lockWaitMs: 100 })).toThrow(/locked by another process/);
    }
    await utimes(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    expect(reencryptLegacyControlNodeCredentials(file, env, { lockWaitMs: 100 }).status).toBe('reencrypted');
  });

  it('writes a nonce into the lock and releases only its own lock', async () => {
    await writeState([]);
    const lock = controlNodeStateLockFile(file);
    let seen = '';
    await withControlNodeStateLock(file, async () => {
      seen = await readFile(lock, 'utf8');
      // Someone else's lock replaced ours (say, a takeover): releasing must not remove it.
      await rm(lock);
      await writeFile(lock, `${process.ppid} someone-else\n`, { mode: 0o600 });
    });
    expect(seen).toMatch(new RegExp(`^${process.pid} [0-9a-f]{32}\\n$`));
    expect(await readFile(lock, 'utf8')).toBe(`${process.ppid} someone-else\n`);
  });

  it('removes a half-written lock when writing it fails', async () => {
    await writeState([]);
    const original = lockTestHooks.writeLock;
    lockTestHooks.writeLock = () => { throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' }); };
    try {
      await expect(withControlNodeStateLock(file, async () => 'unreachable')).rejects.toThrow(/fixture disk full/);
    } finally {
      lockTestHooks.writeLock = original;
    }
    expect(await readdir(directory)).toEqual(['control-nodes.json']);
    await expect(withControlNodeStateLock(file, async () => 'ok')).resolves.toBe('ok');
  });

  it('the console store holds the same lock for its writes and releases it', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MAGNUS_CONTROL_NODES_CONFIG_DIR', directory);
    vi.stubEnv('CONTROL_NODE_CREDENTIAL_KEY', KEY);
    const store = await import('@/lib/control-nodes-store');
    const lock = controlNodeStateLockFile(file);
    let seen = false;
    await store.withNodesMutex((nodes) => {
      seen = readdirSync(directory).includes(path.basename(lock));
      return [...nodes, node('added', { apiSecret: 'added-api-secret-value' })];
    });
    expect(seen).toBe(true);
    expect(await readdir(directory)).not.toContain(path.basename(lock));
    // While another process holds it, a store write waits instead of overwriting.
    await writeFile(lock, `${process.ppid}\n`, { mode: 0o600 });
    const pending = store.withNodesMutex((nodes) => nodes);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    expect(settled).toBe(false);
    await rm(lock);
    await pending;
  });

  it('the store migrates on read in its write queue, so a concurrent save is kept', async () => {
    await writeState([node('jwt', { apiSecret: legacyEncrypt('jwt-api-secret-value', JWT) })]);
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MAGNUS_CONTROL_NODES_CONFIG_DIR', directory);
    vi.stubEnv('CONTROL_NODE_CREDENTIAL_KEY', KEY);
    vi.stubEnv('JWT_SECRET', JWT);
    const store = await import('@/lib/control-nodes-store');
    // The read starts first and needs a migration; the save is queued while it reads.
    const read = store.readNodes();
    const save = store.withNodesMutex((nodes) => [...nodes, node('added', { apiSecret: 'added-api-secret-value' })]);
    const [readBack] = await Promise.all([read, save]);
    // The migration re-reads inside the queue, after the save, so it sees and keeps the new node.
    expect(readBack.map((entry) => entry.id)).toContain('jwt');
    vi.stubEnv('JWT_SECRET', '');
    expect((await store.readNodes()).map((entry) => [entry.id, entry.apiSecret])).toEqual([
      ['jwt', 'jwt-api-secret-value'],
      ['added', 'added-api-secret-value'],
    ]);
  });

  it('magnus-ui credentials names the file it checked and does not report a missing one as clear', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await commandCredentials({ ...env, MAGNUS_UI_DATA_DIR: root }, new Set())).toBe(CREDENTIALS_NO_STATE_EXIT);
    expect(log).toHaveBeenLastCalledWith(`control-node credentials: no state file at ${file} (nothing is stored there; check --data-dir)`);
    await writeState([node('saved', { apiSecret: currentEncrypt('saved-api-secret-value', KEY) })]);
    expect(await commandCredentials({ ...env, MAGNUS_UI_DATA_DIR: root }, new Set())).toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining(`in ${file}: 1 under CONTROL_NODE_CREDENTIAL_KEY, 0 under the legacy`));
  });

  it('runs at console start before the Next.js server can read the store', () => {
    const source = readFileSync(new URL('../../server-tls.mjs', import.meta.url), 'utf8');
    const reencrypt = source.indexOf('reencryptLegacyControlNodeCredentials(controlNodeStateFile(stateRoot))');
    expect(reencrypt).toBeGreaterThan(0);
    expect(reencrypt).toBeLessThan(source.indexOf('require(nextServer)'));
  });
});
