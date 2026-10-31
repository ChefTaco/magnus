import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { TONE_GLOW_TEXT, TONE_TEXT, type Tone } from '@/lib/theme-colors';

export interface PageHeaderProps {
  /** The only text inside the <h1>, so role/name lookups stay exact. */
  title: string;
  eyebrow?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  /** Chip or badge shown beside the title. */
  status?: ReactNode;
  tone?: Tone;
  className?: string;
  testId?: string;
}

/** Consistent page title block with an eyebrow, glow title and right-aligned actions. */
export function PageHeader({
  title,
  eyebrow,
  description,
  icon,
  actions,
  status,
  tone = 'primary',
  className,
  testId,
}: PageHeaderProps): React.ReactElement {
  return (
    <div data-testid={testId} className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span
            aria-hidden="true"
            className={cn(
              'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-panel border bg-surface',
              tone === 'accent' ? 'border-accent/40 shadow-[0_0_14px_var(--color-glow-accent)]' : 'border-primary/40 shadow-[0_0_14px_var(--color-glow)]',
              TONE_TEXT[tone],
            )}
          >
            {icon}
          </span>
        )}
        <div className="min-w-0">
          {eyebrow && (
            <p className={cn('mb-1 text-[10px] font-medium uppercase tracking-[0.3em]', TONE_TEXT[tone], 'opacity-80')}>
              <span aria-hidden="true">// </span>
              {eyebrow}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <h1 className={cn('text-xl font-bold uppercase tracking-wider', TONE_TEXT[tone], TONE_GLOW_TEXT[tone])}>{title}</h1>
            {status}
          </div>
          {description && <p className="mt-1 max-w-3xl text-xs text-text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
