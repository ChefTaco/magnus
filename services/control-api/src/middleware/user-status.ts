import { getDb } from '../db/index.js';
import type { UserRole } from '../types/index.js';

/** Current account state for a locally issued HS256 session token. */
export interface CurrentUserStatus {
  active: boolean;
  role: UserRole;
}

const USER_STATUS_TTL_MS = 30_000;
const USER_STATUS_CACHE_MAX = 1_000;
const cache = new Map<string, { status: CurrentUserStatus | null; expiresAt: number }>();

/**
 * Look up whether a local user still exists, is active, and which role it
 * currently holds. Cached briefly (bounded) so deactivation, demotion, and
 * deletion take effect within seconds instead of at token expiry.
 */
export async function getCurrentUserStatus(userId: string): Promise<CurrentUserStatus | null> {
  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > now) return cached.status;
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { active: true, role: true } });
  const status = user ? { active: user.active, role: user.role as UserRole } : null;
  cache.delete(userId);
  if (cache.size >= USER_STATUS_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(userId, { status, expiresAt: now + USER_STATUS_TTL_MS });
  return status;
}

/** Drop a cached entry after an account mutation so it applies immediately. */
export function invalidateUserStatus(userId?: string): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}
