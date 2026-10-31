'use client';

import { Server, Pencil, Trash2, Plus, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ControlNode } from '@/lib/control-nodes';

interface NodeListPanelProps {
  nodes: ControlNode[];
  activeNodeId: string;
  onEdit: (node: ControlNode) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onUpdate: () => void;
}

export function NodeListPanel({
  nodes,
  activeNodeId,
  onEdit,
  onDelete,
  onAdd,
  onUpdate,
}: NodeListPanelProps): React.ReactElement {
  return (
    <div className="space-y-3">
      {nodes.length === 0 ? (
        <div className="rounded border border-border bg-bg p-6 text-center text-[11px] text-text-muted">
          No control nodes configured. Add one to connect to a remote Control API.
        </div>
      ) : (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {nodes.map((node) => (
            <div
              key={node.id}
              className={`flex items-center justify-between rounded border px-3 py-2.5 ${
                node.id === activeNodeId
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border bg-bg'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <Server className="h-4 w-4 shrink-0 text-text-muted" />
                <div className="min-w-0">
                  <div className="text-[11px] font-bold truncate">{node.name}</div>
                  <div className="text-xs text-text-muted truncate">{node.url}</div>
                </div>
              </div>
              <div className="flex items-center gap-1 ml-2 shrink-0">
                {node.id === activeNodeId && (
                  <span className="mr-1 rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                    Active
                  </span>
                )}
                <button
                  onClick={() => onEdit(node)}
                  className="rounded-md p-1.5 text-text-muted hover:bg-surface-hover hover:text-text transition-all"
                  title="Edit"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onDelete(node.id)}
                  className="rounded-md p-1.5 text-text-muted hover:bg-danger/10 hover:text-danger transition-all"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button
        variant="secondary"
        size="md"
        onClick={onAdd}
        icon={<Plus className="h-4 w-4" />}
        className="w-full"
      >
        Add Control Node
      </Button>

      <Button
        variant="ghost"
        size="md"
        onClick={onUpdate}
        icon={<Download className="h-4 w-4" />}
        className="w-full"
      >
        Check for Updates
      </Button>
    </div>
  );
}
