/**
 * Mission Control — unified multi-tier status home page.
 *
 * Aggregates live health/stats across the four pillars of the Magnus platform:
 *   • Fleet (Control API)
 *   • Hermes Agent installation survey
 *   • AI Memory (HiveMem — indirect via Hermes profiles)
 *
 */

import Link from 'next/link';
import { fleetFetch, fleetSystemFetch } from '@/lib/fleet-fetch';
import { orchestraFetch } from '@/lib/orchestra-fetch';
import {
  Server, Bot, DollarSign, Brain, Activity, Shield, Compass,
  AlertTriangle, CheckCircle2, Siren,
  Router,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { GlowPanel } from '@/components/ui/glow-panel';
import { PageHeader } from '@/components/ui/page-header';
import { Gauge } from '@/components/ui/gauge';
import { MeterBar } from '@/components/ui/meter-bar';
import { StatusDot } from '@/components/ui/status-dot';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { TONE_BORDER, TONE_GLOW_TEXT, TONE_TEXT, latencyTone, type Tone } from '@/lib/theme-colors';
import type { HermesInstallation, HermesProfile } from '@/types/orchestra';

export const dynamic = 'force-dynamic';

interface FleetOverview {
  nodes: { total: number; online: number; offline: number; degraded: number; provisioning: number };
  commands: { total: number; running: number; pending: number };
  health: { avgCpuPercent: number | null; avgMemoryPercent: number | null; reportingNodes: number };
  cron: { total: number; active: number };
}

interface OrchestraStats {
  installations: number;
  healthyInstallations: number;
  profiles: number;
  runningGateways: number;
}

interface HeartbeatStreamStats {
  enabled: boolean;
  streamKey: string;
  length: number;
  consumerGroup: string;
  pending: number;
  lastDeliveredId: string | null;
  consumers: Array<{ name: string; pending: number; idleMs: number }>;
}

interface DependencyHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail' | 'skip'; message: string; latencyMs?: number }>;
}

async function loadFleet(): Promise<FleetOverview | null> {
  try {
    const res = await fleetFetch<{ success: boolean; data: FleetOverview }>('stats/overview');
    return res.success ? res.data : null;
  } catch (err) {
    console.error('[mission-control] fleet fetch failed:', (err as Error).message);
    return null;
  }
}

async function loadOrchestra(): Promise<OrchestraStats | null> {
  try {
    const [installations, profiles] = await Promise.all([
      orchestraFetch<{ data?: HermesInstallation[] }>('installations').catch(() => ({ data: [] as HermesInstallation[] })),
      orchestraFetch<{ data?: HermesProfile[] }>('profiles').catch(() => ({ data: [] as HermesProfile[] })),
    ]);

    const installationList = installations.data ?? [];
    const profileList = profiles.data ?? [];

    return {
      installations: installationList.length,
      healthyInstallations: installationList.filter((item) => item.status === 'running' || item.status === 'detected').length,
      profiles: profileList.length,
      runningGateways: profileList.filter((item) => item.gatewayStatus === 'running').length,
    };
  } catch {
    return null;
  }
}

function Tier({
  title, description, icon: Icon, tone, testId, children,
}: {
  title: string;
  description: string;
  icon: React.ElementType;
  tone: 'primary' | 'accent';
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <GlowPanel as="section" tone={tone} testId={testId}>
      <div className="mb-4 flex items-center gap-3">
        <div
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-panel border bg-bg',
            tone === 'accent'
              ? 'border-accent/40 text-accent shadow-[0_0_12px_var(--color-glow-accent)]'
              : 'border-primary/40 text-primary shadow-[0_0_12px_var(--color-glow)]',
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-text">{title}</h2>
          <p className="text-[11px] text-text-muted">{description}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>
    </GlowPanel>
  );
}

type StatTone = 'default' | 'success' | 'warn' | 'danger' | 'muted';

const STAT_TONE: Record<StatTone, string> = {
  default: 'text-primary',
  success: 'text-success glow-text-success',
  warn: 'text-warning glow-text-warning',
  danger: 'text-danger glow-text-danger',
  muted: 'text-text-muted',
};

