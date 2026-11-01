import { RotateCcw, ShieldOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { AgentSelfUpgrade } from '@/types/upgrades';

/** The agent's own report on whether it can upgrade itself, and the last upgrade's outcome. */
function selfUpgradeReport(metadata: Record<string, unknown> | string | null | undefined): AgentSelfUpgrade | undefined {
  let value: unknown = metadata;
  if (typeof metadata === 'string') {
    try { value = JSON.parse(metadata); } catch { return undefined; }
  }
  return (value as Record<string, unknown> | null | undefined)?.['agentSelfUpgrade'] as AgentSelfUpgrade | undefined;
}

export function AgentSelfUpgradeBadge({ metadata }: { metadata: Record<string, unknown> | string | null | undefined }): React.ReactElement | null {
  const report = selfUpgradeReport(metadata);
  if (!report) return null;
  if (report.upgrade?.state === 'reverted') {
    return (
      <span title={report.upgrade.reason ?? undefined}>
        <Badge variant="danger"><RotateCcw className="mr-1 inline h-3 w-3" />Upgrade to {report.upgrade.to} reverted</Badge>
      </span>
    );
  }
  if (!report.enabled) {
    return (
      <span title={report.reason ?? undefined} data-testid="agent-self-upgrade-off">
        <Badge variant="default"><ShieldOff className="mr-1 inline h-3 w-3" />Self-upgrade off</Badge>
      </span>
    );
  }
  return null;
}
