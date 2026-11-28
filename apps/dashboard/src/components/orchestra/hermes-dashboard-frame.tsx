'use client';

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, MonitorDot, Play, Power, RefreshCcw, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api-client';
import { frameMintUrl, installFrameGrantRelay } from '@/lib/frame-grant-relay';
import { Badge, statusVariant } from '@/components/ui/badge';
import type { HermesInstallation } from '@/types/orchestra';

/**
 * The dashboard runs in an opaque origin (no `allow-same-origin`), so its script has no console
 * authority. Matches `EMBED_IFRAME_SANDBOX` in `runtime-embed-isolation.mjs`; the proxy also
 * sends a `sandbox` policy, which applies when the dashboard is opened in its own tab.
 */
export const HERMES_FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';

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
  // The frame URL carries a short-lived grant; the relay renews it while the frame is open.
  const [frame, setFrame] = useState<{ url: string; grant: string } | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [busyAction, setBusyAction] = useState<HermesDashboardAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFrame(null);
    setMessage(null);
    setError(null);
  }, [installation?.id, frameSrc]);

  useEffect(() => {
    if (!frame || !frameRef.current || !frameSrc) return undefined;
    return installFrameGrantRelay(frameRef.current, frameMintUrl(frameSrc), frame.grant);
  }, [frame, frameSrc]);

  const canConnect = Boolean(installation && frameSrc);

  async function connectFrame(): Promise<void> {
    if (!canConnect) return;
    setError(null);
    try {
      const response = await fetch(frameMintUrl(frameSrc), { credentials: 'same-origin', cache: 'no-store' });
      const body = await response.json().catch(() => null) as { grant?: string; frameUrl?: string; error?: string } | null;
      if (!response.ok || !body?.grant || !body.frameUrl) throw new Error(body?.error ?? `Dashboard frame unavailable (${response.status})`);
      setFrame({ url: body.frameUrl, grant: body.grant });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dashboard frame unavailable');
    }
  }

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
        window.setTimeout(() => void connectFrame(), 2500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} Hermes Dashboard`);
    } finally {
      setBusyAction(null);
    }
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
            onClick={() => void connectFrame()}
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

      {frame ? (
        <div className="overflow-hidden rounded border border-border/50 bg-bg">
          <iframe
            ref={frameRef}
            title={frameTitle}
            src={frame.url}
            className={`${heightClass} w-full bg-bg`}
            sandbox={HERMES_FRAME_SANDBOX}
            referrerPolicy="no-referrer"
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
