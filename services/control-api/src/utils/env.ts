/**
 * Centralized, validated environment secrets for control-api.
 *
 * Import secrets from this module instead of reading process.env directly.
 * Secrets are read from process.env at import time. Ensure dotenv has loaded
 * before any module that imports this is evaluated (use dynamic imports in
 * the entry point — index.ts already does this).
 *
 * At startup, `validateSecrets()` performs both fail-fast missing-secret
 * checks AND full Zod schema validation via `config/env.ts`.
 */
import { loadEnv, type Env } from '../config/env.js';
import { resolveCredentialSecret } from '../services/credential-rotation-service.js';

// ── Exported resolved secrets ──

// JWT_SECRET kept for backward-compat with non-IAM environments.
// When IAM_CORE_URL is set, RS256 tokens from IAM Core are used instead.
export const JWT_SECRET = process.env['JWT_SECRET'] ?? '';
export const API_SECRET = process.env['API_SECRET'] ?? '';
export const NODE_MANAGER_SECRET = process.env['NODE_MANAGER_SECRET'] ?? '';
export const CONTROL_API_URL =
  process.env['CONTROL_API_URL'] ?? 'https://localhost:4000';
export const ENABLE_AGENT_DISCOVERY =
  (process.env['ENABLE_AGENT_DISCOVERY'] ?? 'false').toLowerCase() === 'true';
export const AGENT_DISCOVERY_SECRET = process.env['AGENT_DISCOVERY_SECRET'] ?? '';
/** SHA-256 digest of an optional external collector's read-only bearer token. */
export const MAGNUS_COLLECTOR_TOKEN_SHA256 =
  process.env['MAGNUS_COLLECTOR_TOKEN_SHA256'] ?? '';
/** Dedicated audit-chain HMAC key; deliberately has no master-secret fallback. */
export const AUDIT_HMAC_SECRET = process.env['AUDIT_HMAC_SECRET'] ?? '';

/** IAM Core API URL — when set, enables RS256 JWT verification via IAM. */
export const IAM_CORE_URL = process.env['IAM_CORE_URL'] ?? '';
/** Exact registered claims required for every IAM access token. */
export const IAM_TOKEN_ISSUER = process.env['IAM_TOKEN_ISSUER'] ?? '';
export const IAM_TOKEN_AUDIENCE = process.env['IAM_TOKEN_AUDIENCE'] ?? '';

/** HMAC secret for verifying agent command result signatures. */
export const RESULT_SIGNING_SECRET = process.env['RESULT_SIGNING_SECRET'] ?? '';
/** Optional Control API-only authority for reviewed participant reconciliation. */
export const RESOURCE_PARTICIPANT_RECONCILIATION_SECRET =
  process.env['RESOURCE_PARTICIPANT_RECONCILIATION_SECRET'] ?? '';
/** Optional bounded rollout key; remove after every active agent proves the new signer. */
export const RESULT_SIGNING_PREVIOUS_SECRET = process.env['RESULT_SIGNING_PREVIOUS_SECRET'] ?? '';
export const LOG_INGEST_SIGNING_SECRET = process.env['LOG_INGEST_SIGNING_SECRET'] ?? '';
export const LOG_INGEST_PREVIOUS_SIGNING_SECRET = process.env['LOG_INGEST_PREVIOUS_SIGNING_SECRET'] ?? '';
/** Dedicated encrypted-rotation store key. */
export const CREDENTIAL_ROTATION_KEY = process.env['CREDENTIAL_ROTATION_KEY'] ?? '';
/**
 * Optional Hermes Agent plugin API. When disabled (the default) plugin
 * credentials are ignored and the plugin-scoped routes are unreachable.
 */
export const MAGNUS_PLUGIN_API_ENABLED =
  (process.env['MAGNUS_PLUGIN_API_ENABLED'] ?? 'false').toLowerCase() === 'true';
/** Per-installation SHA-256 digests for read-only Magnus plugins. */
export const MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON =
  process.env['MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON'] ?? '{}';
/** Server-local plugin operator token digest; keep it off every agent host. */
export const MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256 =
  process.env['MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256'] ?? '';
/** Plugin read consumer allowed to relay signed team-approval decisions (optional). */
export const MAGNUS_APPROVAL_BRIDGE_CONSUMER =
  process.env['MAGNUS_APPROVAL_BRIDGE_CONSUMER'] ?? '';
/** Purpose-scoped bearer accepted only by the shared-resource lease API. */
export const MAGNUS_SHARED_RESOURCE_TOKEN_SHA256 =
  process.env['MAGNUS_SHARED_RESOURCE_TOKEN_SHA256'] ?? '';
/** Preferred per-client shared-resource bearer digests for exact actor ownership. */
export const MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON =
  process.env['MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON'] ?? '{}';
