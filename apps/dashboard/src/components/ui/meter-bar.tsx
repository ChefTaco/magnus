import type { CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { DEFAULT_THRESHOLDS, TONE_BG, TONE_TEXT, thresholdTone, type Thresholds, type Tone } from '@/lib/theme-colors';

const GLOW: Partial<Record<Tone, string>> = {
  warning: 'shadow-[0_0_6px_var(--color-warning)]',
  danger: 'shadow-[0_0_8px_var(--color-danger)]',
  accent: 'shadow-[0_0_6px_var(--color-accent)]',
  primary: 'shadow-[0_0_6px_var(--color-primary)]',
};

export interface MeterBarProps {
  value: number | null | undefined;
  max?: number;
  /** Fixed tone; otherwise the tone follows `thresholds`. */
  tone?: Tone;
  thresholds?: Thresholds;
  label?: string;
  size?: 'xs' | 'sm' | 'md';
  showValue?: boolean;
  /** Text shown in place of the computed percentage. */
  valueLabel?: string;
  /** Always glow (otherwise only above the warning threshold). */
  glow?: boolean;
  className?: string;
  testId?: string;
}

const HEIGHT = { xs: 'h-1', sm: 'h-1.5', md: 'h-2' } as const;

/** Thin threshold-coloured bar that sweeps in on mount. The numeric value stays visible. */
export function MeterBar({
  value,
  max = 100,
  tone,
  thresholds = DEFAULT_THRESHOLDS,
  label,
  size = 'xs',
  showValue = false,
  valueLabel,
  glow,
  className,
  testId,
}: MeterBarProps): React.ReactElement {
  const known = typeof value === 'number' && Number.isFinite(value);
  const pct = known ? Math.max(0, Math.min(100, (value / (max || 1)) * 100)) : 0;
  const resolved: Tone = tone ?? (known ? thresholdTone(pct, thresholds) : 'muted');
  const glowing = glow || (!tone && known && pct >= thresholds.warn);
  const text = valueLabel ?? (known ? `${pct.toFixed(pct < 10 && pct > 0 ? 1 : 0)}%` : '—');

  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)} data-testid={testId}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={known ? value : undefined}
        aria-valuetext={text}
        className={cn('relative flex-1 overflow-hidden rounded-full bg-border/70', HEIGHT[size])}
      >
        <div
          style={{ '--meter': `${pct}%` } as CSSProperties}
          className={cn(
            'h-full w-(--meter) rounded-full transition-[width] duration-700 ease-out-expo starting:w-0',
            TONE_BG[resolved],
            glowing && GLOW[resolved],
          )}
        />
      </div>
      {showValue && (
        <span className={cn('num w-11 shrink-0 text-right text-[11px]', known ? TONE_TEXT[resolved] : 'text-text-muted')}>
          {text}
        </span>
      )}
    </div>
  );
}
