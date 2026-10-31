'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { CodexInstallationCard } from '@/components/codex/codex-installation-card';
import type { CodexInstallation } from '@/types/codex';
import { ardentError } from './action-button';

export function CodexNodePanel({ nodeId }: { nodeId: string }): React.ReactElement {
  const [installation, setInstallation] = useState<CodexInstallation | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.codex.installation(nodeId).then(response => {
      if (!active) return;
      if (!response.data) throw new Error('Node Codex inventory returned no installation');
      setInstallation(response.data);
    }).catch(async reason => { if (active) setError(await ardentError(reason)); });
    return () => { active = false; };
  }, [nodeId]);
  if (error) return <p role="alert" className="mt-4 rounded border border-danger/40 bg-danger/10 p-4 text-xs text-danger">Node Codex status: {error}</p>;
  if (!installation) return <p className="mt-4 rounded border border-border bg-surface p-4 text-xs text-text-muted">Reading node-local Codex login…</p>;
  return <div className="mt-4 space-y-2"><CodexInstallationCard installation={installation} onChange={setInstallation} /><p className="text-[11px] text-text-muted">The device flow uses node-local Codex. When browser OAuth is available on the node, its profile owner can use <code>codex login</code>; refresh this card to read the resulting account state. OAuth credentials stay with Codex.</p></div>;
}
