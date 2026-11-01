'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpCircle, ServerCog, X } from 'lucide-react';
import { api } from '@/lib/api-client';
import type { SystemUpdates } from '@/types/upgrades';

const REFRESH_MS = 30 * 60_000;
const DISMISS_KEY = 'magnus.update-banner.dismissed';

function readDismissed(): string | null {
  try { return window.localStorage.getItem(DISMISS_KEY); } catch { return null; }
}

function writeDismissed(value: string): void {
  try { window.localStorage.setItem(DISMISS_KEY, value); } catch { /* per-browser convenience only */ }
}

/** What the banner is about; a dismissal hides it until this changes. */
export function bannerKey(updates: SystemUpdates): string {
  return `${updates.server.latest ?? ''}|${updates.server.latestMajor ?? ''}|${updates.agents.behind.length}|${updates.agents.expected}`;
}

/**
 * Release and version-skew notices above every page: a newer Magnus release
 * (opt-out: MAGNUS_UPDATE_CHECK=false on the server), and agents that run a
 * different version than the server ships with, each with the exact fix.
 */
export function UpdateBanner(): React.ReactElement | null {
  const [updates, setUpdates] = useState<SystemUpdates | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    setDismissed(readDismissed());
    let cancelled = false;
    const load = () => { api.systemUpdates.get().then((data) => { if (!cancelled) setUpdates(data); }).catch(() => undefined); };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  if (!updates) return null;
  const { server, agents } = updates;
  const behind = agents.behind.length;
  if (!server.updateAvailable && !server.latestMajor && behind === 0) return null;
  const key = bannerKey(updates);
  if (dismissed === key) return null;

  return (
    <section role="status" aria-label="Updates" data-testid="update-banner"
      className="relative mb-4 overflow-hidden rounded border border-warning/40 bg-warning/5 px-4 py-3 text-[11px]">
      <div className="absolute inset-y-0 left-0 w-0.5 bg-warning" />
      <button type="button" aria-label="Dismiss" className="absolute right-2 top-2 text-text-muted hover:text-text"
        onClick={() => { writeDismissed(key); setDismissed(key); }}>
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="space-y-2 pr-6">
        {server.updateAvailable && server.latest && (
          <div className="flex items-start gap-2">
            <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="min-w-0 space-y-1">
              <p>
                <span className="font-bold uppercase tracking-wider text-warning">Magnus {server.latest} is available</span>
                <span className="ml-2 text-text-muted">running {server.current}{server.breaking ? ' · contains breaking changes' : ''}</span>
              </p>
              {server.releases.filter((release) => release.summary).map((release) => (
                <p key={release.version} className="text-text-muted">
                  {release.version}: {release.summary}{' '}
                  {release.notesUrl && <a className="text-primary underline" href={release.notesUrl} target="_blank" rel="noreferrer">release notes</a>}
                </p>
              ))}
              {server.newRequiredEnv.length > 0 && (
                <p className="text-text-muted">
                  New required settings:{' '}
                  {server.newRequiredEnv.map((variable) => (
                    <code key={variable.name} className="mr-1 rounded bg-surface px-1">{variable.name}{variable.component !== 'server' ? ` (${variable.component})` : ''}</code>
                  ))}
                  {server.newRequiredEnv.every((variable) => variable.secret) && <span>(secrets: <code>magnus upgrade --generate-secrets</code> fills them in)</span>}
                </p>
              )}
              {server.attention.length > 0 && (
                <p className="text-warning">
                  Needs a maintenance window: {server.attention.map((migration) => `${migration.name} (${migration.impact}${migration.note ? `: ${migration.note}` : ''})`).join('; ')}
                </p>
              )}
              <p className="text-text-muted">On the server host run <code className="rounded bg-surface px-1 text-text">{server.command}</code> (backs up the database and reverts on failure).</p>
            </div>
          </div>
        )}
        {server.latestMajor && (
          <p className="text-text-muted">
            Magnus {server.latestMajor} is a new major version. Major upgrades are never offered automatically; read UPGRADING.md first.
          </p>
        )}
        {behind > 0 && (
          <div className="flex items-start gap-2">
            <ServerCog className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p>
              <span className="font-bold uppercase tracking-wider text-warning">
                {behind} agent{behind === 1 ? '' : 's'} behind the server ({agents.expected})
              </span>
              <span className="ml-2 text-text-muted">
                {agents.behind.slice(0, 5).map((node) => `${node.name} ${node.version}`).join(', ')}{behind > 5 ? ', …' : ''}.
              </span>{' '}
              {agents.upgradesEnabled
                ? <Link href="/nodes?upgrade=agents" className="text-primary underline">Upgrade agents</Link>
                : <span className="text-text-muted">Agent upgrades are off on this server (MAGNUS_AGENT_UPGRADES=false).</span>}
              {agents.fixCommand && <span className="ml-2 text-text-muted">or run <code className="rounded bg-surface px-1 text-text">{agents.fixCommand}</code></span>}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
