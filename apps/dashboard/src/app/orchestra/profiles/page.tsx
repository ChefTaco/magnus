'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bot, Server, Users } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Card } from '@/components/ui/card';
import { Badge, statusVariant } from '@/components/ui/badge';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import { HermesInstallationConfigButton } from '@/components/orchestra/installation-actions';
import type { HermesInstallation, HermesProfile } from '@/types/orchestra';

function isDetected(installation: HermesInstallation): boolean {
  return installation.status !== 'not_installed';
}

export default function HermesProfilesPage(): React.ReactElement {
  const [installations, setInstallations] = useState<HermesInstallation[]>([]);
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    async function load(): Promise<void> {
      setLoading(true);
      setError('');
      try {
        const [installationsRes, profilesRes] = await Promise.all([
          api.hermes.installations(),
          api.hermes.profiles(),
        ]);
        if (!mounted) return;
        setInstallations((installationsRes.data ?? []).filter(isDetected));
        setProfiles(profilesRes.data ?? []);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : 'Failed to load Hermes profiles');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load();
    return () => { mounted = false; };
  }, []);

  const profilesByInstallation = useMemo(() => {
    const map = new Map<string, HermesProfile[]>();
    for (const profile of profiles) map.set(profile.installationId, [...(map.get(profile.installationId) ?? []), profile]);
    return map;
  }, [profiles]);

  const profileCount = installations.reduce((count, installation) => count + (profilesByInstallation.get(installation.id)?.length ?? installation.profiles?.length ?? 0), 0);

  return (
    <PageTransition className="space-y-6">
      <PageItem>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-wider text-primary">Hermes Profiles</h1>
            <p className="mt-1 text-[11px] uppercase tracking-wider text-text-muted">
              {loading ? 'Loading profiles...' : `${profileCount} profile${profileCount === 1 ? '' : 's'} from ${installations.length} detected installation${installations.length === 1 ? '' : 's'}`}
            </p>
          </div>
          <Users className="h-6 w-6 text-primary" />
        </div>
      </PageItem>

      {error && <div className="rounded border border-danger/30 bg-danger/10 p-4 text-xs text-danger">{error}</div>}

      <PageItem>
        <div className="grid gap-4 xl:grid-cols-2">
          {installations.map((installation) => {
            const linkedProfiles = profilesByInstallation.get(installation.id) ?? installation.profiles ?? [];
            return (
              <Card
                key={installation.id}
                title={installation.displayName ?? installation.hostname}
                description={`${installation.hostname} · ${installation.hermesHome}`}
                action={<HermesInstallationConfigButton installation={installation} />}
              >
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3 text-[11px] text-text-muted">
                    <div><span className="block uppercase tracking-wider text-text-muted/70">Status</span><Badge variant={statusVariant(installation.status)}>{installation.status}</Badge></div>
                    <div><span className="block uppercase tracking-wider text-text-muted/70">Version</span><span className="font-mono text-text">{installation.version ?? 'unknown'}</span></div>
                    <div><span className="block uppercase tracking-wider text-text-muted/70">Config</span><span className="font-mono text-text">{installation.configuration?.configPath ?? `${installation.hermesHome}/config.yaml`}</span></div>
                    <div><span className="block uppercase tracking-wider text-text-muted/70">Model Router</span><Badge variant={installation.configuration?.magnusRouterConfigured ? 'success' : 'warning'}>{installation.configuration?.magnusRouterConfigured ? 'Hive primary' : 'not configured'}</Badge></div>
                  </div>

                  <div className="space-y-2">
                    {linkedProfiles.map((profile) => (
                      <div key={profile.id} className="rounded border border-border/50 bg-bg/50 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="flex items-center gap-2 text-sm font-medium text-text"><Bot className="h-3.5 w-3.5 text-primary" />{profile.name}</p>
                            <p className="mt-1 font-mono text-[10px] text-text-muted">{profile.profileHome || 'profile home unknown'}</p>
                          </div>
                          {profile.isDefault && <Badge variant="info">default</Badge>}
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3 text-[11px] text-text-muted">
                          <div><span className="block uppercase tracking-wider text-text-muted/70">Gateway</span><Badge variant={statusVariant(profile.gatewayStatus)}>{profile.gatewayStatus}</Badge></div>
                          <div><span className="block uppercase tracking-wider text-text-muted/70">Provider</span><span className="text-text">{profile.providerSummary ?? 'unknown'}</span></div>
                          <div><span className="block uppercase tracking-wider text-text-muted/70">Model</span><span className="text-text">{profile.modelSummary ?? 'unknown'}</span></div>
                          <div><span className="block uppercase tracking-wider text-text-muted/70">API Server</span><Badge variant={profile.apiServerEnabled ? 'success' : 'default'}>{profile.apiServerEnabled ? `enabled:${profile.apiServerPort ?? '?'}` : 'disabled'}</Badge></div>
                        </div>
                      </div>
                    ))}
                    {linkedProfiles.length === 0 && (
                      <div className="rounded border border-border/50 bg-bg/50 p-4 text-xs text-text-muted">
                        No profiles were reported by this running Hermes Agent.
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
          {!loading && installations.length === 0 && (
            <div className="rounded border border-border bg-surface p-8 text-center text-xs text-text-muted xl:col-span-2">
              <Server className="mx-auto mb-2 h-5 w-5 text-primary" />No detected Hermes Agent installations are available yet.
            </div>
          )}
        </div>
      </PageItem>
    </PageTransition>
  );
}
