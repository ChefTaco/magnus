'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, Bot, Database, Globe2, MonitorDot, Server, Users } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Card, StatCard } from '@/components/ui/card';
import { Badge, statusVariant } from '@/components/ui/badge';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import type { HermesInstallation, HermesProfile } from '@/types/orchestra';

function fmtDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'never';
}

function dashboardAddress(installation: HermesInstallation): string {
  return `127.0.0.1:${installation.dashboardPort} on ${installation.hostname}`;
}

function installLabel(installation: HermesInstallation): string {
  return installation.displayName ?? installation.hostname;
}

function isDetected(installation: HermesInstallation): boolean {
  return installation.status !== 'not_installed';
}

function QuickAction({ label, detail, href, icon }: { label: string; detail: string; href: string; icon: React.ReactNode }): React.ReactElement {
  return (
    <Link href={href} className="group flex min-h-24 items-start gap-3 rounded border border-border/50 bg-surface px-4 py-3 transition-all hover:border-accent/50 hover:bg-bg/70">
      <span className="mt-0.5 text-accent/70 group-hover:text-accent">{icon}</span>
      <span>
        <span className="block text-xs font-bold uppercase tracking-wider text-text group-hover:text-accent">{label}</span>
        <span className="mt-1 block text-[11px] leading-5 text-text-muted">{detail}</span>
      </span>
    </Link>
  );
}

