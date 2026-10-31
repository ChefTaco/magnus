/**
 * Server-side fetch helper for Fleet Control API — used by RSC (Server Components).
 *
 * Reads the active control-node ID from the `magnus_active_node_id` cookie,
 * looks up the node config from `.magnus/control-nodes.json`, and calls the
 * control API directly with a purpose-bound server credential.
 *
 */
import { cookies } from 'next/headers';
import { controlNodeFetchById } from '@/lib/control-node-server';
import { readNodes } from '@/lib/control-nodes-store';

/** Cookie name set by the ControlNodeProvider when switching nodes. */
const ACTIVE_NODE_COOKIE = 'magnus_active_node_id';

interface ResolvedNode {
  id: string;
}

/**
 * Resolve only the operator-selected ID. URL and credential lookup remains on
 * the server and fails closed when the selected record is missing.
 */
async function resolveActiveNode(): Promise<ResolvedNode> {
  const cookieStore = await cookies();
  const activeNodeId = cookieStore.get(ACTIVE_NODE_COOKIE)?.value ?? 'local';
  if (activeNodeId === 'local') return { id: 'local' };
  const nodes = await readNodes();
  if (!nodes.some((node) => node.id === activeNodeId)) {
    throw new Error(`Selected control node '${activeNodeId}' is unavailable`);
  }
  return { id: activeNodeId };
}

/**
 * Fetch from the active Control Node API.
 * Throws on failure (caller should `.catch()`).
 *
 * @param path  API path without leading `/api/v1/` prefix (e.g. `'nodes'`, `'stats/overview'`)
 * @param init  Optional RequestInit overrides
 */
export async function fleetFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const node = await resolveActiveNode();
  const res = await controlNodeFetchById(node.id, path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fleet fetch failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Fetch from the primary server-configured Control API. Use this for global
 * operations surfaces that should not depend on the operator's active
 * control-node cookie or copied control-nodes.json secrets.
 */
export async function fleetSystemFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await controlNodeFetchById('local', path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fleet system fetch failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<T>;
}
