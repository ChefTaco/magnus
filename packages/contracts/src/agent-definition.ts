/**
 * `hive-agent-definition/1`: one portable, complete Ardent agent definition. It carries the persona,
 * the runtime it was built for, the reviewed extension packages and the HiveSkills releases it uses
 * by reference, the portable part of its configuration, and what a target must bind for it. It never
 * carries a credential: secrets appear only as the environment variable names a target must provide,
 * and installation-specific resources (HiveMem, the model gateway, HiveSkills, channels, peers) only
 * as named bindings. History, memory, sessions and artifacts are always excluded: a definition is
 * not a state migration.
 *
 * `sha256` is the SHA-256 of the canonical JSON (sorted keys, no whitespace, see `canonicalJson`) of
 * the definition without its `sha256` field. `persona.sha256` is the SHA-256 of the canonical JSON of
 * `{ soul_md, identity_md }`. Both are hex. This module imports only `zod`, so it runs in a browser.
 */
import { z } from 'zod';

export const AGENT_DEFINITION_SCHEMA = 'hive-agent-definition/1' as const;

/**
 * The shared capability vocabulary. Ardent runtime capabilities (recovery, lineage, artifact transfer)
 * are reported by a node's Ardent installation; the others by the dependency that offers them.
 */
export const HIVE_SERVICE_CAPABILITIES = [
  'ardent.recovery.v1', 'ardent.lineage.v1', 'artifact-transfer.v2',
  'emberpath.execution-trace.v1', 'retry-signal.v1', 'skills.pinned-release.v1',
] as const;
export type HiveServiceCapability = typeof HIVE_SERVICE_CAPABILITIES[number];

/** What a definition never carries. Fixed, in this order. */
export const AGENT_DEFINITION_EXCLUDES = ['history', 'memory', 'sessions', 'artifacts'] as const;
export const AGENT_DEFINITION_BINDING_KINDS = ['hivemem', 'emberpath_alias', 'hiveskills', 'channel', 'peer'] as const;
/** Preflight problem codes. Any problem blocks installation; nothing is created on the target. */
export const AGENT_DEFINITION_PROBLEM_CODES = [
  'MISSING_BINDING', 'SKILL_VERSION_UNAVAILABLE', 'EXTENSION_NOT_REVIEWED', 'RUNTIME_INCOMPATIBLE', 'CAPABILITY_MISSING', 'SECRET_UNBOUND',
] as const;

const utf8Length = (value: string) => new TextEncoder().encode(value).length;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const personaText = z.string().max(131_072)
  .refine((value) => value.trim().length > 0 && utf8Length(value) <= 131_072, 'Identity text must be 1 to 128 KiB');
const semver = z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
const packageName = z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u);
const capabilityName = z.string().regex(/^[a-z0-9.-]{1,64}$/u);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
const distinct = (values: string[]) => new Set(values).size === values.length;

/** A requirement's key: `hivemem`, `model`, `hiveskills`, `channel:<name>`, `peers`. */
export const agentDefinitionBindingKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}(?::[a-z0-9][a-z0-9_-]{0,63})?$/u);
/**
 * The key an install's `bindings` uses for a secret requirement: `secret:<ENV_NAME>`. Its value is
 * `provided` (the target profile's environment supplies it) or `none` (run without it); never the value.
 */
export const agentDefinitionSecretBindingKey = (name: string) => `secret:${name}`;
const bindingKey = z.union([agentDefinitionBindingKeySchema, z.string().regex(/^secret:[A-Z][A-Z0-9_]{0,127}$/u)]);
/** A binding's target: a HiveMem workspace or `default`, an Emberpath alias, `default` for HiveSkills, `provided`/`none` for a secret. */
const bindingTarget = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
export const agentDefinitionBindingsSchema = z.record(bindingKey, bindingTarget)
  .refine((value) => Object.keys(value).length <= 128, 'At most 128 bindings');

export const agentDefinitionExtensionSchema = z.object({
  name: packageName,
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  /** npm SRI of the reviewed archive. */
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u),
  /** Digest of the installed package tree the review recorded. */
  package_tree_sha256: digest,
  /**
   * Additive to the plan's shape: the plugin specifiers the profile loads from this package (the
   * package name or a subpath of it). Omitted: the package name.
   */
  plugins: z.array(z.string().min(1).max(500)).min(1).max(32).optional(),
}).strict();

