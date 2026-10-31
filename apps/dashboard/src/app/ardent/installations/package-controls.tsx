'use client';

import { useState } from 'react';
import type { ArdentFleetInstallation } from '@hivemagnus/magnus-contracts';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { ardentError } from '../profiles/[id]/action-button';

export function PackageControls({ item, refresh }: { item: ArdentFleetInstallation; refresh: () => Promise<void> }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const staged = item.stagedPackage;
  async function install(): Promise<void> {
    setBusy(true); setError(''); setFeedback('');
    try {
      // Package installation is node-wide; the profile segment only satisfies the action route.
      const result = await api.ardent.action<{ installed: boolean; version: string; changed: boolean }>(item.nodeId, item.profiles[0]?.id ?? 'default', 'package-install');
      if (!result.data?.installed || result.data.version !== staged?.version) throw new Error('Node did not verify the installed Ardent package');
      setFeedback(`Ardent ${result.data.version} installed. Create or start a profile when configured.`);
      await refresh();
    } catch (reason) { setError(await ardentError(reason)); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 border-t border-border/50 pt-3 text-xs">
    <div className="flex flex-wrap items-center gap-2"><span className="text-text-muted">Release package</span><span className="font-mono text-text">{staged?.version ?? 'not staged'}</span>{staged && item.version !== staged.version && <Button size="sm" disabled={busy || !item.reachable} onClick={() => void install()}>{busy ? 'Installing…' : item.installed ? 'Update package' : 'Install package'}</Button>}</div>
    {item.stagedPackageError && <p role="alert" className="mt-2 text-danger">{item.stagedPackageError}</p>}
    {feedback && <p role="status" className="mt-2 text-success">{feedback}</p>}{error && <p role="alert" className="mt-2 text-danger">{error}</p>}
  </div>;
}
