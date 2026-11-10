import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { activateContextWithRollbackCheck, contextAdoptionInput, manageContextAdoption, validateContextBundle, type ContextActivationDriver } from './ardent-context-adoption.js';
import { ardentServiceCommand, createArdentRoutes } from './ardent-manager.js';
import { managedExecution } from '../security/managed-context.js';

function bundle() {
  const files = ['ardent/context.js', 'ardent/context-checkpoints.js', 'ardent/context-maintenance.js', 'emberfold/package.json',
    'emberfold/dist/index.js', 'emberfold/dist/compat.js', 'emberfold/LICENSE', 'emberfold/NOTICE', 'zod/package.json', 'zod/index.js'].map(path => {
    const text = path === 'emberfold/package.json' ? JSON.stringify({ name: '@hivemagnus/emberfold', type: 'module', version: '0.1.0' })
      : path === 'zod/package.json' ? JSON.stringify({ name: 'zod', type: 'module', version: '4.6.7' }) : 'synthetic payload';
    return { path, content: Buffer.from(text).toString('base64'), sha256: createHash('sha256').update(text).digest('hex') };
  });
  return { schema_version: 1, engine_version: '0.1.0', validator_version: '4.6.7', files };
}

describe('context-only adoption boundary', () => {
  it.each(['expired', 'cancelled'])('refuses a %s managed owner before inspecting or changing a profile', async condition => {
    const uid = vi.spyOn(process, 'getuid').mockReturnValue(0);
    const touched = vi.fn();
    try {
      await expect(managedExecution.run({ commandId: 'fixture', requestSha256: 'a'.repeat(64),
        claim: { leaseId: 'fixture', nodeId: 'fixture', nodeFqdn: 'node.example.com' },
        coordination: { version: 1, resourceKey: 'node:fixture:ardent', fence: '1', expiresAt: Date.now() + (condition === 'expired' ? -1 : 60000) },
        ...(condition === 'cancelled' ? { signal: AbortSignal.abort() } : {}) },
      () => manageContextAdoption({ owner: 'fixture', home: '/unused', root: '/unused/profile', install: '/unused/runtime' },
        'example', 'context-stage', {}, { profiles: touched, packageName: touched, treeDigest: touched, checkService: touched, service: touched })))
        .rejects.toThrow('live signed owner');
      expect(touched).not.toHaveBeenCalled();
    } finally { uid.mockRestore(); }
  });
  it('preserves existing service enablement during temporary maintenance stops and starts', () => {
    expect(ardentServiceCommand('service-start', true)).toEqual(['start']);
    expect(ardentServiceCommand('service-stop', true)).toEqual(['stop']);
    expect(ardentServiceCommand('service-start')).toEqual(['enable', '--now']);
    expect(ardentServiceCommand('service-stop')).toEqual(['disable', '--now']);
  });
  it('accepts the complete pinned payload and refuses changed bytes, traversal, duplicate paths and an arbitrary runtime replacement', () => {
    expect(validateContextBundle(bundle()).files).toHaveLength(10);
    for (const change of [
      (value: ReturnType<typeof bundle>) => { value.files[0]!.content = Buffer.from('changed').toString('base64'); },
      (value: ReturnType<typeof bundle>) => { value.files[0]!.path = 'zod/v4/../escape.js'; },
      (value: ReturnType<typeof bundle>) => { value.files.push(value.files[0]!); },
      (value: ReturnType<typeof bundle>) => { value.files[0]!.path = 'ardent/cli.js'; },
      (value: ReturnType<typeof bundle>) => { value.engine_version = '999.0.0'; },
      (value: ReturnType<typeof bundle>) => { value.files = value.files.filter(file => file.path !== 'emberfold/dist/compat.js'); }
    ]) { const value = bundle(); change(value); expect(() => validateContextBundle(value)).toThrow(); }
  });
  it('admits only the pinned complete offline storage bundle for both supported architectures', () => {
    const modern = () => {
      const value = { ...bundle(), schema_version: 2 };
      for (const path of ['ardent/sqlite.js', 'sqlite/package.json', 'sqlite/LICENSE', 'sqlite/dist/index.mjs',
        'sqlite/prebuilds/linux-x64/@photostructure+sqlite.glibc.node', 'sqlite/prebuilds/linux-arm64/@photostructure+sqlite.glibc.node',
        'sqlite-loader/package.json', 'sqlite-loader/LICENSE', 'sqlite-loader/index.js', 'sqlite-loader/node-gyp-build.js']) {
        const text = path === 'sqlite/package.json' ? JSON.stringify({ name: '@photostructure/sqlite', version: '3.3.1' })
          : path === 'sqlite-loader/package.json' ? JSON.stringify({ name: 'node-gyp-build', version: '4.8.4' }) : 'synthetic pinned artifact';
        value.files.push({ path, content: Buffer.from(text).toString('base64'), sha256: createHash('sha256').update(text).digest('hex') });
      }
      return value;
    };
    expect(validateContextBundle(modern()).schema_version).toBe(2);
    const legacyHeader = modern(); legacyHeader.schema_version = 1;
    expect(() => validateContextBundle(legacyHeader)).toThrow('Legacy context payload');
    for (const missing of ['ardent/sqlite.js', 'sqlite/LICENSE', 'sqlite/prebuilds/linux-arm64/@photostructure+sqlite.glibc.node', 'sqlite-loader/index.js']) {
      const value = modern(); value.files = value.files.filter(file => file.path !== missing);
      expect(() => validateContextBundle(value)).toThrow('incomplete');
    }
    for (const path of ['sqlite/prebuilds/linux-x64/arbitrary.node', 'sqlite-loader/bin.js', 'sqlite/../escape.js']) {
      const value = modern(); value.files.find(file => file.path === 'sqlite/LICENSE')!.path = path;
      expect(() => validateContextBundle(value)).toThrow();
    }
    const wrongVersion = modern();
    const manifest = wrongVersion.files.find(file => file.path === 'sqlite/package.json')!;
    const text = JSON.stringify({ name: '@photostructure/sqlite', version: '0.0.0' });
    manifest.content = Buffer.from(text).toString('base64'); manifest.sha256 = createHash('sha256').update(text).digest('hex');
    expect(() => validateContextBundle(wrongVersion)).toThrow();
  });
  it('accepts only revision-bound data, never commands, provider credentials or URLs', () => {
    const input = { release_id: '11111111-1111-4111-8111-111111111111', expected_bundle_sha256: 'a'.repeat(64),
      expected_base_sha256: 'b'.repeat(64), expected_policy_sha256: 'c'.repeat(64), expected_config_sha256: 'd'.repeat(64) };
    expect(contextAdoptionInput.parse(input)).toEqual(input);
    for (const extra of [{ command: 'arbitrary' }, { url: 'https://example.com/runtime.tgz' }, { token: 'fixture' }, { expected_policy_sha256: '' }])
      expect(contextAdoptionInput.safeParse({ ...input, ...extra }).success).toBe(false);
  });
  it.each(['context-stage', 'context-adopt', 'context-rollback'])('refuses direct %s without a managed execution owner', async action => {
    const routes = createArdentRoutes(async () => ({ owner: 'fixture', home: '/unused', root: '/unused/profile', install: '/unused/runtime' }));
    const response = await routes.request('/action', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'example', action, body: {} }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('signed managed resource claim') });
  });
});

