// Public browser contract for the Magnus console API. Zod schemas only; no server imports.
import { z } from 'zod';

export const consoleRoleSchema = z.enum(['ADMIN', 'OPERATOR', 'VIEWER']);
export const consoleCapabilitiesSchema = z.object({
  hermes: z.boolean(),
  agentVersion: z.string(),
  magnusVersion: z.string(),
  securityConsoleUrl: z.string().nullable(),
});
export const consoleSessionSchema = z.object({
  userId: z.string().min(1),
  role: consoleRoleSchema,
  capabilities: consoleCapabilitiesSchema,
});
export const consoleSessionResponseSchema = z.object({ success: z.literal(true), data: consoleSessionSchema });
