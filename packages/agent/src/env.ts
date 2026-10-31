/**
 * Centralized, validated environment for the Magnus unified agent.
 *
 * Secrets are read from process.env at import time. Ensure dotenv has loaded
 * before any module that imports this is evaluated.
 *
 * Feature flags:
 *   ENABLE_NODE_MANAGEMENT — load fleet/node management features (default: true)
 */
import { getFqdn } from './fqdn.js';
import { isIPv4 } from 'node:net';
import { agentPrivileged, isRoot } from './privileged.js';
import { ardentPackageNames } from './executors/ardent-packages.js';

function envFlag(name: string, fallback = false): boolean {
  return (process.env[name] ?? String(fallback)).toLowerCase() === 'true';
}

// ── Feature flags ───────────────────────────────────────────────────
export const ENABLE_NODE_MANAGEMENT =
  envFlag('ENABLE_NODE_MANAGEMENT', true);
export const ENABLE_AGENT_DISCOVERY = envFlag('ENABLE_AGENT_DISCOVERY');
// Opt-in until supervised lifecycle and enrollment acceptance are complete.
export const MAGNUS_EXECUTION_SUPERVISOR_ENABLED = envFlag('MAGNUS_EXECUTION_SUPERVISOR_ENABLED');

// ── Node-management secrets ─────────────────────────────────────────
export const NODE_MANAGER_SECRET = process.env['NODE_MANAGER_SECRET'] ?? '';
// Bounded rotation-grace credential: accepted for inbound control-api calls
// alongside the active secret, then removed once every caller uses the new one.
export const NODE_MANAGER_SECRET_PREVIOUS = process.env['NODE_MANAGER_SECRET_PREVIOUS'] ?? '';
export const CONTROL_API_URL =
  process.env['CONTROL_API_URL'] ?? 'https://localhost:4000';
export const RESULT_SIGNING_SECRET = process.env['RESULT_SIGNING_SECRET'] ?? '';
export const LOG_INGEST_TOKEN = process.env['LOG_INGEST_TOKEN'] ?? '';
export const AGENT_DISCOVERY_SECRET = process.env['AGENT_DISCOVERY_SECRET'] ?? '';
export const AGENT_DISCOVERY_BIND_ADDRESS = process.env['AGENT_DISCOVERY_BIND_ADDRESS'] ?? '';

export const HOST_FQDN =
  process.env['HOST_FQDN'] ?? getFqdn();

/**
 * Fail fast if required secrets are missing for enabled features.
 * Call once at startup, after dotenv has loaded.
 * Skipped when NODE_ENV === 'test'.
 */
export function validateSecrets(): void {
  if (process.env['NODE_ENV'] === 'test') return;
  const errors = configurationErrors();
  if (errors.length > 0) {
    const message = `Missing required configuration:\n${errors.map(m => `  • ${m}`).join('\n')}`;
    throw new Error(message);
  }
}

