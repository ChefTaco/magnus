'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { StatCard } from '@/components/ui/card';
import { Badge, statusVariant } from '@/components/ui/badge';
import { Server, Terminal, Clock, Activity, RefreshCw, Sparkles, AlertTriangle, Info, AlertCircle, Pin, PinOff, Globe, Shield, Radio } from 'lucide-react';
import { GlowPanel } from '@/components/ui/glow-panel';
import { PageHeader } from '@/components/ui/page-header';
import { Gauge } from '@/components/ui/gauge';
import { MeterBar } from '@/components/ui/meter-bar';
import { StatusDot } from '@/components/ui/status-dot';
import { AnimatedNumber } from '@/components/ui/animated-number';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonText } from '@/components/ui/skeleton';
import { LazyAreaChart } from '@/components/ui/charts/lazy-area-chart';
import { FleetRadar } from '@/components/overview/fleet-radar';
import { LiveEventList } from '@/components/live-ticker';
import { useSessionSamples, series } from '@/hooks/use-session-samples';
import type { Tone } from '@/lib/theme-colors';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { useControlNode } from '@/lib/control-node-context';
import { formatDate } from '@/lib/utils';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import Link from 'next/link';
import type { AiInsight, PinnedAiInsight, TailscaleExpirySummary } from '@/types/contracts';
import { TailscaleExpiryAlert } from '@/components/nodes/tailscale-expiry-alert';

export interface OverviewStats {
  nodes: { total: number; online: number; offline: number; degraded: number; provisioning: number };
  commands: { total: number; running: number; pending: number };
  cron: { total: number; active: number };
  health: { avgCpuPercent: number | null; avgMemoryPercent: number | null; reportingNodes: number };
  recentCommands: Array<{
    id: string;
    command: string;
    status: string;
    createdAt: string;
    node: { name: string } | null;
  }>;
  recentAudit: Array<{
    id: string;
    action: string;
    timestamp: string;
    targetType: string | null;
    targetId: string | null;
  }>;
}

interface DashboardPageClientProps {
  initialStats: OverviewStats | null;
  initialTailscaleSummary: TailscaleExpirySummary | null;
}

