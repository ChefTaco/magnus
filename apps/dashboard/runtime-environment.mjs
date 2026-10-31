const string = (options = {}) => ({ type: 'string', ...options });
const url = (options = {}) => ({ type: 'url', ...options });
const path = (options = {}) => ({ type: 'path', ...options });
const integer = (options = {}) => ({ type: 'integer', ...options });

/**
 * Canonical dashboard runtime configuration schema and documentation metadata.
 * Keep secrets out of defaults and descriptions: this object is imported by the
 * runtime as well as the documentation drift check.
 */
export const dashboardEnvironmentSchema = Object.freeze({
  CONTROL_API_URL: url({ default: 'https://localhost:4000', purpose: 'Default Magnus Control API target.' }),
  CONTROL_API_CA_PATH: path({ optional: true, purpose: 'Private CA bundle used for verified Control API TLS.' }),
  CONTROL_API_MAX_RESPONSE_BYTES: integer({ default: 1_048_576, minimum: 1024, purpose: 'Maximum accepted Control API response size in bytes.' }),
  DASHBOARD_PROXY_BODY_LIMIT_BYTES: integer({ default: 1_048_576, minimum: 1, purpose: 'Maximum forwarded request body size in bytes, enforced while streaming.' }),
  API_SECRET: string({ required: true, sensitive: true, purpose: 'Server-side secret injected into Control API proxy requests.' }),
  CONTROL_NODE_CREDENTIAL_KEY: string({ required: true, sensitive: true, minimumLength: 32, purpose: 'Dedicated key for encrypted control-node credentials at rest.' }),
  SESSION_SECRET: string({ optional: true, sensitive: true, requirement: 'Required; temporary legacy fallback is separately gated', purpose: 'Dedicated dashboard session signing secret.' }),
  SESSION_ISSUER: string({ default: 'magnus-dashboard', purpose: 'Required issuer claim for dashboard session tokens.' }),
  SESSION_AUDIENCE: string({ default: 'magnus-dashboard-session', purpose: 'Required audience claim for dashboard session tokens.' }),
  ALLOW_LEGACY_SESSION_SECRET: string({ default: 'false', enum: ['true', 'false'], purpose: 'Temporary opt-in for the expiring JWT_SECRET session fallback.' }),
  HERMES_SSH_AUTHORIZATIONS_FILE: path({ default: '.magnus/hermes-ssh-authorizations.json', requirement: 'Required (default path shown)', purpose: 'Reviewed installation, node, address, and SSH host-key bindings.' }),
  DASHBOARD_PUBLIC_ORIGIN: url({ required: true, purpose: 'Canonical browser origin allowed to open the Hermes WebSocket bridge.' }),
  HERMES_WEBSOCKET_ALLOWED_ORIGINS: string({ optional: true, purpose: 'Comma-separated additional allowed Hermes WebSocket origins.' }),
  DASHBOARD_ADMIN_USERNAME: string({ optional: true, requirement: 'Required with DASHBOARD_ADMIN_PASSWORD_HASH; deployment may serialize it', purpose: 'Dedicated dashboard administrator identity.' }),
  DASHBOARD_ADMIN_USERNAME_B64: string({ optional: true, sensitive: true, purpose: 'Serializer-managed base64 form of the dashboard administrator identity.' }),
  DASHBOARD_ADMIN_PASSWORD_HASH: string({ optional: true, requirement: 'Required with DASHBOARD_ADMIN_USERNAME; Argon2id only', sensitive: true, purpose: 'Non-reusable Argon2id dashboard administrator password verifier.' }),
  DASHBOARD_ADMIN_PASSWORD_HASH_B64: string({ optional: true, sensitive: true, purpose: 'Serializer-managed base64 form of the Argon2id verifier.' }),
  DASHBOARD_ADMIN_CREDENTIAL_METADATA_B64: string({ optional: true, sensitive: true, purpose: 'Versioned non-secret credential purpose, rotation, fleet-password, and fingerprint-separation evidence.' }),
  DASHBOARD_LOGIN_USERNAME: string({ optional: true, purpose: 'Temporary two-phase migration source for the former dedicated dashboard login.' }),
  DASHBOARD_LOGIN_PASSWORD: string({ optional: true, sensitive: true, purpose: 'Temporary two-phase reusable secret; rejected when equal to fleet or bootstrap credentials.' }),
  REDIS_URL: url({ default: 'redis://127.0.0.1:6379', sensitive: true, purpose: 'Durable dashboard authentication throttling and concurrency store.' }),
  REDIS_PREFIX: string({ default: 'magnus-', purpose: 'Namespace prefix for durable Redis authentication limiter keys.' }),
  AUTH_RATE_LIMIT_LABEL_KEY: string({ optional: true, sensitive: true, purpose: 'Optional dedicated HMAC key for de-identifying authentication limiter labels.' }),
  DASHBOARD_SSH_USERNAME: string({ optional: true, requirement: 'Required for the terminal and Hermes proxy', purpose: 'Dedicated, unprivileged dashboard proxy account on managed nodes.' }),
  DASHBOARD_SSH_PASSWORD: string({ optional: true, sensitive: true, purpose: 'Optional dedicated dashboard SSH password; restricted keys are preferred.' }),
  DASHBOARD_SSH_PRIVATE_KEY_PATH: path({ optional: true, requirement: 'Required for the terminal and Hermes proxy (or DASHBOARD_SSH_PASSWORD)', purpose: 'Restricted dashboard-proxy private key with no deployment privileges.' }),
  NEXT_PUBLIC_API_URL: url({ default: 'https://localhost:4000', public: true, purpose: 'Legacy build-time Control API URL; must never contain a secret.' }),
  HIVE_OAUTH_DISCOVERY_URL: url({ optional: true, purpose: 'Hive OAuth discovery URL for optional named dashboard login; HTTPS required.' }),
  HIVE_OAUTH_CLIENT_ID: string({ optional: true, purpose: 'Registered Magnus dashboard OAuth client ID.' }),
  HIVE_OAUTH_CLIENT_SECRET: string({ optional: true, sensitive: true, purpose: 'Optional confidential OAuth client secret, kept server-side.' }),
  HIVE_OAUTH_ISSUER: url({ optional: true, purpose: 'Exact trusted Hive access-token issuer.' }),
  HIVE_OAUTH_API_AUDIENCE: string({ optional: true, purpose: 'Exact access-token audience accepted by the Control API.' }),
  HIVE_OAUTH_SCOPE: string({ default: 'openid profile email', purpose: 'Registered named-user OAuth scopes.' }),
  HIVE_ROUTER_ADMIN_URL: url({ optional: true, purpose: 'Optional Hive Router admin plane; enables the embedded router dashboard proxy.' }),
  HIVE_ROUTER_CA_PATH: path({ optional: true, purpose: 'Optional private CA bundle for hostname-verified Hive Router TLS.' }),
  MAGNUS_SECURITY_CONSOLE_URL: url({ optional: true, purpose: 'Optional external security console; enables the Security pages and nav entry.' }),
  MAGNUS_HERMES_ENABLED: string({ default: 'false', enum: ['true', 'false'], purpose: 'Enables the optional Hermes Agent pages, dashboard proxy and WebSocket bridge.' }),
  PORT: integer({ default: 3000, minimum: 1, purpose: 'Listen port for magnus-ui start.' }),
  HOST: string({ default: '0.0.0.0', purpose: 'Listen address for magnus-ui start.' }),
  TLS_CERT_PATH: path({ optional: true, requirement: 'Required unless MAGNUS_UI_ALLOW_HTTP=true', purpose: 'PEM certificate served by magnus-ui start.' }),
  TLS_KEY_PATH: path({ optional: true, requirement: 'Required unless MAGNUS_UI_ALLOW_HTTP=true', purpose: 'PEM private key for TLS_CERT_PATH.' }),
  MAGNUS_UI_DATA_DIR: path({ optional: true, purpose: 'Working directory for runtime state (.magnus/, terminal-audit/); magnus-ui start defaults it to the current directory.' }),
  UI_SECURITY_LOG_PATH: path({ default: '.magnus/security-events.jsonl', purpose: 'Append-only authentication audit log; login fails closed when it cannot be written.' }),
  MAGNUS_UI_ALLOW_HTTP: string({ default: 'false', enum: ['true', 'false'], purpose: 'Serve plain HTTP when no TLS certificate is configured (local development or behind a TLS proxy only).' }),
});

