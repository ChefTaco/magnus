import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import proxy from './proxy';

describe('dashboard authentication proxy', () => {
  it('no longer exempts the retired internal drain route from authentication', async () => {
    expect((await proxy(new NextRequest('https://magnus.example/api/internal/resource-enrollment/drain', { method: 'POST' }))).status).toBe(401);
  });
  it('returns JSON 401 for unauthenticated API requests', async () => {
    const response = await proxy(new NextRequest('https://magnus.example/api/proxy/events/stream'));

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ error: 'authentication_required' });
  });

  it('redirects unauthenticated page requests to login', async () => {
    const response = await proxy(new NextRequest('https://magnus.example/hermes-security'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://magnus.example/login');
  });
});

describe('cross-site requests', () => {
  afterEach(() => vi.unstubAllEnvs());
  const post = (path: string, headers: Record<string, string>) =>
    proxy(new NextRequest(`https://magnus.example.com${path}`, { method: 'POST', headers: { host: 'magnus.example.com', ...headers } }));

  it('refuses a state change from another origin before authentication, login included', async () => {
    vi.stubEnv('DASHBOARD_PUBLIC_ORIGIN', 'https://magnus.example.com');
    for (const path of ['/api/proxy/commands', '/api/terminal/session', '/api/control-nodes', '/api/auth/login']) {
      const response = await post(path, { origin: 'https://evil.example.com', cookie: 'magnus_session=x' });
      expect(response.status, path).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'cross_site_request_refused' });
    }
    expect((await post('/api/proxy/commands', { origin: 'null' })).status).toBe(403);
    expect((await post('/api/proxy/commands', { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await post('/api/proxy/commands', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it('lets same-origin and non-browser requests through to authentication', async () => {
    vi.stubEnv('DASHBOARD_PUBLIC_ORIGIN', 'https://console.example.com');
    expect((await post('/api/proxy/commands', { origin: 'https://console.example.com' })).status).toBe(401);
    expect((await post('/api/proxy/commands', { origin: 'https://magnus.example.com' })).status).toBe(401);
    expect((await post('/api/proxy/commands', { 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect((await post('/api/proxy/commands', {})).status).toBe(401);
    expect((await proxy(new NextRequest('https://magnus.example.com/api/proxy/nodes', { headers: { origin: 'https://evil.example.com' } }))).status).toBe(401);
  });
});
