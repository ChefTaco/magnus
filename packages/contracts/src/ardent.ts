import { z } from 'zod';

export const ArdentContextAdoptionInputSchema = z.object({ release_id: z.string().guid(),
  expected_bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/), expected_base_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expected_policy_sha256: z.string().regex(/^[a-f0-9]{64}$/), expected_config_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const ArdentContextReleaseSchema = z.object({ schema_version: z.literal(1), engine_version: z.literal('0.1.0'),
  bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/), base_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  policy_sha256: z.string().regex(/^[a-f0-9]{64}$/), config_sha256: z.string().regex(/^[a-f0-9]{64}$/), single_profile: z.boolean(), service_unit_matches: z.boolean() }).strict();
export type ArdentContextAdoptionInput = z.infer<typeof ArdentContextAdoptionInputSchema>;
export type ArdentContextRelease = z.infer<typeof ArdentContextReleaseSchema>;

/**
 * The HiveMem credential Magnus issued a profile (New Agent or Enable HiveMem) and renews before its
 * deadline. `renewal-failing` means the last renewal failed and Magnus is retrying; `expired` means the
 * deadline passed, so the agent has no HiveMem until Enable HiveMem runs again. The token is never shown.
 */
export const ArdentHiveMemCredentialStatusSchema = z.object({
  agentId: z.string(), workspaceId: z.string(),
  expiresAt: z.string().datetime().nullable(),
  lastRenewedAt: z.string().datetime().nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
  nextRenewalAt: z.string().datetime().nullable(),
  failures: z.number().int().min(0),
  lastError: z.string().nullable(),
  state: z.enum(['ok', 'renewal-failing', 'expired']),
});
export type ArdentHiveMemCredentialStatus = z.infer<typeof ArdentHiveMemCredentialStatusSchema>;

export const ArdentProfileSummarySchema = z.object({
  id: z.string(), name: z.string(), backend: z.enum(['llamacpp', 'codex']).nullable(),
  apiPort: z.number().int().nullable(), running: z.boolean(), a2aEnabled: z.boolean(),
  /** Channel name (for example telegram) -> enabled, for every channel the profile declares. */
  channels: z.record(z.string(), z.boolean()),
  error: z.string().nullable(),
  /**
   * Set by the server, never by the node agent: the profile's Magnus-managed HiveMem credential, or null
   * when Magnus manages none. Absent from servers older than credential renewal.
   */
  hivemem: ArdentHiveMemCredentialStatusSchema.nullable().optional(),
});
export type ArdentProfileSummary = z.infer<typeof ArdentProfileSummarySchema>;

export const ArdentNodeStateSchema = z.object({
  installed: z.boolean(), version: z.string().nullable(), owner: z.string(),
  profiles: z.array(ArdentProfileSummarySchema), checkedAt: z.string().datetime(),
  stagedPackage: z.object({ version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).nullable().optional(),
  stagedPackageError: z.string().nullable().optional(),
  /** Bridge features of the node agent; studio is a level (see ARDENT_STUDIO_CAPABILITY). Absent on agents older than the Studio bridge. */
  capabilities: z.object({ studio: z.number().int().min(0).optional() }).optional(),
});
export type ArdentNodeState = z.infer<typeof ArdentNodeStateSchema>;

/**
 * A command owner holding the node's managed execution slot (docs/COMMAND_RESOURCE_LEASES.md). While one is
 * held, no other managed Ardent action runs on the node. `unknown` means nobody knows what the command did.
 */
export const ArdentCommandOwnerSchema = z.object({
  commandId: z.string(),
  state: z.enum(['reserved', 'running', 'unknown']),
  /** `ardent:<profile>:<action>` for an Ardent action; null for other commands and for owners older than the label. */
  label: z.string().nullable(),
  profile: z.string().nullable(),
  action: z.string().nullable(),
  /** An Ardent action, which the `command-reconcile` action can settle. Other commands use POST /commands/{id}/reconcile-resource. */
  ardent: z.boolean(),
  acquiredAt: z.string(),
  dispatchedAt: z.string().nullable(),
  deadline: z.string(),
  /** When a reconciliation is first accepted: the deadline plus the receipt margin. */
  reconcilableAfter: z.string(),
});
export type ArdentCommandOwner = z.infer<typeof ArdentCommandOwnerSchema>;

/** The `command-reconcile` action body: an ADMIN's decision about an Ardent action whose outcome is unknown. */
export const ArdentCommandReconcileSchema = z.object({
  /** What the ADMIN established on the node: the action took effect (fully or partly), or it changed nothing. */
  disposition: z.enum(['effects_verified', 'no_effect_verified']),
  /** What they checked, kept in the audit and bound into the signed decision. */
  reason: z.string().trim().min(10).max(500),
}).strict();
export type ArdentCommandReconcile = z.infer<typeof ArdentCommandReconcileSchema>;
export const ArdentCommandReconcileResultSchema = z.object({
  commandId: z.string(),
  outcome: z.enum(['settled', 'already-settled']),
  /** What the node agent held for the command: a result or decision that settled it, an unknown outcome the ADMIN decided, or nothing. */
  receipt: z.enum(['completed', 'reconciled', 'unknown', 'absent']).nullable(),
  settlement: z.string().nullable(),
  evidenceSha256: z.string().nullable(),
  decisionId: z.string().nullable(),
});
export type ArdentCommandReconcileResult = z.infer<typeof ArdentCommandReconcileResultSchema>;

export const ArdentFleetInstallationSchema = ArdentNodeStateSchema.extend({
  nodeId: z.string(), nodeName: z.string(), hostname: z.string(),
  reachable: z.boolean(), error: z.string().nullable(),
  /** Command owners held on the node, oldest first. Absent from servers older than this field. */
  commandOwners: z.array(ArdentCommandOwnerSchema).optional(),
  /** Whether this server can sign a reconciliation decision (COMMAND_RECONCILIATION_SECRET). The node agent needs the same key. */
  commandReconciliation: z.object({ configured: z.boolean() }).optional(),
});
export type ArdentFleetInstallation = z.infer<typeof ArdentFleetInstallationSchema>;
