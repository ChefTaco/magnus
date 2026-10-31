'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Globe2, MonitorDot, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Card } from '@/components/ui/card';
import { Badge, statusVariant } from '@/components/ui/badge';
import { FormField, selectClass } from '@/components/ui/modal';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import { HermesDashboardFrame } from '@/components/orchestra/hermes-dashboard-frame';
import type { HermesInstallation } from '@/types/orchestra';

function installLabel(installation: HermesInstallation): string {
  return installation.displayName ?? installation.hostname;
}

function installationPriority(installation: HermesInstallation): number {
  if (installation.status === 'running' && installation.dashboardStatus === 'running') return 0;
  if (installation.dashboardStatus === 'running') return 1;
  if (installation.status === 'running' || installation.status === 'detected') return 2;
  return 3;
}

function dashboardRoot(installationId: string): string {
  return `/api/hermes/dashboard?installationId=${encodeURIComponent(installationId)}`;
}

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'never';
}

export default function OrchestraWebGatewayPage(): React.ReactElement {
  const [installations, setInstallations] = useState<HermesInstallation[]>([]);
  const [selectedInstallationId, setSelectedInstallationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const response = await api.hermes.installations();
        const nextInstallations = response.data ?? [];
        if (!mounted) return;
        setInstallations(nextInstallations);
        const requestedInstallationId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('installationId') : null;
        const preferred = nextInstallations.find((item) => item.id === requestedInstallationId)
          ?? nextInstallations.find((item) => item.dashboardStatus === 'running')
          ?? nextInstallations[0];
        if (preferred) setSelectedInstallationId((current) => current || preferred.id);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : 'Failed to load Hermes installations');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const selectedInstallation = useMemo(
    () => installations.find((installation) => installation.id === selectedInstallationId) ?? null,
    [installations, selectedInstallationId],
  );

  const orderedInstallations = useMemo(
    () => [...installations].sort((a, b) => installationPriority(a) - installationPriority(b) || installLabel(a).localeCompare(installLabel(b))),
    [installations],
  );

  const frameSrc = selectedInstallationId ? dashboardRoot(selectedInstallationId) : '';
  const runningDashboards = installations.filter((installation) => installation.dashboardStatus === 'running').length;

  return (
    <PageTransition className="space-y-6">
      <PageItem>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-wider text-primary">Web Gateway</h1>
            <p className="mt-1 text-[11px] uppercase tracking-wider text-text-muted">
              Redirect the selected Hermes Agent dashboard gateway through the Magnus UI frame.
            </p>
          </div>
          <a
            href="https://hermes-agent.nousresearch.com/docs/user-guide/features/dashboard"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center justify-center gap-2 rounded border border-border bg-surface px-3 text-[11px] font-bold uppercase tracking-wider text-text-muted transition-all hover:border-accent/50 hover:text-accent"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
            Docs
          </a>
        </div>
      </PageItem>

      {error && (
        <PageItem>
          <Card>
            <div className="flex items-center gap-3 text-sm text-danger"><ShieldAlert className="h-4 w-4" />{error}</div>
          </Card>
        </PageItem>
      )}

      <PageItem>
        <div className="grid gap-3 md:grid-cols-4">
          <Card title="Installations"><div className="text-2xl font-bold text-text">{loading ? '-' : installations.length}</div></Card>
          <Card title="Dashboards"><div className="text-2xl font-bold text-success">{runningDashboards}</div></Card>
          <Card title="Selected"><div className="truncate text-2xl font-bold text-text">{selectedInstallation ? installLabel(selectedInstallation) : '-'}</div></Card>
          <Card title="Port"><div className="font-mono text-2xl font-bold text-text">{selectedInstallation?.dashboardPort ?? '-'}</div></Card>
        </div>
      </PageItem>

      <PageItem>
        <Card title="Gateway Target" description="Select the Hermes installation whose web dashboard should be started and framed.">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(240px,0.7fr)]">
            <FormField label="Installation">
              <select aria-label="Installation" className={selectClass} value={selectedInstallationId} onChange={(event) => setSelectedInstallationId(event.target.value)}>
                {orderedInstallations.map((installation) => (
                  <option key={installation.id} value={installation.id}>{installLabel(installation)} ({installation.hostname}) · dashboard {installation.dashboardStatus} · {installation.status}</option>
                ))}
              </select>
            </FormField>
            <div className="flex flex-wrap items-end gap-2 pb-0.5 text-[11px] text-text-muted">
              {selectedInstallation && (
                <>
                  <Badge variant={statusVariant(selectedInstallation.dashboardStatus)}>dashboard {selectedInstallation.dashboardStatus}</Badge>
                  <Badge variant={statusVariant(selectedInstallation.gatewayStatus)}>gateway {selectedInstallation.gatewayStatus}</Badge>
                  <span className="rounded border border-border px-2 py-1 font-mono">127.0.0.1:{selectedInstallation.dashboardPort}</span>
                </>
              )}
            </div>
          </div>
          {selectedInstallation && (
            <div className="mt-3 grid gap-2 text-[11px] text-text-muted md:grid-cols-3">
              <div className="rounded border border-border/50 bg-bg/50 p-3"><span className="block uppercase tracking-wider text-text-muted/70">Host</span><span className="font-mono text-text">{selectedInstallation.hostname}</span></div>
              <div className="rounded border border-border/50 bg-bg/50 p-3"><span className="block uppercase tracking-wider text-text-muted/70">Home</span><span className="font-mono text-text">{selectedInstallation.hermesHome}</span></div>
              <div className="rounded border border-border/50 bg-bg/50 p-3"><span className="block uppercase tracking-wider text-text-muted/70">Synced</span><span className="text-text">{fmtDate(selectedInstallation.lastSyncedAt)}</span></div>
            </div>
          )}
        </Card>
      </PageItem>

      <PageItem>
        <Card title="Hermes Web Gateway" description="Launch the remote dashboard process and connect the full Hermes gateway into Magnus when it is ready.">
          <HermesDashboardFrame
            installation={selectedInstallation}
            frameSrc={frameSrc}
            frameTitle="Hermes Web Gateway"
            heightClass="h-[780px]"
            emptyMessage="Select a Hermes installation to open the web gateway."
          />
        </Card>
      </PageItem>

      <PageItem>
        <Card title="Connection Model" description="Magnus proxies the selected remote dashboard over SSH and allows same-origin framing for this route.">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded border border-border/50 bg-bg/50 p-3">
              <Globe2 className="mb-2 h-4 w-4 text-primary" />
              <p className="text-xs font-bold uppercase tracking-wider text-text">Whole gateway</p>
              <p className="mt-1 text-[11px] leading-5 text-text-muted">The root Hermes dashboard is framed, so native dashboard navigation stays inside Magnus.</p>
            </div>
            <div className="rounded border border-border/50 bg-bg/50 p-3">
              <MonitorDot className="mb-2 h-4 w-4 text-primary" />
              <p className="text-xs font-bold uppercase tracking-wider text-text">Remote launch</p>
              <p className="mt-1 text-[11px] leading-5 text-text-muted">The launch action starts the dashboard command on the target Hermes host before connecting the frame.</p>
            </div>
            <div className="rounded border border-border/50 bg-bg/50 p-3">
              <ShieldAlert className="mb-2 h-4 w-4 text-primary" />
              <p className="text-xs font-bold uppercase tracking-wider text-text">Frame headers</p>
              <p className="mt-1 text-[11px] leading-5 text-text-muted">Only the Hermes dashboard proxy path permits same-origin iframe embedding.</p>
            </div>
          </div>
        </Card>
      </PageItem>
    </PageTransition>
  );
}
