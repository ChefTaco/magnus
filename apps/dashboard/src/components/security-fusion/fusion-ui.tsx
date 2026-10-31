import type { FusionSource } from '@/lib/security-fusion';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/page-header';
import { StatusDot } from '@/components/ui/status-dot';

export function FusionHeader({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }): React.ReactElement {
  return (
    <header className="mb-6 border-b border-border/50 pb-5">
      <PageHeader eyebrow={eyebrow} title={title} description={copy} tone="accent" />
    </header>
  );
}

const STALE_MS = 15 * 60 * 1000;

export function SourceGrid({ sources }: { sources: FusionSource[] }): React.ReactElement {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {sources.map((source) => {
        const healthy = source.status === 'healthy';
        const lastSuccess = source.lastSuccessAt ? Date.parse(source.lastSuccessAt) : null;
        const stale = lastSuccess === null || Date.now() - lastSuccess > STALE_MS;
        return (
          <div
            key={source.source}
            className={cn(
              'panel-corners rounded-panel border bg-surface p-4 transition-colors',
              healthy ? 'border-border/60 hover:border-success/40' : 'border-warning/30 [--panel-corner-color:var(--color-warning)]',
            )}
          >
            <div className="flex items-center justify-between">
              <strong className="text-xs uppercase tracking-wider text-text">{source.source.replaceAll('_', ' ')}</strong>
              <StatusDot status={healthy ? 'HEALTHY' : source.status === 'error' ? 'ERROR' : 'DEGRADED'} label={source.status} />
            </div>
            <p className={cn('mt-3 text-[10px] uppercase tracking-wider', healthy ? 'text-success' : 'text-warning')}>{source.status}</p>
            <p className={cn('num mt-1 text-[10px]', stale ? 'text-warning' : 'text-text-muted')}>
              Last successful poll: {source.lastSuccessAt ? new Date(source.lastSuccessAt).toLocaleString() : 'Never'}
            </p>
            <p className="num mt-1 text-[10px] text-text-muted">
              Last event: {source.lastEventAt ? new Date(source.lastEventAt).toLocaleString() : 'No evidence received'}
            </p>
            {source.lastError && <p className="mt-2 line-clamp-2 text-[10px] text-danger">{source.lastError}</p>}
          </div>
        );
      })}
    </div>
  );
}
