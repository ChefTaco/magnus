import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { TONE_TEXT, type Tone } from '@/lib/theme-colors';

const RING: Record<Tone, string> = {
  primary: 'border-primary/40 shadow-[0_0_16px_var(--color-glow)]',
  accent: 'border-accent/40 shadow-[0_0_16px_var(--color-glow-accent)]',
  success: 'border-success/40 shadow-[0_0_16px_var(--color-glow-success)]',
  warning: 'border-warning/40 shadow-[0_0_16px_var(--color-glow-warning)]',
  danger: 'border-danger/40 shadow-[0_0_16px_var(--color-glow-danger)]',
  info: 'border-info/40 shadow-[0_0_16px_var(--color-glow)]',
  muted: 'border-border-strong',
};

const FRAME: Record<Tone, string> = {
  primary: 'border-primary/20',
  accent: 'border-accent/25',
  success: 'border-success/20',
  warning: 'border-warning/25',
  danger: 'border-danger/25',
  info: 'border-info/20',
  muted: 'border-border',
};

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  tone?: Tone;
  compact?: boolean;
  className?: string;
  testId?: string;
}

/** Framed empty / error state with an icon in a glow ring. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  tone = 'muted',
  compact = false,
  className,
  testId,
}: EmptyStateProps): React.ReactElement {
  return (
    <div
      data-testid={testId}
      role={tone === 'danger' || tone === 'warning' ? 'alert' : undefined}
      className={cn(
        'flex flex-col items-center justify-center rounded-panel border border-dashed bg-surface/40 text-center',
        FRAME[tone],
        compact ? 'gap-2 px-4 py-5' : 'gap-3 px-6 py-10',
        className,
      )}
    >
      {icon && (
        <span
          className={cn(
            'flex items-center justify-center rounded-full border bg-bg',
            compact ? 'h-8 w-8' : 'h-12 w-12',
            RING[tone],
            tone === 'muted' ? 'text-text-muted' : TONE_TEXT[tone],
          )}
        >
          {icon}
        </span>
      )}
      <p className={cn('font-bold uppercase tracking-wider', compact ? 'text-[11px]' : 'text-xs', tone === 'muted' ? 'text-text' : TONE_TEXT[tone])}>
        {title}
      </p>
      {description && <p className="max-w-md text-[11px] leading-relaxed text-text-muted">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
