import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const fixture = vi.hoisted(() => ({ openSession: vi.fn(), allowed: false }));
vi.mock('@/lib/terminal-sessions', () => ({ openSession: fixture.openSession, getRequestUserId: async () => 'fixture-user' }));
vi.mock('@/app/api/proxy/allowed-targets', () => ({ validateProxyTarget: async () => ({ allowed: fixture.allowed }) }));

const { POST } = await import('./route');
const open = () => POST(new NextRequest('https://magnus.example/api/terminal/open', { method: 'POST', body: JSON.stringify({ host: 'node-1.example.com' }) }));

describe('POST /api/terminal/open', () => {
  beforeEach(() => { fixture.openSession.mockReset().mockResolvedValue('ts_fixture'); });

  it('refuses a host outside the allowlist instead of warning and connecting', async () => {
    fixture.allowed = false;
    expect((await open()).status).toBe(403);
    expect(fixture.openSession).not.toHaveBeenCalled();
  });

  it('opens a session for an allowlisted host', async () => {
    fixture.allowed = true;
    expect((await open()).status).toBe(200);
    expect(fixture.openSession).toHaveBeenCalledTimes(1);
  });
});
