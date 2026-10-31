import { createLocalSession, verifyLocalSession } from './local-sessions';
/**
 * Server-side auth utilities for dashboard login.
 *
 * Admin credentials are validated against a dedicated Argon2id hash.
 * The dashboard's node SSH proxy still uses a separate restricted identity.
 */
import { SignJWT, jwtVerify } from 'jose';
import {
  COOKIE_NAME,
  SESSION_DURATION,
  getSecretKey,
  SESSION_AUDIENCE,
  SESSION_ISSUER,
  sessionVerificationOptions,
} from '@/lib/auth-constants';
import { resolveDashboardLoginCredentials } from '../../runtime-dashboard-credentials.mjs';

export interface SessionPayload {
  username: string;
  email?: string;
  userId?: string;
  role?: 'ADMIN' | 'OPERATOR' | 'VIEWER';
  provider?: 'hive';
  sessionId?: string;
  iat: number;
  exp: number;
}

/** Validate username/password against dedicated dashboard credentials. */
export async function validateCredentials(username: string, password: string): Promise<boolean> {
  let expectedUsername: string;
  let expectedPassword: string | undefined;
  let expectedPasswordHash: string | undefined;
  try {
    const resolved = resolveDashboardLoginCredentials();
    expectedUsername = resolved.username;
    expectedPassword = resolved.password;
    expectedPasswordHash = resolved.passwordHash;
  } catch {
    return false;
  }
  const { timingSafeEqual } = await import('node:crypto');
  const bufUser = Buffer.from(username);
  const bufExpUser = Buffer.from(expectedUsername);
  // Always perform the password operation even when the username is wrong.
  const userMatch = bufUser.length === bufExpUser.length && timingSafeEqual(bufUser, bufExpUser);
  let passMatch = false;
  if (expectedPasswordHash) {
    const { verify } = await import('argon2');
    passMatch = await verify(expectedPasswordHash, password).catch(() => false);
  } else if (expectedPassword != null) {
    const bufPass = Buffer.from(password);
    const bufExpPass = Buffer.from(expectedPassword);
    passMatch = bufPass.length === bufExpPass.length && timingSafeEqual(bufPass, bufExpPass);
  }
  return userMatch && passMatch;
}

// ──────────────────────────────────────────────────────────
// Session token
// ──────────────────────────────────────────────────────────

/** Create a signed HS256 session cookie token. */
export async function createSessionToken(
  username: string,
  extra?: {
    email?: string;
    userId?: string;
    role?: 'ADMIN' | 'OPERATOR' | 'VIEWER';
    provider?: 'hive';
    sessionId?: string;
  },
): Promise<string> {
  const sessionId =
    extra?.provider === 'hive' ? extra.sessionId : await createLocalSession(username);
  return new SignJWT({ username, ...extra, sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION}s`)
    .sign(getSecretKey());
}

/** Verify a session token and return the payload, or null if invalid. */
export async function verifySessionToken(
  token: string,
  failOnStoreError = false,
): Promise<SessionPayload | null> {
  let session: SessionPayload;
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), sessionVerificationOptions());
    session = payload as unknown as SessionPayload;
  } catch {
    return null;
  }
  try {
    return (await verifyLocalSession(session)) ? session : null;
  } catch (error) {
    if (failOnStoreError) throw error;
    return null;
  }
}

export { COOKIE_NAME, SESSION_DURATION };
