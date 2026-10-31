import { Hono } from 'hono';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import { authMiddleware, getUser, requireRole, signUserToken } from '../middleware/auth.js';
import { invalidateUserStatus } from '../middleware/user-status.js';
import { logAuditEvent } from '../services/audit-service.js';
import { hashPassword, verifyPassword } from '../services/password-service.js';
import { HttpError } from '../middleware/error-handler.js';
import { parseBody } from '../utils/validate.js';
import {
  loginSchema,
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
} from '../schemas/users.js';
import { IAM_CORE_URL } from '../utils/env.js';

export const usersRouter = new Hono<AppVariables>();
export const authRouter = new Hono<AppVariables>();

// ─── Auth: POST /auth/login (local Magnus HS256 mode) ──────────────────────

authRouter.post('/login', async (c) => {
  // Login is available when Magnus is using its local dashboard/API auth mode.
  if (IAM_CORE_URL) {
    throw new HttpError(404, 'NOT_FOUND', 'Login endpoint is not available in IAM mode');
  }

  const body = await parseBody(c, loginSchema);
  const db = getDb();

  const user = await db.user.findUnique({ where: { email: body.email } });

  // Prevent timing attacks — always evaluate verifyPassword even on miss
  const dummyHash = '$argon2id$v=19$m=65536,t=3,p=4$dummydummydummy$dummydummydummydummydummydummydummydummy';
  const passwordValid = user
    ? await verifyPassword(user.password, body.password)
    : await verifyPassword(dummyHash, body.password).then(() => false);

  if (!user || !user.active || !passwordValid) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  // Update last login timestamp (fire-and-forget)
  void db.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  }).catch(() => undefined);

  const token = await signUserToken({
    userId: user.id,
    email: user.email,
    role: user.role,
  });

  await logAuditEvent({
    action: 'user.login',
    actorId: user.id,
    actorType: 'user',
    targetType: 'user',
    targetId: user.id,
    details: { email: user.email },
    ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null,
  });

  return c.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// ─── Users CRUD (all require authentication) ────────────────────────────────

usersRouter.use('*', authMiddleware);

/** Omit password from user responses. */
function sanitizeUser(user: { id: string; email: string; name: string; role: string; active: boolean; lastLoginAt: Date | null; createdAt: Date; updatedAt: Date }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// GET /users — list all users (ADMIN only)
usersRouter.get('/', requireRole('ADMIN'), async (c) => {
  const db = getDb();
  const users = await db.user.findMany({
    where: { NOT: { id: 'system' } },
    orderBy: { createdAt: 'desc' },
  });
  return c.json({ users: users.map(sanitizeUser) });
});

// GET /users/:id — get a single user (ADMIN or own account)
usersRouter.get('/:id', async (c) => {
  const caller = getUser(c);
  const userId = c.req.param('id')!;

  if (caller.role !== 'ADMIN' && caller.userId !== userId) {
    throw new HttpError(403, 'FORBIDDEN', 'You can only view your own account');
  }

  const db = getDb();
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found');

  return c.json(sanitizeUser(user));
});

// POST /users — create a new user (ADMIN only)
usersRouter.post('/', requireRole('ADMIN'), async (c) => {
  const caller = getUser(c);
  const body = await parseBody(c, createUserSchema);
  const db = getDb();

  const existing = await db.user.findUnique({ where: { email: body.email } });
  if (existing) throw new HttpError(409, 'CONFLICT', 'A user with this email already exists');

  const passwordHash = await hashPassword(body.password);

  const user = await db.user.create({
    data: {
      email: body.email,
      name: body.name,
      password: passwordHash,
      role: body.role,
    },
  });

  await logAuditEvent({
    action: 'user.create',
    actorId: caller.userId,
    actorType: 'user',
    targetType: 'user',
    targetId: user.id,
    details: { email: user.email, role: user.role },
    ipAddress: c.req.header('x-forwarded-for') ?? null,
  });

  return c.json(sanitizeUser(user), 201);
});

// PATCH /users/:id — update user (ADMIN only)
usersRouter.patch('/:id', requireRole('ADMIN'), async (c) => {
  const caller = getUser(c);
  const userId = c.req.param('id')!;
  const body = await parseBody(c, updateUserSchema);

  if (userId === 'system') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Cannot modify the system user');
  }

  // Prevent admin from demoting themselves
  if (userId === caller.userId && body.role && body.role !== 'ADMIN') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Admins cannot demote their own account');
  }

  const db = getDb();
  const existing = await db.user.findUnique({ where: { id: userId } });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'User not found');

  const user = await db.user.update({
    where: { id: userId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.role !== undefined && { role: body.role }),
      ...(body.active !== undefined && { active: body.active }),
    },
  });
  invalidateUserStatus(userId);

  await logAuditEvent({
    action: 'user.update',
    actorId: caller.userId,
    actorType: 'user',
    targetType: 'user',
    targetId: user.id,
    details: { changes: body },
    ipAddress: c.req.header('x-forwarded-for') ?? null,
  });

  return c.json(sanitizeUser(user));
});

// DELETE /users/:id — delete a user (ADMIN only)
usersRouter.delete('/:id', requireRole('ADMIN'), async (c) => {
  const caller = getUser(c);
  const userId = c.req.param('id')!;

  if (userId === 'system') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Cannot delete the system user');
  }
  if (userId === caller.userId) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Cannot delete your own account');
  }

  const db = getDb();
  const existing = await db.user.findUnique({ where: { id: userId } });
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'User not found');

  await db.user.delete({ where: { id: userId } });
  invalidateUserStatus(userId);

  await logAuditEvent({
    action: 'user.update',
    actorId: caller.userId,
    actorType: 'user',
    targetType: 'user',
    targetId: userId,
    details: { action: 'deleted', email: existing.email },
    ipAddress: c.req.header('x-forwarded-for') ?? null,
  });

  return c.json({ success: true });
});

// PUT /users/:id/password — change password (own account or ADMIN)
usersRouter.put('/:id/password', async (c) => {
  const caller = getUser(c);
  const userId = c.req.param('id')!;
  const body = await parseBody(c, changePasswordSchema);

  const isSelf = caller.userId === userId;
  const isAdmin = caller.role === 'ADMIN';

  if (!isSelf && !isAdmin) {
    throw new HttpError(403, 'FORBIDDEN', 'You can only change your own password');
  }
  if (userId === 'system') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Cannot change the system user password');
  }

  const db = getDb();
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found');

  // Non-admin users must provide their current password
  if (isSelf && !isAdmin) {
    if (!body.currentPassword) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Current password is required');
    }
    const valid = await verifyPassword(user.password, body.currentPassword);
    if (!valid) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    }
  }

  const newHash = await hashPassword(body.newPassword);
  await db.user.update({ where: { id: userId }, data: { password: newHash } });

  await logAuditEvent({
    action: 'user.update',
    actorId: caller.userId,
    actorType: 'user',
    targetType: 'user',
    targetId: userId,
    details: { action: 'password_changed', self: isSelf },
    ipAddress: c.req.header('x-forwarded-for') ?? null,
  });

  return c.json({ success: true });
});
