import { describe, expect, it } from 'vitest';
import {
  parseTailscaleNodeKeyPosture,
  summarizeTailscaleNodeKeys,
} from './tailscale-node-key-service.js';

const NOW = Date.parse('2026-09-03T00:00:00Z');

function services(details: Record<string, unknown>, status = 'active'): string {
  return JSON.stringify([
    { name: 'docker', status: 'active' },
    { name: 'tailscale-node-key', status, details: JSON.stringify(details) },
  ]);
}

describe('parseTailscaleNodeKeyPosture', () => {
  it('warns inclusively at the 30-day renewal boundary', () => {
    const posture = parseTailscaleNodeKeyPosture(services({
      backendState: 'Running',
      dnsName: 'campaign.example.net',
      online: true,
      keyExpiry: '2026-10-03T00:00:00Z',
      expiryEnabled: true,
    }), NOW);

    expect(posture).toMatchObject({ daysRemaining: 30, expired: false, requiresRenewal: true });
  });

  it('does not warn at 31 days or when expiry is disabled', () => {
    expect(parseTailscaleNodeKeyPosture(services({
      backendState: 'Running', keyExpiry: '2026-10-04T00:00:00Z', expiryEnabled: true,
    }), NOW)?.requiresRenewal).toBe(false);

    expect(parseTailscaleNodeKeyPosture(services({
      backendState: 'Running', keyExpiry: null, expiryEnabled: false,
    }), NOW)).toMatchObject({ daysRemaining: null, expired: false, requiresRenewal: false });
  });

  it('marks an expired key as requiring renewal', () => {
    expect(parseTailscaleNodeKeyPosture(services({
      backendState: 'NeedsLogin', keyExpiry: '2026-09-02T23:59:59Z', expiryEnabled: true,
    }, 'failed'), NOW)).toMatchObject({ expired: true, requiresRenewal: true });
  });

  it('rejects malformed and missing service telemetry', () => {
    expect(parseTailscaleNodeKeyPosture('not-json', NOW)).toBeNull();
    expect(parseTailscaleNodeKeyPosture(JSON.stringify([{ name: 'docker', status: 'active' }]), NOW)).toBeNull();
    expect(parseTailscaleNodeKeyPosture(services({
      backendState: 'Running', keyExpiry: 'not-a-date', expiryEnabled: true,
    }), NOW)).toBeNull();
  });
});

describe('summarizeTailscaleNodeKeys', () => {
  it('counts reporting, upcoming, expired, and disabled keys separately', () => {
    const upcoming = parseTailscaleNodeKeyPosture(services({
      backendState: 'Running', keyExpiry: '2026-10-03T00:00:00Z', expiryEnabled: true,
    }), NOW)!;
    const expired = parseTailscaleNodeKeyPosture(services({
      backendState: 'NeedsLogin', keyExpiry: '2026-09-02T00:00:00Z', expiryEnabled: true,
    }, 'failed'), NOW)!;
    const disabled = parseTailscaleNodeKeyPosture(services({
      backendState: 'Running', keyExpiry: null, expiryEnabled: false,
    }), NOW)!;
    const base = { hostname: 'node.example.net', nodeStatus: 'ONLINE', lastHeartbeatAt: null, observedAt: null };

    expect(summarizeTailscaleNodeKeys([
      { ...base, id: '1', name: 'upcoming', tailscale: upcoming },
      { ...base, id: '2', name: 'expired', tailscale: expired },
      { ...base, id: '3', name: 'disabled', tailscale: disabled },
      { ...base, id: '4', name: 'missing', tailscale: null },
    ])).toMatchObject({
      total: 4,
      reporting: 3,
      expiryEnabled: 2,
      expiringSoon: 1,
      expired: 1,
      warningDays: 30,
    });
  });
});
