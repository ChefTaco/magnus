import { z } from 'zod';
import path from 'node:path';
import { parseRouteAliases } from './route-aliases.js';
import { webhookTypeAliases } from '../services/webhook-types.js';

// ─── Shared environment schema — validated with Zod ───

const portSchema = z.coerce.number().int().min(1).max(65535);
import { isConsoleBasePath } from './console-path.js';
import { oathweaveConfigurationIssues } from './oathweave.js';
import { emberpathConfigurationIssues } from '../services/llm-providers/emberpath.js';

const booleanEnvSchema = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

function configuredDigestValues(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.values(value).filter((entry): entry is string => typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry))
      : [];
  } catch { return []; }
}

/** Default skills directory — `<package root>/skills`. */
const DEFAULT_SKILLS_DIR = path.resolve(import.meta.dirname, '../../skills');

export const envSchema = z.object({
  HIVE_REHEARSAL: booleanEnvSchema,
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // PostgreSQL
  DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//).optional(),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(20),

  // Redis (local)
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: portSchema.default(6379),
  REDIS_URL: z.string().startsWith('redis://').optional(),
  REDIS_PREFIX: z.string().default('magnus:'),

  // Retired master secret. Production rejects this key so credentials cannot
  // silently collapse back into a cross-protocol trust domain.
  MAGNUS_SECRET: z.string().optional(),
  // Dedicated audit-chain key. It must never fall back to an API/JWT secret.
  AUDIT_HMAC_SECRET: z.string().min(32).optional(),

  // Control API
  CONTROL_API_PORT: portSchema.default(4000),
  CONTROL_API_URL: z.string().url().default('https://localhost:4000'),
  API_SECRET: z.string().min(32).optional(),
  MAGNUS_COLLECTOR_TOKEN_SHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),

  MAGNUS_RESOURCE_LEASES_ENABLED: booleanEnvSchema,
  RESOURCE_ENROLLMENT_DASHBOARD_SECRET: z.string().min(32).optional(),
  RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT: z.enum(['gateway', 'absent']).optional(),
  FLEET_GATEWAY_URL: z.string().url().optional(),
  FLEET_GATEWAY_TOKEN_SHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Optional signed team-approval relay (Ed25519 public key + actor bindings).
  APPROVAL_SIGNER_PUBLIC_KEY_PEM: z.string().optional(),
  APPROVAL_SIGNER_PUBLIC_KEY_B64: z.string().min(32).optional(),
  APPROVAL_SIGNER_PUBLIC_KEY_PATH: z.string().optional(),
  APPROVAL_TELEGRAM_ACTOR_SHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  APPROVAL_IPHONE_ACTOR_SHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  MAGNUS_APPROVAL_BRIDGE_CONSUMER: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i).optional(),
  // Accepted approval-assertion signature domain prefixes (comma-separated); first is preferred.
  MAGNUS_APPROVAL_ASSERTION_DOMAINS: z.string()
    .regex(/^\s*[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?\s*(?:,\s*[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?\s*)*$/,
      'must list domain prefixes made of a-z, 0-9, "." and "-", separated by commas')
    .optional(),
  // Security Fusion: off (default) | local (in-process) | remote (external security console).
  SECURITY_FUSION_MODE: z.enum(['off', 'remote'], { error: 'Embedded Security Fusion local mode is retired; export and import state into Cindertrace before selecting remote mode (docs/CINDERTRACE_MIGRATION.md)' }).default('off'),
  CINDERTRACE_RESPONSE_SECRET: z.string().min(32).optional(),
  CINDERTRACE_RESTART_ALLOWLIST: z.string().optional(),
  CINDERTRACE_PROTECTED_TARGET_IDS: z.string().optional(),
  SECURITY_FUSION_API_URL: z.string().url().optional(),
  MAGNUS_SECURITY_CONSOLE_URL: z.string().url().optional(),
  SECURITY_APPROVAL_BRIDGE_TOKEN: z.string().min(32).optional(),
  COMMAND_RECONCILIATION_SECRET: z.string().min(32).optional(),
  RESOURCE_PARTICIPANT_RECONCILIATION_SECRET: z.string().regex(/^[A-Za-z0-9._~+/=-]{32,4096}$/).optional(),
  SHARED_RESOURCE_RECONCILIATION_SECRET: z.string().regex(/^[A-Za-z0-9._~+/=-]{32,4096}$/).optional(),
  SHARED_RESOURCE_MISSION_TRUST_JSON: z.string().optional(),
  SHARED_RESOURCE_RESULT_TRUST_JSON: z.string().optional(),
  DASHBOARD_PUBLIC_ORIGIN: z.string().url().optional(),
  MAGNUS_CONSOLE_BASE_PATH: z.string()
    .refine(isConsoleBasePath, 'must be an absolute path such as /fleet, without a trailing slash or dot segments')
    .optional(),
  MAGNUS_HERMES_ENABLED: booleanEnvSchema,
  MAGNUS_APPLICATION_PROBES_FILE: z.string().optional(),
  MAGNUS_OPERATIONS_CATALOG_FILE: z.string().optional(),
  MAGNUS_ENGINEERING_EVIDENCE_FILE: z.string().optional(),
  MAGNUS_ENGINEERING_EVIDENCE_HEAD_SHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  MAGNUS_RECOVERY_RUNNER_PUBLIC_KEY_FILE: z.string().optional(),
  MAGNUS_LESSONS_HIVEMEM_URL: z.string().url().optional(),
  MAGNUS_LESSONS_HIVEMEM_TOKEN: z.string().optional(),
  MAGNUS_LESSONS_WORKSPACE: z.string().optional(),

  // CORS — comma-separated origins allowed to call the Control API
  CORS_ORIGIN: z.string().default('https://localhost:3000'),

  // Listener security. Cleartext is development-only and must be explicitly
  // enabled; the runtime additionally confines it to loopback.
  CONTROL_API_BIND_HOST: z.string().min(1).optional(),
  ALLOW_INSECURE_HTTP: booleanEnvSchema,

  // Node Manager
  NODE_MANAGER_PORT: portSchema.default(4100),
  NODE_MANAGER_SECRET: z.string().min(32).optional(),
  AGENT_TLS_DOMAIN_SUFFIX: z
    .string()
    .regex(
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
    )
    .optional(),
  ENABLE_AGENT_DISCOVERY: booleanEnvSchema,
  AGENT_DISCOVERY_SECRET: z.string().min(32).optional(),
  CREDENTIAL_ROTATION_KEY: z.string().min(32).optional(),
  CREDENTIAL_ROTATION_STATE_PATH: z.string().optional(),

  // Auth / JWT
  JWT_SECRET: z.string().min(32).optional(),
  RESULT_SIGNING_SECRET: z.string().min(32).optional(),
  RESULT_SIGNING_PREVIOUS_SECRET: z.string().min(32).optional(),
  LOG_INGEST_SIGNING_SECRET: z.string().min(32).optional(),
  LOG_INGEST_PREVIOUS_SIGNING_SECRET: z.string().min(32).optional(),
  MAGNUS_PLUGIN_API_ENABLED: booleanEnvSchema,
  MAGNUS_PLUGIN_TOKEN_SHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON: z.string().optional(),
  MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  MAGNUS_SHARED_RESOURCE_TOKEN_SHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  MAGNUS_EMBERMEND_GRANTS_JSON: z.string().optional(),
  MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON: z.string().optional(),
  MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON: z.string().optional(),
  MAGNUS_FLEET_CHECK_TOKEN_SHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  SECURITY_FUSION_RECEIPT_SIGNING_KEY: z.string().min(32).optional(),
  METRICS_TOKEN: z.string().min(32).optional(),
  WEBHOOK_ENCRYPTION_KEY: z.string().min(32).optional(),
  WEBHOOK_ALLOWED_ORIGINS: z.string().default(''),
  JWT_EXPIRY: z.string().default('24h'),
  IAM_CORE_URL: z.string().url().optional(),
  IAM_TOKEN_ISSUER: z.string().min(1).optional(),
  IAM_TOKEN_AUDIENCE: z.string().min(1).optional(),
  OATHWEAVE_ISSUER: z.string().url().optional(),
  OATHWEAVE_JWKS_URL: z.string().url().optional(),
  OATHWEAVE_USERINFO_URL: z.string().url().optional(),
  MAGNUS_OATHWEAVE_IDENTITIES_JSON: z.string().optional(),

  // Skills
  SKILLS_DIR: z.string().default(DEFAULT_SKILLS_DIR),

  // Log retention
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  HEALTH_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(2).default(7),
  HEALTH_SNAPSHOT_FULL_FIDELITY_HOURS: z.coerce.number().int().min(1).default(24),
  HEALTH_SNAPSHOT_SAMPLE_MINUTES: z.coerce.number().int().min(1).default(15),
  ENGINEERING_EXERCISE_RETENTION_DAYS: z.coerce.number().int().min(30).default(90),
  NOTIFICATION_READ_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  NOTIFICATION_MAX_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  ANOMALY_BASELINE_CACHE_MS: z.coerce.number().int().min(30_000).default(300_000),
  MAGNUS_FLEET_CHECK_LOG_DIR: z.string().optional(),

  // TLS
  TLS_CERT_PATH: z.string().optional(),
  TLS_KEY_PATH: z.string().optional(),
  CONTROL_API_CA_PATH: z.string().optional(),
  CONTROL_API_TLS_SERVERNAME: z.string().optional(),
  CONTROL_HOST_AGENT_CA_PATH: z.string().optional(),
  CONTROL_HOST_AGENT_TLS_SERVERNAME: z.string().optional(),

  // Deploy credentials (write-only — never log or expose in API responses)
  SSH_USERNAME: z.string().optional(),
  SSH_PASSWORD: z.string().optional(),
  SSH_PRIVATE_KEY_PATH: z.string().optional(),
  SSH_HOST_KEY_PINS_FILE: z.string().optional(),
  MAGNUS_DOCKER_USER: z.string().optional(),

  // HiveMem (shared agent memory)
  HIVEMEM_URL: z.string().url().optional(),
  HIVEMEM_TOKEN: z.string().optional(),
  // Ardent New Agent: per-agent HiveMem enrollment and Emberpath aliases (services/ardent-hivemem.ts)
  MAGNUS_ARDENT_HIVEMEM_URL: z.string().url().optional(),
  MAGNUS_ARDENT_HIVEMEM_AGENT_URL: z.string().url().optional(),
  MAGNUS_ARDENT_HIVEMEM_ENROLLMENT_TOKEN: z.string().optional(),
  MAGNUS_ARDENT_HIVEMEM_CLIENT_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  MAGNUS_ARDENT_HIVEMEM_CLIENT_SECRET: z.string().optional(),
  MAGNUS_ARDENT_HIVEMEM_TOKEN_URL: z.string().url().optional(),
  MAGNUS_ARDENT_HIVEMEM_SCOPE: z.string().optional(),
  MAGNUS_ARDENT_HIVEMEM_WORKSPACE_ID: z.string().regex(/^[a-z0-9_-]{1,100}$/).optional(),
  MAGNUS_ARDENT_HIVEMEM_CREDENTIAL_HOURS: z.coerce.number().int().min(1).max(720).optional(),
  MAGNUS_ARDENT_EMBERPATH_URL: z.string().url().optional(),
  // Fleet assistant Emberpath provider (opt-in; services/llm-providers/emberpath.ts)
  MAGNUS_EMBERPATH_URL: z.string().url().optional(),
  MAGNUS_EMBERPATH_API_KEY: z.string().optional(),
  MAGNUS_EMBERPATH_MODEL: z.string().optional(),
  // Ardent skill-install: the HiveSkills registry Magnus fetches catalog releases from (services/ardent-hiveskills.ts)
  MAGNUS_ARDENT_HIVESKILLS_URL: z.string().url().optional(),

  // Managed Hermes Agent fleet configuration (all optional)
  MAGNUS_HERMES_REGISTRY_ENABLED: booleanEnvSchema,
  MAGNUS_REGISTRY_DEPLOY_HOSTS: z.string().default(''),
  // Per-node credentials (docs/NODE_CREDENTIALS.md)
  NODE_AUTH_MODE: z.enum(['compat', 'warn', 'enforce']).default('compat'),
  NODE_AUTH_LEGACY_UPGRADE_UNTIL: z.string().refine(value => !Number.isNaN(new Date(value).getTime()), 'must be an ISO 8601 date').optional(),
  NODE_AUTH_SERVER_KEY_PATH: z.string().min(1).optional(),
  NODE_AUTO_REGISTER: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  MAGNUS_NODE_DNS_SUFFIX: z
    .string()
    .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i)
    .optional(),
  HIVE_ROUTER_URL: z.string().url().optional(),
  HIVE_ROUTER_HEALTH_URL: z.string().url().optional(),
  HIVE_ROUTER_MODEL: z.string().optional(),
  HIVE_ROUTER_API_KEY: z.string().optional(),
  MAGNUS_ROUTER_URL: z.string().url().optional(),
  MAGNUS_ROUTER_MODEL: z.string().optional(),
  MAGNUS_ROUTER_API_KEY: z.string().optional(),
  MAGNUS_SKILLS_HIVEMEM_PLUGIN_DIR: z.string().optional(),
  HERMES_HIVEMEM_WORKSPACE_ID: z.string().optional(),
  HERMES_HIVEMEM_DEFAULT_SCOPE: z.enum(['private', 'shared']).optional(),
  HERMES_OPENAI_RUNTIME: z.enum(['auto', 'codex_app_server']).optional(),
  // Optional legacy-path -> current-path prefix map for older clients (see config/route-aliases.ts).
  MAGNUS_ROUTE_ALIASES_JSON: z.string().optional(),
  // Optional legacy webhook type names: comma-separated legacy=format pairs.
  MAGNUS_WEBHOOK_TYPE_ALIASES: z.string()
    .regex(/^\s*(?:[a-z][a-z0-9_-]{0,31}\s*=\s*(?:generic|slack|discord|mattermost)\s*(?:,\s*|$))*$/,
      'must list legacy=format pairs, where format is generic, slack, discord or mattermost')
    .optional(),
}).superRefine((env, ctx) => {
  if (env.FLEET_GATEWAY_URL) {
    const url = new URL(env.FLEET_GATEWAY_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FLEET_GATEWAY_URL'], message: 'FLEET_GATEWAY_URL must be a bare HTTPS origin' });
    if (env.RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT === 'absent')
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT'], message: 'A deployed fleet gateway cannot be declared absent; unset FLEET_GATEWAY_URL or RESOURCE_ENROLLMENT_DASHBOARD_PARTICIPANT' });
  }
  if (Boolean(env.FLEET_GATEWAY_URL) !== Boolean(env.FLEET_GATEWAY_TOKEN_SHA256))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FLEET_GATEWAY_TOKEN_SHA256'], message: 'FLEET_GATEWAY_URL and FLEET_GATEWAY_TOKEN_SHA256 must be configured together' });
  try { webhookTypeAliases(env.MAGNUS_WEBHOOK_TYPE_ALIASES); } catch (error: unknown) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAGNUS_WEBHOOK_TYPE_ALIASES'],
      message: error instanceof Error ? error.message : 'MAGNUS_WEBHOOK_TYPE_ALIASES is invalid' });
  }
  try { parseRouteAliases(env.MAGNUS_ROUTE_ALIASES_JSON); } catch (error: unknown) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAGNUS_ROUTE_ALIASES_JSON'],
      message: error instanceof Error ? error.message : 'MAGNUS_ROUTE_ALIASES_JSON is invalid' });
  }
  if (env.HEALTH_SNAPSHOT_FULL_FIDELITY_HOURS > env.HEALTH_SNAPSHOT_RETENTION_DAYS * 24) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['HEALTH_SNAPSHOT_FULL_FIDELITY_HOURS'],
      message: 'HEALTH_SNAPSHOT_FULL_FIDELITY_HOURS cannot exceed HEALTH_SNAPSHOT_RETENTION_DAYS * 24',
    });
  }
  if (env.NOTIFICATION_READ_RETENTION_DAYS > env.NOTIFICATION_MAX_RETENTION_DAYS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['NOTIFICATION_READ_RETENTION_DAYS'],
      message: 'NOTIFICATION_READ_RETENTION_DAYS cannot exceed NOTIFICATION_MAX_RETENTION_DAYS',
    });
  }

  for (const issue of emberpathConfigurationIssues(env)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
  }

  for (const issue of oathweaveConfigurationIssues(env)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
  }

  if (env.IAM_CORE_URL) {
    for (const field of ['IAM_TOKEN_ISSUER', 'IAM_TOKEN_AUDIENCE'] as const) {
      if (env[field]) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required when IAM_CORE_URL is configured`,
      });
    }
  }

  if (env.NODE_ENV === 'production' && env.MAGNUS_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAGNUS_SECRET'],
      message: 'MAGNUS_SECRET is retired; configure purpose-specific credentials',
    });
  }

  if (
    env.NODE_ENV === 'production'
    && env.CORS_ORIGIN.split(',').some((origin) => origin.trim() === '*')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CORS_ORIGIN'],
      message: 'CORS_ORIGIN cannot be wildcard in production',
    });
  }

  if (Boolean(env.TLS_CERT_PATH) !== Boolean(env.TLS_KEY_PATH)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TLS_CERT_PATH'],
      message: 'TLS_CERT_PATH and TLS_KEY_PATH must be configured together',
    });
  }
  if (env.NODE_ENV === 'production' && (!env.TLS_CERT_PATH || !env.TLS_KEY_PATH)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TLS_CERT_PATH'],
      message: 'TLS_CERT_PATH and TLS_KEY_PATH are required in production',
    });
  }
  if (env.NODE_ENV === 'production' && env.ALLOW_INSECURE_HTTP) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ALLOW_INSECURE_HTTP'],
      message: 'ALLOW_INSECURE_HTTP cannot be enabled in production',
    });
  }

  if (env.ENABLE_AGENT_DISCOVERY && !env.AGENT_DISCOVERY_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AGENT_DISCOVERY_SECRET'],
      message: 'AGENT_DISCOVERY_SECRET is required when ENABLE_AGENT_DISCOVERY=true',
    });
  }


  if (env.MAGNUS_PLUGIN_API_ENABLED) {
    if (!env.MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON'],
        message: 'MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON is required when MAGNUS_PLUGIN_API_ENABLED=true' });
    if (!env.MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256'],
        message: 'MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256 is required when MAGNUS_PLUGIN_API_ENABLED=true' });
  }
  if (env.NODE_ENV === 'production' && !env.DATABASE_URL) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_URL'],
      message: 'DATABASE_URL is required in production' });
  }

  if (env.NODE_ENV === 'production' && env.MAGNUS_PLUGIN_TOKEN_SHA256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MAGNUS_PLUGIN_TOKEN_SHA256'],
      message: 'MAGNUS_PLUGIN_TOKEN_SHA256 is retired; configure per-installation read digests',
    });
  }
  if (env.MAGNUS_SHARED_RESOURCE_TOKEN_SHA256
    && env.MAGNUS_SHARED_RESOURCE_TOKEN_SHA256 === env.MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAGNUS_SHARED_RESOURCE_TOKEN_SHA256'],
      message: 'shared resource credential must differ from plugin credentials' });
  }
  if (env.MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON) {
    try {
      const digests = JSON.parse(env.MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON) as Record<string, unknown>;
      const entries = Object.entries(digests);
      if (entries.length < 1 || entries.length > 16) throw new Error('plugin digest registry must contain 1-16 entries');
      const seen = new Set<string>();
      for (const [consumer, digest] of entries) {
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(consumer)) throw new Error('plugin consumer ID is invalid');
        if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${consumer} digest is invalid`);
        if (seen.has(digest)) throw new Error('plugin read credentials must be unique per consumer');
        seen.add(digest);
      }
      if (env.MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256 && seen.has(env.MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256)) {
        throw new Error('plugin operator credential must differ from every read credential');
      }
      if (env.MAGNUS_SHARED_RESOURCE_TOKEN_SHA256 && (seen.has(env.MAGNUS_SHARED_RESOURCE_TOKEN_SHA256)
        || env.MAGNUS_SHARED_RESOURCE_TOKEN_SHA256 === env.MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256)) {
        throw new Error('shared resource credential must differ from plugin credentials');
      }
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON'],
        message: error instanceof Error ? error.message : 'Invalid plugin digest registry',
      });
    }
  }
  if (env.MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON) {
    try {
      const digests = JSON.parse(env.MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON) as Record<string, unknown>;
      const entries = Object.entries(digests);
      if (entries.length < 1 || entries.length > 32) throw new Error('shared resource digest registry must contain 1-32 entries');
      const seen = new Set<string>();
      for (const [consumer, digest] of entries) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(consumer)) throw new Error('shared resource consumer ID is invalid');
        if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${consumer} digest is invalid`);
        if (seen.has(digest)) throw new Error('shared resource credentials must be unique per consumer');
        seen.add(digest);
      }
      if (env.MAGNUS_SHARED_RESOURCE_TOKEN_SHA256 && seen.has(env.MAGNUS_SHARED_RESOURCE_TOKEN_SHA256))
        throw new Error('legacy and per-client shared resource credentials must differ');
      if (env.MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256 && seen.has(env.MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256))
        throw new Error('shared resource credentials must differ from plugin credentials');
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON'],
        message: error instanceof Error ? error.message : 'Invalid shared resource digest registry' });
    }
  }
  const otherScopedDigests = new Set([
    env.MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256,
    env.MAGNUS_FLEET_CHECK_TOKEN_SHA256,
    env.MAGNUS_COLLECTOR_TOKEN_SHA256,
    env.FLEET_GATEWAY_TOKEN_SHA256,
    ...configuredDigestValues(env.MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON),
  ].filter((value): value is string => Boolean(value)));
  if (env.MAGNUS_SHARED_RESOURCE_TOKEN_SHA256 && otherScopedDigests.has(env.MAGNUS_SHARED_RESOURCE_TOKEN_SHA256)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAGNUS_SHARED_RESOURCE_TOKEN_SHA256'],
      message: 'legacy shared resource credential must differ from every plugin, fleet, and collector credential' });
  }
  if (configuredDigestValues(env.MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON).some(digest => otherScopedDigests.has(digest))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON'],
      message: 'shared resource credentials must differ from every plugin, fleet, and collector credential' });
  }

  for (const raw of env.WEBHOOK_ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean)) {
    try {
      const url = new URL(raw);
      if (
        url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || (url.pathname !== '/' && url.pathname !== '')
      ) throw new Error('invalid');
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WEBHOOK_ALLOWED_ORIGINS'],
        message: 'WEBHOOK_ALLOWED_ORIGINS must contain comma-separated exact HTTPS origins',
      });
      break;
    }
  }

  const purposeSecrets = [
    'API_SECRET',
    'JWT_SECRET',
    'NODE_MANAGER_SECRET',
    'AGENT_DISCOVERY_SECRET',
    'CREDENTIAL_ROTATION_KEY',
    'AUDIT_HMAC_SECRET',
    'RESULT_SIGNING_SECRET',
    'RESULT_SIGNING_PREVIOUS_SECRET',
    'LOG_INGEST_SIGNING_SECRET',
    'LOG_INGEST_PREVIOUS_SIGNING_SECRET',
    'SECURITY_FUSION_RECEIPT_SIGNING_KEY',
    'METRICS_TOKEN',
    'WEBHOOK_ENCRYPTION_KEY',
    'RESOURCE_ENROLLMENT_DASHBOARD_SECRET',
    'SECURITY_APPROVAL_BRIDGE_TOKEN',
    'COMMAND_RECONCILIATION_SECRET',
    'RESOURCE_PARTICIPANT_RECONCILIATION_SECRET',
    'SHARED_RESOURCE_RECONCILIATION_SECRET',
  ] as const;
  const configured = new Map<string, string>();
  for (const field of purposeSecrets) {
    const value = env[field];
    if (!value) continue;
    const prior = configured.get(value);
    if (prior) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be distinct from ${prior}`,
      });
    } else {
      configured.set(value, field);
    }
  }
}).transform((env) => {
  const magnusRouterUrl = env.MAGNUS_ROUTER_URL ?? env.HIVE_ROUTER_URL;
  const magnusRouterModel = env.MAGNUS_ROUTER_MODEL ?? env.HIVE_ROUTER_MODEL;
  const magnusRouterApiKey = env.MAGNUS_ROUTER_API_KEY ?? env.HIVE_ROUTER_API_KEY;
  return {
    ...env,
    MAGNUS_ROUTER_URL: magnusRouterUrl,
    MAGNUS_ROUTER_MODEL: magnusRouterModel,
    MAGNUS_ROUTER_API_KEY: magnusRouterApiKey,
  };
});

export type Env = z.infer<typeof envSchema>;

/** Parse and validate env vars. Throws on invalid config. */
export function loadEnv(overrides?: Record<string, string | undefined>): Env {
  const source = { ...process.env, ...overrides };
  return envSchema.parse(source);
}
