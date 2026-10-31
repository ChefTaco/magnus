'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Download, Loader2, RefreshCw, RotateCw, Save, Settings } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import type { HermesConfigFile, HermesInstallation, HermesOperationJob, HermesProfile } from '@/types/orchestra';
import type { ApiResponse } from '@/types/contracts';

function jobLabel(job: HermesOperationJob): string {
  return `${job.type} ${job.status}`;
}

function unwrap<T>(response: ApiResponse<T>, fallback: string): T {
  if (!response.data) throw new Error(response.error?.message ?? fallback);
  return response.data;
}

function gatewayProfile(profiles: HermesProfile[] | undefined): HermesProfile | null {
  if (!profiles?.length) return null;
  return profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
}

function ActionButton({
  label,
  busyLabel,
  icon,
  disabled,
  onRun,
}: {
  label: string;
  busyLabel: string;
  icon: ReactNode;
  disabled?: boolean;
  onRun: () => Promise<HermesOperationJob>;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function run(): Promise<void> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const job = await onRun();
      setMessage(jobLabel(job));
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || disabled}
        onClick={() => void run()}
        icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      >
        {busy ? busyLabel : label}
      </Button>
      {message && <span className="text-[10px] text-success">{message}</span>}
      {error && <span className="max-w-56 text-[10px] leading-4 text-danger">{error}</span>}
    </div>
  );
}

export function HermesRouterInstallButton({ installation }: { installation: HermesInstallation }): React.ReactElement {
  return (
    <ActionButton
      label="Install"
      busyLabel="Installing"
      icon={<Download className="h-3.5 w-3.5" />}
      onRun={() => api.hermes.configure(installation.id).then((response) => unwrap(response, 'Router install failed'))}
    />
  );
}

export function HermesInstallationActions({ installation, profiles }: { installation: HermesInstallation; profiles?: HermesProfile[] }): React.ReactElement {
  const targetProfile = gatewayProfile(profiles ?? installation.profiles);
  return (
    <div className="flex flex-wrap gap-2">
      <ActionButton
        label="Hermes Update"
        busyLabel="Updating"
        icon={<RefreshCw className="h-3.5 w-3.5" />}
        onRun={() => api.hermes.update(installation.id).then((response) => unwrap(response, 'Hermes update failed'))}
      />
      <ActionButton
        label="Gateway Restart"
        busyLabel="Restarting"
        icon={<RotateCw className="h-3.5 w-3.5" />}
        disabled={!targetProfile}
        onRun={() => targetProfile ? api.hermes.gatewayAction(targetProfile.id, 'restart').then((response) => unwrap(response, 'Gateway restart failed')) : Promise.reject(new Error('No Hermes profile is available for gateway restart'))}
      />
    </div>
  );
}

export function HermesInstallationConfigButton({ installation }: { installation: HermesInstallation }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<HermesConfigFile | null>(null);
  const [configYaml, setConfigYaml] = useState('');
  const [originalYaml, setOriginalYaml] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const changed = useMemo(() => configYaml !== originalYaml, [configYaml, originalYaml]);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    async function load(): Promise<void> {
      setLoading(true);
      setError('');
      setMessage('');
      try {
        const response = await api.hermes.config(installation.id);
        if (!mounted) return;
        const data = unwrap(response, 'Failed to load Hermes config');
        setConfig(data);
        setConfigYaml(data.configYaml);
        setOriginalYaml(data.configYaml);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : 'Failed to load Hermes config');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load();
    return () => { mounted = false; };
  }, [installation.id, open]);

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await api.hermes.updateConfig(installation.id, { configYaml });
      setOriginalYaml(configYaml);
      setMessage(jobLabel(unwrap(response, 'Failed to save Hermes config')));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Hermes config');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} icon={<Settings className="h-3.5 w-3.5" />}>
        Config
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`${installation.displayName ?? installation.hostname} Config`}
        description="Running Hermes Agent config.yaml from the remote installation."
        icon={<Settings className="h-5 w-5 text-primary" />}
        className="max-h-[92vh] max-w-[calc(100vw-1.5rem)] overflow-hidden bg-[#06060d] p-4 sm:max-w-5xl sm:p-6"
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-muted">
            <span className="font-mono">{config?.path ?? installation.configuration?.configPath ?? `${installation.hermesHome}/config.yaml`}</span>
            <span>{config?.exists === false ? 'new config file' : `last synced ${config?.lastSyncedAt ? new Date(config.lastSyncedAt).toLocaleString() : 'unknown'}`}</span>
          </div>
          {error && <div className="rounded border border-danger/30 bg-danger/10 p-3 text-xs text-danger">{error}</div>}
          {message && <div className="rounded border border-success/30 bg-success/10 p-3 text-xs text-success">{message}</div>}
          {loading ? (
            <div className="flex h-72 items-center justify-center rounded border border-border bg-bg text-xs text-text-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading config...
            </div>
          ) : (
            <textarea
              value={configYaml}
              onChange={(event) => setConfigYaml(event.target.value)}
              spellCheck={false}
              placeholder="# config.yaml is empty on this Hermes Agent"
              className="h-[54vh] min-h-72 w-full resize-none rounded border border-border bg-bg p-3 font-mono text-[11px] leading-5 text-text outline-none placeholder:text-text-muted/60 focus:border-primary sm:h-[58vh]"
              aria-label="Hermes config YAML"
            />
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              disabled={loading || saving || !changed}
              onClick={() => void save()}
              icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            >
              {saving ? 'Saving' : 'Save Config'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
