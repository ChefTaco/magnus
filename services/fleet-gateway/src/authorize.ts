/** Who may hold a terminal. Requires one exact account link, one permission and, to open, recency. */
import {
  uniqueOathweaveLink,
  type OathweaveIdentity,
  type OathweaveIdentityLink,
  type OathweaveVerifier,
} from '@hivemagnus/magnus-oathweave';
import { GatewayError } from './errors.js';

export const TERMINAL_PERMISSION = 'magnus:terminal';
/** How recently a person must have proved their identity to open a terminal. */
export const STEP_UP_WINDOW_SECONDS = 300;
/** A clock this far ahead of ours still counts; further means the claim is not believable. */
const AUTH_TIME_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 8192;
const JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface Principal {
  identity: OathweaveIdentity;
  link: OathweaveIdentityLink;
  token: string;
  /** Sessions belong to this exact person and identity session. */
  ownerKey: string;
  subjectKey: string;
}

/** The bearer credential, only from the Authorization header. */
export function bearerToken(header: string | undefined): string {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token.length > MAX_TOKEN_LENGTH || !JWS.test(token)) throw new GatewayError('UNAUTHORIZED');
  return token;
}

const ownerKeyOf = (identity: OathweaveIdentity) => JSON.stringify([identity.issuer, identity.subject, identity.sessionId]);

export function createAuthorizer(
  verify: OathweaveVerifier,
  links: readonly OathweaveIdentityLink[],
  now: () => number = () => Date.now(),
) {
  /** Verifies the token, then the link and permission. Valid for an existing session's calls. */
  async function authorize(token: string): Promise<Principal> {
    let identity: OathweaveIdentity;
    try {
      identity = await verify(token);
    } catch {
      throw new GatewayError('UNAUTHORIZED');
    }
    const link = uniqueOathweaveLink(links, identity.issuer, identity.subject);
    if (link?.role !== 'ADMIN' || !identity.permissions.includes(TERMINAL_PERMISSION)) {
      const refused = new GatewayError('FORBIDDEN');
      refused.audit = { subject: identity.subject, actorId: link?.localUserId ?? 'unlinked' };
      refused.ownerKey = ownerKeyOf(identity);
      throw refused;
    }
    return { identity, link, token, subjectKey: JSON.stringify([identity.issuer, identity.subject]), ownerKey: ownerKeyOf(identity) };
  }

  /** Opening a shell also needs recent verification. Checked last, so a person who cannot use the terminal is never asked. */
  async function authorizeOpen(token: string): Promise<Principal> {
    const principal = await authorize(token);
    const { authTime } = principal.identity;
    const seconds = now() / 1000;
    if (authTime === undefined || authTime > seconds + AUTH_TIME_SKEW_SECONDS || seconds - authTime > STEP_UP_WINDOW_SECONDS) {
      const refused = new GatewayError('STEP_UP_REQUIRED');
      refused.audit = { subject: principal.identity.subject, actorId: principal.link.localUserId };
      throw refused;
    }
    return principal;
  }

  return { authorize, authorizeOpen };
}

export type Authorizer = ReturnType<typeof createAuthorizer>;
