/** Severity levels reported by the Control API security summary. */
export type FusionSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** One evidence source in the Control API security summary. */
export interface FusionSource {
  source: string;
  status: string;
  lastEventAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

export const severityClass: Record<FusionSeverity, string> = {
  info: 'text-text-muted border-border',
  low: 'text-primary border-primary/30',
  medium: 'text-warning border-warning/40',
  high: 'text-accent border-accent/40 shadow-[0_0_10px_var(--color-glow-accent)]',
  critical: 'text-danger border-danger/50 bg-danger/5 shadow-[0_0_14px_var(--color-glow-danger)]',
};
