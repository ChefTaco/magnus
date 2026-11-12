/**
 * Oathweave resource token verification shared by the Magnus server and fleet gateway.
 *
 * A thin layer over `@hivemagnus/hive-common/oathweave`: the suite verifier, its session cache,
 * link lookup and permission helpers, configured to keep Magnus's rules (no clock tolerance, a
 * required `roles` claim, the `clientId` claim only, https endpoints, fifteen-minute tokens).
 */
import {
  createOathweaveVerifier as createSuiteVerifier,
  hasPermissions,
  isOathweaveEndpoint as isSuiteEndpoint,
  uniqueIdentityLink,
  type OathweaveVerifierOptions,
} from '@hivemagnus/hive-common/oathweave';
import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

export {
  OATHWEAVE_SESSION_CACHE_TTL_MS,
  OATHWEAVE_STREAM_RECHECK_MS,
  OathweaveError,
  isOathweaveError,
  watchStreamAuthorization,
} from '@hivemagnus/hive-common/oathweave';

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

// Magnus's link contract: exactly these four fields, a closed role set and a free-form local
// actor label. The shared parser accepts more fields and fewer local IDs, so it is not used here.
const identityLinkSchema = z.object({
  issuer: z.url(),
  subject: z.string().min(1).max(256),
  localUserId,
  role: oathweaveRoleSchema,
}).strict();

export type OathweaveIdentityLink = z.infer<typeof identityLinkSchema>;

/** Parse MAGNUS_OATHWEAVE_IDENTITIES_JSON. Throws on anything malformed. Duplicates parse, and grant nothing. */
export function parseOathweaveLinks(raw: string): OathweaveIdentityLink[] {
  return z.array(identityLinkSchema).max(10_000).parse(JSON.parse(raw));
}

/** The one link for a verified person. A missing or duplicate link yields nothing. */
export function uniqueOathweaveLink(
  links: readonly OathweaveIdentityLink[],
  issuer: string,
  subject: string,
): OathweaveIdentityLink | undefined {
  return uniqueIdentityLink(links, issuer, subject);
}

/** Whether a verified token grants `permission`. Exact names only: Magnus honours no wildcards. */
export function hasOathweavePermission(identity: { readonly permissions: readonly string[] }, permission: string): boolean {
  return hasPermissions(identity.permissions, [permission], { wildcards: false });
}

/** Oathweave endpoints carry bearer tokens, so only verified HTTPS is acceptable. */
export function isOathweaveEndpoint(value: string): boolean {
  return isSuiteEndpoint(value);
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

export interface OathweaveOverrides {
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
  now?: () => number;
}

function assertEndpoints(values: readonly string[]): void {
  for (const value of values) {
    if (!isOathweaveEndpoint(value)) throw new Error('Oathweave endpoints require verified HTTPS');
  }
}

/** The settings Magnus has always verified with, for both principal kinds. */
function suiteOptions(
  options: { issuer: string; jwksUrl: string; audience: string },
  overrides: OathweaveOverrides,
): OathweaveVerifierOptions {
  return {
    issuer: options.issuer,
    audience: options.audience,
    jwksUrl: options.jwksUrl,
    ...(overrides.keys ? { keys: overrides.keys } : {}),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    // Read the clock on every call, as Magnus always has, rather than binding Date.now once.
    now: overrides.now ?? (() => Date.now()),
    clockToleranceSec: 0,
    maxLifetimeSec: 900,
    clientIdClaim: 'clientId',
  };
}

/**
 * Resource JWT validation plus online session revocation. Failure is closed: every refusal is an
 * `OathweaveError`. Signature, claims and lifetime are checked on every call; only the userinfo
 * answer is cached (10 s from when its request started, 2 s for failures).
 */
export function createOathweaveVerifier(options: OathweaveOptions, overrides: OathweaveOverrides = {}): OathweaveVerifier {
  assertEndpoints([options.issuer, options.jwksUrl, options.userinfoUrl]);
  const verifier = createSuiteVerifier({
    ...suiteOptions(options, overrides),
    userinfoUrl: options.userinfoUrl,
    accept: 'user',
    requireRoles: true,
  });
  return async (token: string): Promise<OathweaveIdentity> => {
    const principal = await verifier.verifyUser(token);
    return {
      subject: principal.subject,
      issuer: principal.issuer,
      sessionId: principal.sessionId,
      permissions: [...principal.permissions],
      roles: [...principal.roles],
      displayName: principal.displayName,
      issuedAt: principal.issuedAt,
      expiresAt: principal.expiresAt,
      authTime: principal.authTime,
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
  overrides: OathweaveOverrides = {},
): OathweaveServiceVerifier {
  assertEndpoints([options.issuer, options.jwksUrl]);
  const verifier = createSuiteVerifier({ ...suiteOptions(options, overrides), accept: 'service' });
  return async (token: string): Promise<OathweaveServiceIdentity> => {
    const principal = await verifier.verifyService(token);
    return {
      clientId: principal.subject,
      issuer: principal.issuer,
      tokenId: principal.tokenId,
      permissions: [...principal.permissions],
      issuedAt: principal.issuedAt,
      expiresAt: principal.expiresAt,
    };
  };
}
