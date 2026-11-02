import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { readinessTitle } from '@/lib/agent-upgrade-view';
import type { UpgradeReadiness } from '@/types/upgrades';

/** A node that could not take an agent upgrade now, with the reasons on hover. An agent that does not report it shows nothing. */
export function UpgradeReadinessBadge({ readiness }: { readiness: UpgradeReadiness | null | undefined }): React.ReactElement | null {
  if (readiness?.status !== 'not-ready') return null;
  return (
    <span title={readinessTitle(readiness)} data-testid="upgrade-readiness-badge">
      <Badge variant="warning"><AlertTriangle className="mr-1 inline h-3 w-3" />Upgrade blocked ({readiness.problems.length})</Badge>
    </span>
  );
}

/** The node page: each problem with its cause and what to do about it. */
export function UpgradeReadinessPanel({ readiness }: { readiness: UpgradeReadiness | null | undefined }): React.ReactElement | null {
  if (readiness?.status !== 'not-ready') return null;
  return (
    <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[11px]" data-testid="upgrade-readiness-panel">
      <p className="flex items-center gap-2 font-bold uppercase tracking-wider text-warning">
        <AlertTriangle className="h-3.5 w-3.5" /> This node could not take an agent upgrade now
      </p>
      <ul className="mt-2 space-y-2">
        {readiness.problems.map((problem) => (
          <li key={`${problem.code}-${problem.detail}`}>
            <p className="font-medium text-text"><span className="num">{problem.code}</span>: {problem.detail}</p>
            <p className="text-text-muted">{problem.remedy}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