describe('activation and real rollback ordering', () => {
  function fixture(failAt?: string) {
    const calls: string[] = [];
    const call = async (name: string) => { calls.push(name); if (name === failAt) throw new Error('Injected acceptance failure'); };
    const driver: ContextActivationDriver = {
      phase: state => call('phase:' + state), inspect: async which => { await call('inspect:' + which); return 'snapshot'; },
      check: which => call('check:' + which), stop: () => call('stop'), start: () => call('start'),
      backup: () => call('backup'), activate: () => call('activate'), rollback: () => call('rollback'), verify: which => call('verify:' + which)
    };
    return { calls, driver };
  }
  it('backs up a quiescent database, verifies both binaries, then restores and verifies the adopted runtime', async () => {
    const { calls, driver } = fixture();
    await activateContextWithRollbackCheck(driver);
    expect(calls).toEqual(['inspect:candidate', 'phase:stopping', 'stop', 'check:candidate', 'backup', 'phase:switching', 'activate', 'start', 'verify:active',
      'inspect:active', 'phase:rollback-stopping', 'stop', 'check:active', 'phase:rollback-switching', 'rollback', 'start', 'verify:candidate',
      'phase:rolled-back', 'inspect:candidate', 'phase:restoring', 'stop', 'check:candidate', 'activate', 'start', 'verify:active', 'phase:active']);
  });
  it.each(['inspect:candidate', 'check:candidate', 'backup', 'activate', 'start', 'verify:active', 'rollback', 'verify:candidate'])(
    'stops immediately at %s, never retries and never reports successful adoption', async failAt => {
      const { calls, driver } = fixture(failAt);
      await expect(activateContextWithRollbackCheck(driver)).rejects.toThrow('Injected');
      expect(calls.at(-1)).toBe(failAt);
      expect(calls.filter(call => call === failAt)).toHaveLength(1);
      expect(calls).not.toContain('phase:active');
    });
});