export const agentDefinitionSkillSchema = z.object({
  /** The HiveSkills catalog slug, also the Ardent skill name. */
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
  version: z.string().max(64).regex(/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu),
  /** The release archive's SHA-256, as the catalog and the profile's receipt record it. */
  sha256: digest,
}).strict();

export const agentDefinitionConfigSchema = z.object({
  execution: z.object({
    backend: z.enum(['llamacpp', 'codex']),
    deadline_seconds: z.number().int().min(1).max(86_400).optional(),
    max_parallel_tasks: z.number().int().min(1).max(16).optional(),
    max_parallel_tool_calls: z.number().int().min(1).max(16).optional(),
  }).strict(),
  /** The model is an Emberpath alias, the only portable model reference. Absent: the target binds `model`. */
  model: z.object({ emberpath_alias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u).optional() }).strict(),
  artifacts: z.object({ max_bytes: z.number().int().min(1024).max(67_108_864).optional() }).strict(),
  /** Channels are installation-specific and never carried. */
  channels: z.literal('excluded'),
}).strict();

export const agentDefinitionRequirementsSchema = z.object({
  bindings: z.array(z.object({ key: agentDefinitionBindingKeySchema, kind: z.enum(AGENT_DEFINITION_BINDING_KINDS), required: z.boolean() }).strict())
    .max(64).refine((items) => distinct(items.map((item) => item.key)), 'Duplicate binding key'),
  secrets: z.array(z.object({ env_name: envName, purpose: z.string().trim().min(1).max(200) }).strict())
    .max(64).refine((items) => distinct(items.map((item) => item.env_name)), 'Duplicate secret'),
}).strict();

const definitionFields = {
  schema: z.literal(AGENT_DEFINITION_SCHEMA),
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2000).optional(),
  created_at: z.string().datetime({ offset: true }),
  source_template: z.object({ template_id: z.string().min(1).max(128), version: z.number().int().min(1) }).strict().optional(),
  persona: z.object({ soul_md: personaText, identity_md: personaText, sha256: digest }).strict(),
  runtime: z.object({
    package: packageName,
    version: semver,
    required_capabilities: z.array(capabilityName).max(32).refine((items) => distinct(items.map((item) => item)), 'Duplicate capability'),
  }).strict(),
  extensions: z.array(agentDefinitionExtensionSchema).max(32).refine((items) => distinct(items.map((item) => item.name)), 'Duplicate extension'),
  skills: z.array(agentDefinitionSkillSchema).max(100).refine((items) => distinct(items.map((item) => item.slug)), 'Duplicate skill'),
  config: agentDefinitionConfigSchema,
  requirements: agentDefinitionRequirementsSchema,
  excludes: z.tuple([z.literal('history'), z.literal('memory'), z.literal('sessions'), z.literal('artifacts')]),
};

/** The definition without its digest, as it is hashed. */
export const agentDefinitionBodySchema = z.object(definitionFields).strict();
/** The shape only. `verifyAgentDefinition` checks both digests and the credential guard. */
export const agentDefinitionSchema = z.object({ ...definitionFields, sha256: digest }).strict()
  .refine((value) => utf8Length(JSON.stringify(value)) <= 512 * 1024, 'A definition is at most 512 KiB');

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type AgentDefinitionBody = z.infer<typeof agentDefinitionBodySchema>;
export type AgentDefinitionBindings = z.infer<typeof agentDefinitionBindingsSchema>;
export type AgentDefinitionProblemCode = typeof AGENT_DEFINITION_PROBLEM_CODES[number];

export const agentDefinitionProblemSchema = z.object({ code: z.enum(AGENT_DEFINITION_PROBLEM_CODES), detail: z.string().max(500) });
/** The preflight report: ok exactly when there are no problems. */
export const agentDefinitionPreflightSchema = z.object({ ok: z.boolean(), problems: z.array(agentDefinitionProblemSchema) });
export type AgentDefinitionProblem = z.infer<typeof agentDefinitionProblemSchema>;
export type AgentDefinitionPreflight = z.infer<typeof agentDefinitionPreflightSchema>;

