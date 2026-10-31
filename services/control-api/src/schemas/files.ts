/**
 * Zod schemas for file routes.
 */

import { z } from 'zod';

// ── POST /files/update ──
export const fileUpdateSchema = z.object({
  nodeIds: z.array(z.string().min(1)).min(1, 'At least one nodeId is required'),
  filePath: z.string().min(1, 'filePath is required'),
  content: z.string(),
  createIfMissing: z.boolean().optional().default(true),
  previewOnly: z.boolean().optional().default(false),
  backup: z.boolean().optional().default(true),
});
