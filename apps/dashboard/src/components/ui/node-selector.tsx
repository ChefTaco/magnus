'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { Server } from 'lucide-react';

interface NodeOption {
  id: string;
  name: string;
  hostname: string;
  status: string;
}

interface NodeSelectorProps {
  /** Current value — single ID or array of IDs (multi-select). */
  value: string | string[];
  /** Called when the selection changes. */
  onChange: (value: string | string[]) => void;
  /** Allow selecting multiple nodes. */
  multi?: boolean;
  /** Show an "All Nodes" option (only in multi mode). */
  showAll?: boolean;
  /** Label shown above the dropdown. */
  label?: string;
  /** Placeholder text. */
  placeholder?: string;
  /** Additional CSS class. */
  className?: string;
  /** Disable the selector. */
  disabled?: boolean;
}

/**
 * Dropdown node selector that fetches the ONLINE node list from the API.
 * Supports single or multi select with an optional "All Nodes" shortcut.
 */
export function NodeSelector({
  value,
  onChange,
  multi = false,
  showAll = false,
  label = 'Node',
  placeholder = 'Select a node…',
  className = '',
  disabled = false,
}: NodeSelectorProps): React.ReactElement {
  const [nodes, setNodes] = useState<NodeOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const res = await api.nodes.list({ pageSize: 100 });
        const data = (res.data ?? []) as NodeOption[];
        setNodes(data);
      } catch {
        // silently fail
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  // ── Multi-select mode (checkboxes) ──
  if (multi) {
    const selected = Array.isArray(value) ? value : value ? [value] : [];
    const allSelected = selected.length === nodes.length && nodes.length > 0;
    const onlineNodes = nodes.filter((n) => n.status === 'ONLINE');

    const toggle = (id: string): void => {
      const next = selected.includes(id)
        ? selected.filter((s) => s !== id)
        : [...selected, id];
      onChange(next);
    };

    const toggleAll = (): void => {
      if (allSelected) {
        onChange([]);
      } else {
        onChange(onlineNodes.map((n) => n.id));
      }
    };

    return (
      <div className={className}>
        {label && (
          <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-text-muted">{label}</label>
        )}
        <div className="max-h-48 overflow-y-auto rounded border border-border bg-bg p-2 space-y-1">
          {loading ? (
            <p className="px-2 py-1 text-xs text-text-muted">Loading nodes…</p>
          ) : nodes.length === 0 ? (
            <p className="px-2 py-1 text-xs text-text-muted">No nodes found</p>
          ) : (
            <>
              {showAll && onlineNodes.length > 0 && (
                <label className="flex items-center gap-2 rounded px-2 py-1.5 hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)] hover:bg-surface-hover cursor-pointer border-b border-border mb-1 pb-2 transition-all">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={disabled}
                    className="accent-primary"
                  />
                  <Server className="h-3.5 w-3.5 text-primary" />
                  <span className="text-xs font-bold">All Nodes</span>
                  <span className="ml-auto text-[11px] text-text-muted">{onlineNodes.length} online</span>
                </label>
              )}
              {nodes.map((node) => (
                <label
                  key={node.id}
                  className="flex items-center gap-2 rounded px-2 py-1.5 hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)] hover:bg-surface-hover cursor-pointer transition-all"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(node.id)}
                    onChange={() => toggle(node.id)}
                    disabled={disabled || node.status !== 'ONLINE'}
                    className="accent-primary"
                  />
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      node.status === 'ONLINE'
                        ? 'bg-success'
                        : node.status === 'DEGRADED'
                          ? 'bg-warning'
                          : 'bg-text-muted'
                    }`}
                  />
                  <span className={`text-xs ${node.status !== 'ONLINE' ? 'text-text-muted' : ''}`}>
                    {node.name}
                  </span>
                  <span className="ml-auto text-[11px] text-text-muted">{node.hostname}</span>
                </label>
              ))}
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Single-select mode (dropdown) ──
  const singleValue = Array.isArray(value) ? value[0] ?? '' : value;

  return (
    <div className={className}>
      {label && (
        <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-text-muted">{label}</label>
      )}
      <select
        value={singleValue}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || loading}
        className="w-full rounded border border-border bg-bg px-3 py-2 text-xs outline-none focus:border-primary focus:shadow-[0_0_8px_var(--color-glow)] hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)] transition-all"
      >
        <option value="">{loading ? 'Loading nodes…' : placeholder}</option>
        {nodes.map((node) => (
          <option key={node.id} value={node.id} disabled={node.status !== 'ONLINE'}>
            {node.name} — {node.hostname} ({node.status})
          </option>
        ))}
      </select>
    </div>
  );
}