function Stat({
  label, value, sublabel, tone, meter, gauge,
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  tone?: StatTone;
  /** 0–100 utilisation bar under the value. */
  meter?: { value: number | null; max?: number; thresholds?: { warn: number; crit: number }; tone?: Tone };
  /** Small arc gauge beside the value (label hidden; aria-label names it). */
  gauge?: { value: number | null; max?: number; higherIsBetter?: boolean };
}) {
  return (
    <div
      className="panel-corners glow-hover relative rounded-panel border border-border/60 bg-bg/40 p-3 transition-colors hover:border-accent/40 [--glow-hover-color:var(--color-glow-accent)]"
      data-testid="mission-stat"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.15em] text-text-muted">{label}</div>
          <div className={cn('num mt-1 truncate text-xl font-bold', STAT_TONE[tone ?? 'default'])}>{value}</div>
          {sublabel && <div className="mt-0.5 truncate text-[10px] text-text-muted">{sublabel}</div>}
        </div>
        {gauge && (
          <Gauge
            value={gauge.value}
            max={gauge.max}
            label={label}
            higherIsBetter={gauge.higherIsBetter}
            thresholds={gauge.higherIsBetter ? { warn: 10, crit: 34 } : undefined}
            size={56}
            ticks={false}
            display=""
            hideLabel
            className="-my-1 shrink-0"
          />
        )}
      </div>
      {meter && <MeterBar value={meter.value} max={meter.max} thresholds={meter.thresholds} tone={meter.tone} label={label} className="mt-2" />}
    </div>
  );
}

function OfflineBanner({ pillar }: { pillar: string }) {
  return (
    <EmptyState
      compact
      tone="warning"
      icon={<AlertTriangle className="h-4 w-4" />}
      title={`${pillar} data unavailable`}
      description="The service may be unreachable or not configured."
      className="col-span-full"
    />
  );
}

const CHECK_TONE: Record<DependencyHealth['checks'][number]['status'], { dot: string; text: string }> = {
  pass: { dot: 'bg-success shadow-[0_0_8px_var(--color-success)]', text: 'text-success' },
  warn: { dot: 'bg-warning shadow-[0_0_8px_var(--color-warning)]', text: 'text-warning' },
  fail: { dot: 'bg-danger shadow-[0_0_10px_var(--color-danger)]', text: 'text-danger' },
  skip: { dot: 'bg-text-muted', text: 'text-text-muted' },
};

