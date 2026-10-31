'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, BookOpen, Radio } from 'lucide-react';
import type { ArdentFleetInstallation, ArdentProfileSummary } from '@hivemagnus/magnus-contracts';
import { api } from '@/lib/api-client';
import { Badge, statusVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageItem, PageTransition } from '@/components/ui/page-transition';
import { ardentError } from './[id]/action-button';

type Profile = ArdentProfileSummary & { nodeId: string; nodeName: string; hostname: string; installationVersion: string | null; reachable: boolean };

export default function ArdentProfilesPage(): React.ReactElement {
  const router = useRouter();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [installations, setInstallations] = useState<ArdentFleetInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [nodeId, setNodeId] = useState('');
  const [profileId, setProfileId] = useState('default');
  const [apiPort, setApiPort] = useState('9910');
  useEffect(() => {
    let active = true;
    Promise.all([api.ardent.profiles(), api.ardent.installations()]).then(([profilesResponse, installationsResponse]) => {
      if (!active) return;
      setProfiles(profilesResponse.data ?? []);
      const nodes = installationsResponse.data ?? [];
      setInstallations(nodes);
      setNodeId(current => current || nodes.find(node => node.installed && node.reachable)?.nodeId || '');
    })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Ardent profiles are unavailable'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function create(): Promise<void> {
    setCreateError('');
    const port = Number(apiPort);
    if (!nodeId || !/^[A-Za-z0-9_-]{1,64}$/.test(profileId) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      setCreateError('Choose an installed node, a valid profile ID, and an API port from 1024 to 65535.'); return;
    }
    setCreating(true);
    try {
      const response = await api.ardent.action<{ profile: string; apiPort: number; initialized: boolean }>(nodeId, profileId, 'profile-create', { api_port: port });
      if (!response.data?.initialized || response.data.profile !== profileId || response.data.apiPort !== port)
        throw new Error('Node did not confirm profile creation');
      router.push(`/ardent/profiles/${encodeURIComponent(`${nodeId}~${profileId}`)}`);
    } catch (reason) { setCreateError(await ardentError(reason)); }
    finally { setCreating(false); }
  }
  return (
    <PageTransition className="space-y-6">
      <PageItem><p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-primary/60">Magnus Ardent</p><h1 className="mt-1 text-lg font-bold uppercase tracking-wider text-text">Profiles</h1><p className="mt-1 text-xs text-text-muted">{loading ? 'Reading node profiles…' : `${profiles.length} profiles reported by managed nodes`}</p></PageItem>
      {error && <div role="alert" className="rounded border border-danger/40 bg-danger/10 p-4 text-xs text-danger">{error}</div>}
      {!loading && !error && <PageItem><div className="rounded border border-border/60 bg-surface p-4"><p className="text-xs font-semibold uppercase tracking-wider text-text">Create profile</p><p className="mt-1 text-xs text-text-muted">Initialize a node-local Ardent profile with a private management token. Channels remain disabled until configured.</p><div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_8rem_auto] md:items-end"><label className="text-[11px] text-text-muted">Managed node<select value={nodeId} onChange={event => setNodeId(event.target.value)} className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-xs text-text"><option value="">Select an installed node</option>{installations.filter(item => item.installed && item.reachable).map(item => <option key={item.nodeId} value={item.nodeId}>{item.nodeName} ({item.hostname})</option>)}</select></label><label className="text-[11px] text-text-muted">Profile ID<input value={profileId} maxLength={64} onChange={event => setProfileId(event.target.value)} className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-xs text-text" /></label><label className="text-[11px] text-text-muted">API port<input type="number" min={1024} max={65535} value={apiPort} onChange={event => setApiPort(event.target.value)} className="mt-1 block w-full rounded border border-border bg-bg px-3 py-2 text-xs text-text" /></label><Button size="sm" disabled={creating || !nodeId} onClick={() => void create()}>{creating ? 'Creating…' : 'Create'}</Button></div>{createError && <p role="alert" className="mt-3 text-xs text-danger">{createError}</p>}</div></PageItem>}
      {!loading && !error && installations.some(item => !item.reachable) && <PageItem>
        <div className="rounded border border-border/60 bg-surface p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text">Node inventory needs attention</h2>
          <p className="mt-1 text-xs text-text-muted">Profiles on disconnected nodes cannot be inspected or managed.</p>
          <div className="mt-3 space-y-2">
            {installations.filter(item => !item.reachable).map(item => <div key={item.nodeId} className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-xs">
              <p className="font-semibold text-text">{item.nodeName} ({item.hostname})</p>
              <p className="mt-1 text-danger">{item.error ?? 'Node inventory is unavailable'}</p>
            </div>)}
          </div>
        </div>
      </PageItem>}
      <PageItem>
        <div className="grid gap-3 lg:grid-cols-2">
          {profiles.map(profile => <Link key={`${profile.nodeId}:${profile.id}`} href={`/ardent/profiles/${encodeURIComponent(`${profile.nodeId}~${profile.id}`)}`} className="group rounded border border-border/60 bg-surface p-4 transition-colors hover:border-primary/50">
            <div className="flex items-start justify-between gap-3"><div className="flex gap-3"><BookOpen className="mt-0.5 h-4 w-4 text-primary" /><div><p className="text-sm font-semibold text-text group-hover:text-primary">{profile.name}</p><p className="mt-1 font-mono text-[11px] text-text-muted">{profile.hostname} · {profile.id}</p></div></div><ArrowUpRight className="h-4 w-4 text-text-muted group-hover:text-primary" /></div>
            <div className="mt-4 flex flex-wrap items-center gap-2"><Badge variant={statusVariant(profile.running ? 'running' : 'stopped')}>{profile.running ? 'Running' : 'Stopped'}</Badge><span className="rounded border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-text-muted">{profile.backend ?? 'Unknown backend'}</span><span className="inline-flex items-center gap-1 text-[10px] text-text-muted"><Radio className="h-3 w-3" /> A2A {profile.a2aEnabled ? 'configured' : 'disabled'}</span></div>
            {profile.error && <p className="mt-3 text-xs text-danger">{profile.error}</p>}
          </Link>)}
          {!loading && profiles.length === 0 && !error && <div className="rounded border border-border bg-surface p-8 text-center text-xs text-text-muted lg:col-span-2">No Ardent profiles were reported. Check installations for node errors.</div>}
        </div>
      </PageItem>
    </PageTransition>
  );
}
