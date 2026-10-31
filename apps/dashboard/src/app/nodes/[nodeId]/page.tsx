'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { GlowPanel } from '@/components/ui/glow-panel';
import { Gauge } from '@/components/ui/gauge';
import { MeterBar } from '@/components/ui/meter-bar';
import { StatusDot } from '@/components/ui/status-dot';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonStatGrid } from '@/components/ui/skeleton';
import { NodeMetricsChart } from '@/components/nodes/node-metrics-chart';
import { Badge, statusVariant } from '@/components/ui/badge';
import { HiveMemTokenStatus } from '@/components/orchestra/hivemem-token-status';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api-client';
import { formatDate, formatBytes } from '@/lib/utils';
import {
  Pencil,
  Trash2,
  ArrowLeft,
  RotateCw,
  AlertCircle,
  Loader2,
  ExternalLink,
  ShieldCheck,
  Bot,
  Rocket,
  Puzzle,
  Search,
  MousePointerClick,
  RefreshCcwDot,
  Power,
  Server,
} from 'lucide-react';
import { EditNodeModal, AssignRoleModal } from '@/components/nodes/node-modals';
import { QuickCommandBar } from '@/components/nodes/quick-commands';
import { NodePersonalityCard } from './personality-card';
import { GpuTelemetryCard } from '@/components/nodes/gpu-telemetry-card';
import type { HermesDetectedPlugin, HermesDetectedSkill, HermesInstallation } from '@/types/orchestra';
import type { DiskForecast, GpuTelemetryResponse, SystemUpdateInfo } from '@/types/contracts';

interface NodeDetail {
  id: string;
  name: string;
  hostname: string;
  ipAddress: string;
  port: number;
  status: string;
  os: string;
  arch: string;
  tags: string;
  metadata: string;
  lastHeartbeatAt: string | null;
  agent?: { version: string; status: string } | null;
  role?: { id: string; name: string } | null;
  roleId?: string | null;
}

interface RoleApplicationStep {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

interface RoleApplicationRecord {
  id: string;
  action: string;
  status: string;
  steps: RoleApplicationStep[];
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  role?: { name: string };
}

interface HealthData {
  cpuUsagePercent: number;
  cpuCores: number;
  cpuLoadAverage?: string;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryPercent: number;
  swapTotalBytes?: number;
  swapUsedBytes?: number;
  disks:
    | string
    | Array<{ mountPoint: string; usagePercent: number; totalBytes: number; usedBytes: number }>;
  network?: string | Array<{ interface: string; ipAddress: string }>;
  services?: string | Array<{ name: string; status: string }>;
  wazuh?: WazuhAgentInfo | string;
  systemUpdates?: SystemUpdateInfo | string;
  cockpitAvailable: boolean;
  source: string;
  timestamp: string;
}

interface WazuhAgentInfo {
  installed: boolean;
  serviceStatus: 'active' | 'inactive' | 'failed' | 'not_installed' | 'unknown';
  enabled: 'enabled' | 'disabled' | 'static' | 'unknown';
  version: string | null;
  managerAddresses: string[];
}

function parseDisks(
  disks: HealthData['disks'],
): Array<{ mountPoint: string; usagePercent: number; totalBytes: number; usedBytes: number }> {
  if (typeof disks === 'string') {
    try {
      return JSON.parse(disks) as Array<{
        mountPoint: string;
        usagePercent: number;
        totalBytes: number;
        usedBytes: number;
      }>;
    } catch {
      return [];
    }
  }
  return disks ?? [];
}

function parseServices(services: HealthData['services']): Array<{ name: string; status: string }> {
  if (!services) return [];
  if (typeof services === 'string') {
    try {
      return JSON.parse(services) as Array<{ name: string; status: string }>;
    } catch {
      return [];
    }
  }
  return services;
}

function parseWazuh(wazuh: HealthData['wazuh']): WazuhAgentInfo | null {
  if (!wazuh) return null;
  try {
    const parsed = typeof wazuh === 'string' ? JSON.parse(wazuh) : wazuh;
    if (
      typeof parsed.installed !== 'boolean' ||
      !['active', 'inactive', 'failed', 'not_installed', 'unknown'].includes(parsed.serviceStatus) ||
      !['enabled', 'disabled', 'static', 'unknown'].includes(parsed.enabled) ||
      !(parsed.version === null || typeof parsed.version === 'string') ||
      !Array.isArray(parsed.managerAddresses)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function wazuhBadgeVariant(status: WazuhAgentInfo['serviceStatus']): 'success' | 'danger' | 'warning' | 'default' {
  if (status === 'active') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'inactive') return 'warning';
  return 'default';
}

function parseSystemUpdates(value: HealthData['systemUpdates']): SystemUpdateInfo | null {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as Partial<SystemUpdateInfo> : value;
    if (
      typeof parsed.supported !== 'boolean' ||
      typeof parsed.platform !== 'string' ||
      !['enabled', 'disabled', 'partial', 'unsupported', 'unknown'].includes(parsed.automaticUpdates ?? '') ||
      typeof parsed.rebootRequired !== 'boolean' ||
      !Array.isArray(parsed.timers) ||
      !Array.isArray(parsed.rebootRequiredPackages)
    ) return null;
    return {
      ...parsed,
      fullUpgradePolicyEnabled: parsed.fullUpgradePolicyEnabled === true,
    } as SystemUpdateInfo;
  } catch {
    return null;
  }
}

function usesLoopbackDashboardHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === '' ||
    normalized === '0.0.0.0' ||
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::' ||
    normalized === '::1'
  );
}

function hermesDashboardAddress(installation: HermesInstallation): string {
  const host = usesLoopbackDashboardHost(installation.dashboardHost)
    ? installation.hostname
    : installation.dashboardHost;
  return `${host}:${installation.dashboardPort}`;
}

function idempotencyKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now()}-${random}`;
}

function isHermesInstallationPresent(installation: HermesInstallation | null): installation is HermesInstallation {
  return Boolean(installation && installation.status !== 'not_installed');
}

function detectedSkills(installation: HermesInstallation): HermesDetectedSkill[] {
  return Array.isArray(installation.rawStatus?.skills) ? installation.rawStatus.skills : [];
}

function detectedPlugins(installation: HermesInstallation): HermesDetectedPlugin[] {
  return Array.isArray(installation.rawStatus?.plugins) ? installation.rawStatus.plugins : [];
}

function pluginEnabled(plugin: HermesDetectedPlugin): boolean {
  const status = plugin.status.toLowerCase();
  return status.includes('enabled') && !status.includes('not enabled') && !status.includes('disabled');
}

function findPluginLabel(plugins: HermesDetectedPlugin[], purpose: 'search' | 'crawl'): string {
  const candidates = plugins.filter(pluginEnabled);
  const match = candidates.find((plugin) => {
    const haystack = `${plugin.slug} ${plugin.pluginType} ${plugin.metadata?.description ?? ''}`.toLowerCase();
    return purpose === 'search'
      ? /\b(search|web)\b/.test(haystack)
      : /\b(crawl|browser|firecrawl|browserbase|browser-use)\b/.test(haystack);
  });
  return match ? `${match.slug}${match.version ? ` ${match.version}` : ''}` : 'none enabled';
}

function skillSummary(skills: HermesDetectedSkill[]): string {
  if (skills.length === 0) return '0 synced';
  const enabled = skills.filter((skill) => skill.enabled).length;
  return `${enabled} enabled / ${skills.length} total`;
}

export default function NodeDetailPage(): React.ReactElement {
  const params = useParams<{ nodeId: string }>();
  const router = useRouter();
  const [node, setNode] = useState<NodeDetail | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [diskForecasts, setDiskForecasts] = useState<DiskForecast[]>([]);
  const [gpuTelemetry, setGpuTelemetry] = useState<GpuTelemetryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [assignRoleOpen, setAssignRoleOpen] = useState(false);
  const [roleApps, setRoleApps] = useState<RoleApplicationRecord[]>([]);
  const [softwareVersions, setSoftwareVersions] = useState<Record<string, string>>({});
  const [hermesInstallation, setHermesInstallation] = useState<HermesInstallation | null>(null);
  const [softwareLoading, setSoftwareLoading] = useState(false);
  const [softwareError, setSoftwareError] = useState<string | null>(null);
  const [aptUpdateCount, setAptUpdateCount] = useState<number | null>(null);
  const [aptLastChecked, setAptLastChecked] = useState<string | null>(null);
  const [aptChecking, setAptChecking] = useState(false);
  const [aptCheckError, setAptCheckError] = useState<string | null>(null);
  const [aptUpgrading, setAptUpgrading] = useState(false);
  const [enablingSystemUpdates, setEnablingSystemUpdates] = useState(false);
  const [systemUpdateError, setSystemUpdateError] = useState<string | null>(null);
  const [hermesDeploying, setHermesDeploying] = useState(false);
  const [hermesDeployMessage, setHermesDeployMessage] = useState<string | null>(null);
  const [hermesDeployError, setHermesDeployError] = useState<string | null>(null);
  const [skillsModalOpen, setSkillsModalOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Persist role override across refetches for remote nodes that lack role includes
  const roleOverrideRef = useRef<{ id: string; name: string } | null | undefined>(undefined);

  const loadNode = useCallback(
    async (silent = false): Promise<void> => {
      try {
        if (!silent) setLoading(true);
        const [nodeRes, healthRes, forecastRes, hermesRes, gpuRes] = await Promise.all([
          api.nodes.get(params.nodeId),
          api.nodes.health(params.nodeId).catch(() => null),
          api.nodes.forecast(params.nodeId).catch(() => null),
          api.hermes.installations().catch(() => null),
          api.nodes.gpu(params.nodeId).catch(() => null),
        ]);
        const nodeData = nodeRes.data as unknown as NodeDetail;
        // Apply role override if server doesn't return role data
        if (!nodeData.role && roleOverrideRef.current !== undefined) {
          nodeData.role = roleOverrideRef.current;
        } else if (nodeData.role) {
          roleOverrideRef.current = nodeData.role;
        }
        setNode(nodeData);
        if (healthRes) setHealth(healthRes.data as unknown as HealthData);
        setDiskForecasts(forecastRes?.data?.forecasts ?? []);
        setGpuTelemetry(gpuRes?.data ?? null);

        const installations = (hermesRes?.data ?? []) as HermesInstallation[];
        setHermesInstallation(
          installations.find((installation) => installation.nodeId === nodeData.id) ??
            installations.find(
              (installation) =>
                installation.hostname === nodeData.hostname ||
                installation.hostname === nodeData.ipAddress,
            ) ??
            null,
        );

        // Fetch role applications for this node
        try {
          const appsRes = await api.roles.applications.list({ nodeId: params.nodeId });
          setRoleApps((appsRes.data ?? []) as RoleApplicationRecord[]);
        } catch {
          // applications endpoint may not exist on older control nodes
        }
      } catch {
        // API error
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [params.nodeId],
  );

  useEffect(() => {
    void loadNode();
  }, [loadNode]);


  const handleHermesDeploy = async (): Promise<void> => {
    if (!node) return;
    if (!confirm(`Deploy Hermes Agent to "${node.name}"?`)) return;

    setHermesDeploying(true);
    setHermesDeployMessage(null);
    setHermesDeployError(null);
    try {
      const res = await api.hermes.deploy({
        nodeId: node.id,
        hermesHome: '~/.hermes',
        hermesBin: 'hermes',
        installMethod: 'official-script',
        dashboardPort: 9119,
        enableDashboard: true,
        enableDashboardTui: true,
        startGateway: true,
      }, idempotencyKey('hermes-node-deploy'));
      setHermesDeployMessage(`Hermes Agent deployment started. Job ${res.data?.id.slice(0, 10)}...`);
      void loadNode(true);
    } catch (err: unknown) {
      setHermesDeployError(err instanceof Error ? err.message : 'Hermes Agent deployment failed');
    } finally {
      setHermesDeploying(false);
    }
  };

  // Auto-refresh while node is provisioning, agent is updating, or local upgrade in progress
  useEffect(() => {
    const isTransient =
      node?.status === 'PROVISIONING' ||
      node?.agent?.status === 'UPDATING' ||
      Boolean(hermesDeployMessage && !isHermesInstallationPresent(hermesInstallation));
    if (isTransient && !pollRef.current) {
      pollRef.current = setInterval(() => {
        void loadNode(true);
      }, 4000);
    } else if (!isTransient && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [
    node?.status,
    node?.agent?.status,
    node?.agent?.version,
    loadNode,
    hermesDeployMessage,
    hermesInstallation,
  ]);

  const handleDelete = async (): Promise<void> => {
    if (!node) return;
    if (
      !confirm(
        `Delete node "${node.name}"? This will permanently remove it and all associated data.`,
      )
    )
      return;
    try {
      await api.nodes.delete(node.id);
      router.push('/nodes');
    } catch {
      // handle error
    }
  };

  const loadSoftwareRevisions = useCallback(async (): Promise<void> => {
    if (node?.status !== 'ONLINE') return;
    setSoftwareLoading(true);
    setSoftwareError(null);
    try {
      const script = [
            'version_or_na() { local cmd="$1"; shift; if command -v "$cmd" >/dev/null 2>&1; then ("$@" 2>/dev/null || "$cmd" --version 2>/dev/null || "$cmd" -v 2>/dev/null || echo "unknown") | head -n 1; else echo "not installed"; fi; }',
            'echo "node=$(version_or_na node node --version)"',
            'echo "npm=$(version_or_na npm npm --version)"',
            'echo "python3=$(version_or_na python3 python3 --version)"',
            'echo "redis=$(version_or_na redis-cli redis-cli --version)"',
            'echo "docker=$(version_or_na docker docker --version)"',
            'echo "tailscale=$(version_or_na tailscale tailscale version)"',
            'agent_manifest=/opt/magnus-agent/node_modules/@hivemagnus/magnus-agent/package.json; [ -f "$agent_manifest" ] || agent_manifest=/opt/magnus-agent/package.json; if [ -f "$agent_manifest" ]; then echo "magnus-agent=$(node -e \'process.stdout.write(require(process.argv[1]).version)\' "$agent_manifest" 2>/dev/null || echo unknown)"; else echo "magnus-agent=not installed"; fi',
          ].join('; ');
      const escaped = script.replace(/'/g, "'\\''" );
      const res = await api.quickCommand.exec(node.id, {
        command: `bash -lc '${escaped}'`,
        args: [],
        timeoutSeconds: 60,
      });

      const output = ((res.data as { stdout?: string }).stdout ?? '').trim();
      const parsed = Object.fromEntries(
        output
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.includes('='))
          .map((line) => {
            const [name, ...rest] = line.split('=');
            return [name, rest.join('=').trim() || 'unknown'];
          }),
      );
      setSoftwareVersions(parsed);
    } catch (err: unknown) {
      setSoftwareError(err instanceof Error ? err.message : 'Failed to load software revisions');
    } finally {
      setSoftwareLoading(false);
    }
  }, [node?.id, node?.status]);

  const refreshAptUpdates = useCallback(async (): Promise<void> => {
    if (node?.status !== 'ONLINE') return;
    setAptChecking(true);
    setAptCheckError(null);
    try {
      const aptScript = [
            'set -euo pipefail',
            '(sudo apt-get update -qq || apt-get update -qq) >/dev/null 2>&1',
            "apt list --upgradable 2>/dev/null | sed '1d' | sed '/^Listing/d' | wc -l",
          ].join('; ');
      const aptEscaped = aptScript.replace(/'/g, "'\\''" );
      const res = await api.quickCommand.exec(node.id, {
        command: `bash -lc '${aptEscaped}'`,
        args: [],
        timeoutSeconds: 180,
      });

      const output = ((res.data as { stdout?: string }).stdout ?? '').trim();
      const count = Number.parseInt(output.split('\n').at(-1) ?? '', 10);
      setAptUpdateCount(Number.isFinite(count) ? count : null);
      setAptLastChecked(new Date().toISOString());
    } catch (err: unknown) {
      setAptCheckError(err instanceof Error ? err.message : 'Failed to refresh apt updates');
    } finally {
      setAptChecking(false);
    }
  }, [node?.id, node?.status]);

  const runAptUpgrade = async (): Promise<void> => {
    if (!node) return;
    if (!confirm(`Run apt upgrade on "${node.name}"?`)) return;
    setAptUpgrading(true);
    try {
      const idempotencyKey = `apt-upgrade-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await api.commands.dispatch(
        {
          nodeIds: [node.id],
          command: 'sudo',
          args: ['apt', 'upgrade', '-y'],
          timeoutSeconds: 1800,
          idempotencyKey,
        },
        idempotencyKey,
      );
      const data = res.data as { commands?: Array<{ id: string }> };
      const commandId = data.commands?.[0]?.id;
      alert(
        commandId
          ? `APT Upgrade dispatched (command ${commandId.slice(0, 12)}…). Check Commands for progress.`
          : 'APT Upgrade dispatched. Check Commands for progress.',
      );
      await refreshAptUpdates();
    } catch (err: unknown) {
      alert(`APT Upgrade failed to dispatch: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAptUpgrading(false);
    }
  };

  const enableAutomaticUpdates = async (): Promise<void> => {
    if (!node) return;
    if (!confirm(`Enable unattended apt update and apt upgrade on "${node.name}"? Magnus will install unattended-upgrades and enable the apt timers.`)) return;
    setEnablingSystemUpdates(true);
    setSystemUpdateError(null);
    try {
      await api.nodes.enableSystemUpdates(node.id);
      await loadNode(true);
    } catch (err) {
      setSystemUpdateError(err instanceof Error ? err.message : 'Failed to enable automatic updates');
    } finally {
      setEnablingSystemUpdates(false);
    }
  };

  useEffect(() => {
    void loadSoftwareRevisions();
    void refreshAptUpdates();
  }, [loadSoftwareRevisions, refreshAptUpdates]);

  useEffect(() => {
    if (!node || node.status !== 'ONLINE') return;
    const timer = setInterval(() => {
      void refreshAptUpdates();
    }, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [node, refreshAptUpdates]);

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="skeleton h-56 w-full rounded-panel opacity-70" />
        <SkeletonStatGrid />
        <span className="sr-only">Loading node details…</span>
      </div>
    );
  }

  if (!node) {
    return (
      <EmptyState
        tone="accent"
        icon={<Server className="h-5 w-5" />}
        title="Node not found"
        description="It may have been decommissioned or belong to another control node."
        action={<Button variant="secondary" size="sm" onClick={() => router.push('/nodes')}>Back to nodes</Button>}
        className="mt-12"
      />
    );
  }

  const hermesSkills = isHermesInstallationPresent(hermesInstallation)
    ? detectedSkills(hermesInstallation)
    : [];
  const hermesPlugins = isHermesInstallationPresent(hermesInstallation)
    ? detectedPlugins(hermesInstallation)
    : [];
  const enabledHermesSkills = hermesSkills.filter((skill) => skill.enabled);
  const primaryProvider = hermesInstallation?.configuration?.modelProvider ?? 'unknown';
  const defaultModel = hermesInstallation?.configuration?.modelName ?? 'unknown';
  const webSearchPlugin = findPluginLabel(hermesPlugins, 'search');
  const crawlingPlugin = findPluginLabel(hermesPlugins, 'crawl');
  const wazuh = parseWazuh(health?.wazuh);
  const systemUpdates = parseSystemUpdates(health?.systemUpdates);

  return (
    <div className="space-y-6">
      {/* Cockpit hero: identity, gauges, history */}
      <GlowPanel hero padding="lg" tone={node.status === 'ONLINE' ? 'primary' : node.status === 'OFFLINE' ? 'danger' : 'warning'} testId="node-cockpit">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => router.push('/nodes')} aria-label="Back to nodes">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <StatusDot status={node.status} />
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold text-primary glow-text-primary">{node.name}</h1>
              <p className="num mt-1 truncate text-xs text-text-muted">
                {node.hostname}:{node.port}
                {node.agent && <span className="ml-3 text-primary/70">agent v{node.agent.version}</span>}
                {health?.source && <span className="ml-3 uppercase tracking-wider">source: {health.source}</span>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant(node.status)}>{node.status}</Badge>
          {node.agent?.status === 'UPDATING' && (
            <Badge variant="info">
              <Loader2 className="h-3 w-3 animate-spin mr-1 inline" />
              Upgrading…
            </Badge>
          )}
          <Button
            variant="secondary"
            size="sm"
            icon={<Pencil className="h-3.5 w-3.5" />}
            onClick={() => setEditOpen(true)}
          >
            Edit
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={() => void handleDelete()}
          >
            Delete
          </Button>
        </div>
        </div>
        <div className="mt-6 grid gap-6 xl:grid-cols-[auto_minmax(0,1fr)]">
          <div className="flex flex-wrap justify-center gap-4 sm:justify-start">
            <Gauge value={health?.cpuUsagePercent ?? null} label="CPU Usage" size={128} testId="node-gauge-cpu" />
            <Gauge
              value={health?.memoryPercent ?? null}
              label="Memory"
              size={128}
              sublabel={health ? `${formatBytes(health.memoryUsedBytes)}` : undefined}
              testId="node-gauge-memory"
            />
            {(() => {
              const disks = health ? parseDisks(health.disks) : [];
              const worst = disks.reduce<(typeof disks)[number] | null>((w, d) => (!w || d.usagePercent > w.usagePercent ? d : w), null);
              return (
                <Gauge
                  value={worst?.usagePercent ?? null}
                  label="Disk"
                  size={128}
                  thresholds={{ warn: 80, crit: 90 }}
                  sublabel={worst?.mountPoint}
                  testId="node-gauge-disk"
                />
              );
            })()}
          </div>
          <NodeMetricsChart nodeId={node.id} height={170} />
        </div>
      </GlowPanel>

      {/* Deploy / Upgrade Error Banner */}
      {(node.status === 'DEGRADED' || node.agent?.status === 'ERROR') &&
        (() => {
          try {
            const meta = JSON.parse(node.metadata) as Record<string, unknown>;
            const deployErr = typeof meta['deployError'] === 'string' ? meta['deployError'] : null;
            const upgradeErr =
              typeof meta['upgradeError'] === 'string' ? meta['upgradeError'] : null;
            const errMsg = deployErr ?? upgradeErr;
            const errLabel = deployErr ? 'Deploy Failed' : 'Agent Upgrade Failed';
            if (errMsg) {
              return (
                <div className="rounded-panel border border-danger/40 bg-danger/5 p-4 shadow-[inset_3px_0_0_var(--color-danger),0_0_20px_var(--color-glow-danger)]">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-danger shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-danger">{errLabel}</p>
                      <pre className="mt-1 text-xs text-text-muted whitespace-pre-wrap font-mono">
                        {errMsg}
                      </pre>
                    </div>
                  </div>
                </div>
              );
            }
          } catch {
            /* no metadata */
          }
          return null;
        })()}

      {/* Provisioning Spinner */}
      {node.status === 'PROVISIONING' && (
        <div className="rounded-panel border border-info/40 bg-info/5 p-4 shadow-[inset_3px_0_0_var(--color-info)]">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 text-info animate-spin" />
            <p className="text-xs uppercase tracking-wider text-info">
              Deploying agent… Status will update automatically.
            </p>
          </div>
        </div>
      )}

      {/* Upgrade In Progress */}
      {node.agent?.status === 'UPDATING' && (
        <div className="rounded-panel border border-info/40 bg-info/5 p-4 shadow-[inset_3px_0_0_var(--color-info)]">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 text-info animate-spin" />
            <p className="text-xs uppercase tracking-wider text-info">
              Agent upgrade in progress… Status will update automatically.
            </p>
          </div>
        </div>
      )}

      {/* Quick Commands */}
      <QuickCommandBar nodeId={node.id} nodeStatus={node.status} />

      <GpuTelemetryCard telemetry={gpuTelemetry} />

      {/* Personality Profile */}
      <NodePersonalityCard
        node={{
          id: node.id,
          name: node.name,
          hostname: node.hostname,
          status: node.status,
          lastHeartbeatAt: node.lastHeartbeatAt,
        }}
      />

      {/* Details Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card title="Node Information">
          <dl className="space-y-2 text-sm">
            {[
              ['OS', node.os],
              ['Architecture', node.arch],
              ['Address', `${node.ipAddress}:${node.port}`],
              [
                'Tags',
                (() => {
                  try {
                    const tags = JSON.parse(node.tags) as string[];
                    return tags.length ? tags.join(', ') : '—';
                  } catch {
                    return '—';
                  }
                })(),
              ],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between">
                <dt className="text-text-muted">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
            <div className="flex justify-between">
              <dt className="text-text-muted">Agent Version</dt>
              <dd className="font-medium flex items-center gap-1.5">
                {node.agent?.version ?? '—'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Role</dt>
              <dd className="font-medium">
                {node.role ? (
                  <button
                    className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors cursor-pointer"
                    onClick={() => setAssignRoleOpen(true)}
                    title="Change role"
                  >
                    <ShieldCheck className="h-3 w-3" />
                    {node.role.name}
                  </button>
                ) : (
                  <button
                    className="text-xs text-text-muted hover:text-primary transition-colors cursor-pointer"
                    onClick={() => setAssignRoleOpen(true)}
                  >
                    + Assign Role
                  </button>
                )}
              </dd>
            </div>
            {[
              ['Agent Status', node.agent?.status ?? '—'],
              ['Last Heartbeat', formatDate(node.lastHeartbeatAt)],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between">
                <dt className="text-text-muted">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
            <div className="flex justify-between">
              <dt className="text-text-muted">Cockpit</dt>
              <dd className="font-medium">
                {health?.cockpitAvailable ? (
                  <a
                    href={`https://${node.ipAddress}:9090`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline flex items-center gap-1"
                  >
                    Available
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="text-text-muted">Not Available</span>
                )}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">CPU Cores</dt>
              <dd className="font-medium">{health?.cpuCores ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Memory Used</dt>
              <dd className="font-medium">
                {health
                  ? `${formatBytes(health.memoryUsedBytes)} / ${formatBytes(health.memoryTotalBytes)}`
                  : '—'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Swap Used</dt>
              <dd className="font-medium">
                {health && health.swapTotalBytes
                  ? `${formatBytes(health.swapUsedBytes ?? 0)} / ${formatBytes(health.swapTotalBytes)}`
                  : '—'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Last Health Sample</dt>
              <dd className="font-medium">{health ? formatDate(health.timestamp) : '—'}</dd>
            </div>
          </dl>
          </Card>

          <Card
            title="Hermes Agent"
            description={
              isHermesInstallationPresent(hermesInstallation)
                ? hermesInstallation.displayName ?? hermesInstallation.hostname
                : 'No Hermes Agent installed or found'
            }
            action={
              isHermesInstallationPresent(hermesInstallation) ? (
                <Badge variant={statusVariant(hermesInstallation.status)}>
                  {hermesInstallation.status}
                </Badge>
              ) : undefined
            }
          >
            {isHermesInstallationPresent(hermesInstallation) ? (
              <div className="space-y-4">
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">Version</dt>
                    <dd className="font-mono text-xs">{hermesInstallation.version ?? 'unknown'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">Home</dt>
                    <dd className="font-mono text-xs break-all">{hermesInstallation.hermesHome}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">Dashboard</dt>
                    <dd className="mt-1 flex items-center gap-2">
                      <Badge variant={statusVariant(hermesInstallation.dashboardStatus)}>
                        {hermesInstallation.dashboardStatus}
                      </Badge>
                      <span className="font-mono text-xs">
                        {hermesDashboardAddress(hermesInstallation)}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">Gateway</dt>
                    <dd className="mt-1">
                      <Badge variant={statusVariant(hermesInstallation.gatewayStatus)}>
                        {hermesInstallation.gatewayStatus}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">API Server</dt>
                    <dd className="font-mono text-xs">
                      {hermesInstallation.apiServerEnabled
                        ? `${hermesInstallation.apiServerHost}:${hermesInstallation.apiServerPort ?? '—'}`
                        : 'disabled'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">Primary Provider</dt>
                    <dd className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge variant={primaryProvider === 'unknown' ? 'warning' : 'success'}>
                        {primaryProvider}
                      </Badge>
                      {hermesInstallation.configuration?.magnusRouterConfigured && (
                        <Badge variant="success">Magnus routed</Badge>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">Default Model</dt>
                    <dd className="font-mono text-xs break-all">{defaultModel}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">OpenAI Runtime</dt>
                    <dd className="mt-1"><Badge variant={hermesInstallation.configuration?.openaiRuntime === 'codex_app_server' ? 'success' : 'warning'}>
                      {hermesInstallation.configuration?.openaiRuntime === 'codex_app_server' ? 'Codex app-server' : 'Hermes default'}
                    </Badge></dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">Web Search</dt>
                    <dd className="mt-1 flex items-center gap-2 text-xs">
                      <Search className="h-3.5 w-3.5 text-text-muted" />
                      <span className="font-mono break-all">{webSearchPlugin}</span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">Crawling</dt>
                    <dd className="mt-1 flex items-center gap-2 text-xs">
                      <MousePointerClick className="h-3.5 w-3.5 text-text-muted" />
                      <span className="font-mono break-all">{crawlingPlugin}</span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">Memory</dt>
                    <dd className="mt-1"><Badge variant={hermesInstallation.configuration?.hiveMemConfigured ? 'success' : 'warning'}>
                      {hermesInstallation.configuration?.memoryProvider ?? 'not configured'}
                    </Badge><HiveMemTokenStatus configuration={hermesInstallation.configuration} /></dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">Skills</dt>
                    <dd className="mt-1">
                      <button
                        type="button"
                        onClick={() => setSkillsModalOpen(true)}
                        className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-text hover:border-primary/60 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={hermesSkills.length === 0}
                      >
                        <Puzzle className="h-3.5 w-3.5" />
                        {skillSummary(hermesSkills)}
                      </button>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-text-muted">Last Sync</dt>
                    <dd className="text-xs">{formatDate(hermesInstallation.lastSyncedAt)}</dd>
                  </div>
                </dl>

                <div className="space-y-2">
                  {hermesInstallation.configuration?.modelBaseUrl && (
                    <p className="text-xs text-text-muted">
                      Base URL: <span className="font-mono">{hermesInstallation.configuration.modelBaseUrl}</span>
                    </p>
                  )}
                  {hermesInstallation.configuration?.configPath && (
                    <p className="text-xs text-text-muted">
                      Config: <span className="font-mono">{hermesInstallation.configuration.configPath}</span>
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {(hermesInstallation.profiles ?? []).slice(0, 6).map((profile) => (
                    <span
                      key={profile.id}
                      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-text-muted"
                    >
                      <Bot className="h-3 w-3" />
                      {profile.name}
                    </span>
                  ))}
                  {(hermesInstallation.profiles?.length ?? 0) === 0 && (
                    <span className="text-xs text-text-muted">No profiles synced</span>
                  )}
                </div>

                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ExternalLink className="h-3.5 w-3.5" />}
                  onClick={() =>
                    router.push(
                      `/orchestra/web-gateway?installationId=${encodeURIComponent(hermesInstallation.id)}`,
                    )
                  }
                >
                  Open Dashboard
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-text-muted">
                  No Hermes Agent is installed or currently detected on this node.
                </p>
                {hermesDeployMessage && <p className="text-xs text-success">{hermesDeployMessage}</p>}
                {hermesDeployError && <p className="text-xs text-danger">{hermesDeployError}</p>}
                <Button
                  size="sm"
                  variant="secondary"
                  icon={
                    hermesDeploying ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Rocket className="h-3.5 w-3.5" />
                    )
                  }
                  disabled={!node || node.status !== 'ONLINE' || hermesDeploying}
                  onClick={() => void handleHermesDeploy()}
                >
                  {hermesDeploying ? 'Starting Deployment...' : 'Deploy Hermes Agent'}
                </Button>
                {node?.status !== 'ONLINE' && (
                  <p className="text-xs text-text-muted">
                    Bring the Magnus agent online before starting automated Hermes deployment.
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card title="Service Checks">
            {health && parseServices(health.services).length > 0 ? (
              <div className="space-y-2 text-sm">
                {parseServices(health.services)
                  .slice(0, 8)
                  .map((svc) => (
                    <div
                      key={svc.name}
                      className="flex items-center justify-between rounded border border-border px-2 py-1.5"
                    >
                      <span className="font-medium">{svc.name}</span>
                      <Badge
                        variant={
                          svc.status === 'active'
                            ? 'success'
                            : svc.status === 'failed'
                              ? 'danger'
                              : 'default'
                        }
                      >
                        {svc.status}
                      </Badge>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                No service checks available from this node yet.
              </p>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card
            title="System Update Readiness"
            description="Automatic apt policy and reboot state from the latest heartbeat"
            action={
              systemUpdates ? (
                <Badge variant={systemUpdates.rebootRequired ? 'danger' : systemUpdates.automaticUpdates === 'enabled' ? 'success' : 'warning'}>
                  {systemUpdates.rebootRequired ? 'reboot required' : systemUpdates.automaticUpdates.replace('_', ' ')}
                </Badge>
              ) : undefined
            }
          >
            {systemUpdates ? (
              <div className="space-y-4">
                {systemUpdates.rebootRequired && (
                  <div className="flex gap-3 rounded border border-danger/30 bg-danger/10 p-3">
                    <Power className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                    <div>
                      <p className="text-sm font-medium text-danger">Restart needed to finish installed updates</p>
                      <p className="mt-1 text-xs text-text-muted">
                        {systemUpdates.rebootRequiredPackages.length
                          ? systemUpdates.rebootRequiredPackages.slice(0, 5).join(', ')
                          : 'The operating system has set the reboot-required marker.'}
                      </p>
                    </div>
                  </div>
                )}
                <dl className="space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-text-muted">Platform</dt>
                    <dd className="font-mono text-xs">{systemUpdates.platform}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-text-muted">Automatic updates</dt>
                    <dd><Badge variant={systemUpdates.automaticUpdates === 'enabled' ? 'success' : 'warning'}>{systemUpdates.automaticUpdates}</Badge></dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-text-muted">unattended-upgrades</dt>
                    <dd>{systemUpdates.unattendedUpgradesInstalled ? 'installed' : 'not installed'}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-text-muted">full apt upgrade policy</dt>
                    <dd>{systemUpdates.fullUpgradePolicyEnabled ? 'enabled' : 'not enabled'}</dd>
                  </div>
                  {systemUpdates.timers.map((timer) => (
                    <div key={timer.name} className="flex items-center justify-between gap-3">
                      <dt className="font-mono text-[11px] text-text-muted">{timer.name}</dt>
                      <dd className="font-mono text-[11px]">{timer.state}</dd>
                    </div>
                  ))}
                </dl>
                {systemUpdates.supported && systemUpdates.automaticUpdates !== 'enabled' && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={node.status !== 'ONLINE' || enablingSystemUpdates}
                    onClick={() => void enableAutomaticUpdates()}
                  >
                    {enablingSystemUpdates ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcwDot className="h-3.5 w-3.5" />}
                    {enablingSystemUpdates ? 'Enabling…' : 'Enable automatic updates'}
                  </Button>
                )}
                {systemUpdateError && <p className="text-xs text-danger">{systemUpdateError}</p>}
              </div>
            ) : (
              <p className="text-sm text-text-muted">Update posture will appear after agent v1.6.0 reports its first heartbeat.</p>
            )}
          </Card>

          <Card
            title="Wazuh Agent"
            description="Endpoint-security posture from the latest node heartbeat"
            action={
              wazuh ? (
                <Badge variant={wazuhBadgeVariant(wazuh.serviceStatus)}>
                  {wazuh.serviceStatus.replace('_', ' ')}
                </Badge>
              ) : undefined
            }
          >
            {wazuh ? (
              <dl className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-text-muted">Installation</dt>
                  <dd>
                    <Badge variant={wazuh.installed ? 'success' : 'default'}>
                      {wazuh.installed ? 'installed' : 'not installed'}
                    </Badge>
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-text-muted">Startup</dt>
                  <dd className="font-medium">{wazuh.enabled}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-text-muted">Version</dt>
                  <dd className="font-mono text-xs">{wazuh.version ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Managers</dt>
                  <dd className="mt-1 font-mono text-xs break-all">
                    {wazuh.managerAddresses.length ? wazuh.managerAddresses.join(', ') : '—'}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-text-muted">
                Wazuh posture will appear after this host reports a current Magnus agent heartbeat.
              </p>
            )}
          </Card>

          <Card title="Disk Usage">
            {health && parseDisks(health.disks).length ? (
              <div className="space-y-3">
                {parseDisks(health.disks).map((disk) => (
                  <div key={disk.mountPoint} className="text-sm">
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">{disk.mountPoint}</span>
                      <span className="num">
                        {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
                      </span>
                    </div>
                    <MeterBar
                      value={disk.usagePercent}
                      thresholds={{ warn: 80, crit: 90 }}
                      size="sm"
                      label={`${disk.mountPoint} disk usage`}
                      showValue
                      className="mt-1"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">No disk data available</p>
            )}
          </Card>

          <Card
            title="Capacity Forecast"
            description="Per-volume 30-day growth trend and estimated time to full"
          >
            {diskForecasts.length ? (
              <div className="space-y-3">
                {diskForecasts.map((forecast) => (
                  <div key={forecast.mountPoint} className="rounded border border-border/50 p-3 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-text">{forecast.mountPoint}</span>
                      <Badge variant={forecast.daysUntilFull !== null && forecast.daysUntilFull <= 14 ? 'danger' : forecast.daysUntilFull !== null && forecast.daysUntilFull <= 30 ? 'warning' : 'default'}>
                        {forecast.daysUntilFull === null
                          ? forecast.growthRatePerDay > 0 ? 'trend uncertain' : 'stable/shrinking'
                          : `${forecast.daysUntilFull}d to full`}
                      </Badge>
                    </div>
                    <div className="mt-2 text-text-muted">
                      {forecast.currentUsagePercent.toFixed(1)}% used · {formatBytes(Math.abs(forecast.growthRatePerDay))}/day {forecast.growthRatePerDay >= 0 ? 'growth' : 'reclaimed'} · confidence {(forecast.confidence * 100).toFixed(0)}%
                    </div>
                    <p className="mt-2 text-text-muted">{forecast.recommendation}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">At least three retained samples are needed for a capacity forecast.</p>
            )}
          </Card>

          <Card
            title="Software Revisions"
            description="Major runtime versions and package update status"
            action={
              <Button variant="ghost" size="sm" onClick={() => void loadSoftwareRevisions()}>
                <RotateCw className={`h-3.5 w-3.5 ${softwareLoading ? 'animate-spin' : ''}`} />
              </Button>
            }
          >
            <div className="space-y-2 text-sm">
              {['node', 'npm', 'python3', 'redis', 'docker', 'tailscale', 'magnus-agent'].map((pkg) => (
                <div key={pkg} className="flex items-start justify-between gap-2">
                  <dt className="text-text-muted uppercase text-xs tracking-wide">{pkg}</dt>
                  <dd className="font-mono text-right text-xs break-all">
                    {softwareVersions[pkg] ?? (softwareLoading ? 'Loading…' : '—')}
                  </dd>
                </div>
              ))}
              {softwareError && <p className="text-xs text-danger">{softwareError}</p>}
            </div>

            <div className="mt-4 border-t border-border pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wide text-text-muted">APT Updates</span>
                <Badge variant={aptUpdateCount && aptUpdateCount > 0 ? 'warning' : 'success'}>
                  {aptChecking ? 'Checking…' : `${aptUpdateCount ?? '—'} pending`}
                </Badge>
              </div>
              <p className="text-xs text-text-muted">
                Refreshed hourly via apt update
                {aptLastChecked ? ` • Last check: ${formatDate(aptLastChecked)}` : ''}
              </p>
              {aptCheckError && <p className="text-xs text-danger">{aptCheckError}</p>}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={node.status !== 'ONLINE' || aptChecking}
                  onClick={() => void refreshAptUpdates()}
                >
                  <RotateCw className={`h-3.5 w-3.5 ${aptChecking ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={node.status !== 'ONLINE' || aptUpgrading}
                  onClick={() => void runAptUpgrade()}
                >
                  {aptUpgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {aptUpgrading ? 'Dispatching…' : 'APT Upgrade'}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Role Applications */}
      {roleApps.length > 0 && (
        <Card title="Role Applications">
          <div className="space-y-4">
            {roleApps.map((app) => (
              <div key={app.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">
                      {app.action === 'apply' ? 'Apply' : 'Remove'}: {app.role?.name ?? 'Unknown'}
                    </span>
                  </div>
                  <Badge
                    variant={
                      app.status === 'completed'
                        ? 'success'
                        : app.status === 'failed'
                          ? 'danger'
                          : app.status === 'running'
                            ? 'info'
                            : 'default'
                    }
                  >
                    {app.status}
                  </Badge>
                </div>
                {app.error && (
                  <div className="mb-2 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-xs text-danger font-mono">
                    {app.error}
                  </div>
                )}
                <div className="space-y-1">
                  {app.steps.map((step) => (
                    <div key={step.name} className="flex items-center gap-2 text-xs">
                      <span
                        className={
                          step.status === 'completed'
                            ? 'text-success'
                            : step.status === 'failed'
                              ? 'text-danger'
                              : step.status === 'running'
                                ? 'text-info'
                                : step.status === 'skipped'
                                  ? 'text-text-muted/50'
                                  : 'text-text-muted'
                        }
                      >
                        {step.status === 'completed' && '✓'}
                        {step.status === 'failed' && '✗'}
                        {step.status === 'running' && '⟳'}
                        {step.status === 'skipped' && '—'}
                        {step.status === 'pending' && '○'}
                      </span>
                      <span
                        className={
                          step.status === 'skipped' ? 'text-text-muted/50 line-through' : ''
                        }
                      >
                        {step.name}
                      </span>
                      {step.error && (
                        <span className="text-danger ml-2 truncate max-w-xs" title={step.error}>
                          {step.error}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[10px] text-text-muted">
                  {app.startedAt ? `Started: ${formatDate(app.startedAt)}` : ''}
                  {app.completedAt ? ` — Completed: ${formatDate(app.completedAt)}` : ''}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal
        open={skillsModalOpen}
        onClose={() => setSkillsModalOpen(false)}
        title="Hermes Skills"
        description={`${enabledHermesSkills.length} enabled on ${node.name}`}
        icon={<Puzzle className="h-5 w-5 text-primary" />}
        className="max-w-3xl"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded border border-border bg-bg/50 p-3">
              <p className="text-[10px] uppercase tracking-wide text-text-muted">Enabled</p>
              <p className="mt-1 text-lg font-semibold">{enabledHermesSkills.length}</p>
            </div>
            <div className="rounded border border-border bg-bg/50 p-3">
              <p className="text-[10px] uppercase tracking-wide text-text-muted">Total</p>
              <p className="mt-1 text-lg font-semibold">{hermesSkills.length}</p>
            </div>
            <div className="rounded border border-border bg-bg/50 p-3">
              <p className="text-[10px] uppercase tracking-wide text-text-muted">Sources</p>
              <p className="mt-1 text-sm font-mono">
                {Array.from(new Set(hermesSkills.map((skill) => skill.source))).filter(Boolean).join(', ') || 'unknown'}
              </p>
            </div>
          </div>

          <div className="max-h-[55vh] overflow-auto rounded border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface text-[10px] uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Skill</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {hermesSkills
                  .slice()
                  .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.slug.localeCompare(b.slug))
                  .map((skill) => (
                    <tr key={`${skill.slug}-${skill.source}`} className="bg-bg/20">
                      <td className="px-3 py-2 font-mono">{skill.slug}</td>
                      <td className="px-3 py-2 text-text-muted">{skill.category ?? 'uncategorized'}</td>
                      <td className="px-3 py-2 text-text-muted">{skill.source}</td>
                      <td className="px-3 py-2">
                        <Badge variant={skill.enabled ? 'success' : 'default'}>
                          {skill.enabled ? 'enabled' : 'disabled'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {hermesSkills.length === 0 && (
              <div className="p-6 text-sm text-text-muted">No synced Hermes skills were reported for this node.</div>
            )}
          </div>
        </div>
      </Modal>

      <EditNodeModal
        open={editOpen}
        node={node}
        onClose={() => setEditOpen(false)}
        onSaved={() => void loadNode()}
      />

      <AssignRoleModal
        open={assignRoleOpen}
        node={node ? { id: node.id, name: node.name, role: node.role } : null}
        onClose={() => setAssignRoleOpen(false)}
        onSaved={(assignedRole) => {
          roleOverrideRef.current = assignedRole;
          if (node) {
            setNode({ ...node, role: assignedRole });
          }
          void loadNode();
        }}
      />
    </div>
  );
}
