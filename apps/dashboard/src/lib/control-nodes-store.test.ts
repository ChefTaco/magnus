import { createCipheriv, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const temporaryRoots: string[] = [];

function legacyEncrypt(plaintext: string, sessionSecret: string): string {
  const key = createHash('sha256').update(sessionSecret).digest();
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

async function freshStore() {
  vi.resetModules();
  return import('@/lib/control-nodes-store');
}

describe('control-node protected state', () => {
  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'magnus-control-node-test-'));
    temporaryRoots.push(root);
    vi.stubEnv('NODE_ENV', 'test');
    process.env['MAGNUS_CONTROL_NODES_CONFIG_DIR'] = path.join(root, '.magnus');
    process.env['CONTROL_NODE_CREDENTIAL_KEY'] = 'dedicated-control-node-storage-key-test';
    process.env['SESSION_SECRET'] = 'legacy-dashboard-session-secret-test';
    delete process.env['API_SECRET'];
    delete process.env['JWT_SECRET'];
  });

  afterEach(async () => {
    const root = temporaryRoots.pop();
    if (root) await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
    vi.unstubAllEnvs();
  });

  it('writes atomically with 0700/0600 modes and returns metadata-only DTOs', async () => {
    const store = await freshStore();
    await store.writeNodes([{
      id: 'remote',
      name: 'Remote',
      url: 'https://remote.example.test:4000',
      apiSecret: 'remote-api-secret-value',
      token: 'remote-iam-token-value',
      createdAt: '2026-08-07T00:00:00.000Z',
    }]);
    const directory = process.env['MAGNUS_CONTROL_NODES_CONFIG_DIR']!;
    const file = path.join(directory, 'control-nodes.json');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('remote-api-secret-value');
    expect(raw).not.toContain('remote-iam-token-value');
    expect(raw).toContain('enc2:');

    const [stored] = await store.readNodes();
    const dto = store.toControlNodeDto(stored!);
    expect(dto).toMatchObject({
      hasApiSecret: true,
      hasToken: true,
    });
    expect(dto).not.toHaveProperty('apiSecret');
    expect(dto).not.toHaveProperty('token');
    expect(dto).not.toHaveProperty('nodeManagerSecret');
  });

  it('migrates legacy ciphertext through an authenticated atomic rewrite', async () => {
    const directory = process.env['MAGNUS_CONTROL_NODES_CONFIG_DIR']!;
    await mkdir(directory, { mode: 0o700 });
    const file = path.join(directory, 'control-nodes.json');
    const plaintext = 'legacy-control-api-secret';
    await writeFile(file, JSON.stringify([{
      id: 'legacy',
      name: 'Legacy',
      url: 'https://legacy.example.test:4000',
      apiSecret: legacyEncrypt(plaintext, process.env['SESSION_SECRET']!),
      nodeManagerSecret: 'retired-node-manager-secret',
      createdAt: '2026-08-07T00:00:00.000Z',
    }]), { mode: 0o600 });
    const store = await freshStore();
    expect((await store.readNodes())[0]?.apiSecret).toBe(plaintext);
    const migrated = await readFile(file, 'utf8');
    expect(migrated).toContain('enc2:');
    expect(migrated).not.toContain(plaintext);
    expect(migrated).not.toContain('nodeManagerSecret');
    expect(migrated).not.toContain('retired-node-manager-secret');
  });

  it('does not rewrite state when authenticated decryption fails', async () => {
    const directory = process.env['MAGNUS_CONTROL_NODES_CONFIG_DIR']!;
    await mkdir(directory, { mode: 0o700 });
    const file = path.join(directory, 'control-nodes.json');
    const corrupt = JSON.stringify([{
      id: 'corrupt',
      name: 'Corrupt',
      url: 'https://corrupt.example.test:4000',
      apiSecret: 'enc2:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA',
      createdAt: '2026-08-07T00:00:00.000Z',
    }]);
    await writeFile(file, `${corrupt}\n`, { mode: 0o600 });
    const store = await freshStore();
    await expect(store.readNodes()).rejects.toThrow(/authenticated decryption/);
    expect(await readFile(file, 'utf8')).toBe(`${corrupt}\n`);
  });

  it('fails closed for unsafe modes and malformed state', async () => {
    const directory = process.env['MAGNUS_CONTROL_NODES_CONFIG_DIR']!;
    await mkdir(directory, { mode: 0o700 });
    const file = path.join(directory, 'control-nodes.json');
    await writeFile(file, '{not-json}\n', { mode: 0o600 });
    let store = await freshStore();
    await expect(store.readNodes()).rejects.toThrow();

    await writeFile(file, '[]\n', { mode: 0o600 });
    await chmod(file, 0o644);
    store = await freshStore();
    await expect(store.readNodes()).rejects.toThrow(/mode 0600/);

    await chmod(file, 0o600);
    await chmod(directory, 0o755);
    store = await freshStore();
    await expect(store.readNodes()).rejects.toThrow(/mode 0700/);
  });
});
