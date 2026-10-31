'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ControlNode, ControlNodeMutation } from './control-nodes';
import { DEFAULT_CONTROL_NODE } from './control-nodes';
import { api } from './api-client';

interface ControlNodeContextValue {
  /** All configured control nodes. */
  nodes: ControlNode[];
  /** The currently active node (always defined — falls back to default). */
  activeNode: ControlNode;
  /** Whether the initial load from the server is still in progress. */
  loading: boolean;
  /** Switch to a different control node by ID. */
  switchNode: (id: string) => void;
  /** Add a new control node. Returns the created node. */
  addNode: (data: ControlNodeMutation) => Promise<ControlNode>;
  /** Update an existing control node. */
  updateNode: (id: string, data: ControlNodeMutation) => Promise<ControlNode>;
  /** Remove a control node. */
  removeNode: (id: string) => Promise<void>;
  /** Re-fetch the node list from the server. */
  refreshNodes: () => Promise<void>;
}

const ControlNodeContext = createContext<ControlNodeContextValue | null>(null);

const ACTIVE_NODE_KEY = 'magnus_active_control_node';
/** Caches the full active ControlNode so first-render API config uses the right URL. */
const ACTIVE_NODE_CACHE_KEY = 'magnus_active_control_node_cache';

function getCachedActiveNode(): ControlNode | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(ACTIVE_NODE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ControlNode> & { apiSecret?: unknown; token?: unknown };
    if (
      typeof parsed.id !== 'string'
      || typeof parsed.name !== 'string'
      || typeof parsed.url !== 'string'
      || typeof parsed.createdAt !== 'string'
    ) return null;
    const sanitized: ControlNode = {
      id: parsed.id,
      name: parsed.name,
      url: parsed.url,
      hasApiSecret: parsed.hasApiSecret === true,
      apiSecretFingerprint: typeof parsed.apiSecretFingerprint === 'string' ? parsed.apiSecretFingerprint : null,
      hasToken: parsed.hasToken === true,
      tokenFingerprint: typeof parsed.tokenFingerprint === 'string' ? parsed.tokenFingerprint : null,
      createdAt: parsed.createdAt,
    };
    // Rewrite legacy caches immediately so historical plaintext fields do not
    // remain recoverable from browser storage.
    localStorage.setItem(ACTIVE_NODE_CACHE_KEY, JSON.stringify(sanitized));
    return sanitized;
  } catch {
    return null;
  }
}

function setCachedActiveNode(node: ControlNode): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ACTIVE_NODE_CACHE_KEY, JSON.stringify(node));
  } catch {
    // ignore quota errors
  }
}

