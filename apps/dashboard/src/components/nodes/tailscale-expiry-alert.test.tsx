import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TailscaleExpirySummary } from '@/types/contracts';
import { TailscaleExpiryAlert } from './tailscale-expiry-alert';

function summary(overrides: Partial<TailscaleExpirySummary['nodes'][number]['tailscale']> = {}): TailscaleExpirySummary {
  return {
    total: 1,
    reporting: 1,
    expiryEnabled: 1,
    expiringSoon: 1,
    expired: 0,
    warningDays: 30,
    nodes: [{
      id: 'node-1',
      name: 'campaign',
      hostname: 'node-1.tailnet.example.com',
      nodeStatus: 'ONLINE',
      lastHeartbeatAt: '2026-09-03T00:00:00Z',
      observedAt: '2026-09-03T00:00:00Z',
      tailscale: {
        status: 'active',
        backendState: 'Running',
        dnsName: 'node-1.tailnet.example.com',
        online: true,
        keyExpiry: '2026-10-03T00:00:00Z',
        daysRemaining: 30,
        expiryEnabled: true,
        expired: false,
        requiresRenewal: true,
        ...overrides,
      },
    }],
  };
}

describe('TailscaleExpiryAlert', () => {
  it('renders an actionable warning for keys due within 30 days', () => {
    const html = renderToStaticMarkup(<TailscaleExpiryAlert summary={summary()} />);

    expect(html).toContain('role="alert"');
    expect(html).toContain('Tailscale renewal due');
    expect(html).toContain('campaign');
    expect(html).toContain('30d');
    expect(html).toContain('/nodes#tailscale-renewal');
  });

  it('uses critical copy for an expired key', () => {
    const html = renderToStaticMarkup(<TailscaleExpiryAlert summary={summary({
      daysRemaining: 0,
      expired: true,
      status: 'failed',
      backendState: 'NeedsLogin',
    })} />);

    expect(html).toContain('Tailscale access expired');
    expect(html).toContain('expired');
  });

  it('renders nothing when no node requires renewal', () => {
    const html = renderToStaticMarkup(<TailscaleExpiryAlert summary={summary({
      daysRemaining: 31,
      requiresRenewal: false,
    })} />);

    expect(html).toBe('');
  });
});
