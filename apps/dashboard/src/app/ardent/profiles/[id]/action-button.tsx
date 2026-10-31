'use client';

import { httpErrorBody } from '@/lib/http-error-body';
import { agentDisabledMessage } from '@/lib/agent-privilege';
import { useState } from 'react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

export async function ardentError(reason: unknown): Promise<string> {
  if (reason && typeof reason === 'object' && 'response' in reason) {
    const body = await httpErrorBody(reason);
    const disabled = agentDisabledMessage(body);
    if (disabled) return disabled;
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      const nested = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {};
      const message = typeof nested.message === 'string' ? nested.message : typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : '';
      if (message) return message.slice(0, 300);
    }
  }
  return reason instanceof Error ? reason.message : 'Ardent operation failed';
}

export function ActionButton({ nodeId, profileId, action, target, body, label, disabled, onSuccess }: {
  nodeId: string; profileId: string; action: string; target?: string; body?: unknown; label: string; disabled?: boolean; onSuccess?: (result: unknown) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  async function run(): Promise<void> {
    setBusy(true); setFeedback(''); setError('');
    try {
      const response = await api.ardent.action<unknown>(nodeId, profileId, action, body, target);
      if (!response.success) throw new Error('Ardent did not acknowledge the operation');
      onSuccess?.(response.data);
      setFeedback(action === 'provider-test' ? `Probe completed: ${String((response.data as Record<string, unknown> | undefined)?.auth_mode ?? (response.data as Record<string, unknown> | undefined)?.backend ?? 'ready')}` : 'Operation completed.');
    } catch (reason) { setError(await ardentError(reason)); }
    finally { setBusy(false); }
  }
  return <div className="mt-3"><Button size="sm" variant="secondary" disabled={disabled || busy} onClick={() => void run()}>{busy ? 'Checking…' : label}</Button>{feedback && <p role="status" className="mt-2 text-[11px] text-success">{feedback}</p>}{error && <p role="alert" className="mt-2 text-[11px] text-danger">{error}</p>}</div>;
}