const nodeId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u);
// POST /ardent/agent-definitions/validate. Without bindings, every required binding is reported missing.
export const agentDefinitionValidateRequestSchema = z.object({
  definition: z.unknown(), nodeId, bindings: agentDefinitionBindingsSchema.optional(),
}).strict();
// POST /ardent/agent-definitions/install: a New Agent built from the definition, once its preflight passes.
export const agentDefinitionInstallRequestSchema = z.object({
  definition: z.unknown(),
  nodeId,
  /** The new profile ID on the target. */
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  bindings: agentDefinitionBindingsSchema,
  /** Omitted: the first free port from 9910 on that node. */
  apiPort: z.number().int().min(1024).max(65535).optional(),
}).strict();
// GET /ardent/installations/{nodeId}/profiles/{name}/definition
export const agentDefinitionExportSchema = z.object({
  definition: agentDefinitionSchema,
  /** What the profile has that a definition cannot carry, such as a local skill or an unretained plugin. */
  omitted: z.array(z.object({ kind: z.enum(['skill', 'plugin', 'model', 'channel', 'peer']), name: z.string(), reason: z.string() })),
});

/** Canonical JSON: object keys sorted by code unit, no whitespace, undefined members dropped. Rejects non-JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON has no non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`Canonical JSON cannot hold a ${typeof value}`);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function agentPersonaSha256(persona: { soul_md: string; identity_md: string }): Promise<string> {
  return sha256Hex(canonicalJson({ soul_md: persona.soul_md, identity_md: persona.identity_md }));
}

/** The digest of a definition, computed without its `sha256` member (which may be absent). */
export function agentDefinitionSha256(definition: AgentDefinitionBody | AgentDefinition): Promise<string> {
  const { sha256: _ignored, ...body } = definition as AgentDefinition;
  return sha256Hex(canonicalJson(body));
}

// Definitions are shared and copied, so they must never carry credentials. A guard for obvious mistakes
// (pasted keys and tokens), not a substitute for keeping secrets in the target's environment. The same
// patterns guard ArdentStudio's templates.
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/u,
  /\bnpm_[A-Za-z0-9]{36,}\b/u,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/iu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu,
];

/** JSON paths (`$.persona.soul_md`) of strings, and object keys, that look like credentials. */
export function credentialLikePaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value)) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => credentialLikePaths(item, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(CREDENTIAL_PATTERNS.some((pattern) => pattern.test(key)) ? [`${path}[key]`] : []),
      ...credentialLikePaths(item, `${path}.${key}`),
    ]);
  }
  return [];
}

export type AgentDefinitionCheck =
  | { ok: true; definition: AgentDefinition }
  | { ok: false; code: 'DEFINITION_INVALID' | 'DEFINITION_CONTAINS_CREDENTIAL'; detail: string; paths?: string[] };

/**
 * Everything a receiver checks before it trusts a definition: no credential-like string anywhere (even in
 * a malformed one), the shape, the persona digest and the definition digest.
 */
export async function verifyAgentDefinition(raw: unknown): Promise<AgentDefinitionCheck> {
  const paths = credentialLikePaths(raw);
  if (paths.length) return { ok: false, code: 'DEFINITION_CONTAINS_CREDENTIAL', detail: `Credential-like values at ${paths.slice(0, 10).join(', ')}`, paths };
  const parsed = agentDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'DEFINITION_INVALID', detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500) };
  }
  if (await agentPersonaSha256(parsed.data.persona) !== parsed.data.persona.sha256) return { ok: false, code: 'DEFINITION_INVALID', detail: 'persona.sha256 does not match the persona texts' };
  if (await agentDefinitionSha256(parsed.data) !== parsed.data.sha256) return { ok: false, code: 'DEFINITION_INVALID', detail: 'sha256 does not match the canonical definition' };
  return { ok: true, definition: parsed.data };
}

/** Fill in both digests of a definition body. */
export async function sealAgentDefinition(body: AgentDefinitionBody): Promise<AgentDefinition> {
  const persona = { ...body.persona, sha256: await agentPersonaSha256(body.persona) };
  const sealed = { ...body, persona };
  return { ...sealed, sha256: await agentDefinitionSha256(sealed) };
}
