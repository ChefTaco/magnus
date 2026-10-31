import { cn } from '@/lib/cn';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';

const variantStyles: Record<BadgeVariant, string> = {
  default: 'border-border text-text-muted',
  success: 'border-success/40 text-success bg-success/5 shadow-[0_0_6px_rgba(0,255,65,0.15)]',
  warning: 'border-warning/40 text-warning bg-warning/5 shadow-[0_0_6px_rgba(255,179,0,0.15)]',
  danger: 'border-danger/40 text-danger bg-danger/5 shadow-[0_0_6px_rgba(255,23,68,0.15)]',
  info: 'border-info/40 text-info bg-info/5 shadow-[0_0_6px_rgba(0,176,255,0.15)]',
};

const dotStyles: Record<BadgeVariant, string> = {
  default: 'bg-text-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
  /** Leading status dot. */
  dot?: boolean;
  /** Pulse the leading dot. */
  pulse?: boolean;
}

export function Badge({ children, variant = 'default', className, dot = false, pulse = false }: BadgeProps): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-chip border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
        variantStyles[variant],
        className,
      )}
    >
      {dot && (
        <span aria-hidden="true" className="relative inline-flex h-1.5 w-1.5">
          {pulse && <span className={cn('absolute inset-0 rounded-full animate-halo', dotStyles[variant])} />}
          <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', dotStyles[variant])} />
        </span>
      )}
      {children}
    </span>
  );
}

/** Map node/command statuses to badge variants. */
export function statusVariant(status: string): BadgeVariant {
  switch (status.toUpperCase()) {
    case 'ONLINE':
    case 'COMPLETED':
    case 'ACTIVE':
    case 'RUNNING':
    case 'INSTALLED':
    case 'HEALTHY':
      return 'success';
    case 'DEGRADED':
    case 'PAUSED':
    case 'QUEUED':
    case 'PENDING':
    case 'INSTALLING':
      return 'warning';
    case 'OFFLINE':
    case 'FAILED':
    case 'ERROR':
    case 'TIMEOUT':
    case 'CANCELLED':
    case 'DECOMMISSIONED':
    case 'CRITICAL':
      return 'danger';
    case 'PROVISIONING':
    case 'UPDATING':
      return 'info';
    default:
      return 'default';
  }
}
