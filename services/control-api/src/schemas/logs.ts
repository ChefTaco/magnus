/**
 * Zod schemas for log and notification routes.
 */

import { z } from 'zod';

// ── POST /logs/query ──
export const logQuerySchema = z.object({
  nodeId: z.string().optional(),
  source: z.string().optional(),
  level: z.string().optional(),
  search: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
  cursor: z.string().optional(),
});

// ── POST /logs/ingest (single entry) ──
const logEntrySchema = z.object({
  nodeId: z.string().min(1),
  source: z.string().optional().default('agent'),
  level: z.string().optional().default('info'),
  message: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().optional(),
});

// ── POST /logs/ingest (single or array) ──
export const logIngestSchema = z.union([
  logEntrySchema,
  z.array(logEntrySchema).min(1),
]);

// ── POST /notifications/read ──
export const notificationReadSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'ids array required'),
});
