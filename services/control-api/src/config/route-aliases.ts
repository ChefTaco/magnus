/**
 * Optional request path aliases for clients built against older route names.
 *
 * `MAGNUS_ROUTE_ALIASES_JSON` is a JSON object that maps a legacy path prefix
 * to the current one, for example
 * `{"/api/v1/old/prefix": "/api/v1/new/prefix"}`. A request whose path equals a
 * legacy prefix, or continues it after a `/`, is rewritten before routing, so
 * authentication, endpoint scopes, rate limits and audit all see the current
 * path. Unset (the default) means no aliases.
 */
const segment = '[A-Za-z0-9._~-]+';
const aliasPath = new RegExp(`^/api/v1(?:/${segment})+$`);

export interface RouteAlias { from: string; to: string }

function validPath(path: string): boolean {
  return aliasPath.test(path) && !path.split('/').some(part => part === '.' || part === '..');
}

/** Parse and validate the alias map; throws a descriptive error when it is malformed. */
export function parseRouteAliases(raw: string | undefined): RouteAlias[] {
  if (raw === undefined || raw.trim() === '') return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('MAGNUS_ROUTE_ALIASES_JSON must be a JSON object'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MAGNUS_ROUTE_ALIASES_JSON must be a JSON object');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new Error('MAGNUS_ROUTE_ALIASES_JSON may define at most 64 aliases');
  const aliases: RouteAlias[] = [];
  for (const [from, to] of entries) {
    if (typeof to !== 'string' || !validPath(from) || !validPath(to))
      throw new Error('MAGNUS_ROUTE_ALIASES_JSON keys and values must be /api/v1/... paths without "." or ".." segments');
    if (from === to) throw new Error('MAGNUS_ROUTE_ALIASES_JSON maps a path to itself');
    aliases.push({ from, to });
  }
  for (const { to } of aliases)
    if (aliases.some(alias => to === alias.from || to.startsWith(`${alias.from}/`)))
      throw new Error('MAGNUS_ROUTE_ALIASES_JSON targets must not be aliases themselves');
  // Longest prefix first, so a more specific alias wins.
  return aliases.sort((a, b) => b.from.length - a.from.length);
}

/** The current path for `path`, or null when no alias applies. */
export function resolveRouteAlias(path: string, aliases: readonly RouteAlias[]): string | null {
  for (const { from, to } of aliases) {
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  }
  return null;
}

type Fetch<Env, Context> = (request: Request, env?: Env, context?: Context) => Response | Promise<Response>;

/** Wrap a fetch handler so legacy paths reach their current routes. Returns `fetch` unchanged without aliases. */
export function withRouteAliases<Env, Context>(fetch: Fetch<Env, Context>, aliases: readonly RouteAlias[]): Fetch<Env, Context> {
  if (!aliases.length) return fetch;
  return (request, env, context) => {
    const url = new URL(request.url);
    const target = resolveRouteAlias(url.pathname, aliases);
    if (target === null) return fetch(request, env, context);
    url.pathname = target;
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method, headers: request.headers, redirect: request.redirect, signal: request.signal,
      ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    };
    return fetch(new Request(url, init), env, context);
  };
}
