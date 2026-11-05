import {
  createOathweaveVerifier,
  OATHWEAVE_AUDIENCE,
  type OathweaveVerifier,
} from '@hivemagnus/magnus-oathweave';

export {
  createOathweaveVerifier,
  OATHWEAVE_SESSION_CACHE_TTL_MS,
  OATHWEAVE_STREAM_RECHECK_MS,
  type OathweaveIdentity,
  type OathweaveOptions,
} from '@hivemagnus/magnus-oathweave';

let verifier: OathweaveVerifier | undefined;

/** Whether this server accepts Oathweave tokens. A partial configuration counts, and then fails closed. */
export function oathweaveConfigured(): boolean {
  return Boolean(process.env['OATHWEAVE_ISSUER'] || process.env['OATHWEAVE_JWKS_URL'] || process.env['OATHWEAVE_USERINFO_URL']);
}

export function configuredOathweaveVerifier(): OathweaveVerifier {
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
