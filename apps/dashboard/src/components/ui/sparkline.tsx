import { useId } from 'react';
import { cn } from '@/lib/cn';
import { TONE_VAR, type Tone } from '@/lib/theme-colors';

export interface SparklineProps {
  values: number[];
  tone?: Tone;
  width?: number;
  height?: number;
  /** Fill the area under the line with a fading gradient. */
  area?: boolean;
  /** Fixed upper bound (defaults to max(values), or 100 when `percent`). */
  max?: number;
  percent?: boolean;
  /** Dashed reference line, in value units. */
  threshold?: number;
  /** Pulse ring on the latest point. */
  live?: boolean;
  emptyLabel?: string;
  className?: string;
  testId?: string;
  label?: string;
  /** Stretch to the container width (non-uniform scaling). */
  stretch?: boolean;
}

/** Small SVG trend line with an optional area fill, threshold and a live last point. */
export function Sparkline({
  values,
  tone = 'primary',
  width = 160,
  height = 32,
  area = true,
  max,
  percent = false,
  threshold,
  live = true,
  emptyLabel = 'not enough data',
  className,
  testId,
  label,
  stretch = false,
}: SparklineProps): React.ReactElement {
  const gradientId = `spark${useId().replace(/:/g, '')}`;

  if (values.length < 2) {
    return (
      <div className={cn('flex h-8 items-center text-xs italic text-text-muted', className)} data-testid={testId}>
        {emptyLabel}
      </div>
    );
  }

  const color = TONE_VAR[tone];
  const top = max ?? (percent ? Math.max(100, ...values) : Math.max(...values, threshold ?? 0) || 1);
  const pad = 2;
  const h = height - pad * 2;
  const step = width / (values.length - 1);
  const y = (v: number): number => pad + h - (Math.max(0, v) / top) * h;
  const pts = values.map((v, i) => [i * step, y(v)] as const);
  const line = pts.map(([x, yy]) => `${x.toFixed(1)},${yy.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;

  return (
    <svg
      width={stretch ? '100%' : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={stretch ? 'none' : undefined}
      className={cn('block overflow-visible', className)}
      data-testid={testId}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {area && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <polygon points={`0,${height} ${line} ${width},${height}`} fill={`url(#${gradientId})`} />
        </>
      )}
      {threshold !== undefined && (
        <line
          x1={0}
          x2={width}
          y1={y(threshold)}
          y2={y(threshold)}
          stroke="var(--color-warning)"
          strokeOpacity={0.5}
          strokeDasharray="3 3"
          strokeWidth={1}
        />
      )}
      <polyline fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" points={line} />
      {live && !stretch && (
        <>
          <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} className="origin-center animate-halo [transform-box:fill-box]" />
          <circle cx={last[0]} cy={last[1]} r={2} fill={color} />
        </>
      )}
    </svg>
  );
}
