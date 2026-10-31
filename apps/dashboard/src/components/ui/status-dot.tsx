import { cn } from '@/lib/cn';
import { statusVariant } from './badge';

const COLOR = {
  success: 'bg-success shadow-[0_0_6px_var(--color-success)]',
  warning: 'bg-warning shadow-[0_0_6px_var(--color-warning)]',
  danger: 'bg-danger shadow-[0_0_6px_var(--color-danger)]',
  info: 'bg-info shadow-[0_0_6px_var(--color-info)]',
  default: 'bg-text-muted',
} as const;

const HALO = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  default: 'bg-text-muted',
} as const;

const LIVE = new Set(['ONLINE', 'RUNNING', 'ACTIVE', 'HEALTHY', 'CRITICAL', 'UPDATING', 'PROVISIONING']);

export interface StatusDotProps {
  status: string;
  /** Override the halo pulse (defaults on for live states). */
  pulse?: boolean;
  size?: 'xs' | 'sm';
  className?: string;
  label?: string;
}

/** Glowing status indicator; live states get a pulsing halo. */
export function StatusDot({ status, pulse, size = 'sm', className, label }: StatusDotProps): React.ReactElement {
  const variant = statusVariant(status);
  const animate = pulse ?? LIVE.has(status.toUpperCase());
  const dim = size === 'xs' ? 'h-1.5 w-1.5' : 'h-2 w-2';
  return (
    <span
      className={cn('relative inline-flex shrink-0', dim, className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {animate && <span className={cn('absolute inset-0 rounded-full animate-halo', HALO[variant])} />}
      <span className={cn('relative inline-flex rounded-full', dim, COLOR[variant])} />
    </span>
  );
}
