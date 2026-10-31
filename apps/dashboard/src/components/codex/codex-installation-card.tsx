'use client';

import { useEffect, useState } from 'react';
import { Check, Clipboard, ExternalLink, KeyRound, LogOut, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { ApiResponse } from '@/types/contracts';
import type { CodexDeviceAuthSession, CodexInstallation } from '@/types/codex';
import { canRequestCodexUpdate } from '@/lib/codex-update';

function unwrap<T>(response: ApiResponse<T>, fallback: string): T {
  if (response.data !== undefined) return response.data;
  throw new Error(response.error?.message ?? fallback);
}

function dateLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'not available';
}

function authVariant(status: CodexInstallation['auth']['status']): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'authenticated') return 'success';
  if (status === 'error') return 'danger';
  if (status === 'expired_logged_out' || status === 'wrong_auth_mode') return 'warning';
  return 'default';
}

function authLabel(status: CodexInstallation['auth']['status']): string {
  return status.replaceAll('_', ' ');
}

export function CodexInstallationCard({
  installation,
  onChange,
}: {
  installation: CodexInstallation;
  onChange: (installation: CodexInstallation) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [session, setSession] = useState<CodexDeviceAuthSession | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!session || session.status !== 'pending') return;
    const timer = window.setInterval(async () => {
      try {
        const next = unwrap(await api.codex.deviceAuth(installation.nodeId, session.id), 'Device login status failed');
        setSession(next);
        if (next.status === 'completed') {
          const refreshed = unwrap(await api.codex.installation(installation.nodeId), 'Codex status refresh failed');
          onChange(refreshed);
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : 'Device login status failed');
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [installation.nodeId, onChange, session]);

  async function run(label: string, action: () => Promise<CodexInstallation>): Promise<void> {
    setBusy(label);
    setError('');
    try { onChange(await action()); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : `${label} failed`); }
    finally { setBusy(null); }
  }

  async function startDeviceLogin(): Promise<void> {
    setBusy('device');
    setError('');
    try {
      setSession(unwrap(await api.codex.startDeviceAuth(installation.nodeId), 'Could not create a Codex device code'));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not create a Codex device code');
    } finally {
      setBusy(null);
    }
  }

  async function cancelDeviceLogin(): Promise<void> {
    if (!session) return;
    setBusy('cancel');
    try { setSession(unwrap(await api.codex.cancelDeviceAuth(installation.nodeId, session.id), 'Could not cancel device login')); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : 'Could not cancel device login'); }
    finally { setBusy(null); }
  }

  async function copyCode(): Promise<void> {
    if (!session) return;
    await navigator.clipboard.writeText(session.userCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card
      title={installation.nodeName}
      description={`${installation.hostname}${installation.user ? ` · ${installation.user}` : ''}`}
      action={<Badge variant={installation.reachable ? authVariant(installation.auth.status) : 'danger'}>{installation.reachable ? authLabel(installation.auth.status) : 'unreachable'}</Badge>}
    >
      <div className="space-y-4">
        {!installation.reachable && <div className="rounded border border-danger/30 bg-danger/10 p-3 text-xs text-danger">{installation.error ?? 'Magnus Agent is unreachable.'}</div>}
        {installation.reachable && !installation.installed && <div className="rounded border border-warning/30 bg-warning/10 p-3 text-xs text-warning">Codex CLI was not detected on this node.</div>}
        {installation.reachable && installation.installed && (
          <>
            <div className="grid grid-cols-2 gap-3 text-[11px] text-text-muted">
              <div><span className="block uppercase tracking-wider text-text-muted/70">Installed</span><span className="font-mono text-text">{installation.version ?? 'unknown'}</span></div>
              <div><span className="block uppercase tracking-wider text-text-muted/70">Current release</span><span className="font-mono text-text">{installation.latestVersion ?? 'unavailable'}</span></div>
              <div><span className="block uppercase tracking-wider text-text-muted/70">Update</span><Badge variant={installation.updateAvailable ? 'warning' : !installation.updateSupported ? 'default' : installation.latestVersion ? 'success' : 'default'}>{!installation.updateSupported ? 'read only' : installation.updateAvailable ? 'available' : installation.latestVersion ? 'current' : 'unknown'}</Badge></div>
              <div><span className="block uppercase tracking-wider text-text-muted/70">Install manager</span><span className="text-text">{installation.provenance}</span></div>
              <div><span className="block uppercase tracking-wider text-text-muted/70">Auth mode</span><span className="text-text">{installation.auth.mode === 'chatgpt' ? 'ChatGPT OAuth' : installation.auth.mode ?? 'none'}</span></div>
              <div><span className="block uppercase tracking-wider text-text-muted/70">Access token</span><Badge variant={installation.auth.tokenExpired === false ? 'success' : installation.auth.tokenExpired ? 'danger' : 'default'}>{installation.auth.tokenExpired === false ? 'current' : installation.auth.tokenExpired ? 'expired' : 'not present'}</Badge></div>
              <div><span className="block uppercase tracking-wider text-text-muted/70">Expires</span><span className="text-text">{dateLabel(installation.auth.tokenExpiresAt)}</span></div>
              <div><span className="block uppercase tracking-wider text-text-muted/70">Refresh credential</span><Badge variant={installation.auth.refreshTokenPresent ? 'success' : 'warning'}>{installation.auth.refreshTokenPresent ? 'present' : 'missing'}</Badge></div>
              <div><span className="block uppercase tracking-wider text-text-muted/70">Plan</span><span className="text-text">{installation.auth.planType ?? 'not reported'}</span></div>
            </div>
            <div className={`rounded border p-3 text-xs leading-5 ${installation.auth.oauth ? 'border-success/30 bg-success/10 text-success' : 'border-warning/30 bg-warning/10 text-warning'}`}>
              {installation.auth.message}
              <span className="mt-1 block text-[10px] opacity-80">API-key credentials are not used by this Magnus flow.</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {canRequestCodexUpdate(installation) && (
                <Button size="sm" variant="secondary" disabled={busy !== null} icon={<RefreshCw className={`h-3.5 w-3.5 ${busy === 'update' ? 'animate-spin' : ''}`} />} onClick={() => void run('update', async () => unwrap(await api.codex.update(installation.nodeId), 'Codex update failed'))}>
                  {installation.latestVersion ? 'Update Codex' : 'Check & Update Codex'}
                </Button>
              )}
              {!installation.auth.oauth && (
                <Button size="sm" disabled={busy !== null || session?.status === 'pending'} icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => void startDeviceLogin()}>
                  Generate Device Code
                </Button>
              )}
              {installation.auth.oauth && (
                <Button size="sm" variant="danger" disabled={busy !== null} icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => void run('logout', async () => unwrap(await api.codex.logout(installation.nodeId), 'Codex logout failed'))}>
                  Log Out
                </Button>
              )}
            </div>
          </>
        )}

        {session && (
          <div className="rounded border border-primary/40 bg-primary/5 p-4" aria-live="polite">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-primary">Device login · {session.status}</p>
              <Badge variant={session.status === 'completed' ? 'success' : session.status === 'pending' ? 'warning' : 'danger'}>{session.status}</Badge>
            </div>
            {session.status === 'pending' && (
              <>
                <p className="mt-3 text-xs text-text-muted">Open the authorization page, sign in to ChatGPT, and enter this one-time code:</p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <code className="rounded border border-primary/40 bg-bg px-4 py-2 text-lg font-bold tracking-[0.2em] text-primary">{session.userCode}</code>
                  <Button size="sm" variant="secondary" icon={copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />} onClick={() => void copyCode()}>{copied ? 'Copied' : 'Copy Code'}</Button>
                  <a className="inline-flex h-8 items-center gap-2 rounded border border-primary/60 bg-primary/10 px-3 text-[11px] font-medium uppercase tracking-wider text-primary hover:bg-primary/20" href={session.verificationUrl} target="_blank" rel="noreferrer">Open OpenAI <ExternalLink className="h-3.5 w-3.5" /></a>
                </div>
                <p className="mt-2 text-[10px] text-text-muted">Expires {dateLabel(session.expiresAt)}. Continue only if you started this request here.</p>
                <Button className="mt-3" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void cancelDeviceLogin()}>Cancel</Button>
              </>
            )}
            {session.status !== 'pending' && <p className="mt-3 text-xs text-text-muted">{session.error ?? (session.status === 'completed' ? 'ChatGPT OAuth authorization completed.' : 'Device authorization ended.')}</p>}
          </div>
        )}
        {error && <div className="rounded border border-danger/30 bg-danger/10 p-3 text-xs text-danger">{error}</div>}
      </div>
    </Card>
  );
}
