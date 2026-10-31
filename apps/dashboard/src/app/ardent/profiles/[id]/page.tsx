'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Download, ExternalLink, RefreshCw } from 'lucide-react';
import type { ArdentFleetInstallation, ArdentProfileSummary } from '@hivemagnus/magnus-contracts';
import { api } from '@/lib/api-client';
import { Badge, statusVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageItem, PageTransition } from '@/components/ui/page-transition';
import { ConfigEditor } from './config-editor';
import { IdentityEditor } from './identity-editor';
import { ActionButton } from './action-button';
import { SkillList } from './skill-list';
import { TaskTest } from './task-test';
import { SettingsForm } from './settings-form';
import { PeerEditor } from './peer-editor';
import { MemoryPanel } from './memory-panel';
import { CodexNodePanel } from './codex-node-panel';

const tabs = ['Overview', 'Configuration', 'Identity', 'Providers', 'Channels', 'Peers', 'Skills', 'Tasks & Artifacts', 'API Reference'] as const;
type Tab = typeof tabs[number];
type Profile = ArdentProfileSummary & { nodeId: string; nodeName: string; hostname: string; installationVersion: string | null; reachable: boolean };
type Task = { id: string; state: string; prompt: string; result: string | null; error: string | null; backend: string; created_ms: number };
type Event = { sequence: number; kind: string; detail: unknown; created_ms: number };
type Artifact = { id: string; name: string; bytes: number; media_type: string };
type OpenApi = { openapi: string; info: { title: string; version: string }; paths: Record<string, Record<string, { operationId?: string; summary?: string }>> };

