import { describe, expect, it } from 'vitest';
import {
  generateControlNodePurposeSecrets,
  resolveControlNodeCorsOrigin,
} from './deploy-control-node-service.js';

// Deployment output is source-scanned in CI; this suite protects the pure
// policy helpers while the artifact gate inspects complete generated bundles.

describe('resolveControlNodeCorsOrigin', () => {
  it('uses an explicit dashboard origin', () => {
    expect(resolveControlNodeCorsOrigin('magnus', 'https://magnus.example.test'))
      .toBe('https://magnus.example.test');
  });

  it('derives a restrictive same-host origin when unset', () => {
    expect(resolveControlNodeCorsOrigin('magnus.example.test'))
      .toBe('https://magnus.example.test');
  });

  it('does not propagate a wildcard into a production deployment', () => {
    expect(resolveControlNodeCorsOrigin('magnus.example.test', '*'))
      .toBe('https://magnus.example.test');
  });
});

describe('generateControlNodePurposeSecrets', () => {
  it('generates independent strong values for every protocol boundary', () => {
    const secrets = generateControlNodePurposeSecrets();
    const values = Object.values(secrets);
    expect(values.every((value) => value.length >= 32)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });
});
