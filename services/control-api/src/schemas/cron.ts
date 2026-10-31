/**
 * Zod schemas for cron job routes.
 */

import { z } from 'zod';
import { managedCronRegistrationSchema } from './managed-cron.js';
import { nodeEnvironmentSchema } from './commands.js';

// ── POST /cron ──
export const createCronSchema = z.object({
  nodeId: z.string().min(1, 'nodeId is required'),
  name: z.string().min(1, 'name is required'),
  description: z.string().optional().default(''),
  schedule: z.string().min(1, 'schedule (cron expression) is required'),
  command: z.string().min(1, 'command is required'),
  args: z.array(z.string()).optional().default([]),
  workingDirectory: z.string().nullable().optional(),
  environment: nodeEnvironmentSchema.optional().default({}),
  timeoutSeconds: z.number().int().min(1).max(7200).optional().default(600),
  managed: managedCronRegistrationSchema.optional(),
});

// ── PATCH /cron/:cronId ──
export const updateCronSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  schedule: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  status: z.enum(['active', 'paused', 'error', 'ACTIVE', 'PAUSED', 'ERROR']).optional(),
  timeoutSeconds: z.number().int().min(1).max(7200).optional(),
  workingDirectory: z.string().nullable().optional(),
  environment: nodeEnvironmentSchema.optional(),
  managed: managedCronRegistrationSchema.optional(),
});
