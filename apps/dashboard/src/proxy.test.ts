import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import proxy from './proxy';

describe('dashboard authentication proxy', () => {
  it('delegates only the exact internal drain POST to machine authentication', async () => {
    expect((await proxy(new NextRequest('https://magnus.example/api/internal/resource-enrollment/drain', { method: 'POST' }))).status).toBe(200);
    for (const path of ['/api/internal/resource-enrollment/drain/other', '/api/internal/resource-enrollment/other'])
      expect((await proxy(new NextRequest('https://magnus.example' + path, { method: 'POST' }))).status).toBe(401);
    expect((await proxy(new NextRequest('https://magnus.example/api/internal/resource-enrollment/drain'))).status).toBe(401);
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
