/**
 * Settings of per-node credentials (see docs/NODE_CREDENTIALS.md).
 *
 * `NODE_AUTH_MODE` selects how the server treats the shared node secret (`x-node-token`):
 *   compat   signature or shared secret; a node that has a key can no longer be spoken for with the secret
 *   warn     as compat, and every accepted shared-secret request is logged
 *   enforce  signature only; the shared secret is refused and the legacy upgrade is closed
 */
export type NodeAuthMode = 'compat' | 'warn' | 'enforce';

export const NODE_AUTH_MODES: readonly NodeAuthMode[] = ['compat', 'warn', 'enforce'];
/** How long existing nodes may bind their first key with the shared secret, from the first start. */
export const LEGACY_UPGRADE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A replaced key stays valid this long after a rotation. */
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;
export const ENROLLMENT_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60;
export const ENROLLMENT_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60;

export function nodeAuthMode(env: NodeJS.ProcessEnv = process.env): NodeAuthMode {
  const value = (env['NODE_AUTH_MODE'] ?? '').trim().toLowerCase();
  return (NODE_AUTH_MODES as readonly string[]).includes(value) ? value as NodeAuthMode : 'compat';
}

/** Unknown nodes that present the shared secret are added to the inventory unless this is `false`. */
export function nodeAutoRegister(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['NODE_AUTO_REGISTER'] ?? 'true').trim().toLowerCase() !== 'false';
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
