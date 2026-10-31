import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredControlNode } from '@/lib/control-nodes';

const { readNodes, controlApiFetch } = vi.hoisted(() => ({
  readNodes: vi.fn<() => Promise<StoredControlNode[]>>(),
  controlApiFetch: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/control-nodes-store', () => ({ readNodes }));
vi.mock('@/lib/control-api-fetch', () => ({ controlApiFetch }));

const { controlNodeFetchById, resolveControlNodeById } = await import('@/lib/control-node-server');

const remoteNode = (overrides: Partial<StoredControlNode> = {}): StoredControlNode => ({
  id: 'remote',
  name: 'Remote',
  url: 'https://remote.example.test:4000',
  createdAt: '2026-08-07T00:00:00.000Z',
  ...overrides,
});

describe('server-only control-node credential routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['CONTROL_API_URL'] = 'https://canonical.example.test:4000';
    process.env['API_SECRET'] = 'canonical-api-secret-that-never-crosses-origin';
    readNodes.mockResolvedValue([]);
    controlApiFetch.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  it('injects API_SECRET only for CONTROL_API_URL exact origin', async () => {
    const canonical = await resolveControlNodeById('local');
    expect(canonical.baseUrl).toBe('https://canonical.example.test:4000');
    expect(canonical.credentialHeaders).toEqual({
      'x-api-secret': 'canonical-api-secret-that-never-crosses-origin',
    });
  });

  it('uses an arbitrary node own stored credential without env precedence', async () => {
    readNodes.mockResolvedValue([remoteNode({ apiSecret: 'remote-purpose-secret' })]);
    const remote = await resolveControlNodeById('remote');
    expect(remote.credentialHeaders).toEqual({ 'x-api-secret': 'remote-purpose-secret' });
    expect(Object.values(remote.credentialHeaders)).not.toContain(process.env['API_SECRET']);
  });

  it('fails before fetch for unknown or uncredentialed cross-origin targets', async () => {
    readNodes.mockResolvedValue([remoteNode()]);
    await expect(controlNodeFetchById('remote', 'health')).rejects.toThrow(/no server-side credential/);
    await expect(controlNodeFetchById('missing', 'health')).rejects.toThrow(/Unknown control node/);
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it('does not follow or replay credentials across a 30x response', async () => {
    readNodes.mockResolvedValue([remoteNode({ token: 'remote-iam-token' })]);
    controlApiFetch.mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://attacker.example.test/collect' },
    }));

    await expect(controlNodeFetchById('remote', 'health', {
      headers: {
        authorization: 'Bearer caller-controlled-stale-credential',
        'x-api-secret': 'canonical-secret-must-not-hitchhike',
        cookie: 'sensitive=browser-state',
      },
    })).rejects.toThrow(/redirects are forbidden/);
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = controlApiFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://remote.example.test:4000/api/v1/health');
    expect(init.redirect).toBe('manual');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer remote-iam-token');
    expect(headers.has('x-api-secret')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
  });
});