function channelLabel(name: string): string { return name === 'telegram' ? 'Telegram' : name.charAt(0).toUpperCase() + name.slice(1); }
function date(value: number): string { return new Date(value).toLocaleString(); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function value(value: unknown): string { return value === null || value === undefined ? '—' : typeof value === 'string' ? value : String(value); }
function editable(value: unknown): value is { text: string; revision: string } {
  const entry = object(value);
  return typeof entry.text === 'string' && typeof entry.revision === 'string';
}
function taskList(input: unknown): Task[] {
  return Array.isArray(input) ? input.filter((item): item is Task =>
    item && typeof item === 'object' && typeof item.id === 'string' && typeof item.state === 'string' && typeof item.prompt === 'string' && typeof item.created_ms === 'number') : [];
}
function taskArtifacts(events: Event[]): Artifact[] {
  const found = new Map<string, Artifact>();
  for (const event of events) {
    if (event.kind !== 'research_artifacts') continue;
    for (const raw of Object.values(object(event.detail))) {
      const item = object(raw);
      if (typeof item.id === 'string' && /^[a-f0-9]{64}$/.test(item.id) && typeof item.name === 'string'
        && typeof item.bytes === 'number' && typeof item.media_type === 'string')
        found.set(item.id, item as Artifact);
    }
  }
  return [...found.values()];
}

export default function ArdentProfilePage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('Overview');
  const [installation, setInstallation] = useState<ArdentFleetInstallation | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [taskFilter, setTaskFilter] = useState('all');
  const [taskEvents, setTaskEvents] = useState<Event[]>([]);
  const [downloadError, setDownloadError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const decoded = params.id ?? '';
  const marker = decoded.indexOf('~');
  const nodeId = marker >= 0 ? decoded.slice(0, marker) : '';
  const profileId = marker >= 0 ? decoded.slice(marker + 1) : '';
  const validId = /^[A-Za-z0-9._-]{1,128}$/.test(nodeId) && /^[A-Za-z0-9_-]{1,64}$/.test(profileId);

  useEffect(() => { if (new URLSearchParams(window.location.search).get('tab') === 'tasks') setTab('Tasks & Artifacts'); }, []);

  useEffect(() => {
    let active = true;
    if (!validId) { setError('Profile link is invalid'); setLoading(false); return; }
    api.ardent.installation(nodeId).then(response => {
      if (!active) return;
      const node = response.data;
      setInstallation(node ?? null);
      const found = node?.profiles.find(item => item.id === profileId);
      setProfile(found && node ? { ...found, nodeId, nodeName: node.nodeName, hostname: node.hostname, installationVersion: node.version, reachable: node.reachable } : null);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Node inventory is unavailable'); });
    return () => { active = false; };
  }, [nodeId, profileId, validId, refreshKey]);

  useEffect(() => {
    let active = true;
    if (!validId) return;
    setLoading(true); setError(''); setDownloadError(''); setSelectedTask(null); setTaskEvents([]);
    const get = <T,>(resource: string) => api.ardent.resource<T>(nodeId, profileId, resource).then(response => {
      if (!response.success || response.data === undefined) throw new Error('Profile API returned no data');
      return response.data;
    });
    const read = async (): Promise<unknown> => {
      if (tab === 'Overview') return Promise.all([get<{ profile: string; backend: string; tasks: number }>('status'), get<{ tasks: Task[] }>('tasks')]).then(([status, tasks]) => ({ status, tasks }));
      if (tab === 'Configuration') return get<{ revision: string; text: string }>('config');
      if (tab === 'Identity') return Promise.all([get<{ text: string; revision: string }>('identity/soul'), get<{ text: string; revision: string }>('identity/identity')]).then(([soul, identity]) => ({ soul, identity }));
      if (tab === 'Providers') return Promise.all([get<object>('providers'), get<{ revision: string; text: string }>('config')]).then(([status, config]) => ({ status, config }));
      if (tab === 'Channels') return Promise.all([get<object>('channels'), get<{ revision: string; text: string }>('config')]).then(([status, config]) => ({ status, config }));
      if (tab === 'Peers') return Promise.all([get<{ peers: object[] }>('peers'), get<{ revision: string; text: string }>('peers/config')]).then(([status, config]) => ({ peers: status.peers, config }));
      if (tab === 'Skills') return Promise.all([get<{ skills: Array<{ name: string; description: string; hash: string; enabled: boolean }> }>('skills'), get<{ revision: string }>('config'), get<{ status: 'ready' | 'degraded'; agent_id: string; workspace_id: string; retrieval: string | null; storage: string | null; reason: string | null }>('memory/status')]).then(([skills, config, memory]) => ({ skills: skills.skills, revision: config.revision, memory }));
      if (tab === 'Tasks & Artifacts') return get<{ tasks: Task[] }>('tasks');
      return get<OpenApi>('openapi');
    };
    read().then(result => { if (active) setData(result); })
      .catch(reason => { if (active) { setData(null); setError(reason instanceof Error ? reason.message : 'Profile API is unavailable'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [nodeId, profileId, tab, validId, refreshKey]);

  const rows = useMemo(() => object(data), [data]);
  const tasks = taskList(tab === 'Overview' ? object(rows.tasks).tasks : rows.tasks);
  const filteredTasks = taskFilter === 'all' ? tasks : tasks.filter(task => task.state === taskFilter);
  const openapi = tab === 'API Reference' ? data as OpenApi | null : null;
  const artifacts = taskArtifacts(taskEvents);

  async function inspectTask(task: Task): Promise<void> {
    setSelectedTask(task); setTaskEvents([]); setDownloadError('');
    try {
      const response = await api.ardent.resource<{ events: Event[] }>(nodeId, profileId, `tasks/${task.id}/events`);
      setTaskEvents(response.data?.events ?? []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Task events are unavailable'); }
  }

  function downloadOpenApi(): void {
    if (!openapi) return;
    const href = URL.createObjectURL(new Blob([JSON.stringify(openapi, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = href; link.download = `ardent-${profileId}-openapi.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  async function downloadArtifact(artifact: Artifact): Promise<void> {
    setDownloadError('');
    try {
      const path = `ardent/installations/${encodeURIComponent(nodeId)}/profiles/${encodeURIComponent(profileId)}/artifacts/${artifact.id}`;
      const response = await fetch(`/api/proxy/${path}`, { headers: api.getAuthHeaders(), credentials: 'same-origin' });
      if (!response.ok || response.headers.get('content-type') !== 'application/octet-stream')
        throw new Error(`Artifact download failed (HTTP ${response.status})`);
      const bytes = await response.blob();
      if (bytes.size !== artifact.bytes) throw new Error('Artifact size differs from the task record');
      const href = URL.createObjectURL(bytes);
      const link = document.createElement('a'); link.href = href; link.download = artifact.name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (reason) { setDownloadError(reason instanceof Error ? reason.message : 'Artifact download failed'); }
  }

  return (
    <PageTransition className="space-y-5">
      <PageItem>
        <Link href="/ardent/profiles" className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-text-muted hover:text-primary"><ArrowLeft className="h-3.5 w-3.5" /> Profiles</Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-primary/60">Magnus Ardent / {profileId || 'Invalid profile'}</p><h1 className="mt-1 text-lg font-bold uppercase tracking-wider text-text">{profile?.name ?? (profileId || 'Profile')}</h1><p className="mt-1 font-mono text-[11px] text-text-muted">{installation?.hostname ?? nodeId} · {installation?.version ?? 'version unavailable'}</p></div>
          {profile && <Badge variant={statusVariant(profile.running ? 'running' : 'stopped')}>{profile.running ? 'Running' : 'Stopped'}</Badge>}
        </div>
      </PageItem>
      <PageItem>
        <div className="flex gap-1 overflow-x-auto border-b border-border/60 pb-2" role="tablist" aria-label="Ardent profile sections">
          {tabs.map(item => <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)} className={`shrink-0 rounded px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors ${tab === item ? 'bg-primary/10 text-primary' : 'text-text-muted hover:bg-surface hover:text-text'}`}>{item}</button>)}
        </div>
      </PageItem>
      {error && <div role="alert" className="break-all rounded border border-danger/40 bg-danger/10 p-4 text-xs text-danger">{error}</div>}
      {downloadError && <div role="alert" className="break-all rounded border border-danger/40 bg-danger/10 p-4 text-xs text-danger">{downloadError}</div>}
      {loading && <div className="rounded border border-border bg-surface p-6 text-xs text-text-muted">Loading {tab.toLowerCase()}…</div>}
      {!loading && !error && tab === 'Overview' && <PageItem><div className="grid gap-3 sm:grid-cols-3">
        {[{ label: 'Runtime', value: profile?.running ? 'Connected' : 'Disconnected' }, { label: 'Backend', value: value(object(rows.status).backend ?? profile?.backend) }, { label: 'Recent tasks', value: String(tasks?.length ?? 0) }].map(item => <div key={item.label} className="rounded border border-border/60 bg-surface p-4"><p className="text-[10px] uppercase tracking-wider text-text-muted">{item.label}</p><p className="mt-2 text-sm font-semibold text-text">{item.value}</p></div>)}
        <div className="rounded border border-border/60 bg-surface p-4 sm:col-span-3"><p className="text-[10px] uppercase tracking-wider text-text-muted">Task activity</p>{tasks?.length ? <div className="mt-3 space-y-2">{tasks.slice(0, 5).map(task => <div key={task.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2 text-xs"><span className="max-w-xl truncate text-text">{task.prompt}</span><Badge variant={statusVariant(task.state)}>{task.state}</Badge></div>)}</div> : <p className="mt-2 text-xs text-text-muted">No tasks have been reported by this profile.</p>}</div>
      </div></PageItem>}
      {!loading && !error && tab === 'Configuration' && <PageItem>{editable(data) ? <ConfigEditor nodeId={nodeId} profileId={profileId} entry={data} /> : <p role="alert" className="text-xs text-danger">Configuration response is invalid.</p>}</PageItem>}
      {!loading && !error && tab === 'Identity' && <PageItem>{editable(rows.soul) && editable(rows.identity) ? <IdentityEditor nodeId={nodeId} profileId={profileId} entries={{ soul: rows.soul, identity: rows.identity }} /> : <p role="alert" className="text-xs text-danger">Identity response is invalid.</p>}</PageItem>}
      {!loading && !error && tab === 'Providers' && <PageItem><div className="grid gap-3 lg:grid-cols-2">{['llamacpp', 'codex'].map(name => { const status = object(rows.status); const entry = object(status[name]); return <div key={name} className="rounded border border-border/60 bg-surface p-4"><div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wider text-text">{name === 'llamacpp' ? 'llama.cpp' : 'Codex App Server'}</p>{status.selected === name && <Badge variant="success">Selected</Badge>}</div><dl className="mt-4 space-y-2 text-xs">{Object.entries(entry).map(([key, item]) => <div key={key} className="flex justify-between gap-3 border-t border-border/40 pt-2"><dt className="text-text-muted">{key.replaceAll('_', ' ')}</dt><dd className="max-w-[70%] break-all text-right font-mono text-text">{value(item)}</dd></div>)}</dl>{status.selected === name && <ActionButton nodeId={nodeId} profileId={profileId} action="provider-test" label="Test selected backend" />}</div>; })}</div>{editable(rows.config) && <SettingsForm key={rows.config.revision} nodeId={nodeId} profileId={profileId} entry={rows.config} section="providers" running={profile?.running ?? false} />}{object(rows.status).selected === 'codex' && <CodexNodePanel nodeId={nodeId} />}</PageItem>}
      {!loading && !error && tab === 'Channels' && <PageItem><div className="grid gap-3 lg:grid-cols-2">{Object.keys(object(rows.status)).map(name => { const entry = object(object(rows.status)[name]); return <div key={name} className="rounded border border-border/60 bg-surface p-4"><div className="flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-wider text-text">{channelLabel(name)}</p><Badge variant={statusVariant(entry.enabled ? 'running' : 'stopped')}>{entry.enabled ? 'Enabled' : 'Disabled'}</Badge></div><p className="mt-3 text-xs text-text-muted">Credential {entry.token_configured ? 'configured' : 'unconfigured'} · {value(entry.allowed_user_count)} allowed users</p><ActionButton nodeId={nodeId} profileId={profileId} action="channel-test" target={name} label="Test connection" disabled={!entry.token_configured} /></div>; })}</div>{editable(rows.config) && <SettingsForm key={rows.config.revision} nodeId={nodeId} profileId={profileId} entry={rows.config} section="channels" running={profile?.running ?? false} />}</PageItem>}
      {!loading && !error && tab === 'Peers' && <PageItem><div className="space-y-2">{Array.isArray(rows.peers) && rows.peers.length ? rows.peers.map((peer, index) => { const entry = object(peer); return <div key={value(entry.id) + index} className="rounded border border-border/60 bg-surface p-4"><div className="flex flex-wrap justify-between gap-2"><p className="text-sm font-semibold text-text">{value(entry.id)}</p><Badge variant={statusVariant(entry.enabled ? 'running' : 'stopped')}>{entry.enabled ? 'Enabled' : 'Disabled'}</Badge></div><p className="mt-2 break-all font-mono text-[11px] text-text-muted">{value(entry.url)}</p><p className="mt-2 text-xs text-text-muted">Credential {entry.credential_configured ? 'configured' : 'unconfigured'}</p>{typeof entry.id === 'string' && <ActionButton nodeId={nodeId} profileId={profileId} action="peer-test" target={entry.id} label="Discover peer" disabled={!entry.enabled || !entry.credential_configured} />}</div>; }) : <p className="rounded border border-border bg-surface p-6 text-xs text-text-muted">No authorized peers are configured for this profile.</p>}</div>{editable(rows.config) && <PeerEditor nodeId={nodeId} profileId={profileId} entry={rows.config} running={profile?.running ?? false} />}</PageItem>}
      {!loading && !error && tab === 'Skills' && <PageItem>{Array.isArray(rows.skills) && typeof rows.revision === 'string' ? <SkillList nodeId={nodeId} profileId={profileId} initial={rows.skills as Array<{ name: string; description: string; hash: string; enabled: boolean }>} initialRevision={rows.revision} /> : <p role="alert" className="text-xs text-danger">Skills response is invalid.</p>}{Boolean(rows.memory) && <MemoryPanel nodeId={nodeId} profileId={profileId} status={rows.memory as { status: 'ready' | 'degraded'; agent_id: string; workspace_id: string; retrieval: string | null; storage: string | null; reason: string | null }} />}</PageItem>}
      {!loading && !error && tab === 'Tasks & Artifacts' && <PageItem><div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"><div className="rounded border border-border/60 bg-surface p-4"><TaskTest nodeId={nodeId} profileId={profileId} /><div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wider text-text">Recent tasks</p><label className="text-[11px] text-text-muted">State <select aria-label="Filter tasks by state" value={taskFilter} onChange={event => setTaskFilter(event.target.value)} className="ml-1 rounded border border-border bg-bg px-2 py-1 text-text"><option value="all">All</option><option value="queued">Queued</option><option value="running">Running</option><option value="completed">Completed</option><option value="partial">Partial</option><option value="failed">Failed</option><option value="unknown">Unknown</option></select></label></div><div className="mt-3 max-h-[65vh] space-y-2 overflow-auto">{filteredTasks.length ? filteredTasks.map(task => <button key={task.id} type="button" onClick={() => void inspectTask(task)} className={`w-full rounded border p-3 text-left text-xs ${selectedTask?.id === task.id ? 'border-primary/50 bg-primary/5' : 'border-border/50 bg-bg/50 hover:border-primary/30'}`}><span className="flex items-center justify-between gap-2"><span className="truncate font-medium text-text">{task.prompt}</span><Badge variant={statusVariant(task.state)}>{task.state}</Badge></span><span className="mt-1 block font-mono text-[10px] text-text-muted">{date(task.created_ms)} · {task.id.slice(0, 8)}</span></button>) : <p className="text-xs text-text-muted">{taskFilter === 'all' ? 'No tasks recorded.' : 'No tasks match this state.'}</p>}</div></div><div className="rounded border border-border/60 bg-surface p-4"><p className="text-xs font-semibold uppercase tracking-wider text-text">Task detail</p>{selectedTask ? <div className="mt-3 space-y-3"><p className="text-xs text-text-muted">{selectedTask.prompt}</p>{!['completed', 'partial', 'failed', 'cancelled', 'unknown'].includes(selectedTask.state) && <ActionButton nodeId={nodeId} profileId={profileId} action="task-cancel" target={selectedTask.id} label="Cancel task" onSuccess={() => setRefreshKey(current => current + 1)} />}{selectedTask.result && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-bg p-3 text-xs leading-5 text-text">{selectedTask.result}</pre>}{selectedTask.error && <p className="text-xs text-danger">{selectedTask.error}</p>}{artifacts.length > 0 && <div className="border-t border-border/50 pt-3"><p className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">Artifacts</p>{artifacts.map(artifact => <button key={artifact.id} type="button" onClick={() => void downloadArtifact(artifact)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-primary hover:bg-primary/10"><Download className="h-3.5 w-3.5" /><span className="truncate">{artifact.name}</span><span className="ml-auto font-mono text-[10px] text-text-muted">{artifact.bytes} B</span></button>)}</div>}<div className="space-y-2 border-t border-border/50 pt-3">{taskEvents.map(event => <div key={event.sequence} className="flex gap-3 text-[11px]"><span className="w-14 shrink-0 font-mono text-text-muted">{event.sequence}</span><span className="font-medium text-text">{event.kind.replaceAll('_', ' ')}</span><span className="ml-auto text-text-muted">{date(event.created_ms)}</span></div>)}{taskEvents.length === 0 && <p className="text-xs text-text-muted">No events returned.</p>}</div></div> : <p className="mt-3 text-xs text-text-muted">Select a task to inspect its result and journal.</p>}</div></div></PageItem>}
      {!loading && !error && tab === 'API Reference' && <PageItem><div className="rounded border border-border/60 bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-text">{openapi?.info.title ?? 'API Reference'}</p><p className="mt-1 text-[11px] text-text-muted">OpenAPI {openapi?.openapi} · service {openapi?.info.version}</p></div><Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={downloadOpenApi}>Download JSON</Button></div><div className="mt-4 max-h-[65vh] overflow-auto">{Object.entries(openapi?.paths ?? {}).map(([path, methods]) => Object.entries(methods).filter(([method]) => ['get', 'put', 'post', 'delete', 'patch'].includes(method)).map(([method, operation]) => <div key={`${method}:${path}`} className="flex flex-wrap items-center gap-3 border-t border-border/50 py-2 text-xs"><span className="w-14 shrink-0 font-mono font-bold uppercase text-primary">{method}</span><span className="min-w-0 flex-1 break-all font-mono text-text">{path}</span><span className="text-text-muted">{operation.operationId}</span></div>))}</div><p className="mt-3 inline-flex items-center gap-1 text-[11px] text-text-muted"><ExternalLink className="h-3 w-3" /> JSON-RPC and gRPC contracts are documented separately in the A2A compatibility guide.</p></div></PageItem>}
      <PageItem><button type="button" className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-muted hover:text-primary" onClick={() => setRefreshKey(current => current + 1)}><RefreshCw className="h-3.5 w-3.5" /> Refresh profile</button></PageItem>
    </PageTransition>
  );
}
