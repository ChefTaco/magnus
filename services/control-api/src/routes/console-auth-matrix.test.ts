/**
 * The `auth` column of docs/console-api.md, checked against the mounted app: every `user:*` row is
 * called with a VIEWER, an OPERATOR and an ADMIN session. A role the row excludes must get 403; a role
 * it admits must get past authorization (anything but 401 or 403). The database is unavailable here,
 * so admitted calls usually end in a 500, which is fine: only the authorization outcome is judged.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env['JWT_SECRET'] = 'console-auth-matrix-jwt-secret-at-least-32';
  process.env['NODE_ENV'] = 'test';
});
vi.mock('../middleware/user-status.js', () => ({
  getCurrentUserStatus: async (userId: string) => ({ active: true, role: userId.split('-').pop()!.toUpperCase() }),
  invalidateUserStatus: () => undefined,
  passwordSessionStamp: () => 'stamp',
}));
vi.mock('../middleware/rate-limit.js', async (original) => ({
  ...(await original<object>()),
  rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
  ardentRateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../db/index.js', () => {
  // Every query rejects, as a database that is down would; nothing throws synchronously.
  const fail = () => Promise.reject(new Error('database unavailable in the authorization matrix'));
  const handler: ProxyHandler<object> = { get: (_target, prop) => (prop === 'then' ? undefined : new Proxy(fail, handler)), apply: fail };
  return { getDb: () => new Proxy(fail, handler), disconnectDb: async () => undefined };
});

const { app } = await import('../server.js');
const { signUserToken } = await import('../middleware/auth.js');

interface Row { method: string; path: string; auth: string }
const markdown = readFileSync(new URL('../../../../docs/console-api.md', import.meta.url), 'utf8');
const rows: Row[] = [...markdown.matchAll(/^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \| (?:browser|machine|exclude) \| `(user:[^`]*)` \|/gmu)]
  .map((match) => ({ method: match[1]!, path: match[2]!, auth: match[3]!.replace(/\\\|/g, '|') }));

const ROLES = ['VIEWER', 'OPERATOR', 'ADMIN'] as const;
function admitted(auth: string): readonly string[] {
  if (auth.startsWith('user:any')) return ROLES;
  return auth.slice('user:'.length).split('|');
}

/**
 * Rows whose handler answers 403 for a reason other than the role: the outcome for an admitted role
 * depends on data or a feature flag the matrix does not set up. Each says why.
 */
const ROLE_NOT_THE_ONLY_GATE = new Map<string, string>([
  ['POST /api/v1/remediation/executions/:id/approve', 'approval happens only through the signed approval bridge (403 TELEGRAM_APPROVAL_REQUIRED)'],
  ['GET /api/v1/users/:id', 'self or ADMIN, decided in the handler by the account id'],
]);

/** Rows that answer 410 to every role until an operator re-enables them; the role is checked after that. */
const RETIRED_UNLESS_ENABLED = new Map<string, string>([
  ['POST /api/v1/self-update/apply', 'MAGNUS_LEGACY_GIT_SELF_UPDATE=true'],
  ['POST /api/v1/self-update/check', 'MAGNUS_LEGACY_GIT_SELF_UPDATE=true'],
  ['POST /api/v1/self-update/restart', 'MAGNUS_LEGACY_GIT_SELF_UPDATE=true'],
]);

const tokens = new Map<string, string>();
async function token(role: string): Promise<string> {
  if (!tokens.has(role)) tokens.set(role, await signUserToken({ userId: `matrix-${role.toLowerCase()}`, email: `${role.toLowerCase()}@example.com`, role: role as 'ADMIN' }));
  return tokens.get(role)!;
}

async function call(row: Row, role: string): Promise<number> {
  const path = row.path.replace(/:([A-Za-z]+)(\{[^}]*\})?/g, 'matrix-$1').replace(/\*$/, 'matrix');
  const response = await app.request(path, {
    method: row.method,
    headers: { authorization: `Bearer ${await token(role)}`, 'content-type': 'application/json', 'x-idempotency-key': 'matrix-key' },
    ...(row.method === 'GET' || row.method === 'DELETE' ? {} : { body: '{}' }),
  });
  await response.text();
  return response.status;
}

describe('console API authorization matrix', () => {
  it('has user rows to check', () => {
    expect(rows.length).toBeGreaterThan(200);
  });

  it.each(rows.filter((row) => !row.path.includes('/stream') && !row.path.endsWith('/events')).map((row) => [`${row.method} ${row.path}`, row] as const))(
    '%s answers each role as its auth column says', async (label, row) => {
      const exempt = ROLE_NOT_THE_ONLY_GATE.has(label);
      const outcomes: string[] = [];
      for (const role of ROLES) {
        const status = await call(row, role);
        if (RETIRED_UNLESS_ENABLED.has(label)) {
          if (status !== 410) outcomes.push(`${role} got ${status}; the row is retired unless ${RETIRED_UNLESS_ENABLED.get(label)}`);
          continue;
        }
        const allowed = admitted(row.auth).includes(role);
        if (allowed && !exempt && (status === 401 || status === 403)) outcomes.push(`${role} refused (${status}) but the row admits it`);
        if (!allowed && status !== 403) outcomes.push(`${role} got ${status} but the row requires ${row.auth}`);
      }
      expect(outcomes).toEqual([]);
    }, 20_000);
});
