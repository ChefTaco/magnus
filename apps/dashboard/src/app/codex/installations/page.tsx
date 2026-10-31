'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Server } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { PageItem, PageTransition } from '@/components/ui/page-transition';
import { CodexInstallationCard } from '@/components/codex/codex-installation-card';
import type { CodexInstallation } from '@/types/codex';

export default function CodexInstallationsPage(): React.ReactElement {
  const [installations, setInstallations] = useState<CodexInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const replaceInstallation = useCallback((updated: CodexInstallation) => {
    setInstallations((items) => items.map((item) => item.nodeId === updated.nodeId ? updated : item));
  }, []);

  async function load(refreshLatest = false): Promise<void> {
    setLoading(true);
    setError('');
    try { setInstallations((await api.codex.installations(refreshLatest)).data ?? []); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Failed to load Codex installations'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  const detectedInstallations = installations.filter((item) => item.installed && item.reachable);
  const authenticatedCount = detectedInstallations.filter((item) => item.auth.oauth).length;

  return (
    <PageTransition className="space-y-6">
      <PageItem>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-wider text-primary">Codex Installations</h1>
            <p className="mt-1 text-[11px] uppercase tracking-wider text-text-muted">{loading ? 'Checking installations...' : `${installations.length} managed nodes · ${detectedInstallations.length} Codex installations · ${authenticatedCount} authenticated with ChatGPT OAuth`}</p>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="secondary" disabled={loading} icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={() => void load(true)}>Refresh All</Button>
            <Server className="h-6 w-6 text-primary" />
          </div>
        </div>
      </PageItem>
      <PageItem>
        <div className="rounded border border-primary/30 bg-primary/5 p-4 text-xs leading-5 text-text-muted">
          Magnus validates managed ChatGPT OAuth through Codex App Server without silently refreshing an expired access token. Expired credentials are logged out automatically; generating a device code starts only the ChatGPT subscription flow.
        </div>
      </PageItem>
      {error && <div className="rounded border border-danger/30 bg-danger/10 p-4 text-xs text-danger">{error}</div>}
      <PageItem>
        <div className="grid gap-4 xl:grid-cols-2">
          {detectedInstallations.map((installation) => <CodexInstallationCard key={installation.nodeId} installation={installation} onChange={replaceInstallation} />)}
          {!loading && detectedInstallations.length === 0 && <div className="rounded border border-border bg-surface p-8 text-center text-xs text-text-muted xl:col-span-2">No Codex installations were detected across {installations.length} managed nodes.</div>}
        </div>
      </PageItem>
    </PageTransition>
  );
}
