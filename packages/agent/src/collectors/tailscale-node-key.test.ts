import { describe, expect, it } from 'vitest';
import { parseTailscaleNodeKeyStatus, TAILSCALE_EXPIRY_WARNING_DAYS } from './tailscale-node-key.js';

const NOW = Date.parse('2026-08-21T00:00:00Z');

function status(keyExpiry: string | null, backendState = 'Running'): string {
  return JSON.stringify({
    BackendState: backendState,
    Self: {
      DNSName: 'node.tailnet.example.',
      KeyExpiry: keyExpiry,
      Online: true,
      TailscaleIPs: ['100.64.0.1'],
    },
  });
}

describe('parseTailscaleNodeKeyStatus', () => {
  it('reports healthy keys as an active service', () => {
    const result = parseTailscaleNodeKeyStatus(status('2026-09-21T00:00:00Z'), NOW);
    expect(result.status).toBe('active');
    expect(JSON.parse(result.details ?? '{}')).toMatchObject({
      dnsName: 'node.tailnet.example',
      daysRemaining: 31,
      warningDays: TAILSCALE_EXPIRY_WARNING_DAYS,
    });
  });

  it('warns before the node key expires', () => {
    const result = parseTailscaleNodeKeyStatus(status('2026-08-28T00:00:00Z'), NOW);
    expect(result.status).toBe('inactive');
    expect(JSON.parse(result.details ?? '{}')).toMatchObject({ daysRemaining: 7, expiryEnabled: true });
  });

  it('fails expired and logged-out nodes', () => {
    expect(parseTailscaleNodeKeyStatus(status('2026-08-20T23:59:59Z'), NOW).status).toBe('failed');
    expect(parseTailscaleNodeKeyStatus(status('2026-09-21T00:00:00Z', 'NeedsLogin'), NOW).status).toBe('failed');
  });

  it('treats disabled key expiry as healthy while Tailscale is running', () => {
    const result = parseTailscaleNodeKeyStatus(status(null), NOW);
    expect(result.status).toBe('active');
    expect(JSON.parse(result.details ?? '{}')).toMatchObject({ expiryEnabled: false, daysRemaining: null });
  });

  it('does not fail the whole health snapshot when status output is invalid', () => {
    expect(parseTailscaleNodeKeyStatus('not-json', NOW).status).toBe('unknown');
  });
});
