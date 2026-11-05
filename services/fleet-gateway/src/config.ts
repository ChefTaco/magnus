/** Service configuration. A missing or malformed required setting stops startup, naming only the setting. */
import { isOathweaveEndpoint, parseOathweaveLinks, type OathweaveIdentityLink } from '@hivemagnus/magnus-oathweave';
import { z } from 'zod';

const seconds = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const https = z.string().refine(isOathweaveEndpoint, { message: 'must be an HTTPS URL without credentials or a fragment' });
const secret = z.string().min(32);

const schema = z.object({
  FLEET_GATEWAY_BIND_HOST: z.string().min(1).default('0.0.0.0'),
  FLEET_GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
  TLS_CERT_PATH: z.string().min(1),
  TLS_KEY_PATH: z.string().min(1),
  FLEET_GATEWAY_PUBLIC_ORIGIN: z.string().refine((value) => {
    if (!isOathweaveEndpoint(value)) return false;
    return new URL(value).origin === value;
  }, { message: 'must be the exact HTTPS origin of the console' }),
  OATHWEAVE_ISSUER: https,
  OATHWEAVE_JWKS_URL: https,
  OATHWEAVE_USERINFO_URL: https,
  MAGNUS_OATHWEAVE_IDENTITIES_JSON: z.string().min(2),
  CONTROL_API_URL: https,
  CONTROL_API_CA_PATH: z.string().min(1).optional(),
  FLEET_GATEWAY_API_TOKEN: secret,
  RESOURCE_ENROLLMENT_DASHBOARD_SECRET: secret,
  FLEET_GATEWAY_SSH_USERNAME: z.string().min(1),
  FLEET_GATEWAY_SSH_PRIVATE_KEY_PATH: z.string().min(1),
  FLEET_GATEWAY_KNOWN_HOSTS_FILE: z.string().min(1).default('/var/lib/fleet-gateway/known-hosts/known-hosts.json'),
  FLEET_GATEWAY_TRUST_FORWARDED_FOR: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FLEET_GATEWAY_IDLE_TIMEOUT_SECONDS: seconds(900, 60, 3_600),
  FLEET_GATEWAY_MAX_LIFETIME_SECONDS: seconds(3_600, 300, 3_600),
  FLEET_GATEWAY_MAX_SESSIONS_PER_SUBJECT: z.coerce.number().int().min(1).max(16).default(3),
  FLEET_GATEWAY_MAX_SESSIONS: z.coerce.number().int().min(1).max(256).default(32),
}).superRefine((env, context) => {
  if (env.FLEET_GATEWAY_API_TOKEN === env.RESOURCE_ENROLLMENT_DASHBOARD_SECRET) {
    context.addIssue({ code: 'custom', path: ['FLEET_GATEWAY_API_TOKEN'], message: 'must be distinct from RESOURCE_ENROLLMENT_DASHBOARD_SECRET' });
  }
});

export type GatewayConfig = z.infer<typeof schema> & { links: OathweaveIdentityLink[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Paths and messages only. Zod's input echo could hold a secret value.
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
  }
  let links: OathweaveIdentityLink[];
  try {
    links = parseOathweaveLinks(parsed.data.MAGNUS_OATHWEAVE_IDENTITIES_JSON);
  } catch {
    throw new Error('Invalid configuration: MAGNUS_OATHWEAVE_IDENTITIES_JSON must be a JSON array of {issuer,subject,localUserId,role}');
  }
  if (links.some((link) => link.issuer !== parsed.data.OATHWEAVE_ISSUER)) {
    throw new Error('Invalid configuration: every identity link issuer must exactly equal OATHWEAVE_ISSUER');
  }
  return { ...parsed.data, links };
}
