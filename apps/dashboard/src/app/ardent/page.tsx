'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowUpRight, Bot, Database, Radio, Server } from 'lucide-react';
import type { ArdentFleetInstallation } from '@hivemagnus/magnus-contracts';
import { api } from '@/lib/api-client';
import { Badge, statusVariant } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageItem, PageTransition } from '@/components/ui/page-transition';

function channelSummary(channels: Record<string, boolean>): string {
  const enabled = Object.entries(channels).filter(([, on]) => on).map(([name]) => name);
  return enabled.length ? enabled.join(', ') : 'None';
}

export default function ArdentOverviewPage(): React.ReactElement {
  const [installations, setInstallations] = useState<ArdentFleetInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.ardent.installations()
      .then(response => { if (active) setInstallations(response.data ?? []); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Ardent inventory is unavailable'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const detected = installations.filter(item => item.installed && item.reachable);
  const profiles = detected.flatMap(item => item.profiles.map(profile => ({ ...profile, node: item })));
  const running = profiles.filter(item => item.running).length;
  const unavailable = installations.filter(item => !item.reachable).length;
  const needsAttention = unavailable + profiles.filter(item => !item.running || item.error).length;

  return (
    <PageTransition className="space-y-6">
      <PageItem>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-primary/60">Agent runtime</p>
            <h1 className="mt-1 text-xl font-bold uppercase tracking-wider text-text">Magnus Ardent</h1>
            <p className="mt-2 max-w-2xl text-xs leading-5 text-text-muted">Inspect the Ardent agent runtime across managed nodes. Each signal comes from the node and its authenticated profile API.</p>
          </div>
          <Link href="/ardent/installations" className="inline-flex items-center gap-2 rounded border border-primary/40 bg-primary/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-primary hover:bg-primary/20">
            Open installations <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </PageItem>

      {error && <div role="alert" className="rounded border border-danger/40 bg-danger/10 p-4 text-xs text-danger">{error}</div>}

      <PageItem>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded border border-border/60 bg-surface p-4"><Server className="h-4 w-4 text-primary" /><p className="mt-3 text-2xl font-semibold tabular-nums text-text">{loading || error ? '—' : detected.length}</p><p className="text-[10px] uppercase tracking-widest text-text-muted">Installed nodes</p></div>
          <div className="rounded border border-border/60 bg-surface p-4"><Activity className="h-4 w-4 text-accent" /><p className="mt-3 text-2xl font-semibold tabular-nums text-text">{loading || error ? '—' : running}</p><p className="text-[10px] uppercase tracking-widest text-text-muted">Running profiles</p></div>
          <div className="rounded border border-border/60 bg-surface p-4"><Radio className="h-4 w-4 text-text-muted" /><p className="mt-3 text-2xl font-semibold tabular-nums text-text">{loading || error ? '—' : needsAttention}</p><p className="text-[10px] uppercase tracking-widest text-text-muted">Needs attention</p></div>
        </div>
      </PageItem>

      <PageItem>
        <Card title="Profiles" description="Current profile observations from managed nodes">
          {loading ? <p className="text-xs text-text-muted">Checking profiles…</p> : error ? <p className="text-xs leading-5 text-text-muted">Profile status is unavailable until the Magnus Control API responds.</p> : profiles.length ? (
            <div className="space-y-3">
              {profiles.map(profile => <div key={`${profile.node.nodeId}:${profile.id}`} className="space-y-3 rounded border border-border/60 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><p className="text-sm font-semibold text-text">{profile.name}</p><p className="mt-1 font-mono text-[11px] text-text-muted">{profile.node.hostname} · {profile.id} · Ardent {profile.node.version ?? 'version unknown'}</p></div>
                  <Badge variant={statusVariant(profile.running ? 'running' : 'stopped')}>{profile.running ? 'Running' : 'Stopped'}</Badge>
                </div>
                <div className="grid gap-px overflow-hidden rounded border border-border/60 bg-border/60 sm:grid-cols-3">
                  {[
                    { label: 'Backend', value: profile.backend ?? 'Unknown', icon: Bot },
                    { label: 'A2A', value: profile.a2aEnabled ? 'Configured' : 'Disabled', icon: Radio },
                    { label: 'Channels', value: channelSummary(profile.channels), icon: Database },
                  ].map(signal => <div key={signal.label} className="bg-bg/80 px-3 py-3"><signal.icon className="h-3.5 w-3.5 text-primary/70" /><p className="mt-2 text-[10px] uppercase tracking-wider text-text-muted">{signal.label}</p><p className="mt-0.5 text-xs font-medium capitalize text-text">{signal.value}</p></div>)}
                </div>
                {profile.error && <p role="alert" className="text-xs text-danger">{profile.error}</p>}
                <Link href={`/ardent/profiles/${encodeURIComponent(`${profile.node.nodeId}~${profile.id}`)}`} className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-primary hover:underline">Open profile <ArrowUpRight className="h-3 w-3" /></Link>
              </div>)}
            </div>
          ) : <p className="text-xs leading-5 text-text-muted">No Ardent profiles were detected. Create one on the Profiles page, or review node inventory for installation or connection errors.</p>}
        </Card>
      </PageItem>
    </PageTransition>
  );
}
