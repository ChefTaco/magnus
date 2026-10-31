'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge, statusVariant } from '@/components/ui/badge';
import { ardentError } from './action-button';

type Status = { status: 'ready' | 'degraded'; agent_id: string; workspace_id: string; retrieval: string | null; storage: string | null; reason: string | null };
type Memory = { id: string; content: string; created_at?: string; source?: string };

export function MemoryPanel({ nodeId, profileId, status }: { nodeId: string; profileId: string; status: Status }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Memory[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function search(): Promise<void> {
    if (!query.trim()) { setError('Enter a memory search query.'); return; }
    setBusy(true); setError(''); setSearched(false);
    try {
      const response = await api.ardent.action<{ results: Memory[] }>(nodeId, profileId, 'memory-search', { query: query.trim() });
      if (!Array.isArray(response.data?.results)) throw new Error('HiveMem did not return a search result');
      setResults(response.data.results);
      setSearched(true);
    } catch (reason) { setError(await ardentError(reason)); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 rounded border border-border/60 bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wider text-text">HiveMem</p><Badge variant={statusVariant(status.status)}>{status.status}</Badge></div><p className="mt-2 text-xs text-text-muted">Agent {status.agent_id} · workspace {status.workspace_id}</p>{status.status === 'ready' ? <p className="mt-1 text-[11px] text-text-muted">Retrieval {status.retrieval ?? 'unknown'} · storage {status.storage ?? 'unknown'}</p> : <p role="alert" className="mt-2 text-xs text-danger">{status.reason ?? 'HiveMem unavailable'}</p>}<div className="mt-4 flex flex-wrap gap-2"><input aria-label="Search private memory" value={query} maxLength={1000} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void search(); }} className="min-w-48 flex-1 rounded border border-border bg-bg px-3 py-2 text-xs text-text" placeholder="Search this profile's private memory" /><Button size="sm" disabled={busy || status.status !== 'ready'} onClick={() => void search()}>{busy ? 'Searching…' : 'Search memory'}</Button></div>{error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}{searched && <div className="mt-3 space-y-2">{results.length ? results.map(item => <div key={item.id} className="rounded border border-border/50 bg-bg/40 p-3"><p className="whitespace-pre-wrap text-xs text-text">{item.content}</p><p className="mt-2 font-mono text-[10px] text-text-muted">{item.id}{item.created_at ? ` · ${new Date(item.created_at).toLocaleString()}` : ''}</p></div>) : <p className="text-xs text-text-muted">No permitted memories matched.</p>}</div>}</div>;
}
