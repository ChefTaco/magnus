import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recordSecurityEvent: vi.fn(),
  validateCredentials: vi.fn(),
  createSessionToken: vi.fn(),
  beginAuthentication: vi.fn(),
  clearSuccessfulPair: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@/lib/security-events', () => ({recordSecurityEvent: mocks.recordSecurityEvent}));

vi.mock('@/lib/auth', () => ({
  validateCredentials: mocks.validateCredentials,
  createSessionToken: mocks.createSessionToken,
  COOKIE_NAME: 'magnus_session',
  SESSION_DURATION: 3600,
}));

vi.mock('@/lib/auth-protection', () => ({
  resolveTrustedClientAddress: () => 'hashed-by-limiter',
  beginAuthentication: mocks.beginAuthentication,
}));

const { POST } = await import('./route');

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://magnus.example/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordSecurityEvent.mockResolvedValue(undefined);
    mocks.validateCredentials.mockResolvedValue(false);
    mocks.createSessionToken.mockResolvedValue('signed-session');
    mocks.beginAuthentication.mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
      clearSuccessfulPair: mocks.clearSuccessfulPair,
      release: mocks.release,
    });
  });

  it('issues a secure administrator session only after durable admission', async () => {
    mocks.validateCredentials.mockResolvedValue(true);
    const response = await POST(request({ username: 'admin', password: 'correct' }));
    expect(response.status).toBe(200);
    expect(mocks.recordSecurityEvent).toHaveBeenCalledWith('auth.login_succeeded', expect.any(Headers), 'admin');
    expect(response.headers.get('set-cookie')).toContain('magnus_session=signed-session');
    expect(mocks.clearSuccessfulPair).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('returns an indistinguishable invalid-credential response and retains attempt state', async () => {
    const response = await POST(request({ username: 'admin', password: 'wrong' }));
    expect(response.status).toBe(401);
    expect(mocks.recordSecurityEvent).toHaveBeenCalledWith('auth.login_failed', expect.any(Headers), 'admin');
    await expect(response.json()).resolves.toEqual({ error: 'Invalid credentials' });
    expect(mocks.clearSuccessfulPair).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('returns Retry-After when any durable limit is exhausted', async () => {
    mocks.beginAuthentication.mockResolvedValue({ allowed: false, retryAfterSeconds: 900, release: mocks.release, clearSuccessfulPair: mocks.clearSuccessfulPair });
    const response = await POST(request({ username: 'admin', password: 'wrong' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('900');
    expect(mocks.validateCredentials).not.toHaveBeenCalled();
  });

  it('fails closed when Redis admission is unavailable', async () => {
    mocks.beginAuthentication.mockRejectedValue(new Error('redis unavailable'));
    const response = await POST(request({ username: 'admin', password: 'correct' }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Authentication temporarily unavailable' });
  });

  it('rejects advertised and streaming oversized bodies before authentication', async () => {
    expect((await POST(request('{}', { 'content-length': '4097' }))).status).toBe(413);
    expect((await POST(request('x'.repeat(4097)))).status).toBe(413);
    expect(mocks.beginAuthentication).not.toHaveBeenCalled();
  });
});
