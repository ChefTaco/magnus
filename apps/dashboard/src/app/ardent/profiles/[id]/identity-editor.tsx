'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

type IdentityEntry = { text: string; revision: string };
function IdentityFile({ nodeId, profileId, kind, entry }: { nodeId: string; profileId: string; kind: 'soul' | 'identity'; entry: IdentityEntry }): React.ReactElement {
  const [draft, setDraft] = useState(entry.text);
  const [saved, setSaved] = useState(entry);
  const [history, setHistory] = useState<Array<{ name: string; revision: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setDraft(entry.text); setSaved(entry); setFeedback(''); setError(''); }, [entry.revision, entry.text]);
  async function save(): Promise<void> {
    setBusy(true); setError(''); setFeedback('');
    try { const response = await api.ardent.action<IdentityEntry>(nodeId, profileId, 'identity-save', { text: draft, revision: saved.revision }, kind); if (!response.data?.revision) throw new Error('Ardent did not acknowledge the identity revision'); setSaved(response.data); setFeedback('Saved. The new persona applies to subsequent turns.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Identity save failed'); }
    finally { setBusy(false); }
  }
  async function loadHistory(): Promise<void> {
    setError('');
    try { const response = await api.ardent.resource<{ history: Array<{ name: string; revision: string }> }>(nodeId, profileId, `identity/${kind}/history`); setHistory(response.data?.history ?? []); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Identity history is unavailable'); }
  }
  async function restore(name: string): Promise<void> {
    setBusy(true); setError(''); setFeedback('');
    try { const response = await api.ardent.action<IdentityEntry>(nodeId, profileId, 'identity-restore', { history_name: name, revision: saved.revision }, kind); if (!response.data?.revision) throw new Error('Ardent did not acknowledge the restored revision'); setSaved(response.data); setDraft(response.data.text); setFeedback('Previous version restored.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Identity restore failed'); }
    finally { setBusy(false); }
  }
  return <div className="min-w-0 rounded border border-border/60 bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wider text-text">{kind === 'soul' ? 'SOUL.md' : 'IDENTITY.md'}</p><span className="font-mono text-[10px] text-text-muted">Revision {saved.revision.slice(0, 12)}</span></div>
    <textarea aria-label={kind === 'soul' ? 'SOUL.md' : 'IDENTITY.md'} value={draft} onChange={event => setDraft(event.target.value)} className="mt-3 h-[45vh] min-h-64 w-full resize-y rounded border border-border bg-bg p-4 font-mono text-xs leading-5 text-text focus:border-primary/50 focus:outline-none" />
    <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={busy || draft === saved.text} onClick={() => void save()}>Save</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => void loadHistory()}>Previous versions</Button></div>
    {history.length > 0 && <div className="mt-3 space-y-1 border-t border-border/50 pt-3">{history.map(item => <div key={item.name} className="flex flex-wrap items-center justify-between gap-2 text-[11px]"><span className="break-all font-mono text-text-muted">{item.name}</span><Button size="sm" variant="secondary" disabled={busy} onClick={() => void restore(item.name)}>Restore</Button></div>)}</div>}
    {feedback && <p role="status" className="mt-3 text-xs text-success">{feedback}</p>}{error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
  </div>;
}
export function IdentityEditor({ nodeId, profileId, entries }: { nodeId: string; profileId: string; entries: { soul: IdentityEntry; identity: IdentityEntry } }): React.ReactElement {
  return <div className="grid gap-3 xl:grid-cols-2"><IdentityFile nodeId={nodeId} profileId={profileId} kind="soul" entry={entries.soul} /><IdentityFile nodeId={nodeId} profileId={profileId} kind="identity" entry={entries.identity} /></div>;
}
