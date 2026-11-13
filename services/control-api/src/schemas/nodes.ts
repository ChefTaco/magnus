/**
 * Zod schemas for node routes.
 */

import { z } from 'zod';

// ── POST /nodes/register ──
export const registerNodeSchema = z.object({
  name: z.string().min(1, 'name is required'),
  hostname: z.string().min(1, 'hostname is required'),
  ipAddress: z.string().min(1, 'ipAddress is required'),
  port: z.number().int().min(1).max(65535).optional().default(4100),
  os: z.string().optional(),
  arch: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  agentVersion: z.string().optional(),
});

// ── PATCH /nodes/:nodeId ──
export const updateNodeSchema = z.object({
  name: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: z.string().optional(),
  roleId: z.string().nullable().optional(),
});

// ── POST /nodes/tags/bulk ──
export const bulkNodeTagsSchema = z.object({
  nodeIds: z.array(z.string().min(1).max(128)).min(1).max(500),
  action: z.enum(['add', 'remove']),
  tags: z.array(z.string().max(64)).max(100),
});

// ── POST /nodes/:nodeId/migrate ──
export const migrateNodeSchema = z.object({
  targetControlApiUrl: z.string().url('targetControlApiUrl must be a valid URL'),
  targetSecret: z.string().optional(),
});

// ── POST /nodes/:nodeId/provision-user, /nodes/:nodeId/change-password ──
// The same limits the node agent applies, so a bad request is refused here with a
// clear 400 instead of travelling to the node first.
const linuxUsername = z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/, 'username must be a lowercase Linux account name');
const linuxPassword = z.string().min(1).max(512)
  .refine((value) => !/[\r\n\0]/.test(value), 'password must not contain line breaks or NUL');

export const provisionNodeUserSchema = z.object({
  username: linuxUsername,
  password: linuxPassword,
  group: z.string().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*$/, 'group must be a lowercase Linux group name').optional(),
});

export const changeNodeUserPasswordSchema = z.object({
  username: linuxUsername,
  password: linuxPassword,
});
