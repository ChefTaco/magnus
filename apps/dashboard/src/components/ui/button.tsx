import { cn } from '@/lib/utils';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

const variants: Record<ButtonVariant, string> = {
  primary:
    'border border-primary/60 bg-primary/10 text-primary hover:bg-primary/20 hover:border-primary hover:shadow-[0_0_12px_var(--color-glow)]',
  secondary:
    'border border-border bg-surface text-text-muted hover:border-primary/40 hover:text-text hover:shadow-[0_0_8px_var(--color-glow)]',
  danger:
    'border border-danger/60 bg-danger/10 text-danger hover:bg-danger/20 hover:border-danger hover:shadow-[0_0_12px_rgba(255,23,68,0.3)]',
  success:
    'border border-success/60 bg-success/10 text-success hover:bg-success/20 hover:border-success hover:shadow-[0_0_12px_rgba(0,230,118,0.3)]',
  ghost:
    'text-text-muted hover:text-accent hover:drop-shadow-[0_0_6px_var(--color-glow-accent)]',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[11px]',
  md: 'h-9 px-4 text-xs',
  lg: 'h-10 px-5 text-xs',
};

/** Button classes for links and other elements that should look like a Button. */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', className?: string): string {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-chip font-medium uppercase tracking-wider transition-all duration-200 disabled:opacity-50 disabled:pointer-events-none',
    variants[variant],
    sizes[size],
    className,
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  children,
  className,
  ...props
}: ButtonProps): React.ReactElement {
  return (
    <button
      className={buttonClass(variant, size, className)}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}
