import Link from 'next/link';
import { fleetSystemFetch } from '@/lib/fleet-fetch';

export const dynamic = 'force-dynamic';

type Installation = { id: string; hostname: string; status: string; profiles: number; desiredSkills: number; effectiveEnabledSkills: number; driftedSkills: Array<{ slug: string; status: string; error?: string | null }>; followOn: string };

export default async function HermesDriftPage(): Promise<React.ReactElement> {
  const result = await fleetSystemFetch<{ success: boolean; data: { generatedAt: string; installations: Installation[] } }>('ops/hermes-effective-state').catch(() => null);
  const state = result?.data;
  return <div className="space-y-5" data-testid="hermes-drift-page">
    <header className="flex items-end justify-between gap-4 border-b border-accent/20 pb-4">
      <div><div className="text-[10px] uppercase tracking-[.3em] text-accent">Desired ↔ observed</div><h1 className="mt-1 text-xl font-black uppercase tracking-wider">Hermes drift cockpit</h1><p className="mt-1 text-xs text-text-muted">Preview reconciliation from node-local evidence before changing fleet state.</p></div>
      <div className="text-right text-[10px] uppercase tracking-wider text-text-muted">Evidence age<br/><span className="font-mono text-primary">{state?.generatedAt ?? 'unavailable'}</span></div>
    </header>
    <div className="overflow-hidden rounded border border-border/50 bg-surface">
      <div className="grid grid-cols-[minmax(12rem,1fr)_repeat(4,minmax(6rem,.5fr))_minmax(14rem,1.2fr)] border-b border-border/50 px-3 py-2 text-[9px] uppercase tracking-[.2em] text-text-muted"><span>Node / runtime</span><span>Profiles</span><span>Desired</span><span>Effective</span><span>Drift</span><span>Reconcile preview</span></div>
      {(state?.installations ?? []).map((item) => <div key={item.id} className="grid grid-cols-[minmax(12rem,1fr)_repeat(4,minmax(6rem,.5fr))_minmax(14rem,1.2fr)] items-start border-b border-border/30 px-3 py-3 text-xs last:border-0">
        <div><div className="font-bold text-accent">{item.hostname}</div><div className="mt-1 text-[10px] uppercase text-text-muted">{item.status}</div></div><span>{item.profiles}</span><span>{item.desiredSkills}</span><span>{item.effectiveEnabledSkills}</span><span className={item.driftedSkills.length ? 'text-warning' : 'text-success'}>{item.driftedSkills.length}</span>
        <div><p className="text-[10px] leading-4 text-text-muted">{item.driftedSkills.length ? item.driftedSkills.map((d) => `${d.slug}: ${d.status}`).join(' · ') : 'Observed state matches assigned skill state.'}</p><Link href={`/orchestra/installations?installationId=${item.id}`} className="mt-2 inline-block text-[10px] font-bold uppercase tracking-wider text-primary hover:text-accent">Inspect and reconcile →</Link></div>
      </div>)}
      {!state && <div className="p-5 text-xs text-warning">Effective-state evidence is unavailable. No reconciliation actions are enabled.</div>}
    </div>
  </div>;
}
