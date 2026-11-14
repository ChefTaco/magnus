/**
 * Settings of per-node credentials (see docs/NODE_CREDENTIALS.md).
 *
 * `NODE_AUTH_MODE` selects how the server treats the shared node secret (`x-node-token`):
 *   compat   signature or shared secret; a node that has a key can no longer be spoken for with the secret
 *   warn     as compat, and every accepted shared-secret request is logged
 *   enforce  signature only; the shared secret is refused and not sent, and the legacy upgrade is closed
 *
 * From 3.0.0 `enforce` is the default. `compat` and `warn` still work when set explicitly, for this
 * major only: they are deprecated and removed in the next major.
 */
export type NodeAuthMode = 'compat' | 'warn' | 'enforce';

export const NODE_AUTH_MODES: readonly NodeAuthMode[] = ['compat', 'warn', 'enforce'];
/** The mode of a server that does not set `NODE_AUTH_MODE`. */
export const DEFAULT_NODE_AUTH_MODE: NodeAuthMode = 'enforce';
/** How long existing nodes may bind their first key with the shared secret, from the first start. */
export const LEGACY_UPGRADE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A replaced key stays valid this long after a rotation. */
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;
export const ENROLLMENT_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60;
export const ENROLLMENT_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60;

export interface NodeAuthModeSetting {
  mode: NodeAuthMode;
  /** `NODE_AUTH_MODE` is set (to a valid value). An unset mode is the default, `enforce`. */
  explicit: boolean;
  /** An explicit `compat` or `warn`: still honoured in this major, removed in the next. */
  deprecated: boolean;
}

export function nodeAuthModeSetting(env: NodeJS.ProcessEnv = process.env): NodeAuthModeSetting {
  const value = (env['NODE_AUTH_MODE'] ?? '').trim().toLowerCase();
  const explicit = (NODE_AUTH_MODES as readonly string[]).includes(value);
  const mode = explicit ? value as NodeAuthMode : DEFAULT_NODE_AUTH_MODE;
  return { mode, explicit, deprecated: explicit && mode !== 'enforce' };
}

export function nodeAuthMode(env: NodeJS.ProcessEnv = process.env): NodeAuthMode {
  return nodeAuthModeSetting(env).mode;
}

/** The start-up line for an explicit `compat` or `warn`, or null. */
export function nodeAuthDeprecationWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const setting = nodeAuthModeSetting(env);
  if (!setting.deprecated) return null;
  return `NODE_AUTH_MODE=${setting.mode} is deprecated: the shared node secret (NODE_MANAGER_SECRET, x-node-token) and the shared `
    + 'result keys are accepted for this major only and are removed in the next. Remove the setting to run in enforce mode once '
    + 'GET /api/v1/node-credentials/summary reports no blockers (docs/NODE_CREDENTIALS.md).';
}

/**
 * Unknown nodes that present the shared secret are added to the inventory. The default follows the
 * mode: on in compat and warn, off in enforce (where the shared secret is refused anyway).
 */
export function nodeAutoRegister(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['NODE_AUTO_REGISTER']?.trim().toLowerCase();
  if (!raw) return nodeAuthMode(env) !== 'enforce';
  return raw !== 'false';
}

/** The operator's explicit end of the legacy upgrade, or null to use the persisted 30-day window. */
export function legacyUpgradeOverride(env: NodeJS.ProcessEnv = process.env): Date | null {
  const raw = env['NODE_AUTH_LEGACY_UPGRADE_UNTIL']?.trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function legacyUpgradeDeadline(startedAt: Date, env: NodeJS.ProcessEnv = process.env): Date {
  return legacyUpgradeOverride(env) ?? new Date(startedAt.getTime() + LEGACY_UPGRADE_WINDOW_MS);
}
