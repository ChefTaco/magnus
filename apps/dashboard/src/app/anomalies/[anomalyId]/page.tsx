'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import type { AiConversation, AnomalyCorrelationDetails, RemediationRule, RemediationExecution } from '@/types/contracts';
import { ArrowLeft, Bot, Clock3, GitBranch, RefreshCw, Siren, Terminal, Zap } from 'lucide-react';

type TimelineItem = {
  id: string;
  kind: 'target-anomaly' | 'correlated-anomaly' | 'command';
  title: string;
  timestamp: string;
  detail: string;
  nodeId: string;
};

function timelineKindClass(kind: TimelineItem['kind']): string {
  if (kind === 'target-anomaly') return 'border-primary/30 bg-primary/5 text-primary';
  if (kind === 'command') return 'border-warning/30 bg-warning/5 text-warning';
  return 'border-border bg-surface-hover text-text';
}

export default function AnomalyDetailPage(): React.ReactElement {
  const params = useParams<{ anomalyId: string }>();
  const [details, setDetails] = useState<AnomalyCorrelationDetails | null>(null);
  const [heartbeatConversation, setHeartbeatConversation] = useState<AiConversation | null>(null);
  const [rules, setRules] = useState<RemediationRule[]>([]);
  const [remediationExecs, setRemediationExecs] = useState<RemediationExecution[]>([]);
  const [triggering, setTriggering] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [detailsResp, heartbeatResp, rulesResp, execsResp] = await Promise.allSettled([
        api.anomalies.correlation(params.anomalyId),
        api.assistant.conversations({ type: 'heartbeat', status: 'all', pageSize: 1 }),
        api.remediation.listRules(),
        api.remediation.listExecutions({ pageSize: 20 }),
      ]);

      if (detailsResp.status === 'fulfilled') {
        setDetails(detailsResp.value.data ?? null);
      }
      if (heartbeatResp.status === 'fulfilled') {
        setHeartbeatConversation(heartbeatResp.value.data?.conversations?.[0] ?? null);
      }
      if (rulesResp.status === 'fulfilled') {
        setRules((rulesResp.value.data ?? []).filter((r) => r.enabled));
      }
      if (execsResp.status === 'fulfilled') {
        const all = execsResp.value.data?.executions ?? [];
        setRemediationExecs(all.filter((e) => e.anomalyEventId === params.anomalyId));
      }
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, [params.anomalyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleTrigger = async (ruleId: string) => {
    setTriggering(true);
    try {
      await api.remediation.trigger({ anomalyEventId: params.anomalyId, ruleId });
      await load();
    } catch { /* ignore */ } finally {
      setTriggering(false);
    }
  };

  const timeline = useMemo<TimelineItem[]>(() => {
    if (!details) return [];

    const items: TimelineItem[] = [
      {
        id: details.anomaly.id,
        kind: 'target-anomaly',
        title: `Primary anomaly • ${details.anomaly.metric}`,
        timestamp: details.anomaly.createdAt,
        detail: `Value ${details.anomaly.value.toFixed(2)} • z-score ${details.anomaly.zScore.toFixed(2)} • severity ${details.anomaly.severity}`,
        nodeId: details.anomaly.nodeId,
      },
      ...details.group.anomalies
        .filter((anomaly) => anomaly.id !== details.anomaly.id)
        .map((anomaly) => ({
          id: anomaly.id,
          kind: 'correlated-anomaly' as const,
          title: `Correlated anomaly • ${anomaly.metric}`,
          timestamp: anomaly.createdAt,
          detail: `Value ${anomaly.value.toFixed(2)} • z-score ${anomaly.zScore.toFixed(2)} • severity ${anomaly.severity}`,
          nodeId: anomaly.nodeId,
        })),
      ...details.group.relatedCommands.map((command) => ({
        id: command.id,
        kind: 'command' as const,
        title: `Related command • ${command.command}`,
        timestamp: command.createdAt,
        detail: `Status ${command.status}`,
        nodeId: command.nodeId,
      })),
    ];

    return items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [details]);

  return (
    <PageTransition>
      <PageItem>
        <div className="flex items-center justify-between">
          <div>
            <Link href="/anomalies" className="mb-2 inline-flex items-center gap-1 text-xs uppercase tracking-wider text-text-muted hover:text-primary">
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to anomalies
            </Link>
            <div className="flex items-center gap-2">
              <Siren className="h-5 w-5 text-primary" />
              <h1 className="text-2xl font-bold uppercase tracking-wider text-text">AI anomaly analysis</h1>
            </div>
            <p className="mt-1 text-xs uppercase tracking-wider text-text-muted">Correlation timeline, root-cause hypotheses, and recommended actions</p>
          </div>
          <button
            onClick={() => void load()}
            className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted transition-colors hover:border-primary/40 hover:text-primary"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </PageItem>

      {!details && !loading ? (
        <PageItem>
          <Card className="p-6 text-sm text-text-muted">We couldn’t load correlation details for this anomaly.</Card>
        </PageItem>
      ) : (
        <>
          <PageItem>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Card className="p-4 lg:col-span-2">
                <div className="mb-3 flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-primary" />
                  <h2 className="text-xs font-bold uppercase tracking-wider text-text-muted">AI summary</h2>
                </div>
                <p className="text-sm text-text">{details?.analysis.summary ?? (loading ? 'Loading analysis…' : 'No summary available.')}</p>
                {details && (
                  <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="rounded border border-border/60 bg-bg/40 p-3">
                      <p className="text-lg font-bold text-text">{details.group.anomalies.length}</p>
                      <p className="text-[10px] uppercase tracking-wider text-text-muted">Correlated anomalies</p>
                    </div>
                    <div className="rounded border border-border/60 bg-bg/40 p-3">
                      <p className="text-lg font-bold text-text">{details.group.relatedCommands.length}</p>
                      <p className="text-[10px] uppercase tracking-wider text-text-muted">Related commands</p>
                    </div>
                    <div className="rounded border border-border/60 bg-bg/40 p-3">
                      <p className="text-lg font-bold text-text">{details.analysis.blastRadius}</p>
                      <p className="text-[10px] uppercase tracking-wider text-text-muted">Blast radius</p>
                    </div>
                  </div>
                )}
              </Card>

              <Card className="p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Bot className="h-4 w-4 text-primary" />
                  <h2 className="text-xs font-bold uppercase tracking-wider text-text-muted">Heartbeat context</h2>
                </div>
                {heartbeatConversation ? (
                  <>
                    <p className="text-sm text-text">A legacy heartbeat analysis exists for this anomaly. New fleet checks are recorded as cron logs and exposed through the Magnus API.</p>
                  </>
                ) : (
                  <p className="text-sm text-text-muted">No legacy heartbeat conversation is attached. Use the fleet check logs for current cron-owned status.</p>
                )}
              </Card>
            </div>
          </PageItem>

          <PageItem>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.35fr_0.85fr]">
              <Card className="p-4">
                <div className="mb-4 flex items-center gap-2">
                  <Clock3 className="h-4 w-4 text-primary" />
                  <h2 className="text-xs font-bold uppercase tracking-wider text-text-muted">Correlation timeline</h2>
                </div>
                <div className="space-y-3">
                  {timeline.map((item) => (
                    <div key={`${item.kind}-${item.id}`} className={`rounded border p-3 ${timelineKindClass(item.kind)}`}>
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <span className="text-xs font-bold uppercase tracking-wider">{item.title}</span>
                        <span className="text-[10px] opacity-80">{new Date(item.timestamp).toLocaleString()}</span>
                      </div>
                      <p className="text-[11px] opacity-90">{item.detail}</p>
                      <p className="mt-1 text-[10px] opacity-70">Node: {item.nodeId}</p>
                    </div>
                  ))}
                </div>
              </Card>

              <div className="space-y-4">
                <Card className="p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-primary" />
                    <h2 className="text-xs font-bold uppercase tracking-wider text-text-muted">Suspected triggers</h2>
                  </div>
                  <ul className="space-y-2 text-sm text-text-muted">
                    {(details?.analysis.suspectedTriggers ?? []).map((trigger) => (
                      <li key={trigger} className="rounded border border-border/60 bg-bg/40 px-3 py-2">{trigger}</li>
                    ))}
                  </ul>
                </Card>

                <Card className="p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Siren className="h-4 w-4 text-primary" />
                    <h2 className="text-xs font-bold uppercase tracking-wider text-text-muted">Recommended actions</h2>
                  </div>
                  <ul className="space-y-2 text-sm text-text-muted">
                    {(details?.analysis.recommendedActions ?? []).map((action) => (
                      <li key={action} className="rounded border border-border/60 bg-bg/40 px-3 py-2">{action}</li>
                    ))}
                  </ul>
                </Card>

                {/* Auto-Remediation section */}
                <Card className="p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Zap className="h-4 w-4 text-primary" />
                    <h2 className="text-xs font-bold uppercase tracking-wider text-text-muted">Auto-Remediation</h2>
                  </div>

                  {/* Manual trigger buttons */}
                  {rules.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-[11px] text-text-muted">Trigger a remediation rule for this anomaly:</p>
                      {rules.map((rule) => (
                        <button
                          key={rule.id}
                          disabled={triggering}
                          onClick={() => void handleTrigger(rule.id)}
                          className="flex w-full items-center justify-between rounded border border-border/60 bg-bg/40 px-3 py-2 text-left text-sm text-text transition-colors hover:border-primary/40 disabled:opacity-50"
                        >
                          <div>
                            <span className="font-semibold">{rule.name}</span>
                            {rule.description && <span className="ml-2 text-text-muted text-xs">— {rule.description}</span>}
                          </div>
                          <Zap className="h-3.5 w-3.5 text-primary shrink-0" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-text-muted">
                      No active remediation rules.{' '}
                      <Link href="/anomalies/remediation" className="text-primary hover:underline">Create one</Link>
                    </p>
                  )}

                  {/* Remediation executions for this anomaly */}
                  {remediationExecs.length > 0 && (
                    <div className="mt-4 space-y-2">
                      <p className="text-[11px] uppercase tracking-wider text-text-muted">Executions for this anomaly</p>
                      {remediationExecs.map((exec) => (
                        <div key={exec.id} className="rounded border border-border/60 bg-bg/40 px-3 py-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold text-text">{exec.rule?.name ?? exec.ruleId}</span>
                            <span className={`rounded px-2 py-0.5 font-semibold ${exec.status === 'completed' ? 'bg-success/20 text-success' : exec.status === 'failed' ? 'bg-danger/20 text-danger' : exec.status === 'running' ? 'bg-warning/20 text-warning' : 'bg-primary/20 text-primary'}`}>
                              {exec.status}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] text-text-muted">{new Date(exec.triggeredAt).toLocaleString()}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            </div>
          </PageItem>
        </>
      )}
    </PageTransition>
  );
}