export default function HermesOverviewPage(): React.ReactElement {
  const [installations, setInstallations] = useState<HermesInstallation[]>([]);
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    async function load(showLoading = false): Promise<void> {
      if (showLoading) setLoading(true);
      setError('');
      try {
        const [installationsRes, profilesRes] = await Promise.all([
          api.hermes.installations(),
          api.hermes.profiles(),
        ]);
        if (!mounted) return;
        setInstallations(installationsRes.data ?? []);
        setProfiles(profilesRes.data ?? []);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : 'Failed to load Hermes Agent inventory');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load(true);
    const refreshTimer = window.setInterval(() => void load(), 30_000);
    return () => {
      mounted = false;
      window.clearInterval(refreshTimer);
    };
  }, []);

  const profilesByInstallation = useMemo(() => {
    const map = new Map<string, HermesProfile[]>();
    for (const profile of profiles) map.set(profile.installationId, [...(map.get(profile.installationId) ?? []), profile]);
    return map;
  }, [profiles]);

  const detectedInstallations = useMemo(() => installations.filter(isDetected), [installations]);
  const detectedInstallationIds = useMemo(() => new Set(detectedInstallations.map((installation) => installation.id)), [detectedInstallations]);
  const detectedProfiles = profiles.filter((profile) => detectedInstallationIds.has(profile.installationId));
  const runningGateways = detectedProfiles.filter((p) => p.gatewayStatus === 'running').length;
  const healthyInstalls = detectedInstallations.filter((i) => i.status === 'running' || i.status === 'detected').length;
  const dashboardOnline = detectedInstallations.filter((i) => i.dashboardStatus === 'running').length;

  return (
    <PageTransition className="space-y-6">
      <PageItem>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-wider text-primary">Hermes Agents</h1>
            <p className="mt-1 text-[11px] uppercase tracking-wider text-text-muted">
              {loading ? 'Loading inventory...' : `${detectedInstallations.length} detected installation${detectedInstallations.length === 1 ? '' : 's'} · latest sync ${fmtDate(detectedInstallations[0]?.lastSyncedAt ?? null)}`}
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/orchestra/installations" className="inline-flex h-8 items-center justify-center gap-2 rounded border border-border bg-surface px-3 text-[11px] font-medium uppercase tracking-wider text-text-muted transition-all hover:border-primary/40 hover:text-text">
              <Server className="h-3.5 w-3.5" />
              Installations
            </Link>
            <Link href="/orchestra/web-gateway" className="inline-flex h-8 items-center justify-center gap-2 rounded border border-primary/60 bg-primary/10 px-3 text-[11px] font-medium uppercase tracking-wider text-primary transition-all hover:border-primary hover:bg-primary/20">
              <MonitorDot className="h-3.5 w-3.5" />
              Dashboard
            </Link>
          </div>
        </div>
      </PageItem>

      {error && <div className="rounded border border-danger/30 bg-danger/10 p-4 text-xs text-danger">{error}</div>}

      <PageItem>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <StatCard label="Installations" value={detectedInstallations.length} icon={<Server className="h-4 w-4" />} />
          <StatCard label="Healthy Installs" value={healthyInstalls} icon={<Activity className="h-4 w-4" />} />
          <StatCard label="Dashboard Tunnels" value={dashboardOnline} icon={<MonitorDot className="h-4 w-4" />} />
          <StatCard label="Running Gateways" value={runningGateways} icon={<Bot className="h-4 w-4" />} />
        </div>
      </PageItem>

      <PageItem>
        <div className="grid gap-3 md:grid-cols-3">
          <QuickAction label="Installations" detail="Survey Hermes Agent runtime, home, version, and service posture." href="/orchestra/installations" icon={<Server className="h-4 w-4" />} />
          <QuickAction label="Profiles" detail="Review discovered profiles and their running configuration snapshots." href="/orchestra/profiles" icon={<Users className="h-4 w-4" />} />
          <QuickAction label="Web Gateway" detail="Open the selected Hermes dashboard frame for inspection." href="/orchestra/web-gateway" icon={<Globe2 className="h-4 w-4" />} />
        </div>
      </PageItem>

      <PageItem>
        <Card title="Installation Inventory" description="Runtime, dashboard, gateway, and profile posture">
          <div className="space-y-3">
            {detectedInstallations.map((installation) => {
              const linkedProfiles = profilesByInstallation.get(installation.id) ?? installation.profiles ?? [];
              return (
                <div key={installation.id} className="rounded border border-border/50 bg-bg/50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-text">{installLabel(installation)}</p>
                      <p className="mt-1 font-mono text-[10px] text-text-muted">{installation.hostname} · {installation.hermesHome}</p>
                    </div>
                    <Badge variant={statusVariant(installation.status)}>{installation.status}</Badge>
                  </div>
                  <div className="mt-3 grid gap-2 text-[11px] text-text-muted sm:grid-cols-4">
                    <div><span className="block uppercase tracking-wider text-text-muted/70">Version</span><span className="font-mono text-text">{installation.version ?? 'unknown'}</span></div>
                    <div><span className="block uppercase tracking-wider text-text-muted/70">Dashboard</span><Badge variant={statusVariant(installation.dashboardStatus)}>{installation.dashboardStatus}</Badge></div>
                    <div><span className="block uppercase tracking-wider text-text-muted/70">Gateway</span><Badge variant={statusVariant(installation.gatewayStatus)}>{installation.gatewayStatus}</Badge></div>
                    <div><span className="block uppercase tracking-wider text-text-muted/70">Profiles</span><span className="text-text">{linkedProfiles.length}</span></div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 font-mono text-[10px] text-text-muted">
                      <MonitorDot className="h-3 w-3" />
                      {dashboardAddress(installation)}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-text-muted">
                      <Database className="h-3 w-3" />
                      synced {fmtDate(installation.lastSyncedAt)}
                    </span>
                    <Link className="text-[10px] font-bold uppercase tracking-wider text-accent hover:underline" href={`/orchestra/web-gateway?installationId=${encodeURIComponent(installation.id)}`}>
                      Gateway
                    </Link>
                  </div>
                </div>
              );
            })}
            {!loading && detectedInstallations.length === 0 && <p className="text-xs text-text-muted">No Hermes installations detected yet.</p>}
          </div>
        </Card>
      </PageItem>
    </PageTransition>
  );
}