export function ControlNodeProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [nodes, setNodes] = useState<ControlNode[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem(ACTIVE_NODE_KEY) ?? 'local';
    }
    return 'local';
  });
  const [loading, setLoading] = useState(true);

  const fetchNodes = useCallback(async () => {
    try {
      const res = await fetch('/api/control-nodes');
      const json = (await res.json()) as { success: boolean; data: ControlNode[] };
      if (json.success) {
        if (json.data.length === 0) {
          // No nodes configured — auto-create the local fallback node
          const createRes = await fetch('/api/control-nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: DEFAULT_CONTROL_NODE.name,
              url: DEFAULT_CONTROL_NODE.url,
            }),
          });
          const createJson = (await createRes.json()) as { success: boolean; data: ControlNode };
          if (createJson.success) {
            setNodes([createJson.data]);
            setActiveNodeId(createJson.data.id);
            if (typeof window !== 'undefined') {
              localStorage.setItem(ACTIVE_NODE_KEY, createJson.data.id);
            }
          }
        } else {
          setNodes(json.data);
        }
      }
    } catch {
      // If fetch fails, we'll use defaults
    } finally {
      setLoading(false);
    }
  }, []);

  // Load nodes on mount
  useEffect(() => {
    // Retire the old browser bearer cache. Control-node credentials are now
    // resolved from protected server state only.
    localStorage.removeItem('magnus_token');
    void fetchNodes();
  }, [fetchNodes]);

  // Determine the active node.
  // During the initial render nodes is [] (fetch in flight), so fall back to the
  // cached node persisted on last switchNode — this ensures api.reconfigure() below
  // uses the correct URL before any child effects fire their data fetches.
  const activeNode = useMemo(() => {
    const found = nodes.find((n) => n.id === activeNodeId);
    if (found) return found;
    const cached = getCachedActiveNode();
    if (cached && cached.id === activeNodeId) return cached;
    return DEFAULT_CONTROL_NODE;
  }, [nodes, activeNodeId]);

  // Keep the cache in sync whenever the resolved active node changes
  // (covers the first load after fetchNodes completes).
  const lastCachedNodeIdRef = useRef<string | null>(null);
  if (activeNode.id !== 'local' && lastCachedNodeIdRef.current !== activeNode.id) {
    setCachedActiveNode(activeNode);
    lastCachedNodeIdRef.current = activeNode.id;
  }

  // Sync the cookie for server components (fleetFetch) on every render where
  // the active node changes. This ensures the cookie is set even on first load.
  const lastCookieNodeIdRef = useRef<string | null>(null);
  if (typeof window !== 'undefined' && lastCookieNodeIdRef.current !== activeNode.id) {
    document.cookie = `magnus_active_node_id=${encodeURIComponent(activeNode.id)}; path=/; max-age=31536000; samesite=lax`;
    lastCookieNodeIdRef.current = activeNode.id;
  }

  // ── Synchronous API reconfiguration ──────────────────────────────────────
  // CRITICAL: This MUST happen during render (not in useEffect) so that
  // child component effects see the correct API client configuration.
  // React runs effects bottom-up (children first, parent last), so a
  // useEffect here would fire AFTER child effects that try to fetch data.
  const lastConfiguredNodeIdRef = useRef<string | null>(null);
  if (lastConfiguredNodeIdRef.current !== activeNode.id) {
    api.reconfigure(activeNode.id === 'local' ? '' : activeNode.url);
    lastConfiguredNodeIdRef.current = activeNode.id;
  }

  const switchNode = useCallback((id: string) => {
    setActiveNodeId(id);
    if (typeof window !== 'undefined') {
      localStorage.setItem(ACTIVE_NODE_KEY, id);
      // Set a cookie so server components (fleetFetch) know the active node.
      document.cookie = `magnus_active_node_id=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
      // Persist the full node so the next page load configures the right API URL
      // before fetchNodes completes.
      const node = nodes.find((n) => n.id === id);
      if (node) setCachedActiveNode(node);
    }
  }, [nodes]);

  const addNode = useCallback(
    async (data: ControlNodeMutation): Promise<ControlNode> => {
      const res = await fetch('/api/control-nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = (await res.json()) as { success: boolean; data: ControlNode; error?: string };
      if (!json.success) throw new Error(json.error ?? 'Failed to add node');
      setNodes((prev) => [...prev, json.data]);
      return json.data;
    },
    [],
  );

  const updateNode = useCallback(
    async (id: string, data: ControlNodeMutation): Promise<ControlNode> => {
      const res = await fetch(`/api/control-nodes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = (await res.json()) as { success: boolean; data: ControlNode; error?: string };
      if (!json.success) throw new Error(json.error ?? 'Failed to update node');
      setNodes((prev) => prev.map((n) => (n.id === id ? json.data : n)));
      return json.data;
    },
    [],
  );

  const removeNode = useCallback(
    async (id: string): Promise<void> => {
      const res = await fetch(`/api/control-nodes/${id}`, { method: 'DELETE' });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? 'Failed to delete node');
      setNodes((prev) => prev.filter((n) => n.id !== id));
      // If we deleted the active node, fall back to default
      setActiveNodeId((current) => (current === id ? 'local' : current));
    },
    [],
  );

  const refreshNodes = useCallback(async () => {
    await fetchNodes();
  }, [fetchNodes]);

  const value = useMemo<ControlNodeContextValue>(
    () => ({
      nodes,
      activeNode,
      loading,
      switchNode,
      addNode,
      updateNode,
      removeNode,
      refreshNodes,
    }),
    [nodes, activeNode, loading, switchNode, addNode, updateNode, removeNode, refreshNodes],
  );

  return (
    <ControlNodeContext.Provider value={value}>
      {children}
    </ControlNodeContext.Provider>
  );
}

/** Hook to access the Control Node context. */
export function useControlNode(): ControlNodeContextValue {
  const ctx = useContext(ControlNodeContext);
  if (!ctx) {
    throw new Error('useControlNode must be used within <ControlNodeProvider>');
  }
  return ctx;
}
