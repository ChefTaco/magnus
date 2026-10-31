import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/internal/resource-enrollment/drain/route';
afterEach(() => vi.unstubAllEnvs());
describe('internal drain machine endpoint', () => {
  it('does not treat a dashboard cookie as drain authority', async () => {
    vi.stubEnv('RESOURCE_ENROLLMENT_DASHBOARD_SECRET', 'fixture-dedicated-dashboard-key-32chars');
    const response = await POST(new Request('https://fixture/api/internal/resource-enrollment/drain', {
      method: 'POST', headers: { cookie: 'magnus_session=operator-cookie' }, body: '{}',
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Drain proof unavailable' });
  });
  it('bounds streamed bodies without trusting content-length', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4097)); },
      cancel() { cancelled = true; },
    });
    const request = new Request('https://fixture/api/internal/resource-enrollment/drain', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect((await POST(request)).status).toBe(413);
    expect(cancelled).toBe(true);
  });
});
