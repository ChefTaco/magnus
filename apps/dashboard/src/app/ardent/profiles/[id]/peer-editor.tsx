'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { ardentError } from './action-button';

type Entry = { text: string; revision: string };
export function PeerEditor({ nodeId, profileId, entry, running }: { nodeId: string; profileId: string; entry: Entry; running: boolean }): React.ReactElement {
  const [text, setText] = useState(entry.text);
  const [savedText, setSavedText] = useState(entry.text);
  const [revision, setRevision] = useState(entry.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  async function save(): Promise<void> {
    setBusy(true); setError(''); setFeedback('');
    try {
      const validation = await api.ardent.action<{ valid: boolean; peers: number }>(nodeId, profileId, 'peer-validate', { text });
      if (!validation.data?.valid) throw new Error('Peer configuration failed validation');
      const response = await api.ardent.action<{ revision: string; activation_required: boolean }>(nodeId, profileId, 'peer-save', { text, revision });
      if (!response.data?.revision) throw new Error('Node did not confirm the peer revision');
      setRevision(response.data.revision);
      setSavedText(text);
      setFeedback(`${validation.data.peers} peer routes saved. ${running ? 'Restart this profile to activate them.' : 'They activate when this profile starts.'}`);
    } catch (reason) { setError(await ardentError(reason)); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 rounded border border-border/60 bg-surface p-4"><p className="text-xs font-semibold uppercase tracking-wider text-text">Authorized peer configuration</p><p className="mt-1 text-xs text-text-muted">Peer URLs and token environment variable names are explicit. Discovery does not authorize an unlisted peer.</p><textarea aria-label="Peer YAML" spellCheck={false} value={text} onChange={event => setText(event.target.value)} className="mt-3 min-h-56 w-full resize-y rounded border border-border bg-bg p-3 font-mono text-xs leading-5 text-text" /><div className="mt-3 flex flex-wrap items-center gap-3"><Button size="sm" disabled={busy || text === savedText} onClick={() => void save()}>{busy ? 'Saving…' : 'Validate and save'}</Button><span className="font-mono text-[10px] text-text-muted">Revision {revision.slice(0, 12)}</span></div>{feedback && <p role="status" className="mt-2 text-xs text-success">{feedback}</p>}{error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}</div>;
}
