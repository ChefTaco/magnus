import { z } from 'zod';

export const ArdentContextAdoptionInputSchema = z.object({ release_id: z.string().guid(),
  expected_bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/), expected_base_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expected_policy_sha256: z.string().regex(/^[a-f0-9]{64}$/), expected_config_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const ArdentContextReleaseSchema = z.object({ schema_version: z.literal(1), engine_version: z.literal('0.1.0'),
  bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/), base_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  policy_sha256: z.string().regex(/^[a-f0-9]{64}$/), config_sha256: z.string().regex(/^[a-f0-9]{64}$/), single_profile: z.boolean(), service_unit_matches: z.boolean() }).strict();
export type ArdentContextAdoptionInput = z.infer<typeof ArdentContextAdoptionInputSchema>;
export type ArdentContextRelease = z.infer<typeof ArdentContextReleaseSchema>;

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
  /** Bridge features of the node agent. Absent on agents older than the Studio bridge. */
  capabilities: z.object({ studio: z.number().int().min(0).optional() }).optional(),
});
export type ArdentNodeState = z.infer<typeof ArdentNodeStateSchema>;

export const ArdentFleetInstallationSchema = ArdentNodeStateSchema.extend({
  nodeId: z.string(), nodeName: z.string(), hostname: z.string(),
  reachable: z.boolean(), error: z.string().nullable(),
});
export type ArdentFleetInstallation = z.infer<typeof ArdentFleetInstallationSchema>;
