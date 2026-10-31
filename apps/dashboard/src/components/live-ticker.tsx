'use client';

import { useSyncExternalStore } from 'react';
import { Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import { eventFeed, type FeedEntry, type FeedSeverity } from '@/lib/event-feed';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { EmptyState } from '@/components/ui/empty-state';

const SEVERITY_TEXT: Record<FeedSeverity, string> = {
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
};

const SEVERITY_DOT: Record<FeedSeverity, string> = {
  info: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-danger',
};

function useFeed() {
  return useSyncExternalStore(eventFeed.subscribe, eventFeed.getSnapshot, eventFeed.getServerSnapshot);
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function TickerItem({ entry }: { entry: FeedEntry }): React.ReactElement {
  return (
    <span className="inline-flex shrink-0 items-center gap-2 px-4">
      <span className={cn('h-1.5 w-1.5 rounded-full', SEVERITY_DOT[entry.severity])} />
      <span className="num text-text-muted/70">{timeOf(entry.at)}</span>
      <span className={SEVERITY_TEXT[entry.severity]}>{entry.title}</span>
      {entry.message && <span className="text-text-muted">{entry.message}</span>}
    </span>
  );
}

/** Single-line marquee of fleet events for the header. Hidden until something arrives. */
export function HeaderTicker({ className }: { className?: string }): React.ReactElement | null {
  const { entries } = useFeed();
  const reduced = useReducedMotion();
  if (entries.length === 0) return null;
  const recent = entries.slice(0, 8);
  const latest = recent[0]!;

  return (
    <div className={cn('relative min-w-0 overflow-hidden text-[10px] uppercase tracking-wider', className)}>
      <span className="sr-only" aria-live="polite">
        Latest event: {latest.title}
      </span>
      <div aria-hidden="true" className="[mask-image:linear-gradient(90deg,transparent,black_8%,black_92%,transparent)]">
        {reduced || recent.length < 2 ? (
          <TickerItem entry={latest} />
        ) : (
          <div className="flex w-max animate-ticker hover:[animation-play-state:paused]">
            {[...recent, ...recent].map((entry, i) => (
              <TickerItem key={`${entry.id}-${i}`} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Live event list for dashboard panels. */
export function LiveEventList({ limit = 8, className }: { limit?: number; className?: string }): React.ReactElement {
  const { entries, connected } = useFeed();
  if (entries.length === 0) {
    return (
      <EmptyState
        compact
        icon={<Radio className="h-4 w-4" />}
        tone={connected ? 'primary' : 'muted'}
        title={connected ? 'Listening for fleet events' : 'Event stream connecting'}
        description="Deploys, upgrades, command results and alerts appear here as they happen."
        className={className}
      />
    );
  }
  return (
    <ul className={cn('space-y-1.5', className)} aria-live="off">
      {entries.slice(0, limit).map((entry) => (
        <li
          key={entry.id}
          className="scan-sweep flex items-center gap-2.5 rounded-chip border border-border/60 bg-surface-raised/60 px-3 py-2 text-[11px]"
        >
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full shadow-[0_0_6px_currentColor]', SEVERITY_DOT[entry.severity], SEVERITY_TEXT[entry.severity])} />
          <span className={cn('min-w-0 flex-1 truncate', SEVERITY_TEXT[entry.severity])}>
            {entry.title}
            {entry.message && <span className="ml-2 text-text-muted">{entry.message}</span>}
          </span>
          <span className="num shrink-0 text-[10px] text-text-muted">{timeOf(entry.at)}</span>
        </li>
      ))}
    </ul>
  );
}
