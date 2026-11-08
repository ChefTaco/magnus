import { createHash } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { parseOathweaveLinks, type OathweaveIdentityLink } from '../config/oathweave.js';
import {
  configuredOathweaveServiceVerifier,
  configuredOathweaveVerifier,
  OATHWEAVE_STREAM_RECHECK_MS,
  oathweaveConfigured,
  type OathweaveIdentity,
  type OathweaveServiceIdentity,
} from './oathweave-verifier.js';
import type { AuthTokenPayload, UserRole } from '../types/index.js';

/** Grants the web terminal, only to a person whose account link is ADMIN. No other route reads it. */
export const OATHWEAVE_TERMINAL_PERMISSION = 'magnus:terminal';

/** The token proved who the caller is, but that person has no access to Magnus. */
export class OathweaveAccessDenied extends Error {}

/** The token permission a linked service identity needs for the Ardent bridge. */
export const OATHWEAVE_ARDENT_SERVICE_PERMISSION = 'magnus:ardent';

let parsedLinks: { raw: string; links: OathweaveIdentityLink[] } | undefined;

function identityLinks(raw: string): OathweaveIdentityLink[] {
  if (parsedLinks?.raw !== raw) parsedLinks = { raw, links: parseOathweaveLinks(raw) };
  return parsedLinks.links;
}

/**
 * Map a verified identity through its one explicit account link. The link's role
 * is a ceiling and the token's permissions grant within it, so neither alone
 * confers privilege. IAM role names and email addresses are never consulted.
 */
export function linkedMagnusIdentity(
  identity: OathweaveIdentity,
  raw = process.env['MAGNUS_OATHWEAVE_IDENTITIES_JSON'] ?? '[]',
): AuthTokenPayload {
  let links: OathweaveIdentityLink[];
  try {
    links = identityLinks(raw);
  } catch {
    throw new OathweaveAccessDenied('Identity links are unreadable');
  }
  const matches = links.filter((link) => link.issuer === identity.issuer && link.subject === identity.subject);
  if (matches.length !== 1) throw new OathweaveAccessDenied('An explicit unique account link is required');
  const link = matches[0]!;
  if (link.role === 'ARDENT_SERVICE') throw new OathweaveAccessDenied('A service link cannot authenticate a person');

  let role: UserRole;
  if (link.role === 'ADMIN' && identity.permissions.includes('magnus:admin')) role = 'ADMIN';
  else if (link.role !== 'VIEWER' && identity.permissions.includes('magnus:operate')) role = 'OPERATOR';
  else if (identity.permissions.includes('magnus:view')) role = 'VIEWER';
  else throw new OathweaveAccessDenied('Magnus permission required');

  // `email` is an audit actor label across this server (often read as
  // `user.email ?? user.userId`, and `??` keeps a blank), so it must not be empty.
  return {
    userId: link.localUserId, email: link.localUserId, role, iat: identity.issuedAt, exp: identity.expiresAt,
    // The fleet gateway applies the same rule, and also requires recent identity verification.
    terminal: link.role === 'ADMIN' && identity.permissions.includes(OATHWEAVE_TERMINAL_PERMISSION),
  };
}

/**
 * Map a verified client-credentials token through its one explicit service link.
 * The link (role ARDENT_SERVICE, subject = client ID) and the token permission
 * magnus:ardent are both required. The result is never ADMIN or OPERATOR: its
 * VIEWER role carries no route by itself, and authentication confines it to the
 * Ardent bridge routes.
 */
export function linkedMagnusService(
  identity: OathweaveServiceIdentity,
  raw = process.env['MAGNUS_OATHWEAVE_IDENTITIES_JSON'] ?? '[]',
): AuthTokenPayload {
  let links: OathweaveIdentityLink[];
  try {
    links = identityLinks(raw);
  } catch {
    throw new OathweaveAccessDenied('Identity links are unreadable');
  }
  const matches = links.filter((link) => link.issuer === identity.issuer && link.subject === identity.clientId);
  if (matches.length !== 1 || matches[0]!.role !== 'ARDENT_SERVICE') throw new OathweaveAccessDenied('An explicit unique service link is required');
  if (!identity.permissions.includes(OATHWEAVE_ARDENT_SERVICE_PERMISSION)) throw new OathweaveAccessDenied('Ardent service permission required');
  const userId = `service:ardent:${matches[0]!.localUserId}`;
  return { userId, email: userId, role: 'VIEWER', iat: identity.issuedAt, exp: identity.expiresAt,
    service: { kind: 'ardent', issuer: identity.issuer, clientId: identity.clientId } };
}

