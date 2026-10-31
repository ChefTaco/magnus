import { Fan, Gauge, Thermometer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { MeterBar } from '@/components/ui/meter-bar';
import { formatDate } from '@/lib/utils';
import type { GpuSnapshotPoint, GpuTelemetryResponse } from '@/types/contracts';

interface GpuTelemetryCardProps {
  telemetry: GpuTelemetryResponse | null;
}

function chartPoints(
  history: GpuSnapshotPoint[],
  select: (point: GpuSnapshotPoint) => number | null,
): string {
  const values = history
    .map((point) => ({ timestamp: new Date(point.sampledAt).getTime(), value: select(point) }))
    .filter((point): point is { timestamp: number; value: number } => point.value !== null);
  if (values.length === 0) return '';
  const start = values[0]!.timestamp;
  const end = values.at(-1)!.timestamp;
  const span = Math.max(1, end - start);
  return values
    .map(({ timestamp, value }) => {
      const x = ((timestamp - start) / span) * 600;
      const y = 104 - Math.max(0, Math.min(100, value)) * 0.88;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function metric(value: number | null, suffix = '%'): string {
  return value === null ? 'not reported' : `${value.toFixed(1)}${suffix}`;
}

export function GpuTelemetryCard({ telemetry }: GpuTelemetryCardProps): React.ReactElement {
  const latest = telemetry?.latest ?? null;
  const devices = latest?.devices ?? [];
  const utilizationLine = chartPoints(telemetry?.history ?? [], (point) => point.maxUtilizationPercent);
  const fanLine = chartPoints(telemetry?.history ?? [], (point) => point.maxFanPercent);

  return (
    <Card
      title="GPU telemetry"
      description="30-second load and cooling history"
      action={latest ? <Badge variant="default">sampled {formatDate(latest.sampledAt)}</Badge> : undefined}
    >
      {!latest || devices.length === 0 ? (
        <div className="rounded-panel border border-dashed border-border px-4 py-6 text-center text-xs text-text-muted">
          {latest?.status === 'error'
            ? 'The GPU probe did not complete. Magnus will retry on the next heartbeat.'
            : 'No supported NVIDIA or AMD GPU was detected in the latest sample.'}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {devices.map((device) => (
              <div key={`${device.vendor}-${device.uuid ?? device.index}`} className="rounded-panel border border-border/70 bg-surface-raised/60 p-3 transition-colors hover:border-primary/30">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-text">{device.name}</p>
                    <p className="mt-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                      {device.vendor} · gpu {device.index}
                    </p>
                  </div>
                  {device.fanPercent === 100 && <Badge variant="danger">fan saturated</Badge>}
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2">
                  <div>
                    <dt className="flex items-center gap-1 text-[10px] uppercase text-text-muted"><Gauge className="h-3 w-3" />Load</dt>
                    <dd className="mt-1 num text-sm text-primary">{metric(device.utilizationPercent)}</dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1 text-[10px] uppercase text-text-muted"><Fan className="h-3 w-3" />Fan</dt>
                    <dd className={`mt-1 num text-sm ${device.fanPercent === 100 ? 'text-danger glow-text-danger' : 'text-warning'}`}>
                      {metric(device.fanPercent)}
                    </dd>
                  </div>
                  <div>
                    <dt className="flex items-center gap-1 text-[10px] uppercase text-text-muted"><Thermometer className="h-3 w-3" />Temp</dt>
                    <dd className="mt-1 num text-sm text-text">{metric(device.temperatureCelsius, '°C')}</dd>
                  </div>
                </dl>
                <div className="mt-2 space-y-1">
                  <MeterBar value={device.utilizationPercent} tone="primary" label={`${device.name} load`} />
                  <MeterBar value={device.fanPercent} thresholds={{ warn: 80, crit: 100 }} label={`${device.name} fan`} />
                </div>
              </div>
            ))}
          </div>

          <div className="panel-corners rounded-panel border border-border/70 bg-bg/60 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-text-muted">Host maximum · last 24 hours</p>
              <div className="flex items-center gap-3 text-[10px] text-text-muted">
                <span className="flex items-center gap-1"><span className="h-0.5 w-3 bg-primary shadow-[0_0_4px_var(--color-primary)]" />load</span>
                <span className="flex items-center gap-1"><span className="h-0.5 w-3 bg-warning" />fan</span>
              </div>
            </div>
            <svg viewBox="0 0 600 112" className="h-28 w-full" role="img" aria-label="GPU load and fan percentage over the last 24 hours">
              <line x1="0" y1="16" x2="600" y2="16" stroke="var(--color-danger)" strokeOpacity="0.45" strokeDasharray="5 5" />
              <line x1="0" y1="60" x2="600" y2="60" stroke="currentColor" strokeOpacity="0.12" />
              <line x1="0" y1="104" x2="600" y2="104" stroke="currentColor" strokeOpacity="0.2" />
              <defs>
                <linearGradient id="gpu-load-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {utilizationLine && <polygon points={`0,104 ${utilizationLine} 600,104`} fill="url(#gpu-load-fill)" />}
              {utilizationLine && <polyline points={utilizationLine} fill="none" stroke="var(--color-primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
              {fanLine && <polyline points={fanLine} fill="none" stroke="var(--color-warning)" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
            </svg>
            <div className="mt-1 flex justify-between num text-[9px] text-text-muted"><span>24h ago</span><span>100% saturation line</span><span>now</span></div>
          </div>
        </div>
      )}
    </Card>
  );
}
