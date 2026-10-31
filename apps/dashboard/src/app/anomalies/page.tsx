'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import type { AnomalyEvent, AnomalySummary } from '@/types/contracts';
import { AlertTriangle, ArrowRight, RefreshCw, ShieldAlert, Siren } from 'lucide-react';

function severityClass(severity: string): string {
  if (severity === 'critical') return 'border-danger/30 bg-danger/5 text-danger';
  if (severity === 'warning') return 'border-warning/30 bg-warning/5 text-warning';
  return 'border-info/30 bg-info/5 text-info';
}

export default function AnomaliesPage(): React.ReactElement {
  const [summary, setSummary] = useState<AnomalySummary | null>(null);
  const [anomalies, setAnomalies] = useState<AnomalyEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [summaryResp, listResp] = await Promise.all([
        api.anomalies.summary(),
        api.anomalies.list({ resolved: 'false', pageSize: 100 }),
      ]);
      setSummary(summaryResp.data ?? null);
      setAnomalies(listResp.data?.anomalies ?? []);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hotspot = useMemo(() => summary?.byNode[0] ?? null, [summary]);

  return (
    <PageTransition>
      <PageItem>
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Siren className="h-5 w-5 text-primary" />
              <h1 className="text-2xl font-bold uppercase tracking-wider text-text">Anomalies</h1>
            </div>
            <p className="mt-1 text-xs uppercase tracking-wider text-text-muted">Fleet-wide anomaly feed with AI correlation drill-down</p>
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

      <PageItem>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <ShieldAlert className="h-5 w-5 text-danger" />
              <div>
                <p className="text-lg font-bold text-text">{summary?.totalActive ?? '—'}</p>
                <p className="text-[10px] uppercase tracking-wider text-text-muted">Active anomalies</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-warning" />
              <div>
                <p className="text-lg font-bold text-text">{summary ? Object.keys(summary.bySeverity).length : '—'}</p>
                <p className="text-[10px] uppercase tracking-wider text-text-muted">Severity bands active</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <Siren className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm font-bold text-text">{hotspot?.nodeName ?? '—'}</p>
                <p className="text-[10px] uppercase tracking-wider text-text-muted">Current hotspot</p>
              </div>
            </div>
          </Card>
        </div>
      </PageItem>

      <PageItem>
        <Card className="overflow-hidden p-0">
          <div className="border-b border-border/50 px-4 py-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-text-muted">Unresolved anomalies</h2>
          </div>
          {anomalies.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-muted">
              {loading ? 'Loading anomalies…' : 'No unresolved anomalies at the moment. A rare and beautiful sight.'}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {anomalies.map((anomaly) => (
                <Link
                  key={anomaly.id}
                  href={`/anomalies/${anomaly.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-hover"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span className={`rounded border px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${severityClass(anomaly.severity)}`}>
                        {anomaly.severity}
                      </span>
                      <span className="text-xs font-semibold text-text">{anomaly.metric}</span>
                      <span className="text-[11px] text-text-muted">{anomaly.node?.name ?? anomaly.nodeId}</span>
                      {anomaly.occurrenceCount > 1 && (
                        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold text-accent">
                          ×{anomaly.occurrenceCount}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-text-muted">
                      Value {anomaly.value.toFixed(2)} • z-score {anomaly.zScore.toFixed(2)}
                      {' '}• first seen {new Date(anomaly.firstSeenAt).toLocaleString()}
                      {anomaly.occurrenceCount > 1 && (
                        <> • last seen {new Date(anomaly.lastSeenAt).toLocaleString()}</>
                      )}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 flex-shrink-0 text-text-muted" />
                </Link>
              ))}
            </div>
          )}
        </Card>
      </PageItem>
    </PageTransition>
  );
}
