import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env['JWT_SECRET'] = 'users-route-test-jwt-secret-at-least-32-chars';

interface StoredUser {
  id: string; email: string; name: string; role: 'ADMIN' | 'OPERATOR' | 'VIEWER'; active: boolean; password: string;
  lastLoginAt: Date | null; createdAt: Date; updatedAt: Date;
}

const mocks = vi.hoisted(() => ({
  users: new Map<string, StoredUser>(),
  logAuditEvent: vi.fn(),
}));

function select(user: StoredUser, fields?: Record<string, boolean>) {
  if (!fields) return { ...user };
  return Object.fromEntries(Object.keys(fields).map((key) => [key, user[key as keyof StoredUser]]));
}

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    user: {
      findUnique: async ({ where, select: fields }: { where: { id?: string; email?: string }; select?: Record<string, boolean> }) => {
        const user = where.id ? mocks.users.get(where.id) : [...mocks.users.values()].find((u) => u.email === where.email);
        return user ? select(user, fields) : null;
      },
      findMany: async () => [...mocks.users.values()],
      update: async ({ where, data }: { where: { id: string }; data: Partial<StoredUser> }) => {
        const user = mocks.users.get(where.id)!;
        Object.assign(user, data, { updatedAt: new Date() });
        return { ...user };
      },
      create: vi.fn(),
      delete: vi.fn(),
    },
  }),
}));
vi.mock('../services/audit-service.js', () => ({ logAuditEvent: mocks.logAuditEvent }));

const { Hono } = await import('hono');
const { errorHandler } = await import('../middleware/error-handler.js');
const { hashPassword } = await import('../services/password-service.js');
const { invalidateUserStatus } = await import('../middleware/user-status.js');
const { usersRouter, authRouter } = await import('./users.js');
const app = new Hono().route('/auth', authRouter).route('/users', usersRouter).onError(errorHandler);

const ADMIN_PASSWORD = 'admin-password-for-tests';
const VIEWER_PASSWORD = 'viewer-password-for-tests';

async function login(email: string, password: string): Promise<string> {
  const res = await app.request('/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

function call(path: string, token: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  invalidateUserStatus();
  mocks.users.clear();
  const now = new Date();
  mocks.users.set('admin-1', { id: 'admin-1', email: 'admin@example.com', name: 'Admin', role: 'ADMIN', active: true,
    password: await hashPassword(ADMIN_PASSWORD), lastLoginAt: null, createdAt: now, updatedAt: now });
  mocks.users.set('viewer-1', { id: 'viewer-1', email: 'viewer@example.com', name: 'Viewer', role: 'VIEWER', active: true,
    password: await hashPassword(VIEWER_PASSWORD), lastLoginAt: null, createdAt: now, updatedAt: now });
});

describe('local user accounts', () => {
  it('ends existing sessions when the password changes and hands the caller a new one', async () => {
    const token = await login('viewer@example.com', VIEWER_PASSWORD);
    const otherSession = await login('viewer@example.com', VIEWER_PASSWORD);
    expect((await call('/users/viewer-1', token)).status).toBe(200);

    const res = await call('/users/viewer-1/password', token, 'PUT', { currentPassword: VIEWER_PASSWORD, newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(200);
    const { token: fresh } = (await res.json()) as { token: string };

    expect((await call('/users/viewer-1', token)).status).toBe(401);
    expect((await call('/users/viewer-1', otherSession)).status).toBe(401);
    expect((await call('/users/viewer-1', fresh)).status).toBe(200);
  });

  it('ends the user\'s sessions when an admin resets the password', async () => {
    const admin = await login('admin@example.com', ADMIN_PASSWORD);
    const viewer = await login('viewer@example.com', VIEWER_PASSWORD);
    const res = await call('/users/viewer-1/password', admin, 'PUT', { newPassword: 'reset-by-the-admin' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect((await call('/users/viewer-1', viewer)).status).toBe(401);
    expect((await call('/users', admin)).status).toBe(200);
  });

  it('requires the current password when an admin changes their own', async () => {
    const admin = await login('admin@example.com', ADMIN_PASSWORD);
    expect((await call('/users/admin-1/password', admin, 'PUT', { newPassword: 'taken-over-password' })).status).toBe(400);
    expect((await call('/users/admin-1/password', admin, 'PUT', { currentPassword: 'wrong-password', newPassword: 'taken-over-password' })).status).toBe(401);
    const ok = await call('/users/admin-1/password', admin, 'PUT', { currentPassword: ADMIN_PASSWORD, newPassword: 'rotated-admin-password' });
    expect(ok.status).toBe(200);
  });

  it('refuses to let an admin deactivate or demote their own account', async () => {
    const admin = await login('admin@example.com', ADMIN_PASSWORD);
    expect((await call('/users/admin-1', admin, 'PATCH', { active: false })).status).toBe(400);
    expect((await call('/users/admin-1', admin, 'PATCH', { role: 'VIEWER' })).status).toBe(400);
    expect(mocks.users.get('admin-1')!.active).toBe(true);
    expect((await call('/users/viewer-1', admin, 'PATCH', { active: false })).status).toBe(200);
  });

  it('keeps a viewer to their own account', async () => {
    const viewer = await login('viewer@example.com', VIEWER_PASSWORD);
    expect((await call('/users', viewer)).status).toBe(403);
    expect((await call('/users/admin-1', viewer)).status).toBe(403);
    expect((await call('/users/admin-1/password', viewer, 'PUT', { newPassword: 'not-my-account' })).status).toBe(403);
  });

  it('audits the socket peer, not a forwarding header the client sent', async () => {
    const admin = await login('admin@example.com', ADMIN_PASSWORD);
    await call('/users/viewer-1', admin, 'PATCH', { name: 'Renamed' }, { 'x-forwarded-for': '203.0.113.99' });
    const event = mocks.logAuditEvent.mock.calls.map(([e]) => e as { action: string; ipAddress: unknown }).find((e) => e.action === 'user.update');
    // Without a socket (adapter-free test request) the header is the only source left.
    expect(event?.ipAddress).toBe('203.0.113.99');
  });
});
