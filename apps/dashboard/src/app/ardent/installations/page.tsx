'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, RefreshCw, Server } from 'lucide-react';
import type { ArdentFleetInstallation } from '@hivemagnus/magnus-contracts';
import { api } from '@/lib/api-client';
import { Badge, statusVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageItem, PageTransition } from '@/components/ui/page-transition';
import { ServiceControls } from './service-controls';
import { PackageControls } from './package-controls';

export default function ArdentInstallationsPage(): React.ReactElement {
  const [installations, setInstallations] = useState<ArdentFleetInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setInstallations((await api.ardent.installations()).data ?? []); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Ardent inventory is unavailable'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const detected = installations.filter(item => item.installed && item.reachable);
  return (
    <PageTransition className="space-y-6">
      <PageItem>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-primary/60">Magnus Ardent</p><h1 className="mt-1 text-lg font-bold uppercase tracking-wider text-text">Installations</h1><p className="mt-1 text-xs text-text-muted">{loading ? 'Checking managed nodes…' : `${detected.length} installed · ${installations.length} managed nodes`}</p></div>
          <Button size="sm" variant="secondary" disabled={loading} icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={() => void load()}>Refresh</Button>
        </div>
      </PageItem>
      {error && <div role="alert" className="rounded border border-danger/40 bg-danger/10 p-4 text-xs text-danger">{error}</div>}
      <PageItem>
        <div className="space-y-3">
          {installations.map(item => (
            <div key={item.nodeId} className="rounded border border-border/60 bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3"><Server className="mt-0.5 h-4 w-4 text-primary/70" /><div><p className="text-sm font-semibold text-text">{item.nodeName}</p><p className="mt-1 font-mono text-[11px] text-text-muted">{item.hostname}</p></div></div>
                <Badge variant={statusVariant(!item.reachable ? 'error' : item.installed ? 'running' : 'not_installed')}>{!item.reachable ? 'Check failed' : item.installed ? 'Installed' : 'Not installed'}</Badge>
              </div>
              {item.error && <p className="mt-3 rounded border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger">{item.error}</p>}
              <div className="mt-4 grid gap-3 border-t border-border/50 pt-3 text-xs sm:grid-cols-3">
                <div><p className="text-[10px] uppercase tracking-wider text-text-muted">Version</p><p className="mt-1 font-mono text-text">{item.version ?? '—'}</p></div>
                <div><p className="text-[10px] uppercase tracking-wider text-text-muted">Owner</p><p className="mt-1 font-mono text-text">{item.owner || 'Unavailable'}</p></div>
                <div><p className="text-[10px] uppercase tracking-wider text-text-muted">Profiles</p><p className="mt-1 font-mono text-text">{item.profiles.length}</p></div>
              </div>
              <PackageControls item={item} refresh={load} />
              {item.profiles.length > 0 && <div className="mt-3 space-y-3">{item.profiles.map(profile => <div key={profile.id} className="rounded border border-border/40 bg-bg/40 p-3"><Link href={`/ardent/profiles/${encodeURIComponent(`${item.nodeId}~${profile.id}`)}`} className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline">{profile.name} <ArrowUpRight className="h-3 w-3" /></Link><ServiceControls nodeId={item.nodeId} profileId={profile.id} running={profile.running} refresh={load} /></div>)}</div>}
            </div>
          ))}
          {!loading && installations.length === 0 && !error && <div className="rounded border border-border bg-surface p-8 text-center text-xs text-text-muted">No managed nodes are available to inspect.</div>}
        </div>
      </PageItem>
    </PageTransition>
  );
}
