import { z } from 'zod';

export const ArdentProfileSummarySchema = z.object({
  id: z.string(), name: z.string(), backend: z.enum(['llamacpp', 'codex']).nullable(),
  apiPort: z.number().int().nullable(), running: z.boolean(), a2aEnabled: z.boolean(),
  /** Channel name (for example telegram) -> enabled, for every channel the profile declares. */
  channels: z.record(z.string(), z.boolean()),
  error: z.string().nullable(),
});
export type ArdentProfileSummary = z.infer<typeof ArdentProfileSummarySchema>;

export const ArdentNodeStateSchema = z.object({
  installed: z.boolean(), version: z.string().nullable(), owner: z.string(),
  profiles: z.array(ArdentProfileSummarySchema), checkedAt: z.string().datetime(),
  stagedPackage: z.object({ version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).nullable().optional(),
  stagedPackageError: z.string().nullable().optional(),
});
export type ArdentNodeState = z.infer<typeof ArdentNodeStateSchema>;

export const ArdentFleetInstallationSchema = ArdentNodeStateSchema.extend({
  nodeId: z.string(), nodeName: z.string(), hostname: z.string(),
  reachable: z.boolean(), error: z.string().nullable(),
});
export type ArdentFleetInstallation = z.infer<typeof ArdentFleetInstallationSchema>;