/** Every configuration problem, without throwing. Used by `magnus-agent check`. */
export function configurationErrors(): string[] {
  const errors: string[] = [];

  if (ENABLE_NODE_MANAGEMENT && !NODE_MANAGER_SECRET) {
    errors.push('NODE_MANAGER_SECRET is required when ENABLE_NODE_MANAGEMENT=true');
  }
  if (NODE_MANAGER_SECRET_PREVIOUS && NODE_MANAGER_SECRET_PREVIOUS === NODE_MANAGER_SECRET) {
    errors.push('NODE_MANAGER_SECRET_PREVIOUS must differ from NODE_MANAGER_SECRET');
  }
  if (ENABLE_NODE_MANAGEMENT && RESULT_SIGNING_SECRET.length < 32) {
    errors.push('RESULT_SIGNING_SECRET must be a dedicated secret of at least 32 characters');
  }
  const reconciliation = process.env['COMMAND_RECONCILIATION_SECRET'] ?? '';
  if (reconciliation && (reconciliation.length < 32
    || [NODE_MANAGER_SECRET, NODE_MANAGER_SECRET_PREVIOUS, RESULT_SIGNING_SECRET,
      process.env['RESULT_SIGNING_PREVIOUS_SECRET'] ?? ''].some(value => value && value === reconciliation))) {
    errors.push('COMMAND_RECONCILIATION_SECRET must be an independent secret of at least 32 characters');
  }
  if ((process.env['ENABLE_LOG_FORWARDING'] ?? 'false').toLowerCase() === 'true' && LOG_INGEST_TOKEN.length < 32) {
    errors.push('LOG_INGEST_TOKEN is required when ENABLE_LOG_FORWARDING=true');
  }

  for (const flag of ['ENABLE_NODE_MANAGEMENT', 'ENABLE_LOG_FORWARDING', 'ENABLE_AGENT_DISCOVERY', 'ALLOW_INSECURE_HTTP',
    'MAGNUS_AGENT_PRIVILEGED', 'MAGNUS_EXECUTION_SUPERVISOR_ENABLED']) {
    const value = process.env[flag]?.toLowerCase();
    if (value !== undefined && value !== 'true' && value !== 'false') {
      errors.push(`${flag} must be true or false`);
    }
  }

  if (ENABLE_AGENT_DISCOVERY) {
    if (AGENT_DISCOVERY_SECRET.length < 32) {
      errors.push('AGENT_DISCOVERY_SECRET must contain at least 32 characters when discovery is enabled');
    }
    if (!isIPv4(AGENT_DISCOVERY_BIND_ADDRESS) || AGENT_DISCOVERY_BIND_ADDRESS === '0.0.0.0') {
      errors.push('AGENT_DISCOVERY_BIND_ADDRESS must be an explicit IPv4 interface address when discovery is enabled');
    }
    for (const [name, value] of [
      ['NODE_MANAGER_SECRET', NODE_MANAGER_SECRET],
      ['RESULT_SIGNING_SECRET', RESULT_SIGNING_SECRET],
      ['LOG_INGEST_TOKEN', LOG_INGEST_TOKEN],
    ] as const) {
      if (value && value === AGENT_DISCOVERY_SECRET) {
        errors.push(`AGENT_DISCOVERY_SECRET must be distinct from ${name}`);
      }
    }
  }

  const tlsCertConfigured = Boolean(process.env['TLS_CERT_PATH']);
  const tlsKeyConfigured = Boolean(process.env['TLS_KEY_PATH']);
  if (tlsCertConfigured !== tlsKeyConfigured) {
    errors.push('TLS_CERT_PATH and TLS_KEY_PATH must be configured together');
  }
  if (process.env['NODE_ENV'] === 'production' && (!tlsCertConfigured || !tlsKeyConfigured)) {
    errors.push('TLS_CERT_PATH and TLS_KEY_PATH are required in production');
  }
  if (process.env['NODE_ENV'] === 'production' && envFlag('ALLOW_INSECURE_HTTP')) {
    errors.push('ALLOW_INSECURE_HTTP cannot be enabled in production');
  }

  if (ENABLE_NODE_MANAGEMENT && CONTROL_API_URL === 'https://localhost:4000' && !process.env['CONTROL_API_URL']) {
    errors.push('CONTROL_API_URL should be explicitly set when ENABLE_NODE_MANAGEMENT=true (currently using default https://localhost:4000)');
  }

  if (!ENABLE_NODE_MANAGEMENT) {
    errors.push('ENABLE_NODE_MANAGEMENT must be true; host-access IAM is provided by Hive');
  }

  // Privileged mode is the default. Refuse to start half-privileged: as a
  // non-root account, root-only executors would fail mid-operation.
  if (agentPrivileged() && !isRoot()) {
    errors.push('MAGNUS_AGENT_PRIVILEGED=true requires running as root; run as root or set MAGNUS_AGENT_PRIVILEGED=false');
  }
  if (!agentPrivileged() && MAGNUS_EXECUTION_SUPERVISOR_ENABLED) {
    errors.push('MAGNUS_EXECUTION_SUPERVISOR_ENABLED=true requires MAGNUS_AGENT_PRIVILEGED=true');
  }

  try { ardentPackageNames(); } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : 'MAGNUS_AGENT_ARDENT_PACKAGES is invalid');
  }

  return errors;
}
