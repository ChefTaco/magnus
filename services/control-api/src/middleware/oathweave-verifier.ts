import { createHash } from 'node:crypto';
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { isOathweaveEndpoint, OATHWEAVE_AUDIENCE } from '../config/oathweave.js';

export interface OathweaveOptions {
  issuer: string;
  jwksUrl: string;
  userinfoUrl: string;
  audience: string;
}

export interface OathweaveIdentity {
  subject: string;
  issuer: string;
  sessionId: string;
  roles: string[];
  permissions: string[];
  displayName: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Upper bound on how long a revoked session keeps working here. Measured from
 * the moment the last userinfo request started, not from when it answered, so
 * a slow identity service cannot stretch the bound.
 */
export const OATHWEAVE_SESSION_CACHE_TTL_MS = 15_000;
// Long enough to stop one failing request verifying twice, short enough that a
// network blip does not lock anyone out.
const FAILED_CHECK_TTL_MS = 2_000;
const SESSION_CACHE_MAX = 5_000;
const IDENTITY_REQUEST_TIMEOUT_MS = 3_000;

interface SessionCheck {
  expiresAt: number;
  displayName: Promise<string>;
}

/** Resource JWT validation plus online session revocation. Failure is closed. */
export function createOathweaveVerifier(
  options: OathweaveOptions,
  overrides: { keys?: JWTVerifyGetKey; fetch?: typeof fetch; now?: () => number } = {},
) {
  for (const value of [options.issuer, options.jwksUrl, options.userinfoUrl]) {
    if (!isOathweaveEndpoint(value)) throw new Error('Oathweave endpoints require verified HTTPS');
  }
  const request: typeof fetch = overrides.fetch ?? ((input, init) => fetch(input, init));
  const now = overrides.now ?? Date.now;
  const keys = overrides.keys ?? createRemoteJWKSet(new URL(options.jwksUrl), {
    [customFetch]: (url, init) => request(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
    }),
  });

  // Holds only tokens whose signature already verified, so unauthenticated
  // garbage can neither fill it nor reach the identity service.
  const sessions = new Map<string, SessionCheck>();

  async function fetchDisplayName(token: string, subject: string): Promise<string> {
    const result = await request(options.userinfoUrl, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
    });
    if (!result.ok) throw new Error('Identity session is inactive');
    const user: unknown = await result.json();
    if (!user || typeof user !== 'object' || (user as { sub?: unknown }).sub !== subject) {
      throw new Error('Identity subject mismatch');
    }
    return 'name' in user && typeof user.name === 'string' ? user.name : subject;
  }

  function sessionCheck(token: string, subject: string): Promise<string> {
    const key = createHash('sha256').update(token).digest('hex');
    const startedAt = now();
    const current = sessions.get(key);
    if (current && startedAt < current.expiresAt) return current.displayName;

    sessions.delete(key);
    if (sessions.size >= SESSION_CACHE_MAX) {
      for (const [entryKey, entry] of sessions) if (entry.expiresAt <= startedAt) sessions.delete(entryKey);
      if (sessions.size >= SESSION_CACHE_MAX) sessions.delete(sessions.keys().next().value as string);
    }
    // Concurrent pollers share this one in-flight request.
    const check: SessionCheck = {
      expiresAt: startedAt + OATHWEAVE_SESSION_CACHE_TTL_MS,
      displayName: fetchDisplayName(token, subject),
    };
    check.displayName.catch(() => {
      check.expiresAt = Math.min(check.expiresAt, now() + FAILED_CHECK_TTL_MS);
    });
    sessions.set(key, check);
    return check.displayName;
  }

  return async (token: string): Promise<OathweaveIdentity> => {
    // Signature, claims and lifetime are checked on every call. Only the online
    // session answer is cached, so an expired token never survives on a cache hit.
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: options.issuer,
      audience: options.audience,
      requiredClaims: ['sub', 'iat', 'exp', 'jti'],
      maxTokenAge: '15m',
      currentDate: new Date(now()),
    });
    if (
      payload.aud !== options.audience
      || typeof payload.iat !== 'number'
      || typeof payload.exp !== 'number'
      || payload.exp <= payload.iat
      || payload.exp - payload.iat > 900
    ) throw new Error('Invalid resource token audience or lifetime');
    if (
      payload['actorType'] !== 'USER'
      || typeof payload.sub !== 'string' || !payload.sub
      || typeof payload.jti !== 'string' || !payload.jti
      || typeof payload['sessionId'] !== 'string' || !payload['sessionId']
      || typeof payload['clientId'] !== 'string'
      || !Array.isArray(payload['permissions']) || !payload['permissions'].every((value) => typeof value === 'string')
      || !Array.isArray(payload['roles']) || !payload['roles'].every((value) => typeof value === 'string')
    ) throw new Error('Invalid resource identity');

    const displayName = await sessionCheck(token, payload.sub);
    return {
      subject: payload.sub,
      issuer: options.issuer,
      sessionId: payload['sessionId'],
      permissions: payload['permissions'] as string[],
      roles: payload['roles'] as string[],
      displayName,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  };
}

let verifier: ReturnType<typeof createOathweaveVerifier> | undefined;

/** Whether this server accepts Oathweave tokens. A partial configuration counts, and then fails closed. */
export function oathweaveConfigured(): boolean {
  return Boolean(process.env['OATHWEAVE_ISSUER'] || process.env['OATHWEAVE_JWKS_URL'] || process.env['OATHWEAVE_USERINFO_URL']);
}

export function configuredOathweaveVerifier(): ReturnType<typeof createOathweaveVerifier> {
  if (verifier) return verifier;
  const issuer = process.env['OATHWEAVE_ISSUER'];
  const jwksUrl = process.env['OATHWEAVE_JWKS_URL'];
  const userinfoUrl = process.env['OATHWEAVE_USERINFO_URL'];
  if (!issuer || !jwksUrl || !userinfoUrl) throw new Error('Oathweave configuration is incomplete');
  verifier = createOathweaveVerifier({ issuer, jwksUrl, userinfoUrl, audience: OATHWEAVE_AUDIENCE });
  return verifier;
}

/** Drop the memoized verifier so a test can reconfigure the environment. */
export function resetOathweaveVerifier(): void {
  verifier = undefined;
}
