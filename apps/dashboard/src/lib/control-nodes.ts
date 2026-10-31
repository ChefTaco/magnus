/** Control Node types — a named remote Control API endpoint. */

import { nanoid } from 'nanoid';

export interface ControlNode {
  id: string;
  name: string;
  url: string;
  hasApiSecret: boolean;
  apiSecretFingerprint: string | null;
  hasToken: boolean;
  tokenFingerprint: string | null;
  createdAt: string;
}

/** Server-only persisted representation. Credentials must never enter a DTO. */
export interface StoredControlNode {
  id: string;
  name: string;
  url: string;
  apiSecret?: string;
  token?: string;
  createdAt: string;
}

/** Browser-to-server mutation. Credential fields are write-only replacements. */
export interface ControlNodeMutation {
  name?: string;
  url?: string;
  apiSecret?: string;
  token?: string;
}

/** The default fallback node used when no nodes are configured.
 *  Credentials are intentionally absent. The server-side proxy resolves the
 *  canonical credential only for the exact CONTROL_API_URL origin.
 */
export const DEFAULT_CONTROL_NODE: ControlNode = {
  id: 'local',
  name: 'Local',
  url: '', // Resolved by the authenticated server at runtime.
  hasApiSecret: false,
  apiSecretFingerprint: null,
  hasToken: false,
  tokenFingerprint: null,
  createdAt: new Date().toISOString(),
};

/** Generate a unique ID for new control nodes. */
export function generateNodeId(): string {
  return `cn_${nanoid(16)}`;
}
