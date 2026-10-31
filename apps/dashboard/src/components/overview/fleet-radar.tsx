import { cn } from '@/lib/utils';

export interface FleetRadarCounts {
  online: number;
  degraded: number;
  offline: number;
  provisioning: number;
}

const BLIP: Record<keyof FleetRadarCounts, string> = {
  online: 'bg-success shadow-[0_0_6px_var(--color-success)]',
  degraded: 'bg-warning shadow-[0_0_6px_var(--color-warning)]',
  offline: 'bg-danger shadow-[0_0_8px_var(--color-danger)]',
  provisioning: 'bg-info shadow-[0_0_6px_var(--color-info)]',
};

/** Deterministic pseudo-random in [0, 1) so blips don't jump between renders. */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const MAX_BLIPS = 64;

/**
 * Radar-style fleet readout: one blip per node, coloured by status, under a
 * rotating CSS sweep. Problem nodes sit nearer the centre so they stand out.
 */
export function FleetRadar({ counts, size = 176, className }: { counts: FleetRadarCounts; size?: number; className?: string }): React.ReactElement {
  const order: Array<keyof FleetRadarCounts> = ['offline', 'degraded', 'provisioning', 'online'];
  const blips: Array<{ key: string; status: keyof FleetRadarCounts; x: number; y: number }> = [];
  let seed = 1;
  for (const status of order) {
    for (let i = 0; i < counts[status] && blips.length < MAX_BLIPS; i++, seed++) {
      const band = status === 'online' ? [0.45, 0.92] : status === 'provisioning' ? [0.3, 0.7] : [0.15, 0.55];
      const r = band[0]! + rand(seed) * (band[1]! - band[0]!);
      const a = rand(seed + 101) * Math.PI * 2;
      blips.push({ key: `${status}-${i}`, status, x: 50 + Math.cos(a) * r * 50, y: 50 + Math.sin(a) * r * 50 });
    }
  }
  const total = counts.online + counts.degraded + counts.offline + counts.provisioning;

  return (
    <div
      role="img"
      aria-label={`Fleet radar: ${counts.online} online, ${counts.degraded} degraded, ${counts.offline} offline, ${counts.provisioning} provisioning`}
      className={cn('relative shrink-0 overflow-hidden rounded-full border border-primary/30 bg-bg shadow-[0_0_24px_var(--color-glow),inset_0_0_24px_var(--color-glow)]', className)}
      style={{ width: size, height: size }}
    >
      {/* Range rings and crosshair */}
      <div className="absolute inset-[16%] rounded-full border border-primary/15" />
      <div className="absolute inset-[33%] rounded-full border border-primary/15" />
      <div className="absolute inset-y-0 left-1/2 w-px bg-primary/10" />
      <div className="absolute inset-x-0 top-1/2 h-px bg-primary/10" />
      {/* Sweep */}
      <div
        aria-hidden="true"
        className="absolute inset-0 animate-sweep rounded-full bg-[conic-gradient(from_0deg,transparent_0deg,transparent_290deg,color-mix(in_srgb,var(--color-primary)_35%,transparent)_355deg,var(--color-primary)_360deg)] opacity-70"
      />
      {/* Blips */}
      {blips.map((b) => (
        <span
          key={b.key}
          aria-hidden="true"
          className={cn('absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full', BLIP[b.status], b.status === 'offline' && 'animate-pulse')}
          style={{ left: `${b.x}%`, top: `${b.y}%` }}
        />
      ))}
      {/* Centre readout */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-2xl font-bold text-primary glow-text-primary">{total}</span>
        <span className="text-[9px] uppercase tracking-[0.25em] text-text-muted">nodes</span>
      </div>
    </div>
  );
}
