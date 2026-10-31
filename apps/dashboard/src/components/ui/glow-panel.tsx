import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { TONE_TEXT, type Tone } from '@/lib/theme-colors';

const CORNER_COLOR: Record<Tone, string> = {
  primary: '[--panel-corner-color:color-mix(in_srgb,var(--color-primary)_60%,transparent)]',
  accent: '[--panel-corner-color:color-mix(in_srgb,var(--color-accent)_70%,transparent)]',
  success: '[--panel-corner-color:color-mix(in_srgb,var(--color-success)_60%,transparent)]',
  warning: '[--panel-corner-color:color-mix(in_srgb,var(--color-warning)_70%,transparent)]',
  danger: '[--panel-corner-color:color-mix(in_srgb,var(--color-danger)_70%,transparent)]',
  info: '[--panel-corner-color:color-mix(in_srgb,var(--color-info)_60%,transparent)]',
  muted: '[--panel-corner-color:var(--color-border-strong)]',
};

const GLOW_COLOR: Record<Tone, string> = {
  primary: '[--glow-hover-color:var(--color-glow)]',
  accent: '[--glow-hover-color:var(--color-glow-accent)]',
  success: '[--glow-hover-color:var(--color-glow-success)]',
  warning: '[--glow-hover-color:var(--color-glow-warning)]',
  danger: '[--glow-hover-color:var(--color-glow-danger)]',
  info: '[--glow-hover-color:var(--color-glow)]',
  muted: '[--glow-hover-color:var(--color-glow)]',
};

const HOVER_BORDER: Record<Tone, string> = {
  primary: 'hover:border-primary/30',
  accent: 'hover:border-accent/40',
  success: 'hover:border-success/30',
  warning: 'hover:border-warning/40',
  danger: 'hover:border-danger/40',
  info: 'hover:border-info/30',
  muted: 'hover:border-border-strong',
};

export interface GlowPanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  tone?: Tone;
  /** Corner-bracket accent. */
  corners?: boolean;
  /** Hover glow (compositor-only opacity fade). */
  interactive?: boolean;
  /** Larger showcase panel with a grid backdrop. */
  hero?: boolean;
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  as?: 'div' | 'section' | 'article';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  testId?: string;
  children?: ReactNode;
}

const PADDING = { none: '', sm: 'p-3', md: 'p-5', lg: 'p-6' } as const;

/** Themed surface panel: the base for cards, tiers and hero bands. */
export function GlowPanel({
  tone = 'primary',
  corners = true,
  interactive = true,
  hero = false,
  title,
  description,
  icon,
  action,
  as: Tag = 'div',
  padding = 'md',
  testId,
  className,
  children,
  ...props
}: GlowPanelProps): React.ReactElement {
  return (
    <Tag
      {...props}
      data-testid={testId ?? (props as Record<string, unknown>)['data-testid']}
      className={cn(
        'relative rounded-panel border border-border bg-surface transition-colors duration-300',
        PADDING[padding],
        corners && 'panel-corners',
        corners && CORNER_COLOR[tone],
        interactive && 'glow-hover',
        interactive && GLOW_COLOR[tone],
        interactive && HOVER_BORDER[tone],
        hero && 'grid-bg overflow-hidden bg-surface/80',
        className,
      )}
    >
      {(title || action || icon) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            {icon && <span className={cn('mt-0.5 shrink-0', TONE_TEXT[tone])}>{icon}</span>}
            <div className="min-w-0">
              {title && <h3 className="text-xs font-bold uppercase tracking-wider">{title}</h3>}
              {description && <p className="mt-0.5 text-[11px] text-text-muted">{description}</p>}
            </div>
          </div>
          {action}
        </div>
      )}
      {children}
    </Tag>
  );
}
