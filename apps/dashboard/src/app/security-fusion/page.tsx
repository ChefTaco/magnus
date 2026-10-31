import { ArrowUpRight, ShieldOff } from 'lucide-react';
import { FusionHeader, SourceGrid } from '@/components/security-fusion/fusion-ui';
import { fleetSystemFetch } from '@/lib/fleet-fetch';
import type { FusionSeverity, FusionSource } from '@/lib/security-fusion';
import { severityClass } from '@/lib/security-fusion';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { configuredSecurityConsoleUrl } from '@/lib/security-console';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const consoleUrl = await configuredSecurityConsoleUrl();
  if (!consoleUrl) {
    return (
      <main className="p-6">
        <FusionHeader eyebrow="Optional integration" title="Security" copy="Connect an external security console to investigate cases and evidence." />
        <EmptyState
          tone="muted"
          icon={<ShieldOff className="h-5 w-5" />}
          title="Security console not configured"
          description="Set MAGNUS_SECURITY_CONSOLE_URL on the Magnus UI server and restart it to enable this page."
        />
      </main>
    );
  }
  const result = await fleetSystemFetch<{
    data: { generatedAt: string; bySeverity: Array<{ severity: string; _count: { id: number } }>; sources: FusionSource[] };
  }>('security-integration/summary').catch(() => null);

  return (
    <main className="p-6">
      <FusionHeader eyebrow="Security console" title="Security" copy="Investigations, evidence and security response run in the external security console." />
      <a
        href={consoleUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(buttonClass('primary', 'lg'), 'mb-6 border-accent/60 bg-accent/10 text-accent hover:border-accent hover:bg-accent/20 hover:shadow-[0_0_14px_var(--color-glow-accent)]')}
      >
        Open security console <ArrowUpRight className="h-4 w-4" />
      </a>
      {result ? (
        <>
          <p className="num mb-4 text-[10px] uppercase tracking-wider text-text-muted">Updated {result.data.generatedAt}</p>
          <div className="mb-6 flex flex-wrap gap-3">
            {result.data.bySeverity.map((r) => (
              <div
                key={r.severity}
                className={cn(
                  'rounded-panel border bg-surface px-4 py-3',
                  severityClass[r.severity as FusionSeverity] ?? 'border-border text-text-muted',
                )}
              >
                <div className="text-[10px] uppercase tracking-[0.2em] opacity-80">{r.severity}</div>
                <div className="num mt-1 text-xl font-bold">{r._count.id}</div>
              </div>
            ))}
          </div>
          <SourceGrid sources={result.data.sources} />
        </>
      ) : (
        <EmptyState
          tone="warning"
          icon={<ShieldOff className="h-5 w-5" />}
          title="Security status is unavailable"
          description="Fleet operations remain available."
        />
      )}
    </main>
  );
}
