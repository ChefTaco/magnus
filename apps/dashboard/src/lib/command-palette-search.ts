/**
 * Client-side fuzzy entity search for the Command Palette.
 *
 * Queries multiple API surfaces in parallel (fleet and Orchestra) and
 * returns a unified list of `PaletteEntity` results that can be rendered
 * alongside keyboard shortcut entries.
 *
 */

export type PaletteEntityKind =
  | 'node'
  | 'installation'
  | 'skill'
  | 'action';

export interface PaletteEntity {
  kind: PaletteEntityKind;
  id: string;
  label: string;
  sublabel?: string;
  href: string;
}

interface FetchOpts {
  signal?: AbortSignal;
  /** Max results per source. */
  limit?: number;
}

async function safeJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Lightweight fuzzy match — all query chars must appear in order in the target
 * (case-insensitive). Returns a match score (lower is better) or -1 when no match.
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact substring match wins
  const idx = t.indexOf(q);
  if (idx !== -1) return idx;

  // Otherwise require chars in order
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    score += found - ti;
    ti = found + 1;
  }
  return 1000 + score;
}

export function filterAndRank(query: string, entities: PaletteEntity[]): PaletteEntity[] {
  if (!query.trim()) return entities;
  return entities
    .map((e) => ({ e, s: fuzzyScore(query, `${e.label} ${e.sublabel ?? ''}`) }))
    .filter(({ s }) => s >= 0)
    .sort((a, b) => a.s - b.s)
    .map(({ e }) => e);
}

/**
 * Search across all entity sources. Returns partial results even if some
 * sources fail (e.g. unreachable control node).
 */
export async function searchEntities(
  query: string,
  opts: FetchOpts = {},
): Promise<PaletteEntity[]> {
  const { signal, limit = 10 } = opts;
  if (query.trim().length < 2) return [];

  const deepActions: PaletteEntity[] = [
    { kind: 'action', id: 'deploy-agent', label: 'Deploy agent to host', sublabel: 'Action · Operations', href: '/governor/operations' },
    { kind: 'action', id: 'open-terminal', label: 'Open node terminal', sublabel: 'Action · Nodes', href: '/nodes' },
    { kind: 'action', id: 'run-fleet-check', label: 'Run fleet check', sublabel: 'Action · Fleet readiness', href: '/fleet-readiness' },
    { kind: 'action', id: 'view-stale-nodes', label: 'View stale nodes', sublabel: 'Action · Readiness', href: '/fleet-readiness' },
    { kind: 'action', id: 'rotate-node-secret', label: 'Rotate node secret', sublabel: 'Action · Operations', href: '/governor/operations' },
    { kind: 'action', id: 'latest-failed-deploy', label: 'Open latest failed deploy', sublabel: 'Action · Timeline', href: '/fleet-timeline' },
  ];

  // Fire everything in parallel — each call is fail-safe (returns null).
  const [nodes, installations, skills] = await Promise.all([
    safeJson<{ success?: boolean; data?: Array<{ id: string; name: string; status?: string }> }>(
      '/api/proxy/nodes',
      signal,
    ),
    safeJson<{ data?: Array<{ id: string; hostname: string; displayName?: string | null; status?: string }> }>(
      '/api/proxy/orchestra/installations',
      signal,
    ),
    safeJson<{ data?: Array<{ id: string; name: string; description?: string | null }> }>(
      '/api/proxy/orchestra/skill-catalog',
      signal,
    ),
  ]);

  const entities: PaletteEntity[] = [];

  for (const n of nodes?.data ?? []) {
    entities.push({
      kind: 'node',
      id: n.id,
      label: n.name,
      sublabel: n.status ? `Node · ${n.status}` : 'Node',
      href: `/nodes/${n.id}`,
    });
  }
  for (const i of installations?.data ?? []) {
    entities.push({
      kind: 'installation',
      id: i.id,
      label: i.displayName ?? i.hostname,
      sublabel: `Hermes · ${i.status ?? 'unknown'}`,
      href: `/orchestra/installations`,
    });
  }
  for (const s of skills?.data ?? []) {
    entities.push({
      kind: 'skill',
      id: s.id,
      label: s.name,
      sublabel: s.description ?? 'Skill',
      href: `/skills`,
    });
  }

  return filterAndRank(query, [...deepActions, ...entities]).slice(0, limit);
}
