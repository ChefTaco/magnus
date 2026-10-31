import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifiedTlsOptions } from './tls.js';

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe('verifiedTlsOptions', () => {
  it('always enables certificate and hostname verification', () => {
    expect(verifiedTlsOptions()).toEqual({ rejectUnauthorized: true });
  });

  it('adds an explicit private CA while retaining verification', () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'magnus-agent-ca-'));
    const caPath = join(fixtureDir, 'control-api.pem');
    writeFileSync(caPath, 'test-ca');
    expect(verifiedTlsOptions(caPath)).toEqual({
      rejectUnauthorized: true,
      ca: Buffer.from('test-ca'),
    });
  });

  it('fails closed for a missing configured CA', () => {
    expect(() => verifiedTlsOptions('/missing/magnus-agent-ca.pem')).toThrow(/does not exist/);
  });
});
