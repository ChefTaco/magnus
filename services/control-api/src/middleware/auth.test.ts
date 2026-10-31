/**
 * Unit tests for auth middleware — safeEqual, requireRole, getUser.
 *
 * These tests mock jose and env to avoid real crypto/network dependencies.
 */
import { describe, it, expect, vi } from 'vitest';

// ── Minimal mock env before importing auth ──────────────────────────
vi.mock('../utils/env.js', () => ({
  JWT_SECRET: 'test-jwt-secret-for-unit-tests-at-least-32',
  API_SECRET: 'test-api-secret-for-unit-tests-at-least-32',
  IAM_CORE_URL: '',
  IAM_TOKEN_ISSUER: '',
  IAM_TOKEN_AUDIENCE: '',
  MAGNUS_COLLECTOR_TOKEN_SHA256: '0f4d5aacf86dd715e56be17a14e52b2fa242743fe655dc45796d225375f9e28d',
  MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: JSON.stringify({
    magnus: '4cd2cd8ce912b646598abfc7c79e8fd745b31d27e953cbc3eaca9bc6d11cc561',
    approvals: '36ee70390b50c30a79e1de2eb5433856657f668498ce68a925bbbf53e941b3d5',
  }),
  MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: '5673efb18fe4af55edc214a9c3aa3f85e7a0aa5463fce31f9f676e2c4d274811',
  MAGNUS_SHARED_RESOURCE_TOKEN_SHA256: '73e86e19f711fbe8e48db9aacbbf5ade8abe82b21127e05a67586bb2b3135fe7',
  MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON: JSON.stringify({
    edge: 'f001d6a220557b88b5f1080ea364379f02a6ad7cf953fc865306fde3ad57c887',
  }),
  MAGNUS_FLEET_CHECK_TOKEN_SHA256: '3e0960eb2af58be43271b68f35ea5188db47d3d44c032511479567f14f1f83e3',
  MAGNUS_PLUGIN_API_ENABLED: true,
  MAGNUS_APPROVAL_BRIDGE_CONSUMER: 'approvals',
}));
const userStatus = vi.hoisted(() => ({
  get: vi.fn(async (_userId: string): Promise<{ active: boolean; role: string } | null> => ({ active: true, role: 'OPERATOR' })),
}));
vi.mock('./user-status.js', () => ({ getCurrentUserStatus: userStatus.get, invalidateUserStatus: vi.fn() }));
vi.mock('../services/credential-rotation-service.js', () => ({
  verifyWithRotation: (_name: string, expected: string, provided: string) => expected === provided,
}));

// ── Import after mocks are in place ─────────────────────────────────
const { authMiddleware, getUser, hasPermission, isScopedServiceRequestAllowed, requirePermission, requireRole, signUserToken } = await import('./auth.js');
import type { Context, Next } from 'hono';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockContext(
  headers: Record<string, string> = {},
  method = 'GET',
  path = '/api/v1/nodes',
): Context {
  const store = new Map<string, unknown>();

  const ctx = {
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? undefined,
      method,
      path,
      url: `https://magnus.test${path}`,
    },
    set: (key: string, value: unknown) => store.set(key, value),
    get: (key: string) => store.get(key),
    // Hono's c.var is a Proxy-like accessor backed by the same store as get/set
    var: new Proxy({} as Record<string, unknown>, {
      get: (_target, prop: string) => store.get(prop),
    }),
  } as unknown as Context;

  return ctx;
}

const noop: Next = async () => {};

// ── Tests ───────────────────────────────────────────────────────────

