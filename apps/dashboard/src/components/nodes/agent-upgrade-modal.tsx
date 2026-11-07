'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpCircle, CheckCircle2, ClipboardCheck, Loader2, OctagonX, RotateCcw, XCircle } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api-client';
import { isNotFound, nodeDetail, remedyText, retryCount, retryable, runHeadline, targetDescription, upgradeErrorMessage } from '@/lib/agent-upgrade-view';
import type { AgentUpgradeCheck, AgentUpgradeEligibility, AgentUpgradeRun, NodeRunState } from '@/types/upgrades';

const RUN_POLL_MS = 5_000;

const stateBadge: Record<NodeRunState, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' }> = {
  pending: { label: 'Queued', variant: 'default' },
  requested: { label: 'Installing', variant: 'info' },
  watching: { label: 'Watching', variant: 'info' },
  ambiguous: { label: 'Unknown', variant: 'warning' },
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
 * time. Check shows every node's full report before anything starts. A problem
 * of one node never stops the run; reopening shows the last run, each node needing
 * attention with what to do, and Retry for those nodes.
 */
export function AgentUpgradeModal({ open, onClose, onFinished }: { open: boolean; onClose: () => void; onFinished?: () => void }): React.ReactElement {
  const [eligibility, setEligibility] = useState<AgentUpgradeEligibility | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [run, setRun] = useState<AgentUpgradeRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<AgentUpgradeCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [maxFailures, setMaxFailures] = useState('');

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

  useEffect(() => { if (open) { setRun(null); setCheck(null); void load(); } }, [open, load]);

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
  const majorUpgradeCount = eligibility?.nodes.filter((node) => node.code === 'MAJOR_VERSION').length ?? 0;
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
  const budget = /^[1-9][0-9]{0,2}$/.test(maxFailures) ? { maxFailures: Number(maxFailures) } : {};
  const start = () => act(() => api.agentUpgrades.start({ nodeIds: [...selected], version: eligibility?.version,
    ...(eligibility?.prerelease ? { allowPrerelease: true } : {}), ...budget }));
  const runCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      setCheck(await api.agentUpgrades.check({ version: eligibility?.version, ...(selected.size ? { nodeIds: [...selected] } : {}) }));
    } catch (cause) {
      await fail(cause);
    } finally {
      setChecking(false);
    }
  };
  const stop = () => run && act(() => api.agentUpgrades.stop(run.id));
  const retry = (acknowledgeSuspicion = false) => run && act(() => api.agentUpgrades.retry(run.id, acknowledgeSuspicion ? { acknowledgeSuspicion } : {}));

  const toggle = (nodeId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
    return next;
  });

  return (
    <Modal open={open} onClose={onClose} title="Upgrade agents" icon={<ArrowUpCircle className="h-4 w-4" />}
      description={eligibility ? targetDescription(eligibility) : undefined}
      className="max-h-[calc(100dvh-1.5rem)] max-w-4xl overflow-y-auto">
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
            <p className="flex flex-wrap items-center gap-2">
              {run.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
              {run.status === 'succeeded' && <CheckCircle2 className="h-4 w-4 text-success" />}
              {run.status === 'partial' && <AlertTriangle className="h-4 w-4 text-warning" />}
              {(run.status === 'failed' || run.status === 'interrupted') && <XCircle className="h-4 w-4 text-danger" />}
              {run.status === 'stopped' && <OctagonX className="h-4 w-4 text-warning" />}
              <span className="font-bold uppercase tracking-wider">
                {run.status === 'running' ? `Upgrading to ${run.version}${run.stopRequestedBy ? ' (stopping after the nodes in progress)' : ''}` : runHeadline(run)}
              </span>
            </p>
            {run.status !== 'running' && run.message && <p className="text-text-muted" data-testid="agent-upgrade-run-message">{run.message}</p>}
            {(run.warnings ?? []).map((warning) => (
              <p key={`${warning.nodeId}-${warning.code}`} className="text-warning" data-testid="agent-upgrade-warning">{warning.name}: {warning.detail}</p>
            ))}
            <details open={run.status === 'running'} className="group">
              <summary className="cursor-pointer text-text-muted">
                {run.status === 'running' ? 'Current rollout' : 'Previous rollout'} to {run.version} · {run.nodes.length} agent{run.nodes.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-2 max-h-80 divide-y divide-border/40 overflow-y-auto rounded border border-border">
                {run.nodes.map((node) => (
                  <li key={node.nodeId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <span className="w-40 truncate font-medium text-text">{node.name}{node.nodeId === (run.canaryNodeId ?? run.nodes[0]?.nodeId) ? ' (canary)' : ''}</span>
                    <span className="num shrink-0 text-text-muted">{node.from} → {run.version}</span>
                    <Badge variant={stateBadge[node.state]?.variant ?? 'default'}>
                      {node.state === 'requested' && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
                      {node.state === 'reverted' && <RotateCcw className="mr-1 inline h-3 w-3" />}
                      {stateBadge[node.state]?.label ?? node.state}
                    </Badge>
                    {(node.attempts ?? 1) > 1 && <span className="num text-text-muted">try {node.attempts}</span>}
                    {nodeDetail(node) && <span className="w-full break-words text-text-muted">{nodeDetail(node)}</span>}
                  </li>
                ))}
                {(run.excluded ?? []).map((node) => (
                  <li key={`excluded-${node.nodeId}`} className="flex flex-wrap items-center gap-3 px-3 py-2 text-text-muted" title={node.reason}>
                    <span className="w-40 truncate font-medium text-text">{node.name}</span>
                    <Badge variant="default">Not included</Badge>
                    <span className="w-full break-words text-text-muted">{node.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
            {run.status !== 'running' && (run.attention?.length ?? 0) > 0 && (
              <div className="space-y-2 rounded border border-warning/40 bg-warning/10 px-3 py-2" data-testid="agent-upgrade-attention">
                <p className="font-bold uppercase tracking-wider text-warning">Needs attention</p>
                <ul className="max-h-48 space-y-2 overflow-y-auto">
                  {run.attention!.map((item) => (
                    <li key={`${item.nodeId}-${item.code}`}>
                      <p className="font-medium text-text">{item.name}: <span className="num">{item.code}</span>{item.failureClass === 'release' ? ' (points at the release)' : ''}{item.unknownCode ? ' (unrecognised code)' : ''}</p>
                      {item.detail && <p className="text-text-muted">{item.detail}</p>}
                      <p className="text-text">{item.remedy}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {check && (
          <div className="space-y-2" data-testid="agent-upgrade-check">
            <p className="font-bold uppercase tracking-wider">
              Check: {check.eligible} ready, {check.blocked} blocked{check.release.verified ? '' : `; target not verified: ${check.release.reason ?? 'unknown'}`}
            </p>
            <ul className="max-h-64 divide-y divide-border/40 overflow-y-auto rounded border border-border">
              {check.nodes.map((node) => (
                <li key={node.nodeId} className="space-y-1 px-3 py-2">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="w-40 truncate font-medium text-text">{node.name}</span>
                    <Badge variant={node.eligible ? 'success' : node.preflight?.status === 'blocked' ? 'danger' : 'default'}>{node.eligible ? 'Ready' : node.code ?? 'Not eligible'}</Badge>
                    <span className="text-text-muted">preflight {node.preflight?.status ?? 'not run'}</span>
                  </p>
                  {!node.eligible && node.reason && <p className="text-text-muted">{node.reason}</p>}
                  {!node.eligible && node.remedy && <p className="text-text">{node.remedy}</p>}
                  {node.preflight?.problems.filter((problem) => problem.code !== node.code).map((problem) => (
                    <p key={`${problem.code}-${problem.detail}`} className="text-text-muted">
                      <span className="num">{problem.code}</span>: {problem.detail}. {remedyText(problem.code)}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}

        {showCandidates && (
          <section className="space-y-2" aria-label="Current upgrade eligibility">
            <p className="font-bold uppercase tracking-wider">Target {eligibility.version}: {eligibleCount} ready, {eligibility.nodes.length - eligibleCount} unavailable</p>
            {majorUpgradeCount > 0 && (
              <div className="space-y-1 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-warning" data-testid="agent-upgrade-major-notice">
                <p>{majorUpgradeCount} agent{majorUpgradeCount === 1 ? ' requires' : 's require'} a manual major-version upgrade to {eligibility.version}. This dialog only upgrades agents within their current major version.</p>
                <p>Read the <a href="https://github.com/ChefTaco/magnus/blob/main/UPGRADING.md#agents" target="_blank" rel="noreferrer" className="underline">agent upgrade guide</a>, then upgrade each affected node using its installation method. A successful rollout to an older version does not complete this upgrade.</p>
              </div>
            )}
            {eligibleCount === 0 && <p className="text-text-muted" data-testid="agent-upgrade-empty">No agents can be upgraded from this dialog right now. Review the reasons below; Check refreshes the readiness report.</p>}
            <ul className="max-h-80 divide-y divide-border/40 overflow-y-auto rounded border border-border" data-testid="agent-upgrade-candidates">
              {eligibility.nodes.map((node) => (
                <li key={node.nodeId} className="px-3 py-2">
                  <label className="flex items-start gap-3">
                    <input type="checkbox" className="mt-0.5 shrink-0" aria-label={`Upgrade ${node.name}`} checked={selected.has(node.nodeId)}
                      disabled={!node.eligible || !eligibility.upgradesEnabled} onChange={() => toggle(node.nodeId)} />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="break-words font-medium text-text">{node.name}</span>
                        <span className="num text-text-muted">{node.version}{node.eligible ? ` → ${eligibility.version}` : ''}</span>
                        {node.preflight && node.preflight.status !== 'ok' && (
                          <Badge variant={node.preflight.status === 'blocked' ? 'danger' : 'default'}>preflight {node.preflight.status}</Badge>
                        )}
                      </span>
                      {!node.eligible && <span className="block break-words text-text-muted">{node.reason}</span>}
                    </span>
                  </label>
                </li>
              ))}
              {eligibility.nodes.length === 0 && <li className="px-3 py-2 text-text-muted">No nodes registered.</li>}
            </ul>
          </section>
        )}

        <div className="space-y-3 border-t border-border pt-3">
          <p className="text-text-muted">
            The first agent is a canary. Each agent switches back by itself if the new version does not report a heartbeat in time. Only evidence about the release stops the run: a failure on the canary, an integrity mismatch, or too many reverts. A problem of one node is recorded and the run goes on.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {showCandidates && eligibleCount > 0 && (
              <label className="flex shrink-0 items-center gap-1 text-text-muted" title="Reverts or failed installs that stop the run after its canary. Empty: the server's setting.">
                Stop after
                <input className="w-12 rounded border border-border bg-transparent px-1 py-0.5 text-text" inputMode="numeric" aria-label="Release failures that stop the run"
                  value={maxFailures} onChange={(event) => setMaxFailures(event.target.value)} data-testid="agent-upgrade-max-failures" />
                failures
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
              {run?.status === 'running' && (
                <Button variant="danger" size="sm" onClick={() => void stop()} data-testid="agent-upgrade-stop" disabled={busy || Boolean(run.stopRequestedBy)}
                  icon={<OctagonX className="h-3.5 w-3.5" />}>Stop</Button>
              )}
              {retryable(run) && eligibility?.upgradesEnabled && (
                <Button variant="secondary" size="sm" onClick={() => void retry()} data-testid="agent-upgrade-retry" disabled={busy}
                  icon={<RotateCcw className="h-3.5 w-3.5" />}>Retry {retryCount(run)} node{retryCount(run) === 1 ? '' : 's'}</Button>
              )}
              {retryable(run) && eligibility?.upgradesEnabled && (run?.suspectedRelease || run?.excluded?.some((node) => node.code === 'RETRY_HELD_SUSPECTED')) && (
                <Button variant="danger" size="sm" onClick={() => void retry(true)} data-testid="agent-upgrade-retry-acknowledged" disabled={busy}
                  title="Each attempt on an older agent can strand another lease. Read the agent log first."
                  icon={<RotateCcw className="h-3.5 w-3.5" />}>Retry older agents too</Button>
              )}
              {showCandidates && (
                <Button variant="secondary" size="sm" onClick={() => void runCheck()} data-testid="agent-upgrade-check-button" disabled={busy || checking}
                  icon={checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}>Check</Button>
              )}
              {showCandidates && (
                <Button variant="primary" size="sm" onClick={() => void start()} data-testid="agent-upgrade-start"
                  disabled={busy || selected.size === 0 || !eligibility?.upgradesEnabled}
                  icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}>
                  Upgrade {selected.size} agent{selected.size === 1 ? '' : 's'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
