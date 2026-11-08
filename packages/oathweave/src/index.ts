/** Oathweave resource token verification shared by the Magnus server and fleet gateway. */
import { createHash } from 'node:crypto';
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';

/** The only resource audience Magnus services accept on Oathweave tokens. */
export const OATHWEAVE_AUDIENCE = 'magnus';

/**
 * A link's role is a ceiling for a person. `ARDENT_SERVICE` instead links an
 * Oathweave machine client (its subject is the client ID) to the Ardent bridge
 * permission set: it never authenticates a person and never grants a role.
 */
export const oathweaveRoleSchema = z.enum(['ADMIN', 'OPERATOR', 'VIEWER', 'ARDENT_SERVICE']);

const localUserId = z.string().min(1).max(256)
  // These identifiers name server-owned actors; a link must never impersonate one.
  .refine((value) => value !== 'system' && !value.startsWith('service:'), {
    message: 'localUserId must not name the system or a service actor',
  });

const identityLinkSchema = z.object({
  issuer: z.url(),
  subject: z.string().min(1).max(256),
  localUserId,
  role: oathweaveRoleSchema,
}).strict();

export type OathweaveIdentityLink = z.infer<typeof identityLinkSchema>;

/** Parse MAGNUS_OATHWEAVE_IDENTITIES_JSON. Throws on anything malformed. */
export function parseOathweaveLinks(raw: string): OathweaveIdentityLink[] {
  return z.array(identityLinkSchema).max(10_000).parse(JSON.parse(raw));
}

/** The one link for a verified person. A missing or duplicate link yields nothing. */
export function uniqueOathweaveLink(
  links: readonly OathweaveIdentityLink[],
  issuer: string,
  subject: string,
): OathweaveIdentityLink | undefined {
  const matches = links.filter((link) => link.issuer === issuer && link.subject === subject);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Oathweave endpoints carry bearer tokens, so only verified HTTPS is acceptable. */
export function isOathweaveEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

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
  /** When the person last proved their identity. Undefined means unknown, which is never recent. */
  authTime: number | undefined;
}

export type OathweaveVerifier = (token: string) => Promise<OathweaveIdentity>;

/**
 * How long a userinfo answer is reused. Measured from the moment that request
 * started, not from when it answered, so a slow identity service cannot stretch
 * it. Together with OATHWEAVE_STREAM_RECHECK_MS this keeps logout effective
 * within 15 seconds on open streams as well as on ordinary requests.
 */
export const OATHWEAVE_SESSION_CACHE_TTL_MS = 10_000;
/** How often a long-lived connection re-checks its token. */
export const OATHWEAVE_STREAM_RECHECK_MS = 5_000;
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
): OathweaveVerifier {
  for (const value of [options.issuer, options.jwksUrl, options.userinfoUrl]) {
    if (!isOathweaveEndpoint(value)) throw new Error('Oathweave endpoints require verified HTTPS');
  }
  const request: typeof fetch = overrides.fetch ?? ((input, init) => fetch(input, init));
  const now = overrides.now ?? (() => Date.now());
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
    const authTime = payload['auth_time'];
    return {
      subject: payload.sub,
      issuer: options.issuer,
      sessionId: payload['sessionId'],
      permissions: payload['permissions'] as string[],
      roles: payload['roles'] as string[],
      displayName,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      authTime: typeof authTime === 'number' && Number.isSafeInteger(authTime) && authTime > 0 ? authTime : undefined,
    };
  };
}

export interface OathweaveServiceOptions {
  issuer: string;
  jwksUrl: string;
  audience: string;
}

/** A verified Oathweave client-credentials token. It carries no person and no session. */
export interface OathweaveServiceIdentity {
  clientId: string;
  issuer: string;
  tokenId: string;
  permissions: string[];
  issuedAt: number;
  expiresAt: number;
}

export type OathweaveServiceVerifier = (token: string) => Promise<OathweaveServiceIdentity>;

/**
 * Service-account (client_credentials) tokens of another product. They have no
 * user session to revoke, so they are accepted only when RS256-signed by the
 * issuer's key set, bound to this audience, issued to the client named in their
 * subject, free of any session claim and valid for at most 15 minutes.
 */
export function createOathweaveServiceVerifier(
  options: OathweaveServiceOptions,
  overrides: { keys?: JWTVerifyGetKey; fetch?: typeof fetch; now?: () => number } = {},
): OathweaveServiceVerifier {
  for (const value of [options.issuer, options.jwksUrl]) {
    if (!isOathweaveEndpoint(value)) throw new Error('Oathweave endpoints require verified HTTPS');
  }
  const request: typeof fetch = overrides.fetch ?? ((input, init) => fetch(input, init));
  const now = overrides.now ?? (() => Date.now());
  const keys = overrides.keys ?? createRemoteJWKSet(new URL(options.jwksUrl), {
    [customFetch]: (url, init) => request(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(IDENTITY_REQUEST_TIMEOUT_MS),
    }),
  });
  return async (token: string): Promise<OathweaveServiceIdentity> => {
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
    ) throw new Error('Invalid service token audience or lifetime');
    if (
      payload['actorType'] !== 'SERVICE_ACCOUNT'
      || payload['token_type'] !== 'access'
      || typeof payload.sub !== 'string' || !payload.sub
      || payload['clientId'] !== payload.sub
      || payload['sessionId'] !== undefined
      || typeof payload.jti !== 'string' || !payload.jti
      || !Array.isArray(payload['permissions']) || !payload['permissions'].every((value) => typeof value === 'string')
    ) throw new Error('Invalid service identity');
    return {
      clientId: payload.sub,
      issuer: options.issuer,
      tokenId: payload.jti,
      permissions: payload['permissions'] as string[],
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  };
}
