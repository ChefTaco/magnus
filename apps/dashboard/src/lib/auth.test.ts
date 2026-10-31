vi.mock('@/lib/local-sessions', () => ({
  createLocalSession: vi.fn().mockResolvedValue('session-id'),
  verifyLocalSession: vi.fn().mockResolvedValue(true),
}));
/**
 * Unit tests for magnus-ui auth utilities.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jwtVerify } from 'jose';
import { argon2id, hash } from 'argon2';

// Mock jose before importing auth
vi.mock('jose', () => ({
  SignJWT: vi.fn().mockImplementation(function () { return {
    setProtectedHeader: vi.fn().mockReturnThis(),
    setIssuer: vi.fn().mockReturnThis(),
    setAudience: vi.fn().mockReturnThis(),
    setIssuedAt: vi.fn().mockReturnThis(),
    setExpirationTime: vi.fn().mockReturnThis(),
    sign: vi.fn().mockResolvedValue('mock.jwt.token'),
  }; }),
  jwtVerify: vi.fn().mockResolvedValue({
    payload: {
      username: 'testuser',
      email: 'test@example.com',
      userId: 'user-1',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    },
  }),
}));

// Mock auth-constants
vi.mock('@/lib/auth-constants', () => ({
  COOKIE_NAME: 'magnus_session',
  SESSION_DURATION: '24h',
  SESSION_ISSUER: 'magnus-dashboard',
  SESSION_AUDIENCE: 'magnus-dashboard-session',
  sessionVerificationOptions: vi.fn().mockReturnValue({
    algorithms: ['HS256'],
    issuer: 'magnus-dashboard',
    audience: 'magnus-dashboard-session',
  }),
  getSecretKey: vi.fn().mockReturnValue(new TextEncoder().encode('test-secret-key-abcdefgh')),
}));

const auth = await import('@/lib/auth');

describe('createSessionToken', () => {
  it('should return a JWT string', async () => {
    const token = await auth.createSessionToken('testuser', { email: 'test@example.com' });
    expect(typeof token).toBe('string');
    expect(token).toBe('mock.jwt.token');
  });
});

describe('verifySessionToken', () => {
  it('should verify a valid token and return session payload', async () => {
    const result = await auth.verifySessionToken('mock.jwt.token');
    expect(result).toBeDefined();
    expect(result!.username).toBe('testuser');
    expect(result!.email).toBe('test@example.com');
  });

  it('returns null for an expired session token', async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(new Error('JWTExpired'));
    await expect(auth.verifySessionToken('expired.jwt.token')).resolves.toBeNull();
  });
});

describe('validateCredentials', () => {
  beforeEach(async () => {
    process.env['DASHBOARD_ADMIN_USERNAME'] = 'admin';
    process.env['DASHBOARD_ADMIN_PASSWORD_HASH'] = await hash('secret123', { type: argon2id });
    delete process.env['DASHBOARD_LOGIN_USERNAME'];
    delete process.env['DASHBOARD_LOGIN_PASSWORD'];
  });

  it('should return true for matching credentials', async () => {
    const result = await auth.validateCredentials('admin', 'secret123');
    expect(result).toBe(true);
  });

  it('does not fall back to the dashboard SSH proxy credentials', async () => {
    process.env['DASHBOARD_SSH_USERNAME'] = 'magnus-proxy';
    process.env['DASHBOARD_SSH_PASSWORD'] = 'proxy-secret';
    await expect(auth.validateCredentials('magnus-proxy', 'proxy-secret')).resolves.toBe(false);
    await expect(auth.validateCredentials('admin', 'secret123')).resolves.toBe(true);
    delete process.env['DASHBOARD_SSH_USERNAME'];
    delete process.env['DASHBOARD_SSH_PASSWORD'];
  });

  it('should return false for wrong username', async () => {
    const result = await auth.validateCredentials('wrong', 'secret123');
    expect(result).toBe(false);
  });

  it('should return false for wrong password', async () => {
    const result = await auth.validateCredentials('admin', 'wrong');
    expect(result).toBe(false);
  });
});
