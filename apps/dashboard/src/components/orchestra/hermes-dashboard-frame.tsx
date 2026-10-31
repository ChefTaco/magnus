'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, MonitorDot, Play, Power, RefreshCcw, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Badge, statusVariant } from '@/components/ui/badge';
import type { HermesInstallation } from '@/types/orchestra';

export type HermesDashboardAction = 'install' | 'start' | 'stop' | 'restart' | 'status' | 'launch';

interface HermesDashboardFrameProps {
  installation: HermesInstallation | null;
  frameSrc: string;
  frameTitle: string;
  heightClass?: string;
  emptyMessage?: string;
}

function installLabel(installation: HermesInstallation): string {
  return installation.displayName ?? installation.hostname;
}

export function HermesDashboardFrame({
  installation,
  frameSrc,
  frameTitle,
  heightClass = 'h-[720px]',
  emptyMessage = 'Select a Hermes installation with dashboard access.',
}: HermesDashboardFrameProps): React.ReactElement {
  const [connected, setConnected] = useState(false);
  const [frameNonce, setFrameNonce] = useState(0);
  const [busyAction, setBusyAction] = useState<HermesDashboardAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConnected(false);
    setFrameNonce(0);
    setMessage(null);
    setError(null);
  }, [installation?.id, frameSrc]);

  const canConnect = Boolean(installation && frameSrc);
  const src = frameSrc
    ? `${frameSrc}${frameSrc.includes('?') ? '&' : '?'}frame=${frameNonce}`
    : '';

  async function runAction(action: HermesDashboardAction, connectAfter = false): Promise<void> {
    if (!installation) return;
    setBusyAction(action);
    setError(null);
    setMessage(null);
    try {
      const response = await api.hermes.dashboardAction(installation.id, action);
      const jobId = response.data?.id ? ` Job ${response.data.id.slice(0, 8)} queued.` : '';
      setMessage(`${action === 'launch' ? 'Launch' : action} requested for ${installLabel(installation)}.${jobId}`);
      if (connectAfter) {
        window.setTimeout(() => {
          setFrameNonce((current) => current + 1);
          setConnected(true);
        }, 2500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} Hermes Dashboard`);
    } finally {
      setBusyAction(null);
    }
  }

  function connectFrame(): void {
    if (!canConnect) return;
    setFrameNonce((current) => current + 1);
    setConnected(true);
    setError(null);
  }

  if (!installation) {
    return (
      <div className="rounded border border-border/50 bg-bg/40 p-8 text-center text-xs text-text-muted">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-border/50 bg-bg/50 p-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-text">{installLabel(installation)}</span>
            <Badge variant={statusVariant(installation.dashboardStatus)}>dashboard {installation.dashboardStatus}</Badge>
            <span className="rounded border border-border px-2 py-1 font-mono text-[10px] text-text-muted">
              127.0.0.1:{installation.dashboardPort}
            </span>
          </div>
          <p className="mt-1 truncate text-[11px] text-text-muted">{installation.hostname}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void runAction('launch', true)}
            disabled={busyAction !== null}
            className="inline-flex h-8 items-center justify-center gap-2 rounded border border-primary/60 bg-primary/10 px-3 text-[11px] font-bold uppercase tracking-wider text-primary transition-all hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            Launch
          </button>
          <button
            type="button"
            onClick={() => void runAction('start')}
            disabled={busyAction !== null}
            className="inline-flex h-8 items-center justify-center gap-2 rounded border border-border bg-surface px-3 text-[11px] font-bold uppercase tracking-wider text-text-muted transition-all hover:border-success/50 hover:text-success disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Power className="h-3.5 w-3.5" />
            Start
          </button>
          <button
            type="button"
            onClick={() => void runAction('restart', true)}
            disabled={busyAction !== null}
            className="inline-flex h-8 items-center justify-center gap-2 rounded border border-border bg-surface px-3 text-[11px] font-bold uppercase tracking-wider text-text-muted transition-all hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restart
          </button>
          <button
            type="button"
            onClick={connectFrame}
            disabled={!canConnect || busyAction !== null}
            className="inline-flex h-8 items-center justify-center gap-2 rounded border border-border bg-surface px-3 text-[11px] font-bold uppercase tracking-wider text-text-muted transition-all hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <MonitorDot className="h-3.5 w-3.5" />
            Connect Frame
          </button>
          {frameSrc && (
            <a
              href={frameSrc}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center justify-center gap-2 rounded border border-border bg-surface px-3 text-[11px] font-bold uppercase tracking-wider text-text-muted transition-all hover:border-accent/50 hover:text-accent"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </a>
          )}
        </div>
      </div>

      {(message || error || busyAction) && (
        <div className={`rounded border px-3 py-2 text-[11px] ${error ? 'border-danger/40 bg-danger/10 text-danger' : 'border-primary/30 bg-primary/10 text-primary'}`}>
          {error ?? (busyAction ? `${busyAction} requested...` : message)}
        </div>
      )}

      {connected && src ? (
        <div className="overflow-hidden rounded border border-border/50 bg-bg">
          <iframe
            title={frameTitle}
            src={src}
            className={`${heightClass} w-full bg-bg`}
            sandbox="allow-forms allow-same-origin allow-scripts allow-popups allow-downloads"
          />
        </div>
      ) : (
        <div className="flex min-h-72 flex-col items-center justify-center rounded border border-border/50 bg-bg/40 p-8 text-center">
          <MonitorDot className="mb-3 h-6 w-6 text-primary" />
          <p className="text-xs font-bold uppercase tracking-wider text-text">Dashboard frame is idle</p>
          <p className="mt-2 max-w-xl text-[11px] leading-5 text-text-muted">
            Launch or start the Hermes Dashboard on the selected agent, then connect the Magnus frame once the remote service is up.
          </p>
          <button
            type="button"
            onClick={() => void runAction('launch', true)}
            disabled={busyAction !== null}
            className="mt-4 inline-flex h-8 items-center justify-center gap-2 rounded border border-primary/60 bg-primary/10 px-3 text-[11px] font-bold uppercase tracking-wider text-primary transition-all hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction ? <RefreshCcw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Launch And Connect
          </button>
        </div>
      )}
    </div>
  );
}
