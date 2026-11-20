import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_DIFFERENCES, buildInstallationReport, compareResolution, findPackage, installLayout, lockEntryName, lockEntryParent,
} from './installation-report-service.js';

const roots: string[] = [];
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'magnus-installation-report-'));
  roots.push(root);
  return root;
}
function put(directory: string, name: string, version: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version }));
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** The server's lock as it ships: the security pin on Prisma's config loader resolved to 3.22.1. */
const LOCK = {
  lockfileVersion: 3,
  packages: {
    '': { name: '@hivemagnus/magnus-server', version: '9.9.9' },
    'node_modules/@prisma/config': { version: '7.10.1' },
    'node_modules/effect': { version: '3.22.1' },
    'node_modules/vitest': { version: '5.1.0', dev: true },
    'node_modules/@esbuild/aix-ppc64': { version: '0.28.2', optional: true },
  },
};

/** A consumer install: `npm install @hivemagnus/magnus-server` into a prefix, with the server under node_modules. */
function consumerInstall(effect: string, nested = false): string {
  const prefix = tree();
  const server = join(prefix, 'node_modules/@hivemagnus/magnus-server');
  put(server, '@hivemagnus/magnus-server', '9.9.9');
  writeFileSync(join(server, 'npm-shrinkwrap.json'), JSON.stringify(LOCK));
  put(join(prefix, 'node_modules/@prisma/config'), '@prisma/config', '7.10.1');
  if (nested) {
    put(join(prefix, 'node_modules/effect'), 'effect', '3.22.1');
    put(join(prefix, 'node_modules/@prisma/config/node_modules/effect'), 'effect', effect);
  } else put(join(prefix, 'node_modules/effect'), 'effect', effect);
  return server;
}

describe('lock paths', () => {
  it('names an entry and its parent', () => {
    expect(lockEntryName('node_modules/a/node_modules/@s/b')).toBe('@s/b');
    expect(lockEntryParent('node_modules/a/node_modules/@s/b')).toBe('node_modules/a');
    expect(lockEntryParent('node_modules/@s/b')).toBe('');
  });
});

describe('installation report', () => {
  it('reports a native install that resolved effect 3.20.0 while the signed lock has 3.22.1', () => {
    const server = consumerInstall('3.20.0');
    const report = buildInstallationReport(server, new Date('2026-11-20T09:43:00.000Z'));
    expect(report.magnus.layout).toBe('package');
    expect(report.resolution).toMatchObject({ reference: 'npm-shrinkwrap', checkedAt: '2026-11-20T09:43:00.000Z', checked: 2, truncated: false });
    expect(report.resolution.referenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.resolution.differences).toEqual([{ name: 'effect', path: 'node_modules/effect', expected: '3.22.1', actual: '3.20.0' }]);
  });

  it('finds the copy Node loads, not just any copy: a nested old effect under @prisma/config shadows the hoisted fix', () => {
    const lock = { packages: { ...LOCK.packages, 'node_modules/@prisma/config/node_modules/effect': { version: '3.22.1' } } };
    const server = consumerInstall('3.20.0', true);
    expect(compareResolution(server, lock).differences).toEqual([
      { name: 'effect', path: 'node_modules/@prisma/config/node_modules/effect', expected: '3.22.1', actual: '3.20.0' },
    ]);
  });

  it('reports nothing when the install matches the lock, and skips development and absent optional entries', () => {
    const report = buildInstallationReport(consumerInstall('3.22.1'));
    expect(report.resolution.differences).toEqual([]);
    expect(report.resolution.checked).toBe(2);
  });

  it('reports a locked runtime package that is missing', () => {
    const server = consumerInstall('3.22.1');
    rmSync(join(server, '../../effect'), { recursive: true });
    expect(compareResolution(server, LOCK).differences).toEqual([{ name: 'effect', path: 'node_modules/effect', expected: '3.22.1', actual: null }]);
  });

  it('says when the package shipped no shrinkwrap', () => {
    const root = tree();
    put(root, '@hivemagnus/magnus-server', '9.9.9');
    const report = buildInstallationReport(root);
    expect(report.magnus.layout).toBe('workspace');
    expect(report.resolution).toMatchObject({ reference: 'none', referenceSha256: null, checked: 0, differences: [], truncated: false });
  });

  it('reports an unreadable shrinkwrap as present but unchecked', () => {
    const root = tree();
    writeFileSync(join(root, 'npm-shrinkwrap.json'), '{');
    expect(buildInstallationReport(root).resolution).toMatchObject({ reference: 'npm-shrinkwrap', checked: 0, differences: [] });
  });

  it('caps the differences it lists', () => {
    const root = tree();
    const packages: Record<string, { version: string }> = {};
    for (let index = 0; index < MAX_DIFFERENCES + 5; index += 1) packages[`node_modules/p${index}`] = { version: '1.0.0' };
    const result = compareResolution(root, { packages });
    expect(result.differences).toHaveLength(MAX_DIFFERENCES);
    expect(result.truncated).toBe(true);
    expect(result.checked).toBe(MAX_DIFFERENCES + 5);
  });

  it('follows a workspace symlink to resolve from the real directory', () => {
    const root = tree();
    put(join(root, 'packages/contracts'), '@hivemagnus/magnus-contracts', '1.0.0');
    put(join(root, 'packages/contracts/node_modules/zod'), 'zod', '4.0.0');
    put(join(root, 'node_modules/zod'), 'zod', '3.0.0');
    mkdirSync(join(root, 'node_modules/@hivemagnus'), { recursive: true });
    symlinkSync(join(root, 'packages/contracts'), join(root, 'node_modules/@hivemagnus/magnus-contracts'));
    const server = join(root, 'services/control-api');
    mkdirSync(server, { recursive: true });
    expect(findPackage(findPackage(server, '@hivemagnus/magnus-contracts')!, 'zod')).toBe(join(root, 'packages/contracts/node_modules/zod'));
    expect(compareResolution(server, { packages: {
      'node_modules/@hivemagnus/magnus-contracts': { version: '1.0.0' },
      'node_modules/@hivemagnus/magnus-contracts/node_modules/zod': { version: '4.0.0' },
      'node_modules/zod': { version: '3.0.0' },
    } }).differences).toEqual([]);
  });

  it('tells a node_modules install from a checkout', () => {
    expect(installLayout('/opt/magnus/releases/1/node_modules/@hivemagnus/magnus-server')).toBe('package');
    expect(installLayout('/opt/magnus/services/control-api')).toBe('workspace');
  });
});