describe('authMiddleware', () => {
  it('should grant ADMIN access with valid x-api-secret', async () => {
    const c = createMockContext({ 'x-api-secret': 'test-api-secret-for-unit-tests-at-least-32' });
    await authMiddleware(c, noop);
    const user = c.get('user') as { role: string; userId: string };
    expect(user.role).toBe('ADMIN');
    expect(user.userId).toBe('system');
  });

  it('should reject invalid x-api-secret', async () => {
    const c = createMockContext({ 'x-api-secret': 'wrong-secret' });
    // Should fall through to JWT check and fail
    await expect(authMiddleware(c, noop)).rejects.toThrow();
  });

  it.each([
    ['GET', '/api/v1/nodes'],
    ['GET', '/api/v1/audit'],
    ['GET', '/api/v1/dependencies'],
  ])('allows a plugin read token only on its %s %s surface', async (method, path) => {
    const c = createMockContext(
      { authorization: 'Bearer plugin-scoped-token-for-unit-tests-12345' },
      method,
      path,
    );
    await authMiddleware(c, noop);
    expect(c.get('user')).toMatchObject({ userId: 'service:magnus-plugin-read:magnus', role: 'VIEWER' });
  });

  it('keeps each plugin read principal distinct and denies command replay', async () => {
    const read = createMockContext(
      { authorization: 'Bearer approvals-plugin-read-token-for-unit-tests' },
      'GET',
      '/api/v1/nodes',
    );
    await authMiddleware(read, noop);
    expect(read.get('user')).toMatchObject({ userId: 'service:magnus-plugin-read:approvals', role: 'VIEWER' });
    const command = createMockContext(
      { authorization: 'Bearer approvals-plugin-read-token-for-unit-tests' },
      'POST',
      '/api/v1/commands',
    );
    await expect(authMiddleware(command, noop)).rejects.toThrow(/endpoint-scoped/);
  });

  it('limits the approval bridge exception to exact paths and keeps the principal read-only', async () => {
    for (const [method, path] of [['GET', '/api/v1/team-approvals/plans/remediation:test'], ['POST', '/api/v1/team-approvals/decisions']]) {
      const c = createMockContext({ authorization: 'Bearer approvals-plugin-read-token-for-unit-tests' }, method, path);
      await authMiddleware(c, noop);
      expect(c.get('user')).toMatchObject({ userId: 'service:magnus-plugin-read:approvals', role: 'VIEWER' });
      const other = createMockContext({ authorization: 'Bearer plugin-scoped-token-for-unit-tests-12345' }, method, path);
      await expect(authMiddleware(other, noop)).rejects.toThrow(/endpoint-scoped/);
    }
    for (const [method, path] of [['POST', '/api/v1/team-approvals/plans/remediation:test'], ['POST', '/api/v1/team-approvals/decisions/extra'], ['DELETE', '/api/v1/team-approvals/decisions'], ['POST', '/api/v1/commands']]) {
      const c = createMockContext({ authorization: 'Bearer approvals-plugin-read-token-for-unit-tests' }, method, path);
      await expect(authMiddleware(c, noop)).rejects.toThrow(/endpoint-scoped/);
    }
  });

  it('permits the Magnus-only operator token only on exact plugin write routes', async () => {
    const command = createMockContext(
      { authorization: 'Bearer plugin-operator-token-for-unit-tests-123' },
      'POST',
      '/api/v1/commands',
    );
    await authMiddleware(command, noop);
    expect(command.get('user')).toMatchObject({ userId: 'service:magnus-plugin-operator', role: 'OPERATOR' });
    const admin = createMockContext(
      { authorization: 'Bearer plugin-operator-token-for-unit-tests-123' },
      'GET',
      '/api/v1/credentials/rotations',
    );
    await expect(authMiddleware(admin, noop)).rejects.toThrow(/endpoint-scoped/);
  });

  it('rejects plugin credential replay against admin credentials', async () => {
    const c = createMockContext(
      { authorization: 'Bearer plugin-scoped-token-for-unit-tests-12345' },
      'GET',
      '/api/v1/credentials/rotations',
    );
    await expect(authMiddleware(c, noop)).rejects.toThrow(/endpoint-scoped/);
  });

  it('scopes the shared-resource bearer to normal lease lifecycle routes and excludes reconciliation', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/shared-resource-leases/reserve'],
      ['GET', '/api/v1/shared-resource-leases/abcdefghijklmnop'],
      ['GET', '/api/v1/shared-resource-leases/operation/operation:recover-1'],
      ['POST', '/api/v1/shared-resource-leases/abcdefghijklmnop/start'],
      ['POST', '/api/v1/shared-resource-leases/abcdefghijklmnop/unknown'],
      ['POST', '/api/v1/shared-resource-leases/abcdefghijklmnop/settle'],
    ]) {
      const c = createMockContext({ authorization: 'Bearer shared-resource-token-for-unit-tests-12345' }, method, path);
      await authMiddleware(c, noop);
      expect(c.get('user')).toMatchObject({ userId: 'service:shared-resource-client', role: 'OPERATOR' });
    }
    for (const [method, path] of [
      ['POST', '/api/v1/shared-resource-leases/abcdefghijklmnop/reconcile'],
      ['GET', '/api/v1/nodes'],
      ['POST', '/api/v1/shared-resource-leases/reserve/extra'],
      ['GET', '/api/v1/shared-resource-leases/operation/operation%2Frecover'],
      ['GET', '/api/v1/shared-resource-leases/operation/operation:recover/extra'],
    ]) {
      const c = createMockContext({ authorization: 'Bearer shared-resource-token-for-unit-tests-12345' }, method, path);
      await expect(authMiddleware(c, noop)).rejects.toThrow(/endpoint-scoped/);
    }
  });

  it('binds a per-client shared-resource bearer to its exact actor identity', async () => {
    const c = createMockContext({ authorization: 'Bearer edge-shared-resource-token-for-unit-tests-12345' },
      'GET', '/api/v1/shared-resource-leases/operation/operation:edge-1');
    await authMiddleware(c, noop);
    expect(c.get('user')).toMatchObject({ userId: 'service:shared-resource:edge', role: 'OPERATOR' });
  });

  it.each(['/api/v1/stats/overview', '/api/v1/nodes', '/api/v1/anomalies/summary'])(
    'allows fleet token read-only access on %s',
    async (path) => {
      const c = createMockContext(
        { authorization: 'Bearer fleet-scoped-token-for-unit-tests-123456' },
        'GET',
        path,
      );
      await authMiddleware(c, noop);
      expect(c.get('user')).toMatchObject({ userId: 'service:magnus-fleet-check', role: 'VIEWER' });
    },
  );

  it('rejects fleet token writes', async () => {
    const c = createMockContext(
      { authorization: 'Bearer fleet-scoped-token-for-unit-tests-123456' },
      'POST',
      '/api/v1/nodes',
    );
    await expect(authMiddleware(c, noop)).rejects.toThrow(/endpoint-scoped/);
  });

  it('should reject missing Authorization header', async () => {
    const c = createMockContext({});
    await expect(authMiddleware(c, noop)).rejects.toThrow(/Missing or malformed/);
  });

  it('should reject malformed Authorization header', async () => {
    const c = createMockContext({ authorization: 'Basic abc123' });
    await expect(authMiddleware(c, noop)).rejects.toThrow(/Missing or malformed/);
  });

  it('should accept valid HS256 JWT', async () => {
    const token = await signUserToken({
      userId: 'user-1',
      email: 'test@example.com',
      role: 'OPERATOR',
    });
    const c = createMockContext({ authorization: `Bearer ${token}` });
    await authMiddleware(c, noop);
    const user = c.get('user') as { userId: string; role: string };
    expect(user.userId).toBe('user-1');
  });

  it('uses the current database role and rejects inactive or deleted users', async () => {
    const token = await signUserToken({ userId: 'user-2', email: 'demoted@example.com', role: 'ADMIN' });
    userStatus.get.mockResolvedValueOnce({ active: true, role: 'VIEWER' });
    const demoted = createMockContext({ authorization: `Bearer ${token}` });
    await authMiddleware(demoted, noop);
    expect(demoted.get('user')).toMatchObject({ userId: 'user-2', role: 'VIEWER' });
    expect(userStatus.get).toHaveBeenLastCalledWith('user-2');

    userStatus.get.mockResolvedValueOnce({ active: false, role: 'ADMIN' });
    await expect(authMiddleware(createMockContext({ authorization: `Bearer ${token}` }), noop))
      .rejects.toThrow(/Invalid or expired/);
    userStatus.get.mockResolvedValueOnce(null);
    await expect(authMiddleware(createMockContext({ authorization: `Bearer ${token}` }), noop))
      .rejects.toThrow(/Invalid or expired/);
  });

  it('should reject expired or tampered JWT', async () => {
    const c = createMockContext({ authorization: 'Bearer invalid.token.here' });
    await expect(authMiddleware(c, noop)).rejects.toThrow(/Invalid or expired/);
  });

  it.each(['/api/v1/nodes', '/api/v1/hermes/installations', '/api/v1/ops/observations', '/api/v1/ops/capacity-advice'])(
    'allows the collector token on %s as a viewer',
    async (path) => {
      const c = createMockContext(
        { authorization: 'Bearer collector-read-token-for-tests' },
        'GET',
        path,
      );
      await authMiddleware(c, noop);
      expect(c.get('user')).toMatchObject({
        userId: 'service:observability-collector',
        role: 'VIEWER',
      });
    },
  );

  it.each([
    ['POST', '/api/v1/nodes'],
    ['GET', '/api/v1/audit'],
    ['GET', '/api/v1/hermes/installations/one'],
  ])('rejects scoped collector credentials for %s %s', async (method, path) => {
    const c = createMockContext(
      { authorization: 'Bearer collector-read-token-for-tests' },
      method,
      path,
    );
    await expect(authMiddleware(c, noop)).rejects.toThrow(/read-only and endpoint-scoped/);
  });

  it('rejects a bad collector collector token', async () => {
    const c = createMockContext({ authorization: 'Bearer wrong-collector-token' });
    await expect(authMiddleware(c, noop)).rejects.toThrow(/Invalid or expired/);
  });
});

