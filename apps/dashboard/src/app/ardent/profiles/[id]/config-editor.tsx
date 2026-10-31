'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

export function ConfigEditor({ nodeId, profileId, entry }: {
  nodeId: string; profileId: string; entry: { revision: string; text: string };
}): React.ReactElement {
  const [draft, setDraft] = useState(entry.text);
  const [saved, setSaved] = useState(entry);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setDraft(entry.text); setSaved(entry); setFeedback(''); setError(''); }, [entry.revision, entry.text]);

  async function act(action: 'config-validate' | 'config-save'): Promise<void> {
    setBusy(true); setFeedback(''); setError('');
    try {
      if (action === 'config-validate') {
        const response = await api.ardent.action<{ valid: boolean; runtime_problems: string[] }>(nodeId, profileId, action, { text: draft });
        const problems = response.data?.runtime_problems ?? [];
        setFeedback(problems.length ? `YAML valid. Runtime needs: ${problems.join('; ')}` : 'YAML valid. No runtime prerequisites reported.');
      } else {
        const response = await api.ardent.action<{ revision: string }>(nodeId, profileId, action, { text: draft, revision: saved.revision });
        if (!response.data?.revision) throw new Error('Ardent did not acknowledge the saved revision');
        setSaved({ text: draft, revision: response.data.revision });
        setFeedback('Saved on the node. Restart this profile to activate the new configuration.');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Ardent configuration action failed'); }
    finally { setBusy(false); }
  }

  return <div className="rounded border border-border/60 bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-semibold uppercase tracking-wider text-text">Profile YAML</p><p className="mt-1 text-[11px] text-text-muted">Edit references and settings; the runtime validates the complete versioned document.</p></div><span className="font-mono text-[10px] text-text-muted">Revision {saved.revision.slice(0, 12)}</span></div>
    <textarea aria-label="Profile YAML" spellCheck={false} value={draft} onChange={event => setDraft(event.target.value)} className="mt-3 h-[56vh] min-h-80 w-full resize-y rounded border border-border bg-bg p-4 font-mono text-[11px] leading-5 text-text focus:border-primary/50 focus:outline-none" />
    <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('config-validate')}>Validate</Button><Button size="sm" disabled={busy || draft === saved.text} onClick={() => void act('config-save')}>Save revision</Button><Button size="sm" variant="ghost" disabled={busy || draft === saved.text} onClick={() => setDraft(saved.text)}>Discard</Button></div>
    {feedback && <p role="status" className="mt-3 text-xs text-success">{feedback}</p>}{error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
  </div>;
}
