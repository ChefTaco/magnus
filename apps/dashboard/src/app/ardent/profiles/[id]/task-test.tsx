'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { ardentError } from './action-button';

export function TaskTest({ nodeId, profileId }: { nodeId: string; profileId: string }): React.ReactElement {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState('');
  const [error, setError] = useState('');
  async function submit(): Promise<void> {
    setBusy(true); setError(''); setAccepted('');
    try {
      const response = await api.ardent.action<{ task_id: string; state: string }>(nodeId, profileId, 'task-submit', { prompt: prompt.trim(), idempotency_key: crypto.randomUUID() });
      if (!response.data?.task_id) throw new Error('Ardent did not return a durable task ID');
      setAccepted(`Task ${response.data.task_id.slice(0, 8)} accepted. Refresh the profile to inspect its result.`);
      setPrompt('');
    } catch (reason) { setError(await ardentError(reason)); }
    finally { setBusy(false); }
  }
  return <div className="mb-4 border-b border-border/50 pb-4">
    <p className="text-xs font-semibold uppercase tracking-wider text-text">Test research request</p>
    <p className="mt-1 text-[11px] text-text-muted">Submit a bounded diagnostic task. The result appears in this profile&apos;s task journal.</p>
    <textarea aria-label="Test research prompt" maxLength={4000} value={prompt} onChange={event => setPrompt(event.target.value)} className="mt-3 h-24 w-full resize-y rounded border border-border bg-bg p-3 text-xs text-text focus:border-primary/50 focus:outline-none" />
    <Button size="sm" disabled={busy || !prompt.trim()} onClick={() => void submit()}>Submit test</Button>
    {accepted && <p role="status" className="mt-2 text-[11px] text-success">{accepted}</p>}{error && <p role="alert" className="mt-2 text-[11px] text-danger">{error}</p>}
  </div>;
}
