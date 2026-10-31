'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, Settings, Plus, Check } from 'lucide-react';
import { useControlNode } from '@/lib/control-node-context';
import { ControlNodeModal } from '@/components/control-nodes/control-node-modal';
import { DEFAULT_CONTROL_NODE } from '@/lib/control-nodes';
import { proxyTargetHeaders } from '@/lib/proxy-target';

type NodeHealth = 'unknown' | 'online' | 'offline';

function StatusDot({ status }: { status: NodeHealth }): React.ReactElement {
  const label = status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Checking…';
  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        status === 'online' ? 'bg-success' :
        status === 'offline' ? 'bg-danger' :
        'bg-text-muted/40 animate-pulse'
      }`}
      title={label}
    />
  );
}

export function ControlNodeSelector(): React.ReactElement {
  const { nodes, activeNode, switchNode, loading } = useControlNode();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalCreateMode, setModalCreateMode] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Per-node health status
  const [healthMap, setHealthMap] = useState<Record<string, NodeHealth>>({});
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // All selectable items: configured nodes + default local node
  // Memoize to prevent infinite re-render from checkAllHealth → setHealthMap → render → new ref
  const allNodes = useMemo(
    () => (nodes.length > 0 ? nodes : [DEFAULT_CONTROL_NODE]),
    [nodes],
  );

  const checkAllHealth = useCallback(async (): Promise<void> => {
    const results: Record<string, NodeHealth> = {};
    await Promise.allSettled(
      allNodes.map(async (node) => {
        try {
          // Route through the Next.js server-side proxy to avoid
          // browser TLS rejection of self-signed certs on remote nodes
          const headers = proxyTargetHeaders(node.url);
          const res = await fetch('/api/proxy/health', {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(6_000),
          });
          results[node.id] = res.ok ? 'online' : 'offline';
        } catch {
          results[node.id] = 'offline';
        }
      }),
    );
    setHealthMap(results);
  }, [allNodes]);

  // Initial health check on mount (populates status dot)
  useEffect(() => {
    void checkAllHealth();
  }, [checkAllHealth]);

  // Poll every 30s while dropdown is open; re-check immediately on open
  useEffect(() => {
    if (!dropdownOpen) return;
    void checkAllHealth();
    healthPollRef.current = setInterval(() => void checkAllHealth(), 30_000);
    return () => {
      if (healthPollRef.current) clearInterval(healthPollRef.current);
    };
  }, [dropdownOpen, checkAllHealth]);

  // Click-outside to close dropdown
  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClickOutside(e: MouseEvent): void {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    function handleEsc(e: KeyboardEvent): void {
      if (e.key === 'Escape') setDropdownOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [dropdownOpen]);

  function handleSelectNode(id: string): void {
    switchNode(id);
    setDropdownOpen(false);
  }

  function handleAddNode(): void {
    setDropdownOpen(false);
    setModalCreateMode(true);
    setModalOpen(true);
  }

  function handleOpenSettings(): void {
    setModalCreateMode(false);
    setModalOpen(true);
  }

  if (loading) {
    return (
      <div className="mx-3 mt-2 mb-1 rounded border border-border bg-bg px-3 py-2 text-xs text-text-muted animate-pulse">
        Loading…
      </div>
    );
  }

  return (
    <>
      <div className="relative mx-3 mt-2 mb-1" ref={dropdownRef}>
        <div className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Node Controller</div>
        <div className="flex items-center gap-1">
          {/* Dropdown trigger */}
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            aria-expanded={dropdownOpen}
            aria-haspopup="listbox"
            aria-label={`Node controller: ${activeNode.name}`}
            className="flex flex-1 items-center gap-2 rounded border border-border bg-bg px-2.5 py-1.5 text-left transition-all hover:bg-surface-hover min-w-0"
          >
            <StatusDot status={healthMap[activeNode.id] ?? 'unknown'} />
            <span className="flex-1 truncate text-xs font-medium">{activeNode.name}</span>
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform ${
                dropdownOpen ? 'rotate-180' : ''
              }`}
            />
          </button>

          {/* Settings gear */}
          <button
            onClick={handleOpenSettings}
            className="rounded border border-border bg-bg p-1.5 text-text-muted transition-all hover:bg-surface-hover hover:text-text"
            title="Control Node Settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Dropdown menu */}
        {dropdownOpen && (
          <div className="absolute left-3 right-3 z-50 mt-1 rounded border border-border bg-surface shadow-xl">
            <div role="listbox" aria-label="Control nodes" className="max-h-48 overflow-y-auto py-1">
              {allNodes.map((node) => (
                <button
                  key={node.id}
                  role="option"
                  aria-selected={node.id === activeNode.id}
                  onClick={() => handleSelectNode(node.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-all hover:bg-surface-hover"
                >
                  <StatusDot status={healthMap[node.id] ?? 'unknown'} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{node.name}</div>
                    <div className="text-text-muted truncate text-[10px]">{node.url}</div>
                  </div>
                  {node.id === activeNode.id && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  )}
                </button>
              ))}
            </div>

            {/* Add Node separator + button */}
            <div className="border-t border-border">
              <button
                onClick={handleAddNode}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-primary transition-all hover:bg-surface-hover"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="font-bold">Add Control Node</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* CRUD Modal */}
      <ControlNodeModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        createMode={modalCreateMode}
      />
    </>
  );
}
