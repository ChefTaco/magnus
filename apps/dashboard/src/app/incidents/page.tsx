import { EvidenceReview } from './evidence-review';
import { fleetSystemFetch } from '@/lib/fleet-fetch';
import { configuredSecurityConsoleUrl } from '@/lib/security-console';

type Artifact = Record<string, unknown>;
type Incident = { generatedAt: string; windowHours: number; blastRadius: string; likelyCauses: string[]; artifacts: Record<string, Artifact[]> };

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ nodeId?: string; hours?: string }> }): Promise<React.ReactElement> {
  const params = await searchParams; const query = new URLSearchParams(); if (params.nodeId) query.set('nodeId', params.nodeId); query.set('hours', params.hours ?? '24');
  const securityConsole = await configuredSecurityConsoleUrl();
  const [incident, health, timeline] = await Promise.all([
    fleetSystemFetch<{ data: Incident }>(`ops/incident-summary?${query}`).then((r) => r.data).catch(() => null),
    fleetSystemFetch<{ data: { status: string; checks: Array<{ name: string; status: string; message: string }> } }>('ops/dependency-health').then((r) => r.data).catch(() => null),
    fleetSystemFetch<{ data: Artifact[] }>('ops/timeline?limit=25').then((r) => r.data).catch(() => []),
  ]);
  return <div className="space-y-5" data-testid="incident-workspace-page">
    <header className="border-b border-danger/20 pb-4"><div className="text-[10px] uppercase tracking-[.3em] text-danger">Evidence, not execution</div><div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="mt-1 text-xl font-black uppercase tracking-wider">Incident workspace</h1><p className="mt-1 text-xs text-text-muted">A redacted operating picture. Suggested remediation remains a dry-run until explicitly confirmed elsewhere.</p></div>{securityConsole && <a href={`${securityConsole}/security-fusion/cases`} target="_blank" rel="noopener noreferrer" className="border border-primary/40 px-3 py-2 text-[10px] uppercase tracking-wider text-primary">Correlated security cases ↗</a>}</div></header>
    <EvidenceReview />
    <div className="grid gap-3 lg:grid-cols-[.8fr_1.2fr]">
      <section className="rounded border border-border/50 bg-surface p-4"><div className="text-[10px] uppercase tracking-wider text-text-muted">Current classification</div><div className="mt-2 text-sm font-bold">{incident?.blastRadius ?? 'Unavailable'}</div><ul className="mt-3 space-y-2 text-xs text-warning">{incident?.likelyCauses.map((cause) => <li key={cause}>— {cause}</li>)}</ul><div className="mt-4 border-t border-border/40 pt-3 text-[10px] text-text-muted">Window {incident?.windowHours ?? '—'}h · refreshed {incident?.generatedAt ?? 'never'}</div></section>
      <section className="rounded border border-border/50 bg-surface p-4"><div className="flex justify-between text-[10px] uppercase tracking-wider text-text-muted"><span>Dependency map</span><span>{health?.status ?? 'unavailable'}</span></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{health?.checks.map((check) => <div key={check.name} className="border-l-2 border-primary/30 pl-2 text-xs"><div className="font-bold">{check.name} <span className={check.status === 'pass' ? 'text-success' : 'text-warning'}>{check.status}</span></div><div className="text-[10px] text-text-muted">{check.message}</div></div>)}</div></section>
    </div>
    <section className="rounded border border-border/50 bg-surface p-4"><div className="text-[10px] uppercase tracking-wider text-text-muted">Fleet timeline</div><div className="mt-3 space-y-2">{timeline.map((item, index) => <div key={String(item['id'] ?? index)} className="grid grid-cols-[10rem_7rem_1fr] gap-3 border-b border-border/20 pb-2 text-[11px]"><span className="font-mono text-text-muted">{String(item['timestamp'] ?? '')}</span><span className="uppercase text-accent">{String(item['type'] ?? 'event')}</span><span>{String(item['title'] ?? item['message'] ?? '')}</span></div>)}</div></section>
  </div>;
}
