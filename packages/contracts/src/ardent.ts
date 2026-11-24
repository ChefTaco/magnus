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
  /**
   * The Ardent version this profile runs: its own status when it is running, else the installed package.
   * Null when neither is known. Absent from node agents older than studio level 4.
   */
  version: z.string().nullable().optional(),
  /**
   * What this profile offers through Magnus (ardentProfileCapabilities, capped by the node agent): recovery
   * and lineage 1 on Ardent 3.2.0 or later, artifact_transfer 2 when the profile serves transfer v2.
   * Absent from node agents older than studio level 4.
   */
  capabilities: z.object({ recovery: z.number().int().min(0), lineage: z.number().int().min(0), artifact_transfer: z.number().int().min(0) })
    .catchall(z.number().int().min(0)).optional(),
});
export type ArdentProfileSummary = z.infer<typeof ArdentProfileSummarySchema>;

/** The profile environment key naming the instance in a profile's execution references (Ardent 3.2.0). */
export const ARDENT_INSTANCE_REF_ENV = 'ARDENT_INSTANCE_REF';
/** What Ardent accepts in ARDENT_INSTANCE_REF; any other value stops the runtime, so Magnus never writes one. */
export const ARDENT_INSTANCE_REF_PATTERN = /^[A-Za-z0-9._-]{1,96}$/u;
/** `<node id>.<profile>`, the instance Magnus gives a managed profile, or null when Ardent would not accept it. */
export function ardentInstanceRef(nodeId: string, profile: string): string | null {
  const value = `${nodeId}.${profile}`;
  return nodeId.length > 0 && profile.length > 0 && ARDENT_INSTANCE_REF_PATTERN.test(value) ? value : null;
}

/** The per-profile capabilities a route or action needs, and the capability name Ardent and the Registry use (C5). */
export const ARDENT_RUNTIME_GATES = {
  recovery: { level: 1, capability: 'ardent.recovery.v1' },
  lineage: { level: 1, capability: 'ardent.lineage.v1' },
  artifact_transfer: { level: 2, capability: 'artifact-transfer.v2' },
} as const;
export type ArdentRuntimeGate = keyof typeof ARDENT_RUNTIME_GATES;
/** The Ardent release that added recovery, lineage, execution context and artifact transfer v2. */
export const ARDENT_RUNTIME_CONTRACTS_VERSION = '3.2.0';
export type ArdentProfileCapabilities = { recovery: number; lineage: number; artifact_transfer: number };

const releaseVersion = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u;
/** Whether `version` is `minimum` or later. A version that is not X.Y.Z (or unknown) is not. */
export function ardentVersionAtLeast(version: string | null | undefined, minimum: string): boolean {
  const have = releaseVersion.exec(version ?? '');
  const need = releaseVersion.exec(minimum);
  if (!have || !need) return false;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(have[index]) - Number(need[index]);
    if (difference) return difference > 0;
  }
  // A prerelease of the minimum is older than the release.
  return !/-/u.test(version ?? '');
}

/**
 * The capabilities of one Ardent profile, from its GET /api/v1/status when it answered (version, the
 * `recovery` counts and `capabilities.artifact_transfer`) or else from the installed package version.
 * Recovery and lineage came together with the `recovery` counts in Ardent 3.2.0; artifact transfer
 * version 1 is what every Ardent serves. `agent` caps each level at what the node agent relays.
 */
export function ardentProfileCapabilities(status: unknown, installedVersion: string | null | undefined,
  agent: Partial<Record<string, number>> = {}): { version: string | null; capabilities: ArdentProfileCapabilities } {
  const record = status && typeof status === 'object' && !Array.isArray(status) ? status as Record<string, unknown> : undefined;
  const reported = typeof record?.['version'] === 'string' && record['version'].length <= 64 ? record['version'] : undefined;
  const version = reported ?? installedVersion ?? null;
  const current = ardentVersionAtLeast(version, ARDENT_RUNTIME_CONTRACTS_VERSION);
  const counts = record ? record['recovery'] !== undefined && record['recovery'] !== null : true;
  const declared = record?.['capabilities'] && typeof record['capabilities'] === 'object'
    ? (record['capabilities'] as Record<string, unknown>)['artifact_transfer'] : undefined;
  const transfer = record
    ? typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0 ? declared : 1
    : current ? 2 : 1;
  const cap = (name: keyof ArdentProfileCapabilities, level: number) => {
    const limit = agent[name];
    return typeof limit === 'number' ? Math.max(0, Math.min(level, limit)) : level;
  };
  const runtime = current && counts ? 1 : 0;
  return { version, capabilities: { recovery: cap('recovery', runtime), lineage: cap('lineage', runtime), artifact_transfer: cap('artifact_transfer', transfer) } };
}

/** One retained, reviewed extension package of an Ardent installation. */
export const ArdentRetainedExtensionSchema = z.object({
  name: z.string(), version: z.string(), integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/), packageTreeSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ArdentRetainedExtension = z.infer<typeof ArdentRetainedExtensionSchema>;

/** The `.hiveskills.json` receipts of the HiveSkills releases Magnus installed on a profile, from the node agent (older agents answer 404). */
export const ArdentSkillReceiptsSchema = z.object({
  schema_version: z.literal(1),
  skills: z.array(z.object({ name: z.string(), version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
});
export type ArdentSkillReceipts = z.infer<typeof ArdentSkillReceiptsSchema>;

export const ArdentNodeStateSchema = z.object({
  installed: z.boolean(), version: z.string().nullable(), owner: z.string(),
  profiles: z.array(ArdentProfileSummarySchema), checkedAt: z.string().datetime(),
  stagedPackage: z.object({ version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).nullable().optional(),
  stagedPackageError: z.string().nullable().optional(),
  /** Bridge features of the node agent; studio is a level (see ARDENT_STUDIO_CAPABILITY). Absent on agents older than the Studio bridge. */
  capabilities: z.object({ studio: z.number().int().min(0).optional() }).catchall(z.number().int().min(0)).optional(),
  /** The installed Ardent package name (one of the agent's accepted names). */
  packageName: z.string().nullable().optional(),
  /**
   * The reviewed extension packages retained beside the runtime (extension-bundle.json, bound to the package
   * receipt): empty without a bundle, null when the bundle cannot be read. Absent on older node agents.
   */
  extensions: z.array(ArdentRetainedExtensionSchema).nullable().optional(),
  extensionsError: z.string().nullable().optional(),
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
  /** Whether this server can sign a reconciliation decision: with its node-auth key (agents with a node key), or COMMAND_RECONCILIATION_SECRET (older agents need the same key). */
  commandReconciliation: z.object({ configured: z.boolean() }).optional(),
});
export type ArdentFleetInstallation = z.infer<typeof ArdentFleetInstallationSchema>;