function fail(name, message) {
  throw new Error(`${name} ${message}`);
}

/** Parse one configured value according to the canonical schema. */
/** @param {string} name @param {Record<string, string | undefined>} env */
export function readDashboardEnvironment(name, env = process.env) {
  const definition = dashboardEnvironmentSchema[name];
  if (!definition) fail(name, 'is not declared in the dashboard environment schema');
  const raw = env[name]?.trim();
  const value = raw || definition.default;
  if (value == null || value === '') {
    if (definition.required) fail(name, 'is required');
    return undefined;
  }

  if (definition.enum && !definition.enum.includes(String(value))) {
    fail(name, `must be one of: ${definition.enum.join(', ')}`);
  }
  if (definition.type === 'integer') {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < (definition.minimum ?? Number.MIN_SAFE_INTEGER)) {
      fail(name, `must be an integer of at least ${definition.minimum}`);
    }
    return parsed;
  }
  if (definition.type === 'url') {
    try {
      return new URL(String(value)).toString().replace(/\/$/, '');
    } catch {
      fail(name, 'must be an absolute URL');
    }
  }
  if (definition.type === 'path' && String(value).includes('\0')) fail(name, 'must not contain NUL bytes');
  if (definition.type === 'string' && definition.minimumLength && String(value).length < definition.minimumLength) {
    fail(name, `must contain at least ${definition.minimumLength} characters`);
  }
  return String(value);
}

/** Validate all explicitly configured dashboard variables without requiring optional values. */
/** @param {Record<string, string | undefined>} env */
export function validateDashboardEnvironment(env = process.env) {
  for (const name of Object.keys(dashboardEnvironmentSchema)) {
    if (env[name] != null || dashboardEnvironmentSchema[name].required) {
      readDashboardEnvironment(name, env);
    }
  }
  const credentialKey = env.CONTROL_NODE_CREDENTIAL_KEY;
  if (credentialKey) {
    for (const name of ['API_SECRET', 'SESSION_SECRET', 'JWT_SECRET']) {
      if (env[name] && env[name] === credentialKey) {
        fail('CONTROL_NODE_CREDENTIAL_KEY', `must be distinct from ${name}`);
      }
    }
  }
}

export function dashboardEnvironmentReferenceRows() {
  return Object.entries(dashboardEnvironmentSchema).map(([name, definition]) => ({ name, ...definition }));
}
