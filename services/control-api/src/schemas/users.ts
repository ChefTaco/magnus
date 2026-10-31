/**
 * Zod schemas for user and auth routes.
 */

import { z } from 'zod';

// ── POST /auth/login ──
export const loginSchema = z.object({
  email: z.string().email('Valid email required'),
  password: z.string().min(1, 'Password is required'),
});

// ── POST /users ──
export const createUserSchema = z.object({
  email: z.string().email('Valid email required'),
  name: z.string().min(1, 'Name is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']).optional().default('VIEWER'),
});

// ── PATCH /users/:id ──
export const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(['ADMIN', 'OPERATOR', 'VIEWER']).optional(),
  active: z.boolean().optional(),
});

// ── PUT /users/:id/password ──
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});
