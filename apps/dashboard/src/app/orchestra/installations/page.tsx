'use client';

import { useEffect, useState } from 'react';
import { Bot, Server } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Card } from '@/components/ui/card';
import { Badge, statusVariant } from '@/components/ui/badge';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import { HermesInstallationActions, HermesRouterInstallButton } from '@/components/orchestra/installation-actions';
import { HiveMemTokenStatus } from '@/components/orchestra/hivemem-token-status';
import type { HermesInstallation } from '@/types/orchestra';

export default function HermesInstallationsPage(): React.ReactElement {
  const [installations, setInstallations] = useState<HermesInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');

  useEffect(() => {
    let mounted = true;
    async function load(): Promise<void> {
      setLoading(true);
      setFetchError('');
      try {
        const res = await api.hermes.installations();
        if (mounted) setInstallations(res.data ?? []);
      } catch (err) {
        if (mounted) setFetchError(err instanceof Error ? err.message : 'Failed to load Hermes installations from the active Control API.');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load();
    return () => { mounted = false; };
  }, []);

  const detectedInstallations = installations.filter((installation) => installation.status !== 'not_installed');

  return (
    <PageTransition className="space-y-6">
      <PageItem>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-wider text-primary">Hermes Installations</h1>
            <p className="mt-1 text-[11px] uppercase tracking-wider text-text-muted">
              {loading ? 'Loading installation inventory...' : `${detectedInstallations.length} detected installation${detectedInstallations.length === 1 ? '' : 's'}`}
            </p>
          </div>
          <Server className="h-6 w-6 text-primary" />
        </div>
      </PageItem>

      {fetchError && <div className="rounded border border-danger/30 bg-danger/10 p-4 text-xs text-danger">{fetchError}</div>}

      <PageItem>
        <div className="grid gap-4 xl:grid-cols-2">
          {detectedInstallations.map((installation) => (
            <Card key={installation.id} title={installation.displayName ?? installation.hostname} description={installation.hostname} action={<Badge variant={statusVariant(installation.status)}>{installation.status}</Badge>}>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-[11px] text-text-muted">
                  <div><span className="block uppercase tracking-wider text-text-muted/70">Hermes Home</span><span className="font-mono text-text">{installation.hermesHome}</span></div>
                  <div><span className="block uppercase tracking-wider text-text-muted/70">Version</span><span className="font-mono text-text">{installation.version ?? 'unknown'}</span></div>
                  <div><span className="block uppercase tracking-wider text-text-muted/70">Gateway</span><Badge variant={statusVariant(installation.gatewayStatus)}>{installation.gatewayStatus}</Badge></div>
                  <div><span className="block uppercase tracking-wider text-text-muted/70">Dashboard</span><Badge variant={statusVariant(installation.dashboardStatus)}>{installation.dashboardStatus}</Badge></div>
                  <div><span className="block uppercase tracking-wider text-text-muted/70">Profiles</span><span className="text-text">{installation.profiles?.length ?? 0}</span></div>
                  <div><span className="block uppercase tracking-wider text-text-muted/70">Last Sync</span><span className="text-text">{installation.lastSyncedAt ? new Date(installation.lastSyncedAt).toLocaleString() : 'never'}</span></div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <span className="block uppercase tracking-wider text-text-muted/70">Model Router</span>
                      <Badge variant={installation.configuration?.magnusRouterConfigured ? 'success' : 'warning'}>{installation.configuration?.magnusRouterConfigured ? 'Hive primary' : 'not configured'}</Badge>
                    </div>
                    {!installation.configuration?.magnusRouterConfigured && <HermesRouterInstallButton installation={installation} />}
                  </div>
                  <div><span className="block uppercase tracking-wider text-text-muted/70">Memory</span><Badge variant={installation.configuration?.hiveMemConfigured ? 'success' : 'warning'}>{installation.configuration?.hiveMemConfigured ? 'HiveMem active' : 'not configured'}</Badge><HiveMemTokenStatus configuration={installation.configuration} /></div>
                  <div><span className="block uppercase tracking-wider text-text-muted/70">OpenAI Runtime</span><Badge variant={installation.configuration?.openaiRuntime === 'codex_app_server' ? 'success' : 'warning'}>{installation.configuration?.openaiRuntime === 'codex_app_server' ? 'Codex app-server' : 'Hermes default'}</Badge></div>
                </div>
                {installation.profiles && installation.profiles.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {installation.profiles.slice(0, 6).map((profile) => (
                      <span key={profile.id} className="inline-flex items-center gap-1 rounded border border-border/60 px-2 py-1 text-[10px] text-text-muted"><Bot className="h-3 w-3" />{profile.name}</span>
                    ))}
                  </div>
                )}
                {installation.configuration && (
                  <p className="text-[10px] text-text-muted">Magnus Hermes plugins: adapter required for upstream Hermes Agent plugin compatibility.</p>
                )}
                <HermesInstallationActions installation={installation} />
              </div>
            </Card>
          ))}
          {!loading && !fetchError && detectedInstallations.length === 0 && <div className="rounded border border-border bg-surface p-8 text-center text-xs text-text-muted xl:col-span-2">No Hermes Agent installations detected.</div>}
        </div>
      </PageItem>
    </PageTransition>
  );
}
