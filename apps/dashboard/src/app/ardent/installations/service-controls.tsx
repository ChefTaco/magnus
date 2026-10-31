'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { ardentError } from '../profiles/[id]/action-button';

export function ServiceControls({ nodeId, profileId, running, refresh }: { nodeId: string; profileId: string; running: boolean; refresh: () => Promise<void> }): React.ReactElement {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  async function act(action: 'service-start' | 'service-stop' | 'service-restart'): Promise<void> {
    setBusy(action); setError(''); setFeedback('');
    try {
      const response = await api.ardent.action<{ service: string; running: boolean }>(nodeId, profileId, action);
      if (!response.data?.service) throw new Error('Node did not acknowledge Ardent service state');
      setFeedback(`${profileId} ${response.data.running ? 'running' : 'stopped'} on this node.`);
      await refresh();
    } catch (reason) { setError(await ardentError(reason)); }
    finally { setBusy(''); }
  }
  return <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
    <Button size="sm" disabled={Boolean(busy) || running} onClick={() => void act('service-start')}>Start</Button>
    <Button size="sm" variant="secondary" disabled={Boolean(busy) || !running} onClick={() => void act('service-restart')}>Restart</Button>
    <Button size="sm" variant="danger" disabled={Boolean(busy) || !running} onClick={() => void act('service-stop')}>Stop</Button>
    {busy && <span className="text-[11px] text-text-muted">Waiting for node receipt…</span>}
    {feedback && <span role="status" className="text-[11px] text-success">{feedback}</span>}{error && <span role="alert" className="text-[11px] text-danger">{error}</span>}
  </div>;
}
