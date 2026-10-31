/**
 * auth.ts — Control API authentication middleware.
 *
 * When IAM_CORE_URL is configured, access tokens are RS256 JWTs issued by the
 * external Hive IAM service. Magnus verifies those tokens; IAM administration
 * happens in Hive IAM itself.
 *
 * If IAM_CORE_URL is not set, local Magnus HS256/API-secret auth remains active.
 */

import type { Context, Next } from 'hono';
import { createHash } from 'node:crypto';
import * as jose from 'jose';
import type { AppVariables, AuthTokenPayload, SecurityPermission, UserRole } from '../types/index.js';
import { HttpError } from './error-handler.js';
import {
  JWT_SECRET as jwtSecretRaw,
  API_SECRET as configuredApiSecret,
  IAM_CORE_URL,
  IAM_TOKEN_AUDIENCE,
  IAM_TOKEN_ISSUER,
  MAGNUS_COLLECTOR_TOKEN_SHA256,
  MAGNUS_PLUGIN_API_ENABLED,
  MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON,
  MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256,
  MAGNUS_APPROVAL_BRIDGE_CONSUMER,
  MAGNUS_SHARED_RESOURCE_TOKEN_SHA256,
  MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON,
  MAGNUS_FLEET_CHECK_TOKEN_SHA256,
} from '../utils/env.js';
import { verifyWithRotation } from '../services/credential-rotation-service.js';
import { verifyIamAccessToken } from './iam-token.js';
import { getCurrentUserStatus } from './user-status.js';
import { safeEqual } from '../utils/safe-equal.js';

/** Constant-time string comparison (re-exported for existing callers). */
export { safeEqual };

// ──────────────────────────────────────────────────────────
// RS256 public-key cache (external Hive IAM verification mode)
// ──────────────────────────────────────────────────────────

type JoseKey = Awaited<ReturnType<typeof jose.importSPKI>>;

let cachedPublicKey: JoseKey | null = null;
let publicKeyCachedAt = 0;
let lastForcedRefreshAt = 0;
let publicKeyFetch: Promise<JoseKey> | null = null;
const PUBLIC_KEY_TTL_MS = 60 * 60 * 1_000; // 1 hour
// A forged or expired token must not turn every request into an IAM fetch.
const FORCED_REFRESH_MIN_INTERVAL_MS = 60 * 1_000;