/**
 * The person a linked service acts for, named by the `x-acting-subject` header.
 * The subject must have exactly one person link on the service's own issuer; a
 * service link never qualifies. Only the link is checked: the person's token is
 * not presented, so their link role, not a token permission, is the ceiling.
 */
export function actingOathweaveLink(
  issuer: string,
  subject: string,
  raw = process.env['MAGNUS_OATHWEAVE_IDENTITIES_JSON'] ?? '[]',
): OathweaveIdentityLink | undefined {
  if (!subject || subject.length > 256) return undefined;
  let links: OathweaveIdentityLink[];
  try { links = identityLinks(raw); } catch { return undefined; }
  const matches = links.filter((link) => link.issuer === issuer && link.subject === subject);
  return matches.length === 1 && matches[0]!.role !== 'ARDENT_SERVICE' ? matches[0] : undefined;
}

/** Routing only: the chosen verifier checks the signature and every claim. */
function isServiceToken(token: string): boolean {
  try {
    return decodeJwt(token)['actorType'] === 'SERVICE_ACCOUNT';
  } catch {
    return false;
  }
}

function isOathweaveToken(token: string): boolean {
  if (!oathweaveConfigured()) return false;
  try {
    return decodeProtectedHeader(token).alg === 'RS256';
  } catch {
    return false;
  }
}

/**
 * Authenticate an Oathweave bearer token. Undefined means the token is not this
 * verifier's to judge (Oathweave is off, or it is not an RS256 JWT). Any throw is
 * final: the caller must reject the request rather than try another verifier.
 */
export async function oathweaveAuthentication(token: string): Promise<AuthTokenPayload | undefined> {
  if (!isOathweaveToken(token)) return undefined;
  if (isServiceToken(token)) return linkedMagnusService(await configuredOathweaveServiceVerifier()(token));
  return linkedMagnusIdentity(await configuredOathweaveVerifier()(token));
}

/**
 * A stable rate-limit identity for a fully verified token, or undefined. A
 * service identity's starts with `service:`, so a limiter can give it its own budget. Rate
 * limiters run before route authentication, so they cannot read the context user
 * and must not trust an unverified `sub` a caller could rotate. The answer comes
 * from the same session cache authentication uses, so it adds no identity traffic.
 */
export async function oathweaveRateLimitSubject(token: string): Promise<string | undefined> {
  if (!isOathweaveToken(token)) return undefined;
  try {
    if (isServiceToken(token)) {
      const service = await configuredOathweaveServiceVerifier()(token);
      return `service:${createHash('sha256').update(JSON.stringify([service.issuer, service.clientId])).digest('hex')}`;
    }
    const identity = await configuredOathweaveVerifier()(token);
    return createHash('sha256').update(JSON.stringify([identity.issuer, identity.subject])).digest('hex');
  } catch {
    return undefined;
  }
}

/** How often an open stream re-checks its token. See OATHWEAVE_SESSION_CACHE_TTL_MS. */
export { OATHWEAVE_STREAM_RECHECK_MS };

/**
 * Authentication runs once when a stream opens, so a long-lived stream would
 * otherwise outlive logout and token expiry. Calls onRevoked once the bearer
 * token stops authenticating; the browser reconnects with a fresh token.
 * Returns a function that stops watching. Other credentials are not watched.
 */
export function watchOathweaveStream(authorization: string | undefined, onRevoked: () => void): () => void {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!isOathweaveToken(token)) return () => undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    oathweaveAuthentication(token).catch(() => {
      if (stopped) return;
      stop();
      onRevoked();
    });
  }, OATHWEAVE_STREAM_RECHECK_MS);
  timer.unref();
  return stop;
}
