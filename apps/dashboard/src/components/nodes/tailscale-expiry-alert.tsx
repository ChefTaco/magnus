import Link from 'next/link';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import type { TailscaleExpirySummary } from '@/types/contracts';

interface TailscaleExpiryAlertProps {
  summary: TailscaleExpirySummary;
  showAction?: boolean;
}

export function TailscaleExpiryAlert({
  summary,
  showAction = true,
}: TailscaleExpiryAlertProps): React.ReactElement | null {
  const nodes = summary.nodes
    .filter((node) => node.tailscale?.requiresRenewal)
    .sort((left, right) => {
      if (left.tailscale?.expired !== right.tailscale?.expired) {
        return left.tailscale?.expired ? -1 : 1;
      }
      return (left.tailscale?.daysRemaining ?? Number.MAX_SAFE_INTEGER)
        - (right.tailscale?.daysRemaining ?? Number.MAX_SAFE_INTEGER);
    });
  if (nodes.length === 0) return null;

  const hasExpired = nodes.some((node) => node.tailscale?.expired);
  const Icon = hasExpired ? ShieldAlert : AlertTriangle;
  const styles = hasExpired
    ? {
        panel: 'border-danger/40 bg-danger/5',
        rail: 'bg-danger',
        icon: 'bg-danger/10 text-danger',
        text: 'text-danger',
        chip: 'border-danger/30 text-danger',
        action: 'border-danger/40 text-danger hover:bg-danger/10',
      }
    : {
        panel: 'border-warning/40 bg-warning/5',
        rail: 'bg-warning',
        icon: 'bg-warning/10 text-warning',
        text: 'text-warning',
        chip: 'border-warning/30 text-warning',
        action: 'border-warning/40 text-warning hover:bg-warning/10',
      };

  return (
    <section
      id="tailscale-renewal"
      role="alert"
      aria-label="Tailscale renewal alert"
      className={`relative overflow-hidden rounded border px-4 py-3 ${styles.panel}`}
    >
      <div className={`absolute inset-y-0 left-0 w-0.5 ${styles.rail}`} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded ${styles.icon}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className={`text-xs font-bold uppercase tracking-[0.14em] ${styles.text}`}>
              {hasExpired ? 'Tailscale access expired' : 'Tailscale renewal due'}
            </p>
            <p className="mt-1 text-[11px] text-text-muted">
              {nodes.length} node {nodes.length === 1 ? 'key needs' : 'keys need'} renewal within {summary.warningDays} days.
              Renew before tailnet access is interrupted.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {nodes.map((node) => (
                <span
                  key={node.id}
                  title={node.tailscale?.keyExpiry ? `Expires ${node.tailscale.keyExpiry}` : undefined}
                  className={`inline-flex items-center gap-1 rounded border bg-background/40 px-2 py-0.5 font-mono text-[10px] ${styles.chip}`}
                >
                  <span className="font-semibold">{node.name}</span>
                  <span aria-hidden="true">·</span>
                  <span>{node.tailscale?.expired ? 'expired' : `${node.tailscale?.daysRemaining ?? '?'}d`}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
        {showAction && (
          <Link
            href="/nodes#tailscale-renewal"
            className={`shrink-0 self-start rounded border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors sm:self-center ${styles.action}`}
          >
            Review nodes
          </Link>
        )}
      </div>
    </section>
  );
}