async function fetchIamPublicKey(): Promise<JoseKey> {
  const url = `${IAM_CORE_URL}/api/v1/auth/public-key`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch IAM public key: ${res.status}`);
  }
  const { publicKey: pem } = await res.json() as { publicKey: string };
  const key = await jose.importSPKI(pem, 'RS256');
  cachedPublicKey = key;
  publicKeyCachedAt = Date.now();
  return key;
}

async function getIamPublicKey(forceRefresh = false): Promise<JoseKey> {
  const now = Date.now();
  if (cachedPublicKey) {
    if (!forceRefresh && now - publicKeyCachedAt < PUBLIC_KEY_TTL_MS) return cachedPublicKey;
    // Rotation refresh is rate-limited; within the window the cached key stays authoritative.
    if (forceRefresh && now - lastForcedRefreshAt < FORCED_REFRESH_MIN_INTERVAL_MS) return cachedPublicKey;
  }
  if (forceRefresh) lastForcedRefreshAt = now;
  // Concurrent callers share one in-flight fetch.
  publicKeyFetch ??= fetchIamPublicKey().finally(() => { publicKeyFetch = null; });
  return publicKeyFetch;
}

// ──────────────────────────────────────────────────────────
// Role mapping: Hive IAM roles → Magnus UserRole
// ──────────────────────────────────────────────────────────

const IAM_ROLE_MAP: Record<string, UserRole> = {
  SUPER_ADMIN: 'ADMIN',
  IAM_ADMIN: 'ADMIN',
  OPERATOR: 'OPERATOR',
  VIEWER: 'VIEWER',
  SERVICE: 'OPERATOR',
  DEPLOY_AGENT: 'OPERATOR',
};

function mapIamRoles(roles: string[]): UserRole {
  for (const r of roles) {
    const mapped = IAM_ROLE_MAP[r];
    if (mapped) return mapped;
  }
  return 'VIEWER';
}

// ──────────────────────────────────────────────────────────
// HS256 legacy key (non-IAM mode)
// ──────────────────────────────────────────────────────────

const JWT_SECRET_KEY = jwtSecretRaw
  ? new TextEncoder().encode(jwtSecretRaw)
  : null;

function matchesBearerDigest(token: string, expectedDigest: string): boolean {
  return Boolean(expectedDigest) && safeEqual(createHash('sha256').update(token).digest('hex'), expectedDigest);
}

export function isScopedServiceRequestAllowed(
  service: 'plugin-read' | 'plugin-operator' | 'fleet' | 'shared-resource',
  method: string,
  path: string,
): boolean {
  const pluginExactReads = new Set([
    '/api/v1/stats/overview', '/api/v1/fleet-checks/latest', '/api/v1/fleet-checks/runs',
    '/api/v1/nodes', '/api/v1/nodes/wazuh/summary', '/api/v1/nodes/system-updates/summary',
    '/api/v1/nodes/tailscale/summary',
    '/api/v1/hermes/installations', '/api/v1/anomalies/summary', '/api/v1/anomalies',
    '/api/v1/anomalies/correlations', '/api/v1/anomalies/timeline', '/api/v1/commands',
    '/api/v1/cron', '/api/v1/dependencies', '/api/v1/ops/readiness', '/api/v1/ops/dependency-health',
    '/api/v1/ops/timeline', '/api/v1/ops/incident-summary', '/api/v1/ops/hermes-effective-state',
    '/api/v1/ops/package-security-posture', '/api/v1/alerts/violations', '/api/v1/audit',
    '/api/v1/ops/codex-fleet-status',
    '/api/v1/predictions', '/api/v1/skills', '/api/v1/security-fusion/overview',
    '/api/v1/security-fusion/cases', '/api/v1/security-fusion/events',
    '/api/v1/security-fusion/evidence',
  ]);
  const pluginDynamicRead = [
    /^\/api\/v1\/hermes\/installations\/[^/]+$/,
    /^\/api\/v1\/commands\/[^/]+(?:\/result)?$/,
    /^\/api\/v1\/predictions\/[^/]+$/,
    /^\/api\/v1\/security-fusion\/cases\/[^/]+$/,
    /^\/api\/v1\/security-fusion\/entities\/[^/]+$/,
    /^\/api\/v1\/nodes\/(?!tags$|compare$|scan-users$|register$|wazuh$|system-updates$)[^/]+(?:\/health(?:\/history)?)?$/,
  ].some((pattern) => pattern.test(path));
  const pluginWrites = new Set([
    '/api/v1/commands', '/api/v1/logs/query', '/api/v1/ops/remediation-plan/classify',
    '/api/v1/ops/engineering/dependency-impact', '/api/v1/ops/engineering/runbook-assessment',
    '/api/v1/ops/engineering/delivery-assessment', '/api/v1/ops/engineering/forecast-assessment',
    '/api/v1/ops/engineering/restore-assessment',
  ]);
  const pluginDynamicWrite = /^\/api\/v1\/security-fusion\/cases\/[^/]+\/investigations$/.test(path);
  if (service === 'plugin-read') return method === 'GET' && (pluginExactReads.has(path) || pluginDynamicRead);
  if (service === 'plugin-operator') {
    return (method === 'POST' && (pluginWrites.has(path) || pluginDynamicWrite))
      || (method === 'GET' && path === '/api/v1/ops/engineering/catalog');
  }
  if (service === 'shared-resource') {
    return (method === 'GET' && (/^\/api\/v1\/shared-resource-leases\/[A-Za-z0-9_-]{16,64}$/.test(path)
        || /^\/api\/v1\/shared-resource-leases\/operation\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(path)))
      || (method === 'POST' && (path === '/api/v1/shared-resource-leases/reserve'
        || /^\/api\/v1\/shared-resource-leases\/[A-Za-z0-9_-]{16,64}\/(?:start|unknown|settle)$/.test(path)));
  }
  return method === 'GET' && new Set([
    '/api/v1/stats/overview', '/api/v1/nodes', '/api/v1/anomalies', '/api/v1/anomalies/summary',
  ]).has(path);
}

function assertScopedServiceRequest(
  c: Context<AppVariables>,
  service: 'plugin-read' | 'plugin-operator' | 'fleet' | 'shared-resource',
): void {
  const allowed = isScopedServiceRequestAllowed(service, c.req.method, c.req.path);
  if (!allowed) {
    throw new HttpError(403, 'FORBIDDEN', `${service} credential is endpoint-scoped`);
  }
}

function matchingPluginReadConsumer(token: string): string | null {
  let registry: Record<string, unknown>;
  try {
    registry = JSON.parse(MAGNUS_PLUGIN_READ_TOKEN_DIGESTS_JSON) as Record<string, unknown>;
  } catch {
    return null;
  }
  const digest = createHash('sha256').update(token).digest('hex');
  for (const [consumer, expected] of Object.entries(registry)) {
    if (typeof expected === 'string' && matchesBearerDigest(token, expected) && safeEqual(digest, expected)) {
      return consumer;
    }
  }
  return null;
}

function matchingSharedResourceConsumer(token: string): string | null {
  let registry: Record<string, unknown>;
  try { registry = JSON.parse(MAGNUS_SHARED_RESOURCE_TOKEN_DIGESTS_JSON) as Record<string, unknown>; }
  catch { return null; }
  const digest = createHash('sha256').update(token).digest('hex');
  for (const [consumer, expected] of Object.entries(registry)) {
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(consumer) && typeof expected === 'string'
      && matchesBearerDigest(token, expected) && safeEqual(digest, expected)) return consumer;
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// Core auth middleware
// ──────────────────────────────────────────────────────────

/** Verify token and attach AuthTokenPayload to context. */
export async function authMiddleware(c: Context<AppVariables>, next: Next): Promise<void> {
  // API-secret bypass (system calls from the dashboard, etc.)
  // When IAM Core is configured, this is a bootstrap-only fallback.
  const apiSecret = c.req.header('x-api-secret');
  if (apiSecret && configuredApiSecret && verifyWithRotation('API_SECRET', configuredApiSecret, apiSecret)) {
    if (IAM_CORE_URL) {
      console.warn(`[auth] API_SECRET bypass used while IAM is active — path: ${new URL(c.req.url).pathname} (should migrate to IAM tokens)`);
    }
    c.set('user', {
      userId: 'system',
      email: 'system@magnus.local',
      role: 'ADMIN' as UserRole,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    } satisfies AuthTokenPayload);
    await next();
    return;
  }

  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header');
  }

  const token = header.slice(7);

  // Hermes plugin credentials are honoured only when the plugin API is enabled.
  const pluginReadConsumer = MAGNUS_PLUGIN_API_ENABLED ? matchingPluginReadConsumer(token) : null;
  if (pluginReadConsumer) {
    const approvalBridge = Boolean(MAGNUS_APPROVAL_BRIDGE_CONSUMER) && pluginReadConsumer === MAGNUS_APPROVAL_BRIDGE_CONSUMER && (
      (c.req.method === 'GET' && /^\/api\/v1\/team-approvals\/plans(?:\/[^/]+)?$/.test(c.req.path))
      || (c.req.method === 'POST' && c.req.path === '/api/v1/team-approvals/decisions')
    );
    // Decision POST additionally requires a signed approval assertion; this
    // never grants general operator writes to a read-only plugin credential.
    if (!approvalBridge) assertScopedServiceRequest(c, 'plugin-read');
    c.set('user', {
      userId: `service:magnus-plugin-read:${pluginReadConsumer}`, email: '', role: 'VIEWER',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    } satisfies AuthTokenPayload);
    await next();
    return;
  }

  if (MAGNUS_PLUGIN_API_ENABLED && matchesBearerDigest(token, MAGNUS_PLUGIN_OPERATOR_TOKEN_SHA256)) {
    assertScopedServiceRequest(c, 'plugin-operator');
    c.set('user', {
      userId: 'service:magnus-plugin-operator', email: '', role: 'OPERATOR',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    } satisfies AuthTokenPayload);
    await next();
    return;
  }

  const sharedResourceConsumer = matchingSharedResourceConsumer(token);
  if (sharedResourceConsumer || matchesBearerDigest(token, MAGNUS_SHARED_RESOURCE_TOKEN_SHA256)) {
    assertScopedServiceRequest(c, 'shared-resource');
    c.set('user', {
      userId: sharedResourceConsumer ? `service:shared-resource:${sharedResourceConsumer}` : 'service:shared-resource-client',
      email: '', role: 'OPERATOR',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    } satisfies AuthTokenPayload);
    await next();
    return;
  }

  if (matchesBearerDigest(token, MAGNUS_FLEET_CHECK_TOKEN_SHA256)) {
    assertScopedServiceRequest(c, 'fleet');
    c.set('user', {
      userId: 'service:magnus-fleet-check', email: '', role: 'VIEWER',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    } satisfies AuthTokenPayload);
    await next();
    return;
  }

  // An optional external observability collector has a dedicated read-only
  // credential. Store only its digest and confine it to the collector endpoints.
  if (MAGNUS_COLLECTOR_TOKEN_SHA256) {
    const tokenDigest = createHash('sha256').update(token).digest('hex');
    if (safeEqual(tokenDigest, MAGNUS_COLLECTOR_TOKEN_SHA256)) {
      const allowed = c.req.method === 'GET' && new Set([
        '/api/v1/nodes',
        '/api/v1/hermes/installations',
        '/api/v1/ops/observations',
        '/api/v1/ops/capacity-advice',
      ]).has(c.req.path);
      if (!allowed) {
        throw new HttpError(403, 'FORBIDDEN', 'Collector credential is read-only and endpoint-scoped');
      }
      c.set('user', {
        userId: 'service:observability-collector',
        email: '',
        role: 'VIEWER' as UserRole,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      } satisfies AuthTokenPayload);
      await next();
      return;
    }
  }

  // ── External Hive IAM verification mode: RS256 ────────
  if (IAM_CORE_URL) {
    let payload: jose.JWTPayload;
    try {
      const key = await getIamPublicKey();
      payload = await verifyIamAccessToken(
        token,
        key,
        IAM_TOKEN_ISSUER,
        IAM_TOKEN_AUDIENCE,
      );
    } catch {
      // Might be a key rotation — refresh once and retry
      try {
        const freshKey = await getIamPublicKey(true);
        payload = await verifyIamAccessToken(
          token,
          freshKey,
          IAM_TOKEN_ISSUER,
          IAM_TOKEN_AUDIENCE,
        );
      } catch {
        throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or expired IAM token');
      }
    }

    const roles = (payload['roles'] as string[] | undefined) ?? [];
    c.set('user', {
      userId: payload.sub!,
      email: (payload['email'] as string) ?? '',
      role: mapIamRoles(roles),
      iat: payload.iat ?? 0,
      exp: payload.exp ?? 0,
    } satisfies AuthTokenPayload);

    await next();
    return;
  }

  // ── Legacy HS256 mode ─────────────────────────────────
  if (!JWT_SECRET_KEY) {
    throw new HttpError(500, 'CONFIGURATION_ERROR', 'No JWT_SECRET or IAM_CORE_URL configured');
  }

  let claims: AuthTokenPayload;
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET_KEY);
    claims = payload as unknown as AuthTokenPayload;
  } catch {
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  }

  // The signed role is only a snapshot: deactivated, deleted, or demoted users
  // must not keep access until the token expires. The database role wins.
  const current = typeof claims.userId === 'string' && claims.userId
    ? await getCurrentUserStatus(claims.userId)
    : null;
  if (!current?.active) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  }
  c.set('user', { ...claims, role: current.role });

  await next();
}

/** Create a signed HS256 JWT (local Magnus mode only). */
export async function signUserToken(payload: Omit<AuthTokenPayload, 'iat' | 'exp'>): Promise<string> {
  if (!JWT_SECRET_KEY) {
    throw new Error('signUserToken is not available in IAM Core mode');
  }
  const expiry = process.env['JWT_EXPIRY'] ?? '24h';
  return new jose.SignJWT(payload as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(JWT_SECRET_KEY);
}

/** Extract user from context (set by authMiddleware). */
export function getUser(c: Context<AppVariables>): AuthTokenPayload {
  const user = c.var.user;
  // Runtime guard — user is always set by authMiddleware before this is called
  if (!user) throw new HttpError(401, 'UNAUTHORIZED', 'Not authenticated');
  return user;
}

/** Check that the authenticated user has one of the required roles. */
export function requireRole(...roles: UserRole[]) {
  return async (c: Context<AppVariables>, next: Next): Promise<void> => {
    const user = getUser(c);
    if (!roles.includes(user.role)) {
      throw new HttpError(403, 'FORBIDDEN', `Requires one of: ${roles.join(', ')}`);
    }
    await next();
  };
}

const ROLE_PERMISSIONS: Readonly<Record<UserRole, ReadonlySet<SecurityPermission>>> = {
  ADMIN: new Set(['security-fusion:read', 'security-fusion:evidence:read']),
  OPERATOR: new Set(['security-fusion:read']),
  VIEWER: new Set(['security-fusion:read']),
};

export function hasPermission(user: AuthTokenPayload, permission: SecurityPermission): boolean {
  return ROLE_PERMISSIONS[user.role]?.has(permission) ?? false;
}

/** Require an explicit permission rather than treating any dashboard session as access. */
export function requirePermission(permission: SecurityPermission) {
  return async (c: Context<AppVariables>, next: Next): Promise<void> => {
    if (!hasPermission(getUser(c), permission)) {
      throw new HttpError(403, 'FORBIDDEN', `Requires permission: ${permission}`);
    }
    await next();
  };
}
