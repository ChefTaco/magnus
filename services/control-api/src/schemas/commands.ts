/**
 * Zod schemas for command-related routes.
 */

import { z } from 'zod';
import { commandReconciliationSchema } from './command-reconciliation.js';
import { isSensitiveDetailKey } from '../services/audit-service.js';

/**
 * Node-bound environment. Commands and cron jobs persist their environment and
 * dispatch it from the database, where secret-named values are redacted, so a
 * secret-named key would silently reach the node as "[REDACTED]". Reject it.
 */
export const nodeEnvironmentSchema = z.record(z.string(), z.string()).superRefine((environment, ctx) => {
  for (const key of Object.keys(environment)) {
    if (!isSensitiveDetailKey(key)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: `Environment variable "${key}" is secret-named and is never stored or dispatched; `
        + 'provision the secret on the node and reference it instead',
    });
  }
});

// ── POST /commands ──
export const dispatchCommandSchema = z.object({
  idempotencyKey: z.string().optional(),
  nodeIds: z.array(z.string().min(1)).min(1, 'At least one nodeId is required'),
  command: z.string().min(1, 'command is required'),
  args: z.array(z.string()).optional().default([]),
  workingDirectory: z.string().optional(),
  environment: nodeEnvironmentSchema.optional().default({}),
  timeoutSeconds: z.number().int().min(1).max(3600).optional().default(300),
  riskLevel: z.enum(['low', 'medium', 'high']).optional().default('medium'),
  dryRun: z.boolean().optional().default(false),
});

// ── POST /commands/:commandId/cancel ──
export const cancelCommandSchema = z.object({
  reason: z.string().optional(),
});

// ── POST /quick-command/:nodeId/exec ──
export const quickCommandSchema = z.object({
  command: z.string().min(1, 'command is required'),
  args: z.array(z.string()).optional().default([]),
  timeoutSeconds: z.number().int().min(1).max(600).optional().default(120),
  workingDirectory: z.string().optional(),
});

// Empty body refreshes the existing signed node receipt; no unsigned unlock.
export const reconcileCommandResourceSchema = z.object({
  assertion: commandReconciliationSchema.optional(),
}).strict();
