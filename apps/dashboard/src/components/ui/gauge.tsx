import { useId, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { DEFAULT_THRESHOLDS, TONE_GLOW_TEXT, TONE_TEXT, TONE_VAR, thresholdTone, type Thresholds, type Tone } from '@/lib/theme-colors';

export interface GaugeProps {
  value: number | null | undefined;
  max?: number;
  label: string;
  sublabel?: ReactNode;
  /** Fixed tone; otherwise the tone follows `thresholds`. */
  tone?: Tone;
  thresholds?: Thresholds;
  /** Treat high values as good (e.g. nodes online), inverting the thresholds. */
  higherIsBetter?: boolean;
  size?: number;
  /** Text in the centre; defaults to the percentage. */
  display?: string;
  ticks?: boolean;
  /** Hide the visible caption (the aria-label still names the gauge). */
  hideLabel?: boolean;
  className?: string;
  testId?: string;
}

const SWEEP = 0.75; // 270° arc

/** SVG 270° arc gauge. The value is exposed through role="img" and aria-label. */
export function Gauge({
  value,
  max = 100,
  label,
  sublabel,
  tone,
  thresholds = DEFAULT_THRESHOLDS,
  higherIsBetter = false,
  size = 140,
  display,
  ticks = true,
  hideLabel = false,
  className,
  testId,
}: GaugeProps): React.ReactElement {
  const filterId = useId().replace(/:/g, '');
  const known = typeof value === 'number' && Number.isFinite(value);
  const pct = known ? Math.max(0, Math.min(100, (value / (max || 1)) * 100)) : 0;
  const resolved: Tone =
    tone ?? (!known ? 'muted' : higherIsBetter ? thresholdTone(100 - pct, thresholds) : thresholdTone(pct, thresholds));

  const stroke = Math.max(4, Math.round(size / 16));
  const r = 50 - stroke / 2 - 4;
  const c = 2 * Math.PI * r;
  const track = c * SWEEP;
  const fill = (track * pct) / 100;
  const hero = size >= 140;
  const text = display ?? (known ? `${Math.round(pct)}%` : '—');

  const tickMarks = ticks
    ? Array.from({ length: 11 }, (_, i) => {
        const angle = ((135 + (270 * i) / 10) * Math.PI) / 180;
        const r1 = 50 - 1.5;
        const r2 = 50 - (i % 5 === 0 ? 4 : 2.5);
        return (
          <line
            key={i}
            x1={50 + r1 * Math.cos(angle)}
            y1={50 + r1 * Math.sin(angle)}
            x2={50 + r2 * Math.cos(angle)}
            y2={50 + r2 * Math.sin(angle)}
            stroke="var(--color-border-strong)"
            strokeWidth={0.8}
          />
        );
      })
    : null;

  return (
    <div
      role="img"
      aria-label={`${label}: ${text}`}
      data-testid={testId}
      className={cn('relative inline-flex flex-col items-center', className)}
      style={{ width: size }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" className="overflow-visible">
        {hero && (
          <defs>
            <filter id={`g${filterId}`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="2.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
        )}
        {tickMarks}
        <circle
          cx={50}
          cy={50}
          r={r}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${track} ${c}`}
          transform="rotate(135 50 50)"
        />
        <circle
          cx={50}
          cy={50}
          r={r}
          fill="none"
          stroke={TONE_VAR[resolved]}
          strokeWidth={stroke}
          strokeLinecap="round"
          transform="rotate(135 50 50)"
          filter={hero ? `url(#g${filterId})` : undefined}
          style={{ '--dash': `${fill} ${c}` } as CSSProperties}
          className="[stroke-dasharray:var(--dash)] transition-[stroke-dasharray] duration-1000 ease-out-expo starting:[stroke-dasharray:0_1000]"
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" style={{ height: size }}>
        <span
          className={cn('num font-bold leading-none', TONE_TEXT[resolved], hero && TONE_GLOW_TEXT[resolved])}
          style={{ fontSize: Math.max(12, size * 0.2) }}
        >
          {text}
        </span>
        {sublabel && (
          <span className="num mt-1 text-text-muted" style={{ fontSize: Math.max(9, size * 0.075) }}>
            {sublabel}
          </span>
        )}
      </div>
      {!hideLabel && <span className="-mt-[10%] text-center text-[10px] font-medium uppercase tracking-[0.15em] text-text-muted">{label}</span>}
    </div>
  );
}