describe('scoped service route contract', () => {
  it.each([
    ['GET', '/api/v1/stats/overview'], ['GET', '/api/v1/fleet-checks/latest'],
    ['GET', '/api/v1/fleet-checks/runs'], ['GET', '/api/v1/nodes'],
    ['GET', '/api/v1/nodes/node-1'], ['GET', '/api/v1/nodes/node-1/health'],
    ['GET', '/api/v1/nodes/node-1/health/history'], ['GET', '/api/v1/nodes/wazuh/summary'],
    ['GET', '/api/v1/nodes/system-updates/summary'], ['GET', '/api/v1/nodes/tailscale/summary'],
    ['GET', '/api/v1/hermes/installations'],
    ['GET', '/api/v1/hermes/installations/install-1'], ['GET', '/api/v1/anomalies/summary'],
    ['GET', '/api/v1/anomalies'], ['GET', '/api/v1/anomalies/correlations'],
    ['GET', '/api/v1/anomalies/timeline'], ['POST', '/api/v1/commands'],
    ['GET', '/api/v1/commands/cmd-1'], ['GET', '/api/v1/commands/cmd-1/result'],
    ['GET', '/api/v1/cron'], ['GET', '/api/v1/dependencies'], ['GET', '/api/v1/ops/readiness'],
    ['GET', '/api/v1/ops/dependency-health'], ['GET', '/api/v1/ops/codex-fleet-status'],
    ['GET', '/api/v1/alerts/violations'],
    ['POST', '/api/v1/logs/query'], ['GET', '/api/v1/audit'],
    ['GET', '/api/v1/ops/timeline'], ['GET', '/api/v1/ops/incident-summary'],
    ['GET', '/api/v1/ops/hermes-effective-state'], ['GET', '/api/v1/ops/package-security-posture'],
    ['GET', '/api/v1/predictions'], ['GET', '/api/v1/predictions/node-1'],
    ['POST', '/api/v1/ops/remediation-plan/classify'], ['GET', '/api/v1/skills'],
    ['GET', '/api/v1/security-fusion/overview'], ['GET', '/api/v1/security-fusion/cases'],
    ['GET', '/api/v1/security-fusion/cases/case-1'], ['GET', '/api/v1/security-fusion/events'],
    ['GET', '/api/v1/security-fusion/entities/entity-1'], ['GET', '/api/v1/security-fusion/evidence'],
    ['POST', '/api/v1/security-fusion/cases/case-1/investigations'],
    ['GET', '/api/v1/ops/engineering/catalog'],
    ['POST', '/api/v1/ops/engineering/dependency-impact'],
    ['POST', '/api/v1/ops/engineering/runbook-assessment'],
    ['POST', '/api/v1/ops/engineering/delivery-assessment'],
    ['POST', '/api/v1/ops/engineering/forecast-assessment'],
    ['POST', '/api/v1/ops/engineering/restore-assessment'],
  ])('allows declared plugin route %s %s', (method, path) => {
    const service = path.startsWith('/api/v1/ops/engineering/') ? 'plugin-operator' : method === 'GET' ? 'plugin-read' : 'plugin-operator';
    expect(isScopedServiceRequestAllowed(service, method, path)).toBe(true);
  });

  it.each([
    ['GET', '/api/v1/nodes/scan-users'], ['GET', '/api/v1/nodes/compare'],
    ['POST', '/api/v1/nodes/node-1/system-updates/enable'],
    ['GET', '/api/v1/credentials/rotations'], ['DELETE', '/api/v1/nodes/node-1'],
    ['POST', '/api/v1/dependencies/scan'], ['GET', '/api/v1/dependencies/scan'],
  ])('rejects undeclared plugin route %s %s', (method, path) => {
    expect(isScopedServiceRequestAllowed('plugin-read', method, path)).toBe(false);
    expect(isScopedServiceRequestAllowed('plugin-operator', method, path)).toBe(false);
  });
});

