import { describe, expect, it } from 'vitest';
import { createDiscoveryProbe, verifyDiscoveryResponse } from './discovery.js';

const secret = 'd'.repeat(32);
const nonce = 'n'.repeat(43);
const timestamp = 1_723_046_400_000;

const response = {
  type: 'MAGNUS_AGENT_RESPONSE' as const,
  nonce,
  timestamp: timestamp + 1_000,
  hostname: 'node1.example.test',
  fqdn: 'node1.example.test',
  port: 4100,
  version: '1.6.3',
  signature: 'PycEqGKaUgFw2zhbsecn4mwpzxHv9vWoapQ02i7L7wU',
};

describe('authenticated Control discovery protocol', () => {
  it('matches the agent probe signature contract', () => {
    expect(createDiscoveryProbe(secret, timestamp, nonce).signature).toBe(
      'Gw4DENjNCCo--aytDKcGkxobnhBSb6CP-Pt1iLF6O9Q',
    );
  });

  it('accepts only fresh responses bound to this scan nonce and key', () => {
    expect(verifyDiscoveryResponse(response, secret, nonce, timestamp + 1_000)).toBe(true);
    expect(verifyDiscoveryResponse(response, secret, 'x'.repeat(43), timestamp + 1_000)).toBe(false);
    expect(verifyDiscoveryResponse(response, 'e'.repeat(32), nonce, timestamp + 1_000)).toBe(false);
    expect(verifyDiscoveryResponse(response, secret, nonce, timestamp + 31_002)).toBe(false);
  });

  it('rejects malformed identity metadata even when a signature field is present', () => {
    expect(verifyDiscoveryResponse({ ...response, port: 0 }, secret, nonce, timestamp + 1_000)).toBe(false);
    expect(verifyDiscoveryResponse({ ...response, fqdn: 'bad\nname' }, secret, nonce, timestamp + 1_000)).toBe(false);
  });
});
