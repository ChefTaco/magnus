import { createCipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  controlNodeStateFile,
  credentialsNeedReencryption,
  describeCredentialCounts,
  describeReencryption,
  inspectControlNodeCredentials,
  reencryptLegacyControlNodeCredentials,
} from '../../runtime-control-node-credentials.mjs';
import { commandCredentials, credentialStorageWarnings } from '../../bin/magnus-ui.mjs';

const KEY = 'fixture-dedicated-control-node-key-0123456789';
const JWT = 'fixture-legacy-jwt-secret-0123456789abcdef';
const SESSION = 'fixture-session-secret-0123456789abcdef';
const env = { CONTROL_NODE_CREDENTIAL_KEY: KEY, JWT_SECRET: JWT, SESSION_SECRET: SESSION };

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
    expect(describeCredentialCounts(inspectControlNodeCredentials(file))).toBe('control-node credentials: none stored');
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

  it('runs at console start before the Next.js server can read the store', () => {
    const source = readFileSync(new URL('../../server-tls.mjs', import.meta.url), 'utf8');
    const reencrypt = source.indexOf('reencryptLegacyControlNodeCredentials(controlNodeStateFile(stateRoot))');
    expect(reencrypt).toBeGreaterThan(0);
    expect(reencrypt).toBeLessThan(source.indexOf('require(nextServer)'));
  });
});