/** Dependency checks drawn as stations on a glowing bus line. */
function SystemBus({ checks }: { checks: DependencyHealth['checks'] }) {
  const shown = checks.slice(0, 7);
  return (
    <div className="relative">
      <div aria-hidden="true" className="absolute left-4 right-4 top-[7px] hidden h-px bg-gradient-to-r from-primary/10 via-primary/50 to-primary/10 shadow-[0_0_6px_var(--color-primary)] lg:block" />
      <ol className="relative grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {shown.map((check) => {
          const tone = CHECK_TONE[check.status];
          return (
            <li key={check.name} className="flex flex-col items-start gap-2 lg:items-center" title={check.message}>
              <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border bg-bg">
                {check.status === 'fail' && <span className={cn('absolute inset-0 rounded-full animate-halo', tone.dot)} />}
                <span className={cn('relative h-2 w-2 rounded-full', tone.dot)} />
              </span>
              <div className="w-full rounded-chip border border-border/60 bg-bg/40 p-2 lg:text-center">
                <div className="truncate text-[10px] uppercase tracking-[0.15em] text-text-muted">{check.name}</div>
                <div className="mt-1 flex items-baseline gap-2 lg:justify-center">
                  <span className={cn('text-xs font-semibold uppercase', tone.text)}>{check.status}</span>
                  {typeof check.latencyMs === 'number' && (
                    <span className={cn('num text-[10px]', TONE_TEXT[latencyTone(check.latencyMs)])}>{Math.round(check.latencyMs)}ms</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

async function loadDependencyHealth(): Promise<DependencyHealth | null> {
  try {
    const res = await fleetSystemFetch<{ success: boolean; data: DependencyHealth }>('ops/dependency-health');
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

export default async function MissionControlPage(): Promise<React.ReactElement> {
  const [fleet, orchestra, dependencyHealth, heartbeatStream] = await Promise.all([
    loadFleet(),
    loadOrchestra(),
    loadDependencyHealth(),
    fleetFetch<{ success: boolean; data: HeartbeatStreamStats }>('heartbeat/stream/stats')
      .then((r) => (r.success ? r.data : null))
      .catch(() => null),
  ]);

  // Overall posture
  const onlineNodes = fleet?.nodes.online ?? 0;
  const offlineNodes = (fleet?.nodes.offline ?? 0) + (fleet?.nodes.degraded ?? 0);
  const posture =
    fleet === null ? 'unknown' :
    offlineNodes === 0 ? 'green' :
    offlineNodes > 0 ? 'amber' : 'amber';
  const postureLabel =
    posture === 'green' ? 'All Systems Nominal' :
    posture === 'amber' ? 'Attention Required' : 'Status Unknown';
  const PostureIcon = posture === 'green' ? CheckCircle2 : posture === 'amber' ? Siren : Activity;
  const postureTone: Tone = posture === 'green' ? 'success' : posture === 'amber' ? 'warning' : 'muted';
  const cpu = fleet?.health.avgCpuPercent ?? null;

  return (
    <div data-testid="mission-control-page">
      <PageHeader
        title="Mission Control"
        eyebrow="Command deck"
        tone="accent"
        icon={<Compass className="h-5 w-5" />}
        description="Unified posture across Fleet operations, Hermes Agent inventory, and AI Memory."
        className="mb-6"
      />

      <div className="space-y-5">
        {/* Posture banner */}
        <div
          className={cn(
            'grid-bg relative flex flex-wrap items-center gap-4 overflow-hidden rounded-panel border px-5 py-4',
            postureTone === 'success' && 'border-success/40 bg-success/5 shadow-[0_0_24px_var(--color-glow-success)]',
            postureTone === 'warning' && 'border-warning/50 bg-warning/5 shadow-[0_0_28px_var(--color-glow-warning)]',
            postureTone === 'muted' && 'border-border bg-surface',
          )}
          data-testid="mission-posture"
          data-posture={posture}
        >
          <span className={cn('relative flex h-11 w-11 items-center justify-center rounded-full border bg-bg', TONE_BORDER[postureTone], TONE_TEXT[postureTone])}>
            {posture === 'amber' && <span className="absolute inset-0 rounded-full bg-warning/30 animate-halo" />}
            <PostureIcon className="relative h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-[0.3em] text-text-muted">Fleet posture</div>
            <div className={cn('text-lg font-bold uppercase tracking-[0.15em]', TONE_TEXT[postureTone], TONE_GLOW_TEXT[postureTone])}>{postureLabel}</div>
          </div>
          {fleet && (
            <div className="flex flex-wrap gap-4 text-[10px] uppercase tracking-wider text-text-muted">
              <span className="flex items-center gap-1.5"><StatusDot status="ONLINE" size="xs" />{fleet.nodes.online} up</span>
              <span className="flex items-center gap-1.5"><StatusDot status="DEGRADED" size="xs" />{fleet.nodes.degraded} degraded</span>
              <span className="flex items-center gap-1.5"><StatusDot status="OFFLINE" size="xs" pulse={fleet.nodes.offline > 0} />{fleet.nodes.offline} down</span>
            </div>
          )}
        </div>

        <GlowPanel as="section" tone="accent" testId="dependency-health-strip">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Router className="h-4 w-4 text-accent" />
              <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-text">Dependency Health</h2>
              {dependencyHealth && (
                <Badge variant={dependencyHealth.status === 'healthy' ? 'success' : dependencyHealth.status === 'degraded' ? 'warning' : 'danger'} dot>
                  {dependencyHealth.status}
                </Badge>
              )}
            </div>
            <Link href="/fleet-readiness" className="text-[10px] uppercase tracking-wider text-primary hover:text-accent">
              Readiness
            </Link>
          </div>
          {dependencyHealth ? (
            <SystemBus checks={dependencyHealth.checks} />
          ) : (
            <EmptyState compact tone="warning" icon={<Router className="h-4 w-4" />} title="Dependency health unavailable" />
          )}
        </GlowPanel>

        {/* Fleet tier */}
        <Tier title="Fleet" description="Nodes, commands, and reporting health" icon={Server} tone="primary" testId="mission-tier-fleet">
          {!fleet && <OfflineBanner pillar="Fleet" />}
          {fleet && (
            <>
              <Stat
                label="Nodes online"
                value={onlineNodes}
                sublabel={`${fleet.nodes.total} total`}
                tone={offlineNodes === 0 ? 'success' : 'default'}
                gauge={{ value: onlineNodes, max: fleet.nodes.total || 1, higherIsBetter: true }}
              />
              <Stat
                label="Offline / degraded"
                value={offlineNodes}
                tone={offlineNodes > 0 ? 'warn' : 'muted'}
                meter={{ value: offlineNodes, max: fleet.nodes.total || 1, thresholds: { warn: 1, crit: 34 } }}
              />
              <Stat
                label="Avg CPU"
                value={cpu === null ? '—' : `${Math.round(cpu)}%`}
                sublabel={`${fleet.health.reportingNodes} reporting`}
                meter={{ value: cpu }}
              />
              <Stat
                label="Commands"
                value={fleet.commands.running + fleet.commands.pending}
                sublabel={`${fleet.commands.running} running · ${fleet.commands.pending} pending`}
              />
            </>
          )}
        </Tier>

        {/* Hermes Agent tier */}
        <Tier title="Hermes Agent" description="Hermes Agent installations and profiles" icon={Bot} tone="accent" testId="mission-tier-orchestra">
          {!orchestra && <OfflineBanner pillar="Hermes Agent" />}
          {orchestra && (
            <>
              <Stat label="Installations" value={orchestra.installations} />
              <Stat
                label="Healthy"
                value={orchestra.healthyInstallations}
                sublabel={`${orchestra.installations} total`}
                tone={orchestra.installations > 0 && orchestra.healthyInstallations === orchestra.installations ? 'success' : 'default'}
                meter={{ value: orchestra.healthyInstallations, max: orchestra.installations || 1, tone: orchestra.healthyInstallations === orchestra.installations ? 'success' : 'warning' }}
              />
              <Stat
                label="Profiles"
                value={orchestra.profiles}
              />
              <Stat
                label="Gateways"
                value={orchestra.runningGateways}
                sublabel="running"
                meter={orchestra.profiles > 0 ? { value: orchestra.runningGateways, max: orchestra.profiles, tone: 'accent' } : undefined}
              />
            </>
          )}
        </Tier>

        {/* Heartbeat stream stats */}
        <GlowPanel as="section" tone="accent" testId="heartbeat-stream-stats">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-accent" />
              <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-text">
                Heartbeat Stream
              </h2>
              {heartbeatStream?.enabled && <StatusDot status="RUNNING" size="xs" label="Stream active" />}
            </div>
            <span className="text-[10px] uppercase tracking-wider text-text-muted">
              Redis Streams
            </span>
          </div>
          {heartbeatStream ? (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" data-testid="heartbeat-stream-grid">
                <Stat label="Stream length" value={heartbeatStream.length.toLocaleString()} sublabel={heartbeatStream.streamKey} />
                <Stat
                  label="Pending"
                  value={heartbeatStream.pending.toLocaleString()}
                  tone={heartbeatStream.pending > 100 ? 'warn' : 'muted'}
                  meter={{ value: heartbeatStream.pending, max: 200, thresholds: { warn: 50, crit: 90 } }}
                />
                <Stat label="Consumers" value={heartbeatStream.consumers.length} sublabel={heartbeatStream.consumerGroup} />
                <Stat
                  label="Last delivered"
                  value={heartbeatStream.lastDeliveredId ?? '—'}
                  sublabel={heartbeatStream.enabled ? 'active' : 'idle'}
                />
              </div>
              {heartbeatStream.consumers.length > 0 && (
                <ul className="mt-4 grid gap-2 sm:grid-cols-2" aria-label="Consumer idle time">
                  {heartbeatStream.consumers.slice(0, 6).map((consumer) => (
                    <li key={consumer.name} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3 text-[10px]">
                      <span className="truncate uppercase tracking-wider text-text-muted">{consumer.name}</span>
                      <MeterBar
                        value={Math.min(consumer.idleMs, 60_000)}
                        max={60_000}
                        thresholds={{ warn: 25, crit: 75 }}
                        valueLabel={consumer.idleMs < 1000 ? `${consumer.idleMs}ms` : `${Math.round(consumer.idleMs / 1000)}s idle`}
                        label={`${consumer.name} idle time`}
                        showValue
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <EmptyState compact icon={<Activity className="h-4 w-4" />} title="Heartbeat stream metrics unavailable" />
          )}
        </GlowPanel>

        {/* Quick actions */}
        <GlowPanel as="section" interactive={false}>
          <div className="mb-4 flex items-center gap-2">
            <Activity className="h-4 w-4 text-accent" />
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-text">Quick actions</h2>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <QuickLink href="/" label="Fleet Overview" icon={Server} />
            <QuickLink href="/orchestra/installations" label="Hermes Installations" icon={DollarSign} />
            <QuickLink href="/orchestra/profiles" label="Hermes Profiles" icon={Brain} />
            <QuickLink href="/orchestra/web-gateway" label="Web Gateway" icon={Compass} />
            <QuickLink href="/governor/operations" label="Operations" icon={Activity} />
            <QuickLink href="/audit" label="Audit trail" icon={Shield} />
          </div>
        </GlowPanel>
      </div>
    </div>
  );
}

function QuickLink({ href, label, icon: Icon }: { href: string; label: string; icon: React.ElementType }) {
  return (
    <Link
      href={href}
      className="glow-hover group flex flex-col items-center gap-2 rounded-panel border border-border/60 bg-bg/40 px-3 py-4 text-center text-xs transition-colors hover:border-accent/60 hover:bg-accent/5 [--glow-hover-color:var(--color-glow-accent)]"
      data-testid="mission-quick-link"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-accent/30 bg-bg transition-shadow group-hover:shadow-[0_0_14px_var(--color-glow-accent)]">
        <Icon className="h-4 w-4 text-accent/70 group-hover:text-accent" />
      </span>
      <span className="text-[10px] uppercase tracking-wider text-text-muted group-hover:text-text">{label}</span>
    </Link>
  );
}
