/**
 * Zod schemas for deploy routes.
 */

import { z } from 'zod';

// ── POST /deploy ──
export const deployNodeSchema = z.object({
  hostname: z.string().min(1, 'hostname is required'),
  name: z.string().optional(),
  sshPort: z.number().int().min(1).max(65535).optional(),
  nodeId: z.string().optional(),
});

// ── POST /deploy/control-node ──
export const deployControlNodeSchema = z.object({
  hostname: z.string().min(1, 'hostname is required'),
  sshPort: z.number().int().min(1).max(65535).optional(),
  controlApiPort: z.number().int().min(1).max(65535).optional(),
  nodeManagerSecret: z.string().optional(),
  corsOrigin: z.string().url().optional(),
});
