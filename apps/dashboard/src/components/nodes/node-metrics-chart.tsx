'use client';

import { useEffect, useState } from 'react';
import { LineChart } from 'lucide-react';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { LazyAreaChart } from '@/components/ui/charts/lazy-area-chart';
import { EmptyState } from '@/components/ui/empty-state';

type Period = '1h' | '6h' | '24h';

interface TimeseriesResponse {
  timestamps: string[];
  values: number[];
}

const PERIODS: Period[] = ['1h', '6h', '24h'];

/** CPU and memory history for one node, from the Control API health timeseries. */
export function NodeMetricsChart({ nodeId, height = 180 }: { nodeId: string; height?: number }): React.ReactElement {
  const [period, setPeriod] = useState<Period>('1h');
  const [data, setData] = useState<Array<{ t: number; cpu: number | null; mem: number | null }> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const load = async (): Promise<void> => {
      try {
        const [cpu, mem] = await Promise.all([
          api.get<TimeseriesResponse>(`nodes/${nodeId}/health/timeseries?metric=cpu&period=${period}`),
          api.get<TimeseriesResponse>(`nodes/${nodeId}/health/timeseries?metric=memory&period=${period}`),
        ]);
        if (cancelled) return;
        const cpuData = cpu.data ?? { timestamps: [], values: [] };
        const memData = mem.data ?? { timestamps: [], values: [] };
        const rows = new Map<number, { t: number; cpu: number | null; mem: number | null }>();
        cpuData.timestamps.forEach((ts, i) => {
          const t = Date.parse(ts);
          rows.set(t, { t, cpu: cpuData.values[i] ?? null, mem: null });
        });
        memData.timestamps.forEach((ts, i) => {
          const t = Date.parse(ts);
          const row = rows.get(t) ?? { t, cpu: null, mem: null };
          row.mem = memData.values[i] ?? null;
          rows.set(t, row);
        });
        setData([...rows.values()].sort((a, b) => a.t - b.t));
      } catch {
        if (!cancelled) {
          setData([]);
          setFailed(true);
        }
      }
    };
    void load();
    const interval = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [nodeId, period]);

  return (
    <div className="flex min-w-0 flex-col" data-testid="node-metrics-chart">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">CPU / memory history</span>
        <div role="group" aria-label="History period" className="flex rounded-chip border border-border bg-bg p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              aria-pressed={period === p}
              className={cn(
                'rounded-chip px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors',
                period === p ? 'bg-primary/15 text-primary shadow-[0_0_8px_var(--color-glow)]' : 'text-text-muted hover:text-text',
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      {data === null ? (
        <div className="skeleton w-full" style={{ height }} />
      ) : data.length < 2 ? (
        <EmptyState
          compact
          icon={<LineChart className="h-4 w-4" />}
          title={failed ? 'History unavailable' : 'Not enough samples yet'}
          description={failed ? 'The health timeseries endpoint did not answer.' : `No health snapshots in the last ${period}.`}
          tone={failed ? 'warning' : 'muted'}
          className="flex-1"
        />
      ) : (
        <LazyAreaChart
          data={data}
          xKey="t"
          percent
          height={height}
          formatX={(v) => new Date(Number(v)).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}
          series={[
            { key: 'cpu', label: 'CPU', tone: 'primary' },
            { key: 'mem', label: 'Memory', tone: 'accent' },
          ]}
        />
      )}
    </div>
  );
}
