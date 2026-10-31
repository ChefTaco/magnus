import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const upstream = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/local-sessions', () => ({ verifyLocalSession: vi.fn(async () => true) }));
vi.mock('@/lib/hive-login', () => ({ hiveCredential: vi.fn(async () => null) }));
vi.mock('jose', () => ({ jwtVerify: vi.fn(async () => ({ payload: { username: 'fixture' } })) }));
vi.mock('@/lib/auth-constants', () => ({
  COOKIE_NAME: 'magnus_session', getSecretKey: () => new Uint8Array(32), sessionVerificationOptions: () => ({}),
}));
vi.mock('../allowed-targets', () => ({ validateProxyTarget: vi.fn(async () => ({
  allowed: true, baseUrl: 'https://control.example', credentialHeaders: { 'x-api-secret': 'fixture-api-secret' },
})) }));
vi.mock('@/lib/control-api-fetch', () => ({ controlApiFetch: upstream.fetch }));
import { POST } from './route';

function request(body: ReadableStream<Uint8Array>): NextRequest {
  return new NextRequest(new Request('https://dashboard.example/api/proxy/commands', {
    method: 'POST', headers: { cookie: 'magnus_session=fixture-token', 'x-proxy-target': 'https://control.example' },
    body, duplex: 'half',
  } as RequestInit));
}
const params = { params: Promise.resolve({ path: ['commands'] }) };

describe('proxy body rejection before upstream effects', () => {
  beforeEach(() => {
    vi.stubEnv('DASHBOARD_PROXY_BODY_LIMIT_BYTES', '4');
    upstream.fetch.mockReset();
    upstream.fetch.mockResolvedValue(Response.json({ success: true }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns 413 and never forwards a chunked oversized mutation', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123'));
        controller.enqueue(new TextEncoder().encode('45'));
      }, cancel,
    });
    expect((await POST(request(body), params)).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 rather than forwarding an empty mutation when input fails', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('fixture input failed')); } });
    expect((await POST(request(body), params)).status).toBe(400);
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it('preserves an accepted request body', async () => {
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{}'));
      controller.close();
    } });
    expect((await POST(request(body), params)).status).toBe(200);
    expect(upstream.fetch).toHaveBeenCalledWith('https://control.example/api/v1/commands',
      expect.objectContaining({ method: 'POST', body: '{}' }), undefined);
  });
});
