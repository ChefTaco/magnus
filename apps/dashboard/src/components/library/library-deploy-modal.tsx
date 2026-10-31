'use client';

import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { Rocket, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

interface DeployResult {
  nodeId: string;
  nodeName: string;
  status: string;
  error?: string;
}

interface LibraryDeployModalProps {
  open: boolean;
  onClose: () => void;
  file: {
    id: string;
    name: string;
    mimeType: string;
  } | null;
}

export function LibraryDeployModal({
  open,
  onClose,
  file,
}: LibraryDeployModalProps): React.ReactElement {
  const [nodes, setNodes] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [results, setResults] = useState<DeployResult[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadNodes = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api.nodes.list({ status: 'ONLINE' });
      if (res.success && Array.isArray(res.data)) {
        setNodes(
          res.data.map((n: unknown) => {
            const node = n as { id: string; name: string; status: string };
            return { id: node.id, name: node.name, status: node.status };
          }),
        );
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadNodes();
      setSelectedNodeIds([]);
      setResults(null);
    }
  }, [open, loadNodes]);

  const toggleNode = (nodeId: string): void => {
    setSelectedNodeIds((prev) =>
      prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId],
    );
  };

  const selectAll = (): void => {
    setSelectedNodeIds(nodes.map((n) => n.id));
  };

  const handleDeploy = async (): Promise<void> => {
    if (!file || selectedNodeIds.length === 0) return;
    setDeploying(true);
    setResults(null);
    try {
      const res = await api.libraryDeploy.deploy({
        fileId: file.id,
        nodeIds: selectedNodeIds,
        overwrite: true,
      });
      if (res.success && Array.isArray(res.data)) {
        setResults(res.data as DeployResult[]);
      }
    } catch (err: unknown) {
      setResults([
        {
          nodeId: 'error',
          nodeName: 'Deploy Error',
          status: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error',
        },
      ]);
    } finally {
      setDeploying(false);
    }
  };

  const typeLabel =
    file?.mimeType === 'application/x-magnus-skill'
      ? 'Skill'
      : file?.mimeType === 'application/x-magnus-cronjob'
        ? 'Cron Job'
        : 'Item';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Deploy ${typeLabel}`}
      description={file?.name ?? ''}
      icon={<Rocket className="h-5 w-5 text-primary" />}
      className="max-w-lg"
    >
      <div className="space-y-4">
        {/* Node selection */}
        {!results && (
          <>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                Target Nodes
              </label>
              <button
                onClick={selectAll}
                className="text-[10px] text-primary hover:text-primary/80 uppercase tracking-wider transition-all"
              >
                Select All
              </button>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 text-xs text-text-muted py-4 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading nodes...
              </div>
            ) : nodes.length === 0 ? (
              <p className="text-xs text-text-muted py-4 text-center">
                No online nodes available
              </p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {nodes.map((node) => (
                  <label
                    key={node.id}
                    className="flex items-center gap-3 rounded border border-border/50 px-3 py-2 hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)] transition-all cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedNodeIds.includes(node.id)}
                      onChange={() => toggleNode(node.id)}
                      className="rounded border-border"
                    />
                    <span className="text-xs">{node.name}</span>
                  </label>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void handleDeploy()}
                disabled={deploying || selectedNodeIds.length === 0}
              >
                {deploying ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                    Deploying...
                  </>
                ) : (
                  <>
                    <Rocket className="h-3.5 w-3.5 mr-1.5" />
                    Deploy to {selectedNodeIds.length} node
                    {selectedNodeIds.length !== 1 ? 's' : ''}
                  </>
                )}
              </Button>
            </div>
          </>
        )}

        {/* Results */}
        {results && (
          <>
            <div className="space-y-2">
              {results.map((r, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded border border-border/50 px-3 py-2 text-xs"
                >
                  {r.status === 'success' ? (
                    <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                  ) : (
                    <XCircle className="h-4 w-4 text-danger shrink-0" />
                  )}
                  <span className="font-bold">{r.nodeName}</span>
                  {r.error && (
                    <span className="text-[10px] text-danger/70 truncate">{r.error}</span>
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-2">
              <Button variant="secondary" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
