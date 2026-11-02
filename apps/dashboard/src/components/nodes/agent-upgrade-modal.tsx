'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpCircle, CheckCircle2, Loader2, OctagonX, RotateCcw, XCircle } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api-client';
import { isNotFound, nodeDetail, retryable, targetDescription, upgradeErrorMessage } from '@/lib/agent-upgrade-view';
import type { AgentUpgradeEligibility, AgentUpgradeRun, NodeRunState } from '@/types/upgrades';

const RUN_POLL_MS = 5_000;

const stateBadge: Record<NodeRunState, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' }> = {
  pending: { label: 'Queued', variant: 'default' },
  requested: { label: 'Installing', variant: 'info' },
  confirmed: { label: 'Upgraded', variant: 'success' },
  reverted: { label: 'Reverted', variant: 'danger' },
  failed: { label: 'Failed', variant: 'danger' },
  refused: { label: 'Refused', variant: 'warning' },
  skipped: { label: 'Skipped', variant: 'default' },
};

/**
 * "Upgrade agents": every node with whether it can take the target agent
 * version now. Nodes that cannot (offline, not installed with
 * `magnus-agent install-service`, self-upgrade switched off, another major,
 * enrollment blockers) are greyed out with the reason. One canary goes first;
 * each agent reverts itself if the new version does not report a heartbeat in
 * time. Reopening shows the last run, with Retry for the nodes it left over.
 */
