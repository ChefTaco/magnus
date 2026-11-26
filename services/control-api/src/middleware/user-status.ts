import { getDb } from '../db/index.js';
import type { UserRole } from '../types/index.js';

/** Current account state for a locally issued HS256 session token. */
export interface CurrentUserStatus {
  active: boolean;
  role: UserRole;
  /** Changes whenever the password changes; a session token issued before carries the old value. */
  sessionStamp?: string;
}

/**
 * The stamp that binds local sessions to one stored password: the random salt of its Argon2
 * encoding (`$argon2id$v=19$m=…,t=…,p=…$<salt>$<digest>`). Every password change hashes with a
 * new salt, so the stamp changes; the salt is not secret and says nothing about the password.
 */
export function passwordSessionStamp(storedHash: string): string {
  const parts = storedHash.split('$');
  const salt = storedHash.startsWith('$argon2') && parts.length >= 6 ? parts[parts.length - 2] : undefined;
  return salt && salt.length >= 16 ? salt : `len${storedHash.length}:${storedHash.slice(-12)}`;
}

const USER_STATUS_TTL_MS = 30_000;
const USER_STATUS_CACHE_MAX = 1_000;
const cache = new Map<string, { status: CurrentUserStatus | null; expiresAt: number }>();

/**
 * Look up whether a local user still exists, is active, which role it
 * currently holds and its password stamp. Cached briefly (bounded) so
 * deactivation, demotion, deletion and password changes take effect within
 * seconds instead of at token expiry.
 */
export async function getCurrentUserStatus(userId: string): Promise<CurrentUserStatus | null> {
  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > now) return cached.status;
  const user = await getDb().user.findUnique({ where: { id: userId }, select: { active: true, role: true, password: true } });
  const status = user ? { active: user.active, role: user.role as UserRole, sessionStamp: passwordSessionStamp(user.password) } : null;
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
