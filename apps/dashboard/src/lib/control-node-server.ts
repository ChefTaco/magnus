import { cookies } from 'next/headers';
import { verifySessionToken, COOKIE_NAME } from '@/lib/auth';
import { hiveCredential } from '@/lib/hive-login';
import 'server-only';

import { controlApiFetch } from '@/lib/control-api-fetch';
import { readNodes } from '@/lib/control-nodes-store';
import type { StoredControlNode } from '@/lib/control-nodes';

export interface ResolvedControlNode {
  id: string;
  name: string;
  baseUrl: string;
  credentialHeaders: Record<string, string>;
  credentialSource: 'canonical-api-secret' | 'stored-api-secret' | 'stored-iam-token';
}

function parseOrigin(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  const localHttp = parsed.protocol === 'http:' && parsed.hostname === 'localhost';
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Error(`${label} must use HTTPS`);
  }
  return parsed;
}

function canonicalTarget(): URL | null {
  const configured = process.env['CONTROL_API_URL']?.trim();
  return configured ? parseOrigin(configured, 'CONTROL_API_URL') : null;
}

function storedCredential(node: StoredControlNode): Pick<ResolvedControlNode, 'credentialHeaders' | 'credentialSource'> {
  if (node.token) {
    return {
      credentialHeaders: { Authorization: `Bearer ${node.token}` },
      credentialSource: 'stored-iam-token',
    };
  }
  if (node.apiSecret) {
    return {
      credentialHeaders: { 'x-api-secret': node.apiSecret },
      credentialSource: 'stored-api-secret',
    };
  }
  throw new Error(`Control node '${node.id}' has no server-side credential`);
}

function canonicalCredential(): Pick<ResolvedControlNode, 'credentialHeaders' | 'credentialSource'> {
  const secret = process.env['API_SECRET']?.trim() ?? '';
  if (!secret) throw new Error('Canonical Control API credential is unavailable');
  return {
    credentialHeaders: { 'x-api-secret': secret },
    credentialSource: 'canonical-api-secret',
  };
}

function resolveKnownNode(node: StoredControlNode): ResolvedControlNode {
  const parsed = parseOrigin(node.url, `Control node '${node.id}' URL`);
  const canonical = canonicalTarget();
  const credential = canonical && parsed.origin === canonical.origin
    ? canonicalCredential()
    : storedCredential(node);
  return {
    id: node.id,
    name: node.name,
    baseUrl: parsed.origin,
    ...credential,
  };
}

/** Resolve an operator-selected ID without accepting a client-supplied URL or credential. */
export async function resolveControlNodeById(id: string): Promise<ResolvedControlNode> {
  const canonical = canonicalTarget();
  if (id === 'local') {
    if (!canonical) throw new Error('CONTROL_API_URL is required for the local control node');
    return {
      id: 'local',
      name: 'Local',
      baseUrl: canonical.origin,
      ...canonicalCredential(),
    };
  }
  const nodes = await readNodes();
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Unknown control node '${id}'`);
  return resolveKnownNode(node);
}

/** Resolve an allow-listed proxy target by exact origin, entirely server-side. */
export async function resolveControlNodeTarget(target: string): Promise<ResolvedControlNode> {
  const parsed = parseOrigin(target, 'Control node target');
  const canonical = canonicalTarget();
  if (canonical && parsed.origin === canonical.origin) {
    return {
      id: 'local',
      name: 'Local',
      baseUrl: canonical.origin,
      ...canonicalCredential(),
    };
  }
  const nodes = await readNodes();
  const node = nodes.find((candidate) => {
    try {
      return parseOrigin(candidate.url, `Control node '${candidate.id}' URL`).origin === parsed.origin;
    } catch {
      return false;
    }
  });
  if (!node) throw new Error(`Target origin '${parsed.origin}' is not a configured control node`);
  return resolveKnownNode(node);
}

/** Fetch only after ID resolution has produced a purpose-bound server credential. */
export async function controlNodeFetchById(
  id: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const node = await resolveControlNodeById(id);
  const headers = new Headers(init?.headers);
  // Callers may supply content or tracing headers, but never authentication.
  // This prevents a canonical or stale credential from hitchhiking to an
  // arbitrary configured origin alongside its purpose-bound credential.
  for (const name of ['authorization', 'x-api-secret', 'proxy-authorization', 'cookie']) {
    headers.delete(name);
  }
  const cookie = (await cookies()).get(COOKIE_NAME)?.value;
  const session = cookie ? await verifySessionToken(cookie) : null;
  const delegated = session ? await hiveCredential(session, node.baseUrl) : null;
  for (const [name, value] of Object.entries(delegated ? { Authorization: `Bearer ${delegated}` } : node.credentialHeaders)) headers.set(name, value);
  const response = await controlApiFetch(
    `${node.baseUrl}/api/v1/${path.replace(/^\/+/, '')}`,
    { ...init, headers, cache: 'no-store', redirect: 'manual' },
  );
  if (response.status >= 300 && response.status < 400) {
    throw new Error('Credentialed Control API redirects are forbidden');
  }
  return response;
}
