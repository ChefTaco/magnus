import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifiedLocalTlsOptions } from './local-tls.js';

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe('verifiedLocalTlsOptions', () => {
  it('retains verification and pins the expected DNS identity', () => {
    expect(verifiedLocalTlsOptions(undefined, 'magnus.example.test')).toEqual({
      rejectUnauthorized: true,
      servername: 'magnus.example.test',
    });
  });

  it('loads a private CA without disabling verification', () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'magnus-local-ca-'));
    const caPath = join(fixtureDir, 'ca.pem');
    writeFileSync(caPath, 'test-ca');
    expect(verifiedLocalTlsOptions(caPath, 'magnus.example.test')).toEqual({
      rejectUnauthorized: true,
      ca: Buffer.from('test-ca'),
      servername: 'magnus.example.test',
    });
  });

  it('fails closed when a configured CA is absent', () => {
    expect(() => verifiedLocalTlsOptions('/missing/magnus-local-ca.pem')).toThrow(/does not exist/);
  });
});
