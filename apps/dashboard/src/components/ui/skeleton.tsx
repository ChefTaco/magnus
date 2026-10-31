import { cn } from '@/lib/cn';

/** Shimmering placeholder block. */
export function Skeleton({ className }: { className?: string }): React.ReactElement {
  return <div aria-hidden="true" className={cn('skeleton h-3 w-full', className)} />;
}

/** A few lines of placeholder text with varied widths. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }): React.ReactElement {
  const widths = ['w-full', 'w-11/12', 'w-4/5', 'w-2/3', 'w-3/4'];
  return (
    <div role="status" aria-label="Loading" className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={widths[i % widths.length]} />
      ))}
    </div>
  );
}

/** Placeholder table rows. */
export function SkeletonTable({ rows = 5, cols = 4, className }: { rows?: number; cols?: number; className?: string }): React.ReactElement {
  return (
    <div role="status" aria-label="Loading" className={cn('overflow-hidden rounded-panel border border-border', className)}>
      <div className="flex gap-4 border-b border-border bg-surface px-4 py-3">
        {Array.from({ length: cols }, (_, c) => (
          <Skeleton key={c} className="h-2 flex-1 opacity-60" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b border-border/50 px-4 py-3 last:border-0">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cn('h-3 flex-1', (r + c) % 3 === 0 && 'max-w-[60%]')} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Placeholder stat tiles. */
export function SkeletonStatGrid({ count = 4, className }: { count?: number; className?: string }): React.ReactElement {
  return (
    <div role="status" aria-label="Loading" className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-4', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="panel-corners rounded-panel border border-border bg-surface p-5">
          <Skeleton className="h-2 w-1/2" />
          <Skeleton className="mt-4 h-7 w-2/3" />
          <Skeleton className="mt-3 h-1 w-full opacity-60" />
        </div>
      ))}
    </div>
  );
}
