import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  verifySessionToken: vi.fn(),
  credentials: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (mocks.cookie ? { value: mocks.cookie } : undefined) }) }));
vi.mock('@/lib/auth', () => ({ verifySessionToken: mocks.verifySessionToken }));
vi.mock('@/lib/auth-constants', () => ({
  COOKIE_NAME: 'magnus_session',
  sessionSecretDiagnostics: () => ({ configured: true, source: 'dedicated' }),
}));
vi.mock('../../../../runtime-hermes-security-event-state.mjs', () => ({ hermesSecurityEventDiagnostics: () => ({ droppedEvents: 0 }) }));
vi.mock('../../../../runtime-dashboard-credentials.mjs', () => ({ dashboardCredentialDiagnostics: mocks.credentials }));

const { GET } = await import('./route');

describe('GET /api/health', () => {
  beforeEach(() => {
    mocks.cookie = undefined;
    mocks.verifySessionToken.mockReset().mockResolvedValue(null);
    mocks.credentials.mockReset().mockReturnValue({ migrated: true, loginSource: 'dashboard-admin-password', sshConfigured: true });
  });

  it('answers only the status to an anonymous caller', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'healthy' });
  });

  it('adds the diagnostics for a local administrator session', async () => {
    mocks.cookie = 'signed-session';
    mocks.verifySessionToken.mockResolvedValue({ username: 'admin' });
    const body = await (await GET()).json();
    expect(body.diagnostics.dashboardCredentials).toMatchObject({ loginSource: 'dashboard-admin-password', sshConfigured: true });
    expect(body.diagnostics.sessionSecret).toMatchObject({ source: 'dedicated' });
  });

  it('answers only the status to viewers, operators and named (Hive) sessions', async () => {
    mocks.cookie = 'signed-session';
    for (const session of [{ username: 'viewer', role: 'VIEWER' }, { username: 'operator', role: 'OPERATOR' },
      { username: 'alice', role: 'VIEWER', provider: 'hive' }, { username: 'bob', role: 'ADMIN', provider: 'hive' }]) {
      mocks.verifySessionToken.mockResolvedValue(session);
      expect(await (await GET()).json(), session.username).toEqual({ status: 'healthy' });
    }
  });

  it('reports misconfigured credentials as unhealthy 503 instead of throwing', async () => {
    mocks.credentials.mockImplementation(() => { throw new Error('DASHBOARD_ADMIN_PASSWORD_HASH must be an Argon2id hash'); });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unhealthy' });
  });
});