export function AgentUpgradeModal({ open, onClose, onFinished }: { open: boolean; onClose: () => void; onFinished?: () => void }): React.ReactElement {
  const [eligibility, setEligibility] = useState<AgentUpgradeEligibility | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [run, setRun] = useState<AgentUpgradeRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = async (cause: unknown) => setError(await upgradeErrorMessage(cause));

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.agentUpgrades.eligibility();
      setEligibility(data);
      setSelected(new Set(data.nodes.filter((node) => node.eligible).map((node) => node.nodeId)));
      setRun(data.latestRun ?? null);
    } catch (cause) {
      setError(await upgradeErrorMessage(cause));
    }
  }, []);

  useEffect(() => { if (open) { setRun(null); void load(); } }, [open, load]);

  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const timer = window.setInterval(() => {
      api.agentUpgrades.run(run.id).then((next) => {
        setRun(next);
        if (next.status !== 'running') onFinished?.();
      }).catch(async (cause: unknown) => {
        window.clearInterval(timer);
        setError(isNotFound(cause) ? `Upgrade run ${run.id} is no longer known to the server` : await upgradeErrorMessage(cause));
        if (isNotFound(cause)) setRun(null);
      });
    }, RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [run, onFinished]);

  const eligibleCount = useMemo(() => eligibility?.nodes.filter((node) => node.eligible).length ?? 0, [eligibility]);
  const showCandidates = eligibility && (!run || run.status !== 'running');

  const act = async (action: () => Promise<AgentUpgradeRun>) => {
    setBusy(true);
    setError(null);
    try {
      setRun(await action());
    } catch (cause) {
      await fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const start = () => act(() => api.agentUpgrades.start({ nodeIds: [...selected], version: eligibility?.version,
    ...(eligibility?.prerelease ? { allowPrerelease: true } : {}) }));
  const stop = () => run && act(() => api.agentUpgrades.stop(run.id));
  const retry = () => run && act(() => api.agentUpgrades.retry(run.id));

  const toggle = (nodeId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
    return next;
  });

  return (
    <Modal open={open} onClose={onClose} title="Upgrade agents" icon={<ArrowUpCircle className="h-4 w-4" />}
      description={eligibility ? targetDescription(eligibility) : undefined}
      className="max-w-2xl">
      <div className="space-y-4 text-[11px]">
        {error && <div className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger" data-testid="agent-upgrade-error">{error}</div>}
        {eligibility && !eligibility.upgradesEnabled && (
          <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-warning">
            Agent upgrades are off: {eligibility.disabledReason}
          </div>
        )}
        {!eligibility && !error && <div className="flex items-center gap-2 text-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Checking agents…</div>}

        {run && (
          <div className="space-y-2" data-testid="agent-upgrade-run">
            <p className="flex items-center gap-2">
              {run.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
              {run.status === 'succeeded' && <CheckCircle2 className="h-4 w-4 text-success" />}
              {(run.status === 'failed' || run.status === 'interrupted') && <XCircle className="h-4 w-4 text-danger" />}
              {run.status === 'stopped' && <OctagonX className="h-4 w-4 text-warning" />}
              <span className="font-bold uppercase tracking-wider">
                {run.status === 'running' ? `Upgrading to ${run.version}${run.stopRequestedBy ? ' (stopping after the nodes in progress)' : ''}` : `Last run: ${run.status}`}
              </span>
            </p>
            {run.status !== 'running' && run.message && <p className="text-text-muted" data-testid="agent-upgrade-run-message">{run.message}</p>}
            <ul className="max-h-80 divide-y divide-border/40 overflow-y-auto rounded border border-border">
              {run.nodes.map((node) => (
                <li key={node.nodeId} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-40 truncate font-medium text-text">{node.name}{node.nodeId === (run.canaryNodeId ?? run.nodes[0]?.nodeId) ? ' (canary)' : ''}</span>
                  <span className="num w-28 text-text-muted">{node.from} → {run.version}</span>
                  <Badge variant={stateBadge[node.state]?.variant ?? 'default'}>
                    {node.state === 'requested' && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
                    {node.state === 'reverted' && <RotateCcw className="mr-1 inline h-3 w-3" />}
                    {stateBadge[node.state]?.label ?? node.state}
                  </Badge>
                  {nodeDetail(node) && <span className="min-w-0 flex-1 truncate text-text-muted" title={nodeDetail(node) ?? undefined}>{nodeDetail(node)}</span>}
                </li>
              ))}
              {(run.excluded ?? []).map((node) => (
                <li key={`excluded-${node.nodeId}`} className="flex items-center gap-3 px-3 py-2 opacity-60" title={node.reason}>
                  <span className="w-40 truncate font-medium text-text">{node.name}</span>
                  <Badge variant="default">Not included</Badge>
                  <span className="min-w-0 flex-1 truncate text-text-muted">{node.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {showCandidates && (
          <ul className="max-h-80 divide-y divide-border/40 overflow-y-auto rounded border border-border" data-testid="agent-upgrade-candidates">
            {eligibility.nodes.map((node) => (
              <li key={node.nodeId} className={`flex items-center gap-3 px-3 py-2 ${node.eligible && eligibility.upgradesEnabled ? '' : 'opacity-50'}`}
                title={node.reason ?? undefined}>
                <input type="checkbox" aria-label={`Upgrade ${node.name}`} checked={selected.has(node.nodeId)}
                  disabled={!node.eligible || !eligibility.upgradesEnabled} onChange={() => toggle(node.nodeId)} />
                <span className="w-40 truncate font-medium text-text">{node.name}</span>
                <span className="num w-20 text-text-muted">{node.version}</span>
                <span className="min-w-0 flex-1 truncate text-text-muted">{node.eligible ? `→ ${eligibility.version}` : node.reason}</span>
              </li>
            ))}
            {eligibility.nodes.length === 0 && <li className="px-3 py-2 text-text-muted">No nodes registered.</li>}
          </ul>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-text-muted">
            The first agent is a canary. Each agent switches back by itself if the new version does not report a heartbeat in time. A revert or failure stops the run; an agent that refuses before changing anything is skipped over.
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
            {run?.status === 'running' && (
              <Button variant="danger" size="sm" onClick={() => void stop()} data-testid="agent-upgrade-stop" disabled={busy || Boolean(run.stopRequestedBy)}
                icon={<OctagonX className="h-3.5 w-3.5" />}>Stop</Button>
            )}
            {retryable(run) && eligibility?.upgradesEnabled && (
              <Button variant="secondary" size="sm" onClick={() => void retry()} data-testid="agent-upgrade-retry" disabled={busy}
                icon={<RotateCcw className="h-3.5 w-3.5" />}>Retry the rest</Button>
            )}
            {showCandidates && (
              <Button variant="primary" size="sm" onClick={() => void start()} data-testid="agent-upgrade-start"
                disabled={busy || selected.size === 0 || !eligibility?.upgradesEnabled}
                icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}>
                Upgrade {selected.size || eligibleCount} agent{(selected.size || eligibleCount) === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
