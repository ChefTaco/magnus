import type { ControlNode } from './control-nodes';

/**
 * The browser copy of the active node only has to configure the first render's
 * API URL. Credential fingerprints stay out of browser storage: the UI gets them
 * from the server's response.
 */
export type CachedControlNode = Pick<ControlNode, 'id' | 'name' | 'url' | 'hasApiSecret' | 'hasToken' | 'createdAt'>;

export function cachedControlNode(node: ControlNode): CachedControlNode {
  return { id: node.id, name: node.name, url: node.url, hasApiSecret: node.hasApiSecret, hasToken: node.hasToken, createdAt: node.createdAt };
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
  return { id: parsed.id, name: parsed.name, url: parsed.url, hasApiSecret: parsed.hasApiSecret === true, hasToken: parsed.hasToken === true, createdAt: parsed.createdAt };
}

export function nodeFromCache(cached: CachedControlNode): ControlNode {
  return { ...cached, apiSecretFingerprint: null, tokenFingerprint: null };
}
