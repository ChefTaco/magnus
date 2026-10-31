'use client';

import { Loader2, RefreshCw, Download, RotateCcw, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UpdateStatus {
  controlApiVersion: string;
  agentVersion: string;
  repoRoot: string;
  gitBranch: string | null;
  gitCommit: string | null;
  lastChecked: string | null;
  isGitRepo: boolean;
}

interface UpdateCheck {
  available: boolean;
  behindBy: number;
  currentCommit: string;
  remoteCommit: string;
  error?: string;
}

export type UpdateLoading = 'idle' | 'checking' | 'applying' | 'restarting';

interface UpdatePanelProps {
  activeNodeName: string;
  updateStatus: UpdateStatus | null;
  updateCheck: UpdateCheck | null;
  updateLoading: UpdateLoading;
  updateResult: string | null;
  onCheckUpdates: () => void;
  onApplyUpdate: (restart: boolean) => void;
  onRestart: () => void;
  onBack: () => void;
}

export function UpdatePanel({
  updateStatus,
  updateCheck,
  updateLoading,
  updateResult,
  onCheckUpdates,
  onApplyUpdate,
  onRestart,
  onBack,
}: UpdatePanelProps): React.ReactElement {
  return (
    <div className="space-y-4">
      {/* Current status */}
      {updateStatus && (
        <div className="rounded border border-border bg-bg p-3 space-y-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">Control API</span>
            <span className="text-xs">v{updateStatus.controlApiVersion}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-text-muted">Agent Version</span>
            <span className="text-xs">v{updateStatus.agentVersion}</span>
          </div>
          {updateStatus.gitBranch && (
            <div className="flex items-center justify-between">
              <span className="text-text-muted flex items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5" /> Branch
              </span>
              <span className="text-xs">{updateStatus.gitBranch}</span>
            </div>
          )}
          {updateStatus.gitCommit && (
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Commit</span>
              <span className="text-xs">{updateStatus.gitCommit}</span>
            </div>
          )}
          {updateStatus.lastChecked && (
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Last Checked</span>
              <span className="text-xs">
                {new Date(updateStatus.lastChecked).toLocaleString()}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Tarball notice */}
      {updateStatus && updateStatus.isGitRepo === false && (
        <div className="rounded border border-primary/30 bg-primary/10 px-3 py-2 text-[11px] text-text-muted">
          <span className="font-bold text-primary">Tarball deployment</span>
          <span className="ml-1">
            — Git-based self-update is not available. Use <strong>Deploy</strong> from another
            control node to push updates.
          </span>
        </div>
      )}

      {/* Update available */}
      {updateCheck && updateCheck.available && (
        <div className="rounded border border-warning/30 bg-warning/10 px-3 py-2 text-[11px]">
          <span className="font-bold text-warning">Update available</span>
          <span className="text-text-muted ml-1">
            — {updateCheck.behindBy} commit{updateCheck.behindBy !== 1 ? 's' : ''} behind (
            {updateCheck.currentCommit} → {updateCheck.remoteCommit})
          </span>
        </div>
      )}

      {/* Success result */}
      {updateResult && (
        <div className="rounded border border-success/30 bg-success/10 px-3 py-2 text-[11px] text-success">
          {updateResult}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        {updateStatus?.isGitRepo !== false && (
          <Button
            variant="secondary"
            size="md"
            onClick={onCheckUpdates}
            disabled={updateLoading !== 'idle'}
            icon={
              updateLoading === 'checking' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )
            }
          >
            {updateLoading === 'checking' ? 'Checking…' : 'Check for Updates'}
          </Button>
        )}

        {updateCheck?.available && (
          <>
            <Button
              variant="primary"
              size="md"
              onClick={() => onApplyUpdate(false)}
              disabled={updateLoading !== 'idle'}
              icon={
                updateLoading === 'applying' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )
              }
            >
              {updateLoading === 'applying' ? 'Updating…' : 'Pull & Build'}
            </Button>

            <Button
              variant="primary"
              size="md"
              onClick={() => onApplyUpdate(true)}
              disabled={updateLoading !== 'idle'}
              icon={
                updateLoading === 'applying' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )
              }
            >
              {updateLoading === 'applying' ? 'Updating…' : 'Pull, Build & Restart'}
            </Button>
          </>
        )}

        <Button
          variant="ghost"
          size="md"
          onClick={onRestart}
          disabled={updateLoading !== 'idle'}
          icon={
            updateLoading === 'restarting' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4" />
            )
          }
        >
          {updateLoading === 'restarting' ? 'Restarting…' : 'Restart Only'}
        </Button>
      </div>

      <div className="flex justify-start pt-2 border-t border-border">
        <Button variant="ghost" size="md" onClick={onBack}>
          ← Back to list
        </Button>
      </div>
    </div>
  );
}
