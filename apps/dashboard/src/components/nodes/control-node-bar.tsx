'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Server,
  Trash2,
  RefreshCw,
  Loader2,
  Download,
  RotateCcw,
  GitBranch,
  ChevronUp,
  ArrowUpCircle,
  Settings,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useControlNode } from '@/lib/control-node-context';
import { api } from '@/lib/api-client';
import { ControlNodeModal } from '@/components/control-nodes/control-node-modal';
import { proxyTargetHeaders } from '@/lib/proxy-target';

type HealthStatus = 'checking' | 'online' | 'offline';
type UpdateLoading = 'idle' | 'checking' | 'applying' | 'restarting';

interface VersionInfo {
  controlApiVersion: string;
  agentVersion: string;
}

interface UpdateStatus {
  controlApiVersion: string;
  agentVersion: string;
  repoRoot: string;
  gitBranch: string | null;
  gitCommit: string | null;
  lastChecked: string | null;
  isGitRepo: boolean;
}

interface UpdateCheckResult {
  available: boolean;
  behindBy: number;
  currentCommit: string;
  remoteCommit: string;
  error?: string;
}

export function ControlNodeBar(): React.ReactElement {
  const { activeNode, removeNode } = useControlNode();

  // Health polling
  const [healthStatus, setHealthStatus] = useState<HealthStatus>('checking');
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Version info
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);

  // Update panel
  const [updateExpanded, setUpdateExpanded] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [updateLoading, setUpdateLoading] = useState<UpdateLoading>('idle');
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEditId, setModalEditId] = useState<string | null>(null);
  const [modalCreateMode, setModalCreateMode] = useState(false);



  const pollHealth = useCallback(async (): Promise<void> => {
    try {
      // Route through Next.js proxy to avoid browser TLS rejection
      const headers = proxyTargetHeaders(activeNode.url);
      const res = await fetch('/api/proxy/health', {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      setHealthStatus(res.ok ? 'online' : 'offline');
    } catch {
      setHealthStatus('offline');
    }
  }, [activeNode.url]);

  const fetchVersion = useCallback(async (): Promise<void> => {
    try {
      const res = await api.selfUpdate.version();
      if (res.success) {
        setVersionInfo(res.data ?? null);
      }
    } catch {
      // version not available
    }
  }, []);

  // Poll health on mount and every 30s, re-fetch version on active node change
  useEffect(() => {
    setHealthStatus('checking');
    setVersionInfo(null);
    setUpdateExpanded(false);
    setUpdateCheck(null);
    setUpdateResult(null);
    setUpdateError(null);

    void pollHealth();
    void fetchVersion();

    healthPollRef.current = setInterval(() => {
      void pollHealth();
    }, 30_000);

    return () => {
      if (healthPollRef.current) {
        clearInterval(healthPollRef.current);
        healthPollRef.current = null;
      }
    };
  }, [activeNode.id, pollHealth, fetchVersion]);

  // ── Update actions ──

  const handleCheckUpdates = async (): Promise<void> => {
    setUpdateLoading('checking');
    setUpdateError(null);
    setUpdateResult(null);
    try {
      // Fetch full status first
      const statusRes = await api.selfUpdate.status();
      if (statusRes.success) setUpdateStatus(statusRes.data ?? null);

      const res = await api.selfUpdate.check();
      if (res.success) {
        setUpdateCheck(res.data ?? null);
        if (res.data!.error) {
          setUpdateError(res.data!.error);
        } else if (!res.data!.available) {
          setUpdateResult('Already up to date.');
        }
      }
    } catch (err) {
      // Try to extract the API error message from the response body
      let message = 'Failed to check for updates';
      if (err && typeof err === 'object' && 'response' in err) {
        try {
          const body = await (err as { response: Response }).response.json() as { error?: { message?: string } };
          if (body?.error?.message) message = body.error.message;
        } catch { /* ignore parse errors */ }
      } else if (err instanceof Error) {
        message = err.message;
      }
      setUpdateError(message);
    } finally {
      setUpdateLoading('idle');
    }
  };

  const handleApplyUpdate = async (restart: boolean): Promise<void> => {
    setUpdateLoading('applying');
    setUpdateError(null);
    setUpdateResult(null);
    try {
      const res = await api.selfUpdate.apply(restart);
      if (res.success) {
        const d = res.data;
        if (!d) return;
        if (d.updated) {
          setUpdateResult(
            `Updated from v${d.previousVersion} → v${d.currentVersion}` +
            (d.restart?.scheduled ? `. Restarting via ${d.restart.method}…` : '. Restart manually to apply.'),
          );
        } else {
          setUpdateResult('Code pulled but no version change detected.');
        }
        setUpdateCheck(null);
        // Refresh version + status
        void fetchVersion();
        const statusRes = await api.selfUpdate.status();
        if (statusRes.success) setUpdateStatus(statusRes.data ?? null);
      }
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setUpdateLoading('idle');
    }
  };

  const handleRestart = async (): Promise<void> => {
    setUpdateLoading('restarting');
    setUpdateError(null);
    try {
      const res = await api.selfUpdate.restart();
      if (res.success) {
        setUpdateResult(`Restart scheduled via ${res.data!.method}. Reconnecting shortly…`);
      }
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'Restart failed');
    } finally {
      setUpdateLoading('idle');
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!confirm(`Delete control node "${activeNode.name}"? You'll be switched to another node.`)) return;
    try {
      await removeNode(activeNode.id);
    } catch {
      // handle error
    }
  };

  const handleOpenEdit = (): void => {
    setModalEditId(activeNode.id);
    setModalCreateMode(false);
    setModalOpen(true);
  };

  const handleModalClose = (): void => {
    setModalOpen(false);
    setModalEditId(null);
    setModalCreateMode(false);
    // Re-poll in case settings changed
    void pollHealth();
    void fetchVersion();
  };

  const healthBadge = (): React.ReactElement => {
    switch (healthStatus) {
      case 'checking':
        return (
          <Badge variant="info">
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            Checking
          </Badge>
        );
      case 'online':
        return <Badge variant="success">Online</Badge>;
      case 'offline':
        return <Badge variant="danger">Offline</Badge>;
    }
  };

  return (
    <>
      <div className="rounded border border-border bg-surface">
        {/* ── Main row ── */}
        <div className="flex items-center justify-between px-5 py-3">
          <div className="flex items-center gap-4 min-w-0">
            <div className="flex items-center gap-2.5">
              <Server className="h-4.5 w-4.5 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {/* Active control node display (switch via sidebar) */}
                  <div className="flex items-center gap-1.5 rounded border border-border bg-bg px-2.5 py-1 text-xs font-bold min-w-0">
                    <Server className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                    <span className="truncate">{activeNode.name}</span>
                  </div>
                  <button
                    onClick={handleOpenEdit}
                    className="rounded border border-border bg-bg p-1.5 text-text-muted transition-all hover:bg-surface-hover hover:text-text hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)]"
                    title="Control Node Settings"
                  >
                    <Settings className="h-3.5 w-3.5" />
                  </button>
                  {healthBadge()}
                </div>
                <div className="text-xs text-text-muted truncate mt-0.5">
                  {activeNode.url}
                  {versionInfo && (
                    <span className="ml-2">
                      v{versionInfo.controlApiVersion}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ── Actions ── */}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              title="Check for updates"
              onClick={() => {
                if (!updateExpanded) {
                  setUpdateExpanded(true);
                  // Fetch status first; only auto-check if it's a git repo
                  void (async () => {
                    try {
                      const statusRes = await api.selfUpdate.status();
                      if (statusRes.success) {
                        setUpdateStatus(statusRes.data ?? null);
                        if (statusRes.data?.isGitRepo) {
                          void handleCheckUpdates();
                        }
                      }
                    } catch {
                      void handleCheckUpdates();
                    }
                  })();
                } else {
                  setUpdateExpanded(false);
                }
              }}
            >
              <ArrowUpCircle className="h-3.5 w-3.5 text-primary" />
              <span className="hidden sm:inline">Update</span>
            </Button>
            <Button variant="ghost" size="sm" title="Delete control node" onClick={() => void handleDelete()}>
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Refresh status"
              onClick={() => {
                setHealthStatus('checking');
                void pollHealth();
                void fetchVersion();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* ── Expandable update panel ── */}
        {updateExpanded && (
          <div className="border-t border-border px-5 py-3 space-y-3">
            {updateError && (
              <div className="rounded border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
                {updateError}
              </div>
            )}

            {updateResult && (
              <div className="rounded border border-success/30 bg-success/10 p-3 text-xs text-success">
                {updateResult}
              </div>
            )}

            {/* Status info */}
            {updateStatus && (
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-text-muted">
                <span>
                  Control API: <span className="text-text">v{updateStatus.controlApiVersion}</span>
                </span>
                <span>
                  Agent: <span className="text-text">v{updateStatus.agentVersion}</span>
                </span>
                {updateStatus.gitBranch && (
                  <span className="flex items-center gap-1">
                    <GitBranch className="h-3 w-3" />
                    <span className="text-text">{updateStatus.gitBranch}</span>
                  </span>
                )}
                {updateStatus.gitCommit && (
                  <span>
                    Commit: <span className="text-text">{updateStatus.gitCommit}</span>
                  </span>
                )}
                {updateStatus.lastChecked && (
                  <span>
                    Checked: {new Date(updateStatus.lastChecked).toLocaleString()}
                  </span>
                )}
              </div>
            )}

            {/* Non-git deployment notice */}
            {updateStatus && updateStatus.isGitRepo === false && (
              <div className="rounded border border-primary/30 bg-primary/10 p-3 text-xs text-text-muted">
                <span className="font-bold text-primary">Tarball deployment</span>
                <span className="ml-1">
                  — Git-based self-update is not available. Use Deploy from another control node to push updates.
                </span>
              </div>
            )}

            {/* Update available banner */}
            {updateCheck?.available && (
              <div className="rounded border border-warning/30 bg-warning/10 p-3 text-xs">
                <span className="font-bold text-warning uppercase tracking-wider">Update available</span>
                <span className="text-text-muted ml-1">
                  — {updateCheck.behindBy} commit{updateCheck.behindBy !== 1 ? 's' : ''} behind
                  ({updateCheck.currentCommit} → {updateCheck.remoteCommit})
                </span>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              {updateStatus?.isGitRepo !== false && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleCheckUpdates()}
                  disabled={updateLoading !== 'idle'}
                  icon={
                    updateLoading === 'checking'
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <RefreshCw className="h-3.5 w-3.5" />
                  }
                >
                  {updateLoading === 'checking' ? 'Checking…' : 'Check for Updates'}
                </Button>
              )}

              {updateCheck?.available && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleApplyUpdate(false)}
                    disabled={updateLoading !== 'idle'}
                    icon={
                      updateLoading === 'applying'
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Download className="h-3.5 w-3.5" />
                    }
                  >
                    {updateLoading === 'applying' ? 'Updating…' : 'Pull & Build'}
                  </Button>

                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleApplyUpdate(true)}
                    disabled={updateLoading !== 'idle'}
                    icon={
                      updateLoading === 'applying'
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <RotateCcw className="h-3.5 w-3.5" />
                    }
                  >
                    {updateLoading === 'applying' ? 'Updating…' : 'Pull, Build & Restart'}
                  </Button>
                </>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleRestart()}
                disabled={updateLoading !== 'idle'}
                icon={
                  updateLoading === 'restarting'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <RotateCcw className="h-3.5 w-3.5" />
                }
              >
                {updateLoading === 'restarting' ? 'Restarting…' : 'Restart Only'}
              </Button>

              <div className="ml-auto">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setUpdateExpanded(false)}
                  icon={<ChevronUp className="h-3.5 w-3.5" />}
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* CRUD Modal */}
      <ControlNodeModal
        open={modalOpen}
        onClose={handleModalClose}
        editNodeId={modalEditId}
        createMode={modalCreateMode}
      />
    </>
  );
}
