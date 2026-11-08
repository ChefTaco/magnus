'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, CircleAlert, Code2, KeyRound, RefreshCw, Server } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, StatCard } from '@/components/ui/card';
import { PageItem, PageTransition } from '@/components/ui/page-transition';
import type { CodexInstallation } from '@/types/codex';
import { canRequestCodexUpdate } from '@/lib/codex-update';

export default function CodexOverviewPage(): React.ReactElement {
  const [installations, setInstallations] = useState<CodexInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatingNodeId, setUpdatingNodeId] = useState<string | null>(null);

  async function updateInstallation(installation: CodexInstallation): Promise<void> {
    setUpdatingNodeId(installation.nodeId);
    setError('');
    try {
      const response = await api.codex.update(installation.nodeId);
      if (!response.data) throw new Error(response.error?.message ?? 'Codex update failed');
      const updated = response.data;
      setInstallations((items) => items.map((item) => item.nodeId === updated.nodeId ? updated : item));
    } catch (updateError) {
      setError(`${installation.nodeName}: ${updateError instanceof Error ? updateError.message : 'Codex update failed'}`);
    } finally {
      setUpdatingNodeId(null);
    }
  }

  async function load(refreshLatest = false): Promise<void> {
    setLoading(true);
    setError('');
    try { setInstallations((await api.codex.installations(refreshLatest)).data ?? []); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Failed to load Codex fleet state'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  const installed = installations.filter((item) => item.installed && item.reachable);
  const healthyOauth = installed.filter((item) => item.auth.oauth);
  const updates = installed.filter((item) => item.updateAvailable);
  const needsAuth = installed.filter((item) => !item.auth.oauth);
  const latestVersion = useMemo(() => installed.find((item) => item.latestVersion)?.latestVersion ?? 'unavailable', [installed]);

  return (
    <PageTransition className="space-y-6">
      <PageItem>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-wider text-primary">Codex Agents</h1>
            <p className="mt-1 text-[11px] uppercase tracking-wider text-text-muted">ChatGPT OAuth and CLI release posture · API tokens disabled</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={loading || updatingNodeId !== null} icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={() => void load(true)}>Refresh</Button>
            <Link href="/codex/installations" className="inline-flex h-8 items-center gap-2 rounded border border-primary/60 bg-primary/10 px-3 text-[11px] font-medium uppercase tracking-wider text-primary hover:bg-primary/20"><Server className="h-3.5 w-3.5" />Installations</Link>
          </div>
        </div>
      </PageItem>
      {error && <div role="alert" className="rounded border border-danger/30 bg-danger/10 p-4 text-xs text-danger">{error}</div>}
      <PageItem>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <StatCard label="Codex Installed" value={installed.length} icon={<Code2 className="h-4 w-4" />} />
          <StatCard label="OAuth Healthy" value={healthyOauth.length} icon={<KeyRound className="h-4 w-4" />} />
          <StatCard label="Updates Available" value={updates.length} icon={<RefreshCw className="h-4 w-4" />} />
          <StatCard label="Needs Login" value={needsAuth.length} icon={<CircleAlert className="h-4 w-4" />} />
        </div>
      </PageItem>
      <PageItem>
        <Card title="Fleet Posture" description={`Latest published Codex CLI: ${latestVersion}`}>
          <div className="space-y-2">
            {installed.map((item) => (
              <div key={item.nodeId} className="flex flex-wrap items-center justify-between gap-3 rounded border border-border/50 bg-bg/50 px-3 py-2">
                <div>
                  <p className="text-xs font-medium text-text">{item.nodeName}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-text-muted">{item.version ?? (item.reachable ? 'not installed' : 'agent unreachable')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {item.updateAvailable && <Badge variant="warning">update</Badge>}
                  <Badge variant={item.auth.oauth ? 'success' : item.reachable ? 'warning' : 'danger'}>{item.auth.oauth ? 'OAuth current' : item.reachable ? item.auth.status.replaceAll('_', ' ') : 'unreachable'}</Badge>
                  {canRequestCodexUpdate(item) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={loading || updatingNodeId !== null}
                      aria-label={`Update Codex on ${item.nodeName}`}
                      icon={<RefreshCw className={`h-3.5 w-3.5 ${updatingNodeId === item.nodeId ? 'animate-spin' : ''}`} />}
                      onClick={() => void updateInstallation(item)}
                    >
                      {updatingNodeId === item.nodeId ? 'Updating Codex…' : item.latestVersion ? 'Update Codex' : 'Check & Update Codex'}
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {!loading && installed.length === 0 && <p className="text-xs text-text-muted">No Codex installations were detected across {installations.length} managed nodes.</p>}
            {loading && <p className="inline-flex items-center gap-2 text-xs text-text-muted"><Activity className="h-3.5 w-3.5 animate-pulse" />Loading cached Codex fleet state...</p>}
          </div>
        </Card>
      </PageItem>
    </PageTransition>
  );
}
