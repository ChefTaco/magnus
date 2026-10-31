import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectHiveMemToken } from './hivemem-token.js';

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function envWithExpiry(secondsFromNow: number): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'hivemem-token-'));
  homes.push(home);
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })).toString('base64url');
  const path = join(home, '.env');
  await writeFile(path, `HERMES_HIVEMEM_TOKEN=header.${payload}.signature\n`);
  return path;
}

describe('HiveMem token monitoring', () => {
  it('marks an expired token without attempting authentication', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const posture = await inspectHiveMemToken(await envWithExpiry(-60), 'https://hive.example');
    expect(posture.status).toBe('expired');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(posture)).not.toContain('signature');
  });

  it('requires a successful authentication check before reporting validity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const posture = await inspectHiveMemToken(await envWithExpiry(7 * 86400), 'https://hive.example');
    expect(posture.status).toBe('expiring');
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe('https://hive.example/v1/auth/me');
    expect(JSON.stringify(posture)).not.toContain('signature');

    fetchMock.mockResolvedValue({ status: 401, ok: false });
    const rejected = await inspectHiveMemToken(await envWithExpiry(30 * 86400), 'https://hive.example');
    expect(rejected.status).toBe('rejected');
  });
});
