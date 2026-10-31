import { describe, expect, it } from 'vitest';
import {
  createDiscoveryProbe,
  createDiscoveryResponse,
  verifyDiscoveryProbe,
} from './discovery.js';

const secret = 'd'.repeat(32);
const nonce = 'n'.repeat(43);
const timestamp = 1_723_046_400_000;

describe('authenticated agent discovery protocol', () => {
  it('matches the versioned Control API probe signature', () => {
    const probe = createDiscoveryProbe(secret, timestamp, nonce);
    expect(probe.signature).toBe('Gw4DENjNCCo--aytDKcGkxobnhBSb6CP-Pt1iLF6O9Q');
    expect(verifyDiscoveryProbe(probe, secret, timestamp)).toBe(true);
  });

  it('rejects stale, tampered, and wrong-key probes', () => {
    const probe = createDiscoveryProbe(secret, timestamp, nonce);
    expect(verifyDiscoveryProbe(probe, secret, timestamp + 30_001)).toBe(false);
    expect(verifyDiscoveryProbe({ ...probe, nonce: `x${probe.nonce.slice(1)}` }, secret, timestamp)).toBe(false);
    expect(verifyDiscoveryProbe(probe, 'e'.repeat(32), timestamp)).toBe(false);
  });

  it('matches the nonce-bound response signature expected by Control', () => {
    const response = createDiscoveryResponse({
      secret,
      nonce,
      timestamp: timestamp + 1_000,
      hostname: 'node1.example.test',
      fqdn: 'node1.example.test',
      port: 4100,
      version: '1.6.3',
    });
    expect(response.signature).toBe('PycEqGKaUgFw2zhbsecn4mwpzxHv9vWoapQ02i7L7wU');
  });
});