export const MAGNUS_FLEET_CHECK_TOKEN_SHA256 = process.env['MAGNUS_FLEET_CHECK_TOKEN_SHA256'] ?? '';
export const SECURITY_FUSION_RECEIPT_SIGNING_KEY = process.env['SECURITY_FUSION_RECEIPT_SIGNING_KEY'] ?? '';
/** Security Fusion mode: `off` (default), `local` (in-process) or `remote` (external console). */
export const SECURITY_FUSION_MODE = process.env['SECURITY_FUSION_MODE'] ?? 'off';
export const METRICS_TOKEN = process.env['METRICS_TOKEN'] ?? '';
export const WEBHOOK_ENCRYPTION_KEY = process.env['WEBHOOK_ENCRYPTION_KEY'] ?? '';

let validatedEnv: Env | null = null;

/** Return the single validated runtime configuration consumed by services. */
export function getValidatedEnv(): Env {
  validatedEnv ??= loadEnv();
  return validatedEnv;
}

/** Active node-manager secret, including durable rotations. */
export function getNodeManagerSecret(): string {
  return resolveCredentialSecret('NODE_MANAGER_SECRET', NODE_MANAGER_SECRET);
}

// ── Startup validation ──

/**
 * Return a description of every missing or too-short required secret.
 * Optional integrations only contribute when their feature is enabled.
 */
export function listMissingSecrets(): string[] {
  const missing: string[] = [];

  const usingIam = !!IAM_CORE_URL;
  if (!usingIam && JWT_SECRET.length < 32) missing.push('JWT_SECRET (dedicated, min 32 chars)');
  if (usingIam && !IAM_TOKEN_ISSUER) missing.push('IAM_TOKEN_ISSUER');
  if (usingIam && !IAM_TOKEN_AUDIENCE) missing.push('IAM_TOKEN_AUDIENCE');
  if (API_SECRET.length < 32) missing.push('API_SECRET (dedicated, min 32 chars)');
  if (NODE_MANAGER_SECRET.length < 32) missing.push('NODE_MANAGER_SECRET (dedicated, min 32 chars)');
  if (AUDIT_HMAC_SECRET.length < 32) missing.push('AUDIT_HMAC_SECRET (dedicated, min 32 chars)');
  if (RESULT_SIGNING_SECRET.length < 32) missing.push('RESULT_SIGNING_SECRET (dedicated, min 32 chars)');
  if (LOG_INGEST_SIGNING_SECRET.length < 32) missing.push('LOG_INGEST_SIGNING_SECRET (dedicated, min 32 chars)');
  if (CREDENTIAL_ROTATION_KEY.length < 32) missing.push('CREDENTIAL_ROTATION_KEY (dedicated, min 32 chars)');
  if (METRICS_TOKEN.length < 32) missing.push('METRICS_TOKEN (dedicated, min 32 chars)');
  if (WEBHOOK_ENCRYPTION_KEY.length < 32) missing.push('WEBHOOK_ENCRYPTION_KEY (dedicated, min 32 chars)');
  if (SECURITY_FUSION_MODE === 'local' && SECURITY_FUSION_RECEIPT_SIGNING_KEY.length < 32) {
    missing.push('SECURITY_FUSION_RECEIPT_SIGNING_KEY (dedicated, min 32 chars; required when SECURITY_FUSION_MODE=local)');
  }
  if (MAGNUS_PLUGIN_API_ENABLED && MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON === '{}') {
    missing.push('MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON (per-installation read credentials; required when MAGNUS_PLUGIN_API_ENABLED=true)');
  }
  if (MAGNUS_PLUGIN_API_ENABLED && !/^[a-f0-9]{64}$/.test(MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256)) {
    missing.push('MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256 (server-local operator credential digest; required when MAGNUS_PLUGIN_API_ENABLED=true)');
  }
  if (process.env['NODE_ENV'] === 'production' && !process.env['DATABASE_URL']) {
    missing.push('DATABASE_URL (PostgreSQL connection string; required in production)');
  }
  return missing;
}

/**
 * Fail fast if required secrets are missing, then run full Zod validation.
 * Call once at startup, after dotenv has loaded.
 * Skipped when NODE_ENV === 'test'.
 */
export function validateSecrets(): void {
  if (process.env['NODE_ENV'] === 'test') return;

  const missing = listMissingSecrets();
  if (missing.length > 0) {
    const hint =
      'Set independent purpose-specific credentials of at least 32 characters; MAGNUS_SECRET is retired';
    console.error(
      `\n❌ Missing required secrets: ${missing.join(', ')}\n   ${hint}\n`,
    );
    process.exit(1);
  }

  // Full Zod schema validation — catches type errors, invalid ports, etc.
  try {
    getValidatedEnv();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Environment validation failed:\n${message}\n`);
    process.exit(1);
  }
}