describe('getUser', () => {
  it('should return user when set', () => {
    const c = createMockContext({});
    const fakeUser = {
      userId: 'u1',
      email: 'a@b.c',
      role: 'ADMIN',
      iat: 0,
      exp: 0,
    };
    c.set('user', fakeUser);
    expect(getUser(c)).toEqual(fakeUser);
  });

  it('should throw when user not set', () => {
    const c = createMockContext({});
    expect(() => getUser(c)).toThrow(/Not authenticated/);
  });
});

describe('requireRole', () => {
  it('should pass for matching role', async () => {
    const c = createMockContext({});
    c.set('user', { userId: 'u1', email: '', role: 'ADMIN', iat: 0, exp: 0 });
    const middleware = requireRole('ADMIN');
    await expect(middleware(c, noop)).resolves.toBeUndefined();
  });

  it('should reject non-matching role', async () => {
    const c = createMockContext({});
    c.set('user', { userId: 'u1', email: '', role: 'VIEWER', iat: 0, exp: 0 });
    const middleware = requireRole('ADMIN', 'OPERATOR');
    await expect(middleware(c, noop)).rejects.toThrow(/Requires one of/);
  });
});

describe('Security Fusion permissions', () => {
  const admin = { userId: 'admin', email: '', role: 'ADMIN' as const, iat: 0, exp: 0 };
  const operator = { userId: 'operator', email: '', role: 'OPERATOR' as const, iat: 0, exp: 0 };
  const viewer = { userId: 'viewer', email: '', role: 'VIEWER' as const, iat: 0, exp: 0 };

  it('maps read access only to approved roles and evidence access only to admins', () => {
    expect(hasPermission(admin, 'security-fusion:read')).toBe(true);
    expect(hasPermission(operator, 'security-fusion:read')).toBe(true);
    expect(hasPermission(viewer, 'security-fusion:read')).toBe(true);
    expect(hasPermission(admin, 'security-fusion:evidence:read')).toBe(true);
    expect(hasPermission(operator, 'security-fusion:evidence:read')).toBe(false);
  });

  it('permits a viewer to read but denies raw evidence', async () => {
    const c = createMockContext({});
    c.set('user', viewer);
    await expect(requirePermission('security-fusion:read')(c, noop)).resolves.toBeUndefined();
    await expect(requirePermission('security-fusion:evidence:read')(c, noop)).rejects.toThrow(/permission/);
  });
});

describe('signUserToken', () => {
  it('should return a signed JWT string', async () => {
    const token = await signUserToken({
      userId: 'user-123',
      email: 'test@example.com',
      role: 'OPERATOR',
    });
    expect(typeof token).toBe('string');
    // JWT has 3 dot-separated parts
    expect(token.split('.').length).toBe(3);
  });
});
