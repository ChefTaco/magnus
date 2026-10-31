/**
 * Zod schemas for role routes.
 */

import { z } from 'zod';

// ── POST /roles ──
export const createRoleSchema = z.object({
  name: z.string().min(1, 'Role name is required'),
  description: z.string().optional().default(''),
  libraryFileIds: z.array(z.string()).optional().default([]),
  skillNames: z.array(z.string()).optional().default([]),
  aptPackages: z.array(z.string()).optional().default([]),
  npmPackages: z.array(z.string()).optional().default([]),
  envConfig: z.record(z.string(), z.string()).optional().default({}),
  dockerEnabled: z.boolean().optional().default(false),
  dockerNonRoot: z.boolean().optional().default(false),
  dockerImage: z.string().nullable().optional(),
  dockerVolumes: z.array(z.string()).optional().default([]),
  firewallEnabled: z.boolean().optional().default(false),
  firewallMode: z.enum(['restrictive', 'permissive']).optional().default('restrictive'),
  firewallAllowRules: z.array(z.string()).optional().default([]),
  status: z.string().optional().default('active'),
});

// ── PATCH /roles/:roleId ──
export const updateRoleSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  libraryFileIds: z.array(z.string()).optional(),
  skillNames: z.array(z.string()).optional(),
  aptPackages: z.array(z.string()).optional(),
  npmPackages: z.array(z.string()).optional(),
  envConfig: z.record(z.string(), z.string()).optional(),
  dockerEnabled: z.boolean().optional(),
  dockerNonRoot: z.boolean().optional(),
  dockerImage: z.string().nullable().optional(),
  dockerVolumes: z.array(z.string()).optional(),
  firewallEnabled: z.boolean().optional(),
  firewallMode: z.enum(['restrictive', 'permissive']).optional(),
  firewallAllowRules: z.array(z.string()).optional(),
  status: z.string().optional(),
});

// ── POST /roles/:roleId/assign ──
export const assignRoleSchema = z.object({
  nodeIds: z.array(z.string().min(1)).min(1, 'At least one nodeId is required'),
  defer: z.boolean().optional().default(false),
});

// ── POST /roles/:roleId/unassign ──
export const unassignRoleSchema = z.object({
  nodeIds: z.array(z.string().min(1)).min(1, 'At least one nodeId is required'),
});

// ── POST /roles/:roleId/apply ──
export const applyRoleSchema = z.object({
  nodeIds: z.array(z.string().min(1)).optional(),
});
