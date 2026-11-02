import type { ControlNode } from './control-nodes';

/**
 * The browser copy of the active node only has to configure the first render's
 * API URL. Anything about credentials stays out of browser storage (fingerprints
 * and whether a credential exists): the UI gets those from the server's response.
 */
export type CachedControlNode = Pick<ControlNode, 'id' | 'name' | 'url' | 'createdAt'>;

export function cachedControlNode(node: ControlNode): CachedControlNode {
  return { id: node.id, name: node.name, url: node.url, createdAt: node.createdAt };
}

/** Parses a stored copy, including older ones holding plaintext credentials or fingerprints. */
export function parseCachedControlNode(raw: string): CachedControlNode | null {
  const parsed = JSON.parse(raw) as Partial<ControlNode>;
  if (
    typeof parsed.id !== 'string'
    || typeof parsed.name !== 'string'
    || typeof parsed.url !== 'string'
    || typeof parsed.createdAt !== 'string'
  ) return null;
  return { id: parsed.id, name: parsed.name, url: parsed.url, createdAt: parsed.createdAt };
}

export function nodeFromCache(cached: CachedControlNode): ControlNode {
  return { ...cached, hasApiSecret: false, apiSecretFingerprint: null, hasToken: false, tokenFingerprint: null };
}
