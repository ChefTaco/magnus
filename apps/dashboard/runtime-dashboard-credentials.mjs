import { existsSync, readFileSync } from 'node:fs';

export const LEGACY_DASHBOARD_CREDENTIALS_DEADLINE = '2026-10-01';
export const DASHBOARD_ADMIN_CREDENTIAL_VERSION = 2;

/** @param {string | undefined} first @param {string | undefined} second @param {string} message */
function requirePair(first, second, message) {
  if (Boolean(first) !== Boolean(second)) throw new Error(message);
}

/** @param {Record<string, string | undefined>} env @param {string} key */
function credentialValue(env, key) {
  const encoded = env[`${key}_B64`];
  if (encoded != null) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error(`${key}_B64 is not valid base64`);
    }
    return Buffer.from(encoded, 'base64').toString('utf8');
  }
  return env[key];
}

/** @param {Record<string, string | undefined>} env @param {Date} now */
export function resolveDashboardLoginCredentials(env = process.env, now = new Date()) {
  const username = credentialValue(env, 'DASHBOARD_ADMIN_USERNAME');
  const password = credentialValue(env, 'DASHBOARD_ADMIN_PASSWORD');
  // A dedicated plaintext admin password takes precedence when configured.
  if (username && password) {
    return { username, password, source: 'dashboard-admin-password', version: DASHBOARD_ADMIN_CREDENTIAL_VERSION };
  }
  const passwordHash = credentialValue(env, 'DASHBOARD_ADMIN_PASSWORD_HASH');
  requirePair(username, passwordHash, 'DASHBOARD_ADMIN_USERNAME and DASHBOARD_ADMIN_PASSWORD (or _HASH) must be configured together');
  if (username && passwordHash) {
    if (!passwordHash.startsWith('$argon2id$')) {
      throw new Error('DASHBOARD_ADMIN_PASSWORD_HASH must be an Argon2id hash');
    }
    return { username, passwordHash, source: 'dashboard-admin-hash', version: DASHBOARD_ADMIN_CREDENTIAL_VERSION };
  }

  // Two-phase compatibility path for installations following the former
  // dedicated-login guidance. Fleet SSH or bootstrap credentials are never accepted.
  const legacyUsername = credentialValue(env, 'DASHBOARD_LOGIN_USERNAME');
  const legacyPassword = credentialValue(env, 'DASHBOARD_LOGIN_PASSWORD');
  requirePair(legacyUsername, legacyPassword, 'DASHBOARD_LOGIN_USERNAME and DASHBOARD_LOGIN_PASSWORD must be configured together');
  if (!legacyUsername || !legacyPassword) {
    throw new Error('Dedicated dashboard administrator credentials are required');
  }
  if (now >= new Date(`${LEGACY_DASHBOARD_CREDENTIALS_DEADLINE}T00:00:00Z`)) {
    throw new Error('Legacy dashboard login credentials have expired; configure the dashboard administrator hash');
  }
  for (const key of ['DASHBOARD_SSH_PASSWORD', 'BOOTSTRAP_SSH_PASSWORD']) {
    if (env[key] && legacyPassword === env[key]) {
      throw new Error(`Dashboard login password must not equal ${key}`);
    }
  }
  return { username: legacyUsername, password: legacyPassword, source: 'legacy-dashboard-login', version: 1 };
}

/**
 * Dedicated, unprivileged SSH identity for the terminal and Hermes proxy.
 * @param {Record<string, string | undefined>} env
 */
export function resolveDashboardSshCredentials(env = process.env) {
  const username = env.DASHBOARD_SSH_USERNAME;
  const password = env.DASHBOARD_SSH_PASSWORD;
  const privateKeyPath = env.DASHBOARD_SSH_PRIVATE_KEY_PATH;
  if (!username || (!password && !privateKeyPath)) {
    throw new Error('Dedicated dashboard SSH proxy credentials are required (DASHBOARD_SSH_USERNAME with DASHBOARD_SSH_PRIVATE_KEY_PATH or DASHBOARD_SSH_PASSWORD)');
  }
  let privateKey;
  if (privateKeyPath) {
    if (!existsSync(privateKeyPath)) throw new Error(`Dashboard SSH private key does not exist: ${privateKeyPath}`);
    privateKey = readFileSync(privateKeyPath, 'utf8');
  }
  return { username, password: password ?? '', privateKey, privateKeyPath, source: 'dedicated' };
}

/** @param {Record<string, string | undefined>} env */
function dashboardSshConfigured(env) {
  try {
    resolveDashboardSshCredentials(env);
    return true;
  } catch {
    return false;
  }
}

/** @param {Record<string, string | undefined>} env @param {Date} now */
export function dashboardCredentialDiagnostics(env = process.env, now = new Date()) {
  const login = resolveDashboardLoginCredentials(env, now);
  // SSH credentials are only needed by the terminal and Hermes proxy.
  const sshConfigured = dashboardSshConfigured(env);
  let metadata = null;
  if (env.DASHBOARD_ADMIN_CREDENTIAL_METADATA_B64) {
    try {
      metadata = JSON.parse(Buffer.from(env.DASHBOARD_ADMIN_CREDENTIAL_METADATA_B64, 'base64').toString('utf8'));
    } catch {
      throw new Error('DASHBOARD_ADMIN_CREDENTIAL_METADATA_B64 is invalid');
    }
  }
  // A dedicated hash without deployment metadata is complete; when metadata
  // is supplied it must prove the v2 credential separation.
  const loginMigrated = (login.source === 'dashboard-admin-hash' && metadata === null)
    || (login.source === 'dashboard-admin-hash'
    && metadata?.purpose === 'dashboard-admin-login'
    && metadata?.version === DASHBOARD_ADMIN_CREDENTIAL_VERSION
    && metadata?.secretForm === 'argon2id-hash'
    && metadata?.reusableSecret === false
    && metadata?.fleetPasswordAuthenticationDisabled === true
    && metadata?.fingerprintsDiffer === true)
    // A dedicated plaintext admin password is a complete dedicated credential.
    || login.source === 'dashboard-admin-password';
  return {
    migrated: loginMigrated,
    sshConfigured,
    loginSource: login.source,
    credentialVersion: login.version,
    metadata,
    migrationDeadline: LEGACY_DASHBOARD_CREDENTIALS_DEADLINE,
    warning: !loginMigrated
      ? `CRITICAL: dashboard credential migration is incomplete and expires ${LEGACY_DASHBOARD_CREDENTIALS_DEADLINE}`
      : null,
  };
}
