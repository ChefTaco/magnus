import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPinnedHermesInstallScript,
  HERMES_INSTALL_PIN,
  HERMES_INSTALL_SCRIPT_MAX_BYTES,
  hermesInstallPin,
  hermesInstallScriptUrl,
} from './hermes-install-pin.js';
import { hermesRoutes, runPinnedHermesInstaller } from './hermes-manager.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const COMMIT = 'a'.repeat(40);

describe('pinned Hermes installer', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('ships a full commit and script digest, never a branch', () => {
    expect(HERMES_INSTALL_PIN.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(HERMES_INSTALL_PIN.scriptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(hermesInstallScriptUrl(HERMES_INSTALL_PIN.commit))
      .toBe(`https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_INSTALL_PIN.commit}/scripts/install.sh`);
    expect(() => hermesInstallScriptUrl('main')).toThrow();
  });

  it('accepts an operator override only when both values are set and valid', () => {
    expect(hermesInstallPin({}).source).toBe('release');
    expect(hermesInstallPin({ HERMES_INSTALL_COMMIT: COMMIT, HERMES_INSTALL_SCRIPT_SHA256: 'b'.repeat(64) }))
      .toEqual({ commit: COMMIT, scriptSha256: 'b'.repeat(64), source: 'environment' });
    expect(() => hermesInstallPin({ HERMES_INSTALL_COMMIT: COMMIT })).toThrow(/set together/);
    expect(() => hermesInstallPin({ HERMES_INSTALL_COMMIT: 'main', HERMES_INSTALL_SCRIPT_SHA256: 'b'.repeat(64) })).toThrow();
  });

  it('downloads from the pinned commit without following redirects and checks the digest', async () => {
    const script = '#!/usr/bin/env bash\necho fixture\n';
    const fetcher = vi.fn(async () => new Response(script));
    const bytes = await fetchPinnedHermesInstallScript({ commit: COMMIT, scriptSha256: sha256(script) }, fetcher as unknown as typeof fetch);
    expect(bytes.toString()).toBe(script);
    expect(fetcher).toHaveBeenCalledWith(hermesInstallScriptUrl(COMMIT), expect.objectContaining({ redirect: 'error' }));
    await expect(fetchPinnedHermesInstallScript({ commit: COMMIT, scriptSha256: 'c'.repeat(64) },
      (async () => new Response(script)) as unknown as typeof fetch)).rejects.toThrow(/digest/);
  });

  it('refuses an oversized or failed download', async () => {
    const big = 'x'.repeat(HERMES_INSTALL_SCRIPT_MAX_BYTES + 1);
    await expect(fetchPinnedHermesInstallScript({ commit: COMMIT, scriptSha256: sha256(big) },
      (async () => new Response(big)) as unknown as typeof fetch)).rejects.toThrow(/larger/);
    await expect(fetchPinnedHermesInstallScript({ commit: COMMIT, scriptSha256: 'c'.repeat(64) },
      (async () => new Response('missing', { status: 404 })) as unknown as typeof fetch)).rejects.toThrow(/HTTP 404/);
  });

  describe('install route', () => {
    let home: string;
    beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'hermes-install-')); });
    afterEach(async () => { await rm(home, { recursive: true, force: true }); });

    it('runs the verified script with the pinned commit instead of piping a branch into bash', async () => {
      const script = '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$HERMES_HOME/install-args"\n';
      vi.stubEnv('HERMES_INSTALL_COMMIT', COMMIT);
      vi.stubEnv('HERMES_INSTALL_SCRIPT_SHA256', sha256(script));
      const fetcher = vi.fn(async () => new Response(script));
      const result = await runPinnedHermesInstaller(home, true, fetcher as unknown as typeof fetch);
      expect(result.code).toBe(0);
      const args = (await readFile(join(home, 'install-args'), 'utf8')).trim().split('\n');
      expect(args).toEqual(['--commit', COMMIT, '--non-interactive', '--hermes-home', home, '--skip-browser']);
    });

    it('never runs a script whose digest does not match', async () => {
      vi.stubEnv('HERMES_INSTALL_COMMIT', COMMIT);
      vi.stubEnv('HERMES_INSTALL_SCRIPT_SHA256', 'd'.repeat(64));
      vi.stubGlobal('fetch', vi.fn(async () => new Response(`#!/usr/bin/env bash\ntouch "${home}/ran"\n`)));
      const bin = join(home, 'hermes');
      await writeFile(bin, '#!/bin/sh\nexit 0\n');
      await chmod(bin, 0o755);
      const response = await hermesRoutes.request('/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hermesHome: home, hermesBin: bin }),
      });
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).toMatch(/digest/);
      await expect(readFile(join(home, 'ran'))).rejects.toThrow();
    });
  });
});
