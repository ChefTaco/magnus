import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hiveRouterTlsOptions } from './hive-router-fetch';

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe('hiveRouterTlsOptions', () => {
  it('keeps certificate and hostname verification enabled with system trust', () => {
    expect(hiveRouterTlsOptions()).toEqual({ rejectUnauthorized: true });
  });

  it('loads an explicit private CA without weakening verification', () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'magnus-hive-ca-'));
    const caPath = join(fixtureDir, 'ca.pem');
    writeFileSync(caPath, 'test-ca');
    expect(hiveRouterTlsOptions(caPath)).toEqual({
      rejectUnauthorized: true,
      ca: Buffer.from('test-ca'),
    });
  });

  it('fails closed when the configured CA is missing', () => {
    expect(() => hiveRouterTlsOptions('/missing/magnus-hive-ca.pem')).toThrow(/does not exist/);
  });
});