export default function DashboardPageClient({
  initialStats,
  initialTailscaleSummary,
}: DashboardPageClientProps): React.ReactElement {
  const { activeNode, nodes } = useControlNode();
  const [stats, setStats] = useState<OverviewStats | null>(initialStats);
  const [tailscaleSummary, setTailscaleSummary] = useState<TailscaleExpirySummary | null>(initialTailscaleSummary);
  const [loading, setLoading] = useState(!initialStats);
  const [insights, setInsights] = useState<AiInsight[]>([]);
  const [insightsGeneratedAt, setInsightsGeneratedAt] = useState<string | null>(null);
  const [pinnedInsights, setPinnedInsights] = useState<PinnedAiInsight[]>([]);
  // Skip the first client fetch when the server already provided stats.
  const skipInitialFetchRef = useRef(!!initialStats);
  // Federation mode — aggregate stats across all control nodes
  const [federationMode, setFederationMode] = useState(false);
  const [federationFleets, setFederationFleets] = useState<Array<{ nodeId: string; nodeName: string; stats: OverviewStats | null; error?: string }>>([]);

  const fetchFederationStats = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/federation');
      const json = await res.json() as { success: boolean; data: { aggregated: OverviewStats; fleets: Array<{ nodeId: string; nodeName: string; stats: OverviewStats | null; error?: string }> } };
      if (json.success) {
        setStats(json.data.aggregated);
        setFederationFleets(json.data.fleets);
      }
    } catch {
      // silently ignore
    }
  }, []);

  // The Tailscale summary can take several seconds; it never holds the stats back.
  const fetchTailscale = useCallback(async (): Promise<void> => {
    const tailscaleRes = await api.nodes.tailscaleSummary().catch(() => null);
    if (tailscaleRes?.success && tailscaleRes.data) setTailscaleSummary(tailscaleRes.data);
  }, []);

  const fetchStats = useCallback(async (silent = false): Promise<void> => {
    try {
      if (!silent) setLoading(true);
      void fetchTailscale();
      const res = await api.stats.overview();
      if (res.success) setStats(res.data as unknown as OverviewStats);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[DashboardPage] fetchStats error:', message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [fetchTailscale]);

  useEffect(() => {
    if (federationMode) {
      void fetchFederationStats();
      const interval = setInterval(() => void fetchFederationStats(), 15_000);
      return () => clearInterval(interval);
    }
    // On first mount with SSR data, skip the initial fetch — just start polling
    if (skipInitialFetchRef.current) {
      skipInitialFetchRef.current = false;
      if (!initialTailscaleSummary) void fetchTailscale();
      const interval = setInterval(() => void fetchStats(true), 15_000);
      return () => clearInterval(interval);
    }
    // When activeNode changes, reset and fetch fresh
    setStats(null);
    setLoading(true);
    void fetchStats();
    const interval = setInterval(() => void fetchStats(true), 15_000);
    return () => clearInterval(interval);
  }, [fetchStats, fetchFederationStats, fetchTailscale, activeNode.id, federationMode, initialTailscaleSummary]);

  const loadInsights = useCallback(async (): Promise<void> => {
    try {
      const [insightsResp, pinsResp] = await Promise.all([
        api.assistant.getInsights(),
        api.assistant.listPinnedInsights(),
      ]);
      setInsights(insightsResp.data?.insights ?? []);
      setInsightsGeneratedAt(insightsResp.data?.generatedAt ?? null);
      setPinnedInsights(pinsResp.data?.pins ?? []);
    } catch {
      // silently ignore
    }
  }, []);

  // Load AI insights + refresh every 5 minutes
  useEffect(() => {
    void loadInsights();
    const interval = setInterval(() => void loadInsights(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadInsights]);

  async function togglePin(insight: AiInsight): Promise<void> {
    const existing = pinnedInsights.find((item) => item.title === insight.title && item.body === insight.body);
    try {
      if (existing) {
        await api.assistant.unpinInsight(existing.id);
      } else {
        await api.assistant.pinInsight({ ...insight, generatedAt: insightsGeneratedAt ?? undefined });
      }
      await loadInsights();
    } catch {
      // silently ignore
    }
  }

  const sampleKey = `magnus:overview:${federationMode ? 'federation' : activeNode.id}`;
  const samples = useSessionSamples(
    sampleKey,
    stats
      ? {
          online: stats.nodes.online,
          active: stats.commands.running + stats.commands.pending,
          cron: stats.cron.active,
          cpu: stats.health.avgCpuPercent,
          mem: stats.health.avgMemoryPercent,
        }
      : null,
  );
  const prev = samples.length > 1 ? samples[samples.length - 2] : undefined;
  const deltaOf = (metric: string, current: number | null | undefined): number | undefined => {
    const before = prev?.[metric];
    return typeof before === 'number' && typeof current === 'number' ? Math.round((current - before) * 10) / 10 : undefined;
  };

  const cpu = stats?.health.avgCpuPercent ?? null;
  const mem = stats?.health.avgMemoryPercent ?? null;
  const onlinePct = stats && stats.nodes.total > 0 ? (stats.nodes.online / stats.nodes.total) * 100 : null;
  const posture: { label: string; tone: Tone } = !stats
    ? { label: 'Acquiring', tone: 'muted' }
    : stats.nodes.offline > 0
      ? { label: 'Nodes offline', tone: 'danger' }
      : stats.nodes.degraded > 0
        ? { label: 'Degraded', tone: 'warning' }
        : { label: 'All systems nominal', tone: 'success' };

  const healthTrend = stats
    ? stats.health.reportingNodes > 0
      ? { value: `${stats.health.reportingNodes} node${stats.health.reportingNodes !== 1 ? 's' : ''} reporting`, positive: true }
      : { value: 'No health data', positive: false }
    : { value: 'Connecting…', positive: true };

  const chartData = samples.map((s) => ({ t: s.t, cpu: s['cpu'] ?? null, mem: s['mem'] ?? null }));

  return (
    <PageTransition className="space-y-6">
      <PageItem>
        <PageHeader
          title={federationMode ? 'Federated Fleet Overview' : 'Fleet Overview'}
          eyebrow={federationMode ? 'Federation · live' : 'Fleet · live'}
          description={
            federationMode
              ? `Aggregated stats across ${federationFleets.length} control node${federationFleets.length !== 1 ? 's' : ''}`
              : 'Real-time status of your Magnus fleet'
          }
          status={<Badge variant={posture.tone === 'muted' ? 'default' : posture.tone === 'danger' ? 'danger' : posture.tone === 'warning' ? 'warning' : 'success'} dot pulse={posture.tone !== 'success'}>{posture.label}</Badge>}
          actions={
            <>
              {nodes.length > 1 && (
                <Button
                  variant={federationMode ? 'primary' : 'secondary'}
                  size="sm"
                  icon={<Globe className="h-3.5 w-3.5" />}
                  onClick={() => setFederationMode((v) => !v)}
                >
                  {federationMode ? 'All Fleets' : 'Single Fleet'}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                onClick={() => federationMode ? void fetchFederationStats() : void fetchStats()}
              >
                Refresh
              </Button>
            </>
          }
        />
      </PageItem>

      {!federationMode && tailscaleSummary && (
        <PageItem>
          <TailscaleExpiryAlert summary={tailscaleSummary} />
        </PageItem>
      )}

      {/* Hero: fleet gauges, radar and session trend */}
      <PageItem>
        <GlowPanel hero padding="lg" tone={posture.tone === 'danger' ? 'danger' : posture.tone === 'warning' ? 'warning' : 'primary'} testId="overview-hero">
          {!stats && loading ? (
            <div className="flex flex-wrap items-center justify-around gap-6" aria-busy="true">
              {[0, 1, 2].map((i) => <div key={i} className="skeleton h-36 w-36 rounded-full opacity-60" />)}
              <div className="skeleton h-44 w-44 rounded-full opacity-60" />
            </div>
          ) : (
            <div className="grid gap-6 xl:grid-cols-[auto_1fr]">
              <div className="flex flex-wrap items-center justify-center gap-6 sm:justify-start">
                <FleetRadar
                  counts={{
                    online: stats?.nodes.online ?? 0,
                    degraded: stats?.nodes.degraded ?? 0,
                    offline: stats?.nodes.offline ?? 0,
                    provisioning: stats?.nodes.provisioning ?? 0,
                  }}
                />
                <div className="flex flex-wrap justify-center gap-4">
                  <Gauge
                    value={onlinePct}
                    label="Nodes online"
                    tone={!stats ? 'muted' : stats.nodes.offline > 0 ? 'danger' : stats.nodes.online < stats.nodes.total ? 'warning' : 'success'}
                    display={stats ? `${stats.nodes.online}/${stats.nodes.total}` : undefined}
                    size={150}
                    testId="overview-gauge-online"
                  />
                  <Gauge value={cpu} label="Avg CPU" size={150} sublabel={stats ? `${stats.health.reportingNodes} reporting` : undefined} testId="overview-gauge-cpu" />
                  <Gauge value={mem} label="Avg memory" size={150} testId="overview-gauge-mem" />
                </div>
              </div>
              <div className="flex min-w-0 flex-col">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">CPU / memory · this session</span>
                  <div className="flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-wider text-text-muted">
                    <span className="flex items-center gap-1.5"><StatusDot status="ONLINE" size="xs" pulse={false} />{stats?.nodes.online ?? 0} up</span>
                    <span className="flex items-center gap-1.5"><StatusDot status="DEGRADED" size="xs" />{stats?.nodes.degraded ?? 0} degraded</span>
                    <span className="flex items-center gap-1.5"><StatusDot status="OFFLINE" size="xs" pulse={(stats?.nodes.offline ?? 0) > 0} />{stats?.nodes.offline ?? 0} down</span>
                    <span className="flex items-center gap-1.5"><StatusDot status="PROVISIONING" size="xs" pulse={false} />{stats?.nodes.provisioning ?? 0} provisioning</span>
                  </div>
                </div>
                {chartData.length > 1 ? (
                  <LazyAreaChart
                    data={chartData}
                    xKey="t"
                    percent
                    height={170}
                    formatX={(v) => new Date(Number(v)).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}
                    series={[
                      { key: 'cpu', label: 'CPU', tone: 'primary' },
                      { key: 'mem', label: 'Memory', tone: 'accent' },
                    ]}
                    testId="overview-session-chart"
                  />
                ) : (
                  <div className="flex h-[170px] items-center justify-center rounded-panel border border-dashed border-primary/20 text-[11px] uppercase tracking-wider text-text-muted">
                    <span className="mr-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                    Collecting samples — trend appears after the next poll
                  </div>
                )}
              </div>
            </div>
          )}
        </GlowPanel>
      </PageItem>

      {/* Stats Grid */}
      <PageItem>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Total Nodes"
            value={stats ? <AnimatedNumber value={stats.nodes.total} /> : '—'}
            icon={<Server className="h-4 w-4" />}
            trend={stats ? { value: `${stats.nodes.online} online`, positive: stats.nodes.online > 0 } : { value: 'Loading…', positive: true }}
            spark={series(samples, 'online')}
            delta={(() => { const d = deltaOf('online', stats?.nodes.online); return d !== undefined ? { value: d, unit: ' up' } : undefined; })()}
          />
          <StatCard
            label="Active Commands"
            value={stats ? <AnimatedNumber value={stats.commands.running + stats.commands.pending} /> : '—'}
            icon={<Terminal className="h-4 w-4" />}
            trend={stats ? { value: `${stats.commands.total} total`, positive: true } : undefined}
            spark={series(samples, 'active')}
            tone="accent"
          />
          <StatCard
            label="Cron Jobs"
            value={stats ? <AnimatedNumber value={stats.cron.total} /> : '—'}
            icon={<Clock className="h-4 w-4" />}
            trend={stats ? { value: `${stats.cron.active} active`, positive: stats.cron.active > 0 } : undefined}
            spark={series(samples, 'cron')}
          />
          <StatCard
            label="System Health"
            value={loading || cpu === null ? '—' : <AnimatedNumber value={cpu} decimals={Number.isInteger(cpu) ? 0 : 1} suffix="% CPU" />}
            icon={<Activity className="h-4 w-4" />}
            trend={healthTrend}
            meter={loading ? undefined : cpu}
            delta={(() => { const d = deltaOf('cpu', cpu); return d !== undefined ? { value: d, unit: '%', positiveIsGood: false } : undefined; })()}
            tone={cpu !== null && cpu >= 90 ? 'danger' : cpu !== null && cpu >= 70 ? 'warning' : 'primary'}
          />
        </div>
      </PageItem>

      {/* Federation Fleet Breakdown */}
      {federationMode && federationFleets.length > 0 && (
        <PageItem>
          <GlowPanel title="Fleet Breakdown">
            <div className="space-y-2">
              {federationFleets.map((fleet) => (
                <div key={fleet.nodeId} className="grid grid-cols-1 items-center gap-3 rounded-chip border border-border/50 bg-surface-raised px-4 py-2.5 text-xs sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]">
                  <div className="flex items-center gap-2">
                    <StatusDot status={fleet.stats ? 'ONLINE' : 'OFFLINE'} />
                    <span className="font-medium">{fleet.nodeName}</span>
                  </div>
                  {fleet.stats ? (
                    <>
                      <MeterBar
                        value={fleet.stats.nodes.total > 0 ? (fleet.stats.nodes.online / fleet.stats.nodes.total) * 100 : null}
                        tone={fleet.stats.nodes.offline > 0 ? 'warning' : 'success'}
                        label={`${fleet.nodeName} nodes online`}
                        valueLabel={`${fleet.stats.nodes.online}/${fleet.stats.nodes.total}`}
                        showValue
                      />
                      <div className="flex items-center gap-4 text-text-muted">
                        <span className="num">{fleet.stats.nodes.total} nodes</span>
                        <span className="num">{fleet.stats.commands.running} running</span>
                      </div>
                    </>
                  ) : (
                    <Badge variant={statusVariant('OFFLINE')} className="justify-self-start">Unreachable</Badge>
                  )}
                </div>
              ))}
            </div>
          </GlowPanel>
        </PageItem>
      )}

      {/* Recent Activity */}
      <PageItem>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <GlowPanel title="Recent Commands" icon={<Terminal className="h-3.5 w-3.5" />}>
            {!stats ? (
              loading ? <SkeletonText lines={4} /> : <EmptyState compact title="Stats unavailable" description="The Control API did not answer; retrying every 15 seconds." tone="warning" />
            ) : stats.recentCommands.length === 0 ? (
              <EmptyState compact icon={<Terminal className="h-4 w-4" />} title="No commands dispatched yet" action={<Link href="/commands" className="text-[11px] uppercase tracking-wider text-primary hover:underline">Run a command →</Link>} />
            ) : (
              <div className="space-y-1.5">
                {stats.recentCommands.map((cmd) => (
                  <div key={`${cmd.id}-${cmd.status}`} className="scan-sweep flex items-center justify-between gap-2 rounded-chip border border-border/50 bg-surface-raised/60 px-3 py-2 text-[11px] transition-colors hover:border-primary/30">
                    <div className="flex min-w-0 items-center gap-2">
                      <StatusDot status={cmd.status} size="xs" />
                      <code className="truncate text-primary">{cmd.command}</code>
                      {cmd.node && <span className="shrink-0 text-text-muted">on {cmd.node.name}</span>}
                    </div>
                    <div className="ml-2 flex shrink-0 items-center gap-2">
                      <Badge variant={statusVariant(cmd.status)}>{cmd.status}</Badge>
                      <span className="num hidden text-text-muted sm:inline">{formatDate(cmd.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </GlowPanel>

          <GlowPanel title="Recent Activity" tone="accent" icon={<Shield className="h-3.5 w-3.5" />}>
            {!stats ? (
              loading ? <SkeletonText lines={4} /> : <EmptyState compact title="Audit feed unavailable" tone="warning" />
            ) : stats.recentAudit.length === 0 ? (
              <EmptyState compact icon={<Shield className="h-4 w-4" />} title="No audit events yet" />
            ) : (
              <ol className="relative space-y-1.5 border-l border-accent/20 pl-3">
                {stats.recentAudit.map((evt) => (
                  <li key={evt.id} className="relative flex items-center justify-between gap-2 rounded-chip px-2 py-1.5 text-[11px] transition-colors hover:bg-accent/5">
                    <span aria-hidden="true" className="absolute -left-[15.5px] top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_6px_var(--color-accent)]" />
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium text-text">{evt.action}</span>
                      {evt.targetType && (
                        <span className="truncate text-text-muted">{evt.targetType}{evt.targetId ? ` ${evt.targetId.slice(0, 8)}…` : ''}</span>
                      )}
                    </div>
                    <span className="num shrink-0 text-text-muted">{formatDate(evt.timestamp)}</span>
                  </li>
                ))}
              </ol>
            )}
          </GlowPanel>

          <GlowPanel title="Live Event Stream" icon={<Radio className="h-3.5 w-3.5" />} tone="success">
            <LiveEventList limit={7} />
          </GlowPanel>
        </div>
      </PageItem>

      {/* Quick Actions */}
      <PageItem>
        <GlowPanel title="Quick Actions" interactive={false}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <QuickAction href="/nodes" label="Manage Nodes" icon={<Server className="h-5 w-5" />} />
            <QuickAction href="/commands" label="Run Command" icon={<Terminal className="h-5 w-5" />} />
            <QuickAction href="/cron" label="Cron Jobs" icon={<Clock className="h-5 w-5" />} />
            <QuickAction href="/files" label="Edit Files" icon={<Activity className="h-5 w-5" />} />
          </div>
        </GlowPanel>
      </PageItem>

      {/* AI Insights */}
      {(pinnedInsights.length > 0 || insights.length > 0) && (
        <PageItem>
          <GlowPanel
            title="AI Insights"
            icon={<Sparkles className="h-4 w-4" />}
            action={insightsGeneratedAt ? <span className="num text-[10px] text-text-muted">Updated {formatDate(insightsGeneratedAt)}</span> : undefined}
          >
            {pinnedInsights.length > 0 && (
              <div className="mb-4">
                <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-text-muted">Pinned</p>
                <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {pinnedInsights.map((insight) => (
                    <div key={insight.id} className="rounded-chip border border-primary/25 bg-primary/5 px-3 py-2 shadow-[inset_2px_0_0_var(--color-primary)]">
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-bold text-text">{insight.title}</p>
                          <p className="text-[10px] text-text-muted">Pinned {formatDate(insight.pinnedAt)}</p>
                        </div>
                        <button
                          onClick={() => void api.assistant.unpinInsight(insight.id).then(loadInsights)}
                          className="rounded p-1 text-text-muted transition-colors hover:text-warning"
                          title="Unpin insight"
                        >
                          <PinOff className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <p className="text-[11px] text-text-muted">{insight.body}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {insights.slice(0, 6).map((insight, i) => {
                const Icon = insight.severity === 'critical' ? AlertCircle
                  : insight.severity === 'warning' ? AlertTriangle
                  : Info;
                const colorClass = insight.severity === 'critical' ? 'text-danger border-danger/30 bg-danger/5 shadow-[inset_2px_0_0_var(--color-danger),0_0_12px_var(--color-glow-danger)]'
                  : insight.severity === 'warning' ? 'text-warning border-warning/30 bg-warning/5 shadow-[inset_2px_0_0_var(--color-warning)]'
                  : 'text-info border-info/30 bg-info/5 shadow-[inset_2px_0_0_var(--color-info)]';
                const pinned = pinnedInsights.some((item) => item.title === insight.title && item.body === insight.body);
                return (
                  <div key={i} className={`rounded-chip border px-3 py-2 ${colorClass}`}>
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                        <span className="truncate text-xs font-bold">{insight.title}</span>
                      </div>
                      <button
                        onClick={() => void togglePin(insight)}
                        className="rounded p-1 transition-colors hover:bg-white/5"
                        title={pinned ? 'Unpin insight' : 'Pin insight'}
                      >
                        {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                      </button>
                    </div>
                    <p className="line-clamp-2 text-[10px] opacity-80">{insight.body}</p>
                  </div>
                );
              })}
            </div>
          </GlowPanel>
        </PageItem>
      )}
    </PageTransition>
  );
}

function QuickAction({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
}): React.ReactElement {
  return (
    <Link
      href={href}
      className="glow-hover group flex flex-col items-center gap-2 rounded-panel border border-border bg-surface-raised/60 p-4 text-center transition-colors duration-300 hover:border-primary/50 hover:bg-primary/5"
    >
      <span className="text-primary transition-all group-hover:drop-shadow-[0_0_8px_var(--color-primary)]">{icon}</span>
      <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted group-hover:text-primary transition-colors">{label}</span>
    </Link>
  );
}
