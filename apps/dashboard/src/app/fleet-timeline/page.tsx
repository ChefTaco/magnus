import Link from 'next/link';
import { fleetSystemFetch } from '@/lib/fleet-fetch';

export const dynamic = 'force-dynamic';
import { Clock, GitBranch } from 'lucide-react';

interface TimelineItem {
  type: string;
  severity: string;
  title: string;
  node?: string | null;
  timestamp: string;
  href?: string;
}

async function loadTimeline(): Promise<TimelineItem[]> {
  try {
    const res = await fleetSystemFetch<{ success: boolean; data: TimelineItem[] }>('ops/timeline?limit=120');
    return res.success ? res.data : [];
  } catch {
    return [];
  }
}

export default async function FleetTimelinePage(): Promise<React.ReactElement> {
  const items = await loadTimeline();
  return (
    <div className="space-y-5" data-testid="fleet-timeline-page">
      <div>
        <h1 className="text-lg font-bold uppercase tracking-wider">Fleet Timeline</h1>
        <p className="mt-1 text-[11px] uppercase tracking-wider text-text-muted">
          Recent heartbeats, commands, deploys, Hermes jobs, logs, and audit events in one stream
        </p>
      </div>
      <div className="rounded border border-border/50 bg-surface">
        {items.map((item) => (
          <div key={`${item.type}-${item.timestamp}-${item.title}`} className="grid gap-3 border-b border-border/30 px-4 py-3 text-xs last:border-0 sm:grid-cols-[150px_120px_1fr_160px]">
            <div className="flex items-center gap-2 text-text-muted">
              <Clock className="h-3.5 w-3.5" />
              {new Date(item.timestamp).toLocaleString()}
            </div>
            <div className="uppercase tracking-[0.16em] text-accent">{item.type}</div>
            <div>
              {item.href ? <Link href={item.href} className="text-text hover:text-primary">{item.title}</Link> : item.title}
              {item.node && <div className="mt-0.5 text-[10px] text-text-muted">{item.node}</div>}
            </div>
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-muted">
              <GitBranch className="h-3.5 w-3.5" />
              {item.severity}
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="p-4 text-xs text-warning">Timeline data unavailable.</div>}
      </div>
    </div>
  );
}
