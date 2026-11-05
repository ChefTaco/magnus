import { z } from 'zod';
import { isOathweaveEndpoint, parseOathweaveLinks } from '@hivemagnus/magnus-oathweave';

export {
  isOathweaveEndpoint,
  OATHWEAVE_AUDIENCE,
  parseOathweaveLinks,
  type OathweaveIdentityLink,
} from '@hivemagnus/magnus-oathweave';

type OathweaveEnv = {
  IAM_CORE_URL?: string | undefined;
  OATHWEAVE_ISSUER?: string | undefined;
  OATHWEAVE_JWKS_URL?: string | undefined;
  OATHWEAVE_USERINFO_URL?: string | undefined;
  MAGNUS_OATHWEAVE_IDENTITIES_JSON?: string | undefined;
};

/** Every startup problem with the Oathweave settings, keyed by variable name. */
export function oathweaveConfigurationIssues(env: OathweaveEnv): Array<{ path: keyof OathweaveEnv; message: string }> {
  const issues: Array<{ path: keyof OathweaveEnv; message: string }> = [];
  const fields = ['OATHWEAVE_ISSUER', 'OATHWEAVE_JWKS_URL', 'OATHWEAVE_USERINFO_URL'] as const;
  if (!fields.some((field) => env[field]) && !env.MAGNUS_OATHWEAVE_IDENTITIES_JSON) return issues;

  if (env.IAM_CORE_URL && env.OATHWEAVE_ISSUER) {
    issues.push({ path: 'OATHWEAVE_ISSUER', message: 'IAM_CORE_URL and OATHWEAVE_ISSUER cannot both be configured; choose one RS256 token verifier' });
  }
  for (const field of fields) {
    const value = env[field];
    if (!value) issues.push({ path: field, message: `${field} is required when Oathweave authentication is configured` });
    else if (!isOathweaveEndpoint(value)) issues.push({ path: field, message: `${field} must be an HTTPS URL without credentials or a fragment` });
  }
  if (!env.MAGNUS_OATHWEAVE_IDENTITIES_JSON) {
    issues.push({ path: 'MAGNUS_OATHWEAVE_IDENTITIES_JSON', message: 'MAGNUS_OATHWEAVE_IDENTITIES_JSON is required when Oathweave authentication is configured' });
    return issues;
  }
  try {
    const links = parseOathweaveLinks(env.MAGNUS_OATHWEAVE_IDENTITIES_JSON);
    const seen = new Set<string>();
    for (const link of links) {
      if (env.OATHWEAVE_ISSUER && link.issuer !== env.OATHWEAVE_ISSUER) throw new Error('every identity link issuer must exactly equal OATHWEAVE_ISSUER');
      const key = JSON.stringify([link.issuer, link.subject]);
      if (seen.has(key)) throw new Error('identity links must be unique per issuer and subject');
      seen.add(key);
    }
  } catch (error) {
    issues.push({ path: 'MAGNUS_OATHWEAVE_IDENTITIES_JSON', message: error instanceof Error && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)
      ? error.message : 'MAGNUS_OATHWEAVE_IDENTITIES_JSON must be a JSON array of {issuer,subject,localUserId,role}' });
  }
  return issues;
}
