/**
 * Optional integration detection for Magnus UI.
 *
 * Every integration is off unless its server-side environment variables are
 * set. Nothing here falls back to a built-in host. Plain ESM so the Next.js
 * server, the TLS wrapper and the `magnus-ui` CLI share one definition.
 */

/** @param {string | undefined} value */
function present(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Normalize an absolute http(s) URL without a trailing slash, or return null.
 * @param {string | undefined} value
 */
export function normalizeIntegrationUrl(value) {
  if (!present(value)) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * External security console base URL (MAGNUS_SECURITY_CONSOLE_URL), or null.
 * @param {Record<string, string | undefined>} [env]
 */
export function securityConsoleUrl(env = process.env) {
  return normalizeIntegrationUrl(env['MAGNUS_SECURITY_CONSOLE_URL']);
}

/**
 * Hive Router admin-plane base URL (HIVE_ROUTER_ADMIN_URL), or null.
 * @param {Record<string, string | undefined>} [env]
 */
export function hiveRouterAdminUrl(env = process.env) {
  return normalizeIntegrationUrl(env['HIVE_ROUTER_ADMIN_URL']);
}

/**
 * Named Hive IAM (OIDC) login is configured.
 * @param {Record<string, string | undefined>} [env]
 */
export function hiveLoginConfigured(env = process.env) {
  return ['HIVE_OAUTH_DISCOVERY_URL', 'HIVE_OAUTH_CLIENT_ID', 'HIVE_OAUTH_ISSUER', 'HIVE_OAUTH_API_AUDIENCE', 'DASHBOARD_PUBLIC_ORIGIN']
    .every((name) => present(env[name]));
}

/**
 * Hermes Agent pages, dashboard proxy and WebSocket bridge (MAGNUS_HERMES_ENABLED=true).
 * @param {Record<string, string | undefined>} [env]
 */
export function hermesEnabled(env = process.env) {
  return String(env['MAGNUS_HERMES_ENABLED'] ?? '').trim().toLowerCase() === 'true';
}

/**
 * Snapshot of which optional integrations are enabled.
 * @param {Record<string, string | undefined>} [env]
 */
export function readIntegrations(env = process.env) {
  return {
    securityConsoleUrl: securityConsoleUrl(env),
    hiveRouter: hiveRouterAdminUrl(env) !== null,
    hiveLogin: hiveLoginConfigured(env),
    hermes: hermesEnabled(env),
  };
}

/**
 * Human-readable integration rows for `magnus-ui check`.
 * @param {Record<string, string | undefined>} [env]
 */
export function describeIntegrations(env = process.env) {
  const flags = readIntegrations(env);
  return [
    { name: 'Security console', enabled: flags.securityConsoleUrl !== null, via: 'MAGNUS_SECURITY_CONSOLE_URL' },
    { name: 'Hive Router admin', enabled: flags.hiveRouter, via: 'HIVE_ROUTER_ADMIN_URL' },
    { name: 'Hive IAM login (OIDC)', enabled: flags.hiveLogin, via: 'HIVE_OAUTH_* + DASHBOARD_PUBLIC_ORIGIN' },
    { name: 'Hermes Agent', enabled: flags.hermes, via: 'MAGNUS_HERMES_ENABLED=true' },
  ];
}
