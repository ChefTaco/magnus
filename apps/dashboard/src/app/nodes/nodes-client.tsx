'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Badge, statusVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/utils';
import { api } from '@/lib/api-client';
import { useControlNode } from '@/lib/control-node-context';
import {
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  Wifi,
  Loader2,
  AlertCircle,
  AlertTriangle,
  ShieldCheck,
  Terminal,
  RefreshCcwDot,
  Power,
  Server,
} from 'lucide-react';
import type { DiskInfo, SystemUpdateInfo, TailscaleExpirySummary } from '@/types/contracts';
import { getUserDiskSeverity, getWorstPersistentDisk } from '@/lib/user-disk';
import Link from 'next/link';
import { EditNodeModal, RegisterNodeModal, AssignRoleModal } from '@/components/nodes/node-modals';
import { ControlNodeBar } from '@/components/nodes/control-node-bar';
import { TerminalModal } from '@/components/nodes/terminal-modal';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import { TailscaleExpiryAlert } from '@/components/nodes/tailscale-expiry-alert';
import { PageHeader } from '@/components/ui/page-header';
import { MeterBar } from '@/components/ui/meter-bar';
import { StatusDot } from '@/components/ui/status-dot';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonTable } from '@/components/ui/skeleton';

export interface NodeRow {
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
}

interface NodeHealth {
  cpuUsagePercent: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryPercent: number;
  disks: string | DiskInfo[];
}

interface SystemUpdateSummary {
  total: number;
  reporting: number;
  enabled: number;
  actionNeeded: number;
  rebootRequired: number;
  nodes: Array<{ id: string; systemUpdates: SystemUpdateInfo | null }>;
}

interface DiscoveredAgent {
  hostname: string;
  fqdn: string;
  ip: string;
  port: number;
  version: string;
  registered: boolean;
}

function getNodeError(metadata: string): { label: string; message: string } | null {
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    if (typeof parsed['deployError'] === 'string')
      return { label: 'Deploy failed', message: parsed['deployError'] };
    if (typeof parsed['upgradeError'] === 'string')
      return { label: 'Upgrade failed', message: parsed['upgradeError'] };
    return null;
  } catch {
    return null;
  }
}

interface NodesPageClientProps {
  initialNodes: NodeRow[];
  initialTailscaleSummary: TailscaleExpirySummary | null;
}

export default function NodesPageClient({
  initialNodes,
  initialTailscaleSummary,
}: NodesPageClientProps): React.ReactElement {
  const { activeNode } = useControlNode();
  const [nodes, setNodes] = useState<NodeRow[]>(initialNodes);
  const [loading, setLoading] = useState(!initialNodes.length && initialNodes !== undefined ? false : false);
  const [error, setError] = useState<string | null>(null);
  const [registerModalOpen, setRegisterModalOpen] = useState(false);
  const [editNode, setEditNode] = useState<NodeRow | null>(null);
  const [assignRoleNode, setAssignRoleNode] = useState<NodeRow | null>(null);
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredAgent[]>([]);
  const [terminalNode, setTerminalNode] = useState<NodeRow | null>(null);
  const [nodeHealth, setNodeHealth] = useState<Record<string, NodeHealth>>({});
  const [systemUpdateSummary, setSystemUpdateSummary] = useState<SystemUpdateSummary | null>(null);
  const [tailscaleSummary, setTailscaleSummary] = useState<TailscaleExpirySummary | null>(initialTailscaleSummary);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const roleOverridesRef = useRef<Record<string, { id: string; name: string } | null>>({});
  const [isFirstLoad, setIsFirstLoad] = useState(initialNodes.length > 0);

  const fetchNodes = useCallback(
    async (silent = false): Promise<void> => {
      try {
        if (!silent) setLoading(true);
        setError(null);
        const [res, updateRes, tailscaleRes] = await Promise.all([
          api.nodes.list(),
          api.nodes.systemUpdatesSummary().catch(() => null),
          api.nodes.tailscaleSummary().catch(() => null),
        ]);
        const data = (res.data as unknown as NodeRow[]).map((n) => {
          if (n.role) {
            delete roleOverridesRef.current[n.id];
            return n;
          }
          const override = roleOverridesRef.current[n.id];
          return override !== undefined ? { ...n, role: override } : n;
        });
        setNodes(data);
        setSystemUpdateSummary((updateRes?.data as SystemUpdateSummary | undefined) ?? null);
        setTailscaleSummary(tailscaleRes?.data ?? null);

        const healthEntries = await Promise.all(
          data.map(async (node) => {
            try {
              const healthRes = await api.nodes.health(node.id);
              return [node.id, healthRes.data as unknown as NodeHealth] as const;
            } catch {
              return [node.id, null] as const;
            }
          }),
        );
        setNodeHealth(
          Object.fromEntries(
            healthEntries.filter(
              (entry): entry is readonly [string, NodeHealth] => entry[1] !== null,
            ),
          ),
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const isNetworkError =
          message === 'Failed to fetch' ||
          message.includes('TypeError') ||
          message.includes('NetworkError') ||
          message.includes('ECONNREFUSED') ||
          message.includes('timeout');
        if (!silent) {
          setError(isNetworkError ? `Control node unreachable (${activeNode.name})` : message);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [activeNode.name],
  );

  useEffect(() => {
    if (isFirstLoad) {
      setIsFirstLoad(false);
      // Still fetch health + agent version even with SSR data
      void (async () => {
        // Fetch health for initial nodes
        if (initialNodes.length > 0) {
          const healthEntries = await Promise.all(
            initialNodes.map(async (node) => {
              try {
                const healthRes = await api.nodes.health(node.id);
                return [node.id, healthRes.data as unknown as NodeHealth] as const;
              } catch {
                return [node.id, null] as const;
              }
            }),
          );
          setNodeHealth(
            Object.fromEntries(
              healthEntries.filter(
                (entry): entry is readonly [string, NodeHealth] => entry[1] !== null,
              ),
            ),
          );
        }
        try {
          const updateRes = await api.nodes.systemUpdatesSummary();
          setSystemUpdateSummary(updateRes.data as SystemUpdateSummary);
        } catch {
          setSystemUpdateSummary(null);
        }
        try {
          const tailscaleRes = await api.nodes.tailscaleSummary();
          setTailscaleSummary(tailscaleRes.data ?? null);
        } catch {
          setTailscaleSummary(null);
        }
      })();
      return;
    }
    // activeNode changed — clear and re-fetch
    setNodes([]);
    setError(null);
    setDiscovered([]);
    setNodeHealth({});
    setSystemUpdateSummary(null);
    setTailscaleSummary(null);
    roleOverridesRef.current = {};
    void fetchNodes();
  }, [activeNode.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh when any node is in a transient state
  useEffect(() => {
    const hasTransient =
      nodes.some((n) => n.status === 'PROVISIONING' || n.agent?.status === 'UPDATING');
    if (hasTransient && !pollRef.current) {
      pollRef.current = setInterval(() => {
        void fetchNodes(true);
      }, 4000);
    } else if (!hasTransient && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [nodes, fetchNodes]);

  const deleteNode = async (node: NodeRow): Promise<void> => {
    if (
      !confirm(
        `Delete node "${node.name}"? This will permanently remove it and all associated data.`,
      )
    )
      return;
    try {
      await api.nodes.delete(node.id);
      void fetchNodes();
    } catch {
      // handle error
    }
  };


  const scanNetwork = async (): Promise<void> => {
    setScanning(true);
    setDiscovered([]);
    try {
      const res = await api.discovery.scan(5000);
      if (res.success && Array.isArray(res.data)) {
        setDiscovered(res.data as DiscoveredAgent[]);
      }
    } catch {
      // scan failed
    } finally {
      setScanning(false);
    }
  };


  return (
    <PageTransition className="space-y-6">
      <PageItem>
      <PageHeader
        title="Nodes"
        eyebrow="Fleet"
        description="Manage your Magnus fleet nodes"
        status={nodes.length > 0 ? (
          <span className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-text-muted">
            <span className="flex items-center gap-1.5"><StatusDot status="ONLINE" size="xs" /><span className="num">{nodes.filter((n) => n.status === 'ONLINE').length}</span> online</span>
            <span className="flex items-center gap-1.5"><StatusDot status="OFFLINE" size="xs" pulse={false} /><span className="num">{nodes.filter((n) => n.status === 'OFFLINE').length}</span> offline</span>
          </span>
        ) : undefined}
        actions={<>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => void fetchNodes()}
          >
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setRegisterModalOpen(true)}
          >
            Register Node
          </Button>
        </>}
      />
      </PageItem>

      <PageItem>
      <ControlNodeBar />
      </PageItem>

      {tailscaleSummary && (
        <PageItem>
          <TailscaleExpiryAlert summary={tailscaleSummary} showAction={false} />
        </PageItem>
      )}

      {systemUpdateSummary && (
        <PageItem>
          <section className="panel-corners overflow-hidden rounded-panel border border-border bg-surface" aria-label="System update readiness">
            <div className="grid grid-cols-2 divide-x divide-y divide-border/60 sm:grid-cols-4 sm:divide-y-0">
              <div className="col-span-2 flex items-center gap-3 px-4 py-3 sm:col-span-1">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-panel border border-primary/30 bg-primary/10 text-primary shadow-[0_0_10px_var(--color-glow)]">
                  <RefreshCcwDot className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-text-muted">Auto-update coverage</p>
                  <p className="num mt-0.5 text-sm font-semibold">{systemUpdateSummary.enabled} / {systemUpdateSummary.reporting} enabled</p>
                  <MeterBar
                    className="mt-1.5"
                    value={systemUpdateSummary.reporting > 0 ? (systemUpdateSummary.enabled / systemUpdateSummary.reporting) * 100 : null}
                    tone={systemUpdateSummary.enabled === systemUpdateSummary.reporting ? 'success' : 'warning'}
                    label="Auto-update coverage"
                  />
                </div>
              </div>
              <div className="px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-text-muted">Action needed</p>
                <p className={`num mt-1 text-lg font-bold ${systemUpdateSummary.actionNeeded ? 'text-warning glow-text-warning' : 'text-success'}`}>
                  {systemUpdateSummary.actionNeeded}
                </p>
              </div>
              <div className="px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-text-muted">Reboot debt</p>
                <p className={`num mt-1 flex items-center gap-1.5 text-lg font-bold ${systemUpdateSummary.rebootRequired ? 'text-danger glow-text-danger' : 'text-success'}`}>
                  {systemUpdateSummary.rebootRequired ? <Power className="h-4 w-4" /> : null}
                  {systemUpdateSummary.rebootRequired}
                </p>
              </div>
              <div className="px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-text-muted">Reporting</p>
                <p className="num mt-1 text-lg font-bold">{systemUpdateSummary.reporting} / {systemUpdateSummary.total}</p>
              </div>
            </div>
          </section>
        </PageItem>
      )}

      <PageItem>
      <Card>
        {error ? (
          error.startsWith('Control node unreachable') ? (
            <EmptyState
              tone="warning"
              icon={<Wifi className="h-5 w-5" />}
              title={error}
              description="Cannot connect to this Control Node. Verify it is running and reachable."
              action={<Button variant="secondary" size="sm" onClick={() => void fetchNodes()}>Retry</Button>}
            />
          ) : (
            <EmptyState
              tone="danger"
              icon={<AlertCircle className="h-5 w-5" />}
              title="Error loading nodes"
              description={error}
              action={<Button variant="secondary" size="sm" onClick={() => void fetchNodes()}>Retry</Button>}
            />
          )
        ) : loading ? (
          <SkeletonTable rows={6} cols={9} className="border-0" />
        ) : nodes.length === 0 ? (
          <EmptyState
            tone="primary"
            icon={<Server className="h-5 w-5" />}
            title="No nodes registered"
            description="Register your first Magnus node to get started."
            action={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setRegisterModalOpen(true)}>Register Node</Button>}
          />
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="sticky top-0 z-10 border-b border-primary/30 bg-surface/95 text-left text-[10px] font-bold uppercase tracking-[0.15em] text-text-muted shadow-[0_1px_0_var(--color-primary),0_4px_12px_-6px_var(--color-glow)] backdrop-blur-sm">
                  <th className="pb-3 pr-4">Name</th>
                  <th className="pb-3 pr-4">Host</th>
                  <th className="pb-3 pr-4">Address</th>
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3 pr-4">Agent</th>
                  <th className="pb-3 pr-4">Role</th>
                  <th className="pb-3 pr-4">CPU</th>
                  <th className="pb-3 pr-4">Memory</th>
                  <th className="pb-3 pr-4">Persistent Disk</th>
                  <th className="pb-3 pr-4">Updates</th>
                  <th className="pb-3 pr-4">Tailscale key</th>
                  <th className="pb-3 pr-4">Last Heartbeat</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {nodes.map((node) => {
                  const health = nodeHealth[node.id];
                  const userDisk = getWorstPersistentDisk(health?.disks);
                  const userDiskSeverity = userDisk
                    ? getUserDiskSeverity(userDisk.usagePercent)
                    : null;
                  const updates = systemUpdateSummary?.nodes.find((item) => item.id === node.id)?.systemUpdates ?? null;
                  const tailscale = tailscaleSummary?.nodes.find((item) => item.id === node.id)?.tailscale ?? null;
                  return (
                    <tr key={node.id} className="group/row relative transition-colors hover:bg-primary/[0.03] [&>td:first-child]:shadow-[inset_2px_0_0_transparent] hover:[&>td:first-child]:shadow-[inset_2px_0_0_var(--color-primary)]">
                      <td className="py-3 pl-2 pr-4">
                        <div className="flex items-center gap-2">
                          <StatusDot status={node.status} size="xs" />
                          {node.status === 'ONLINE' && (
                            <button
                              onClick={() => setTerminalNode(node)}
                              title={`Open terminal on ${node.name}`}
                              className="flex h-6 w-6 items-center justify-center rounded border border-border/50 text-text-muted hover:text-primary hover:border-primary/40 transition-colors"
                            >
                              <Terminal className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <Link
                            href={`/nodes/${node.id}`}
                            className="font-medium text-primary hover:text-primary-hover transition-colors"
                          >
                            {node.name}
                          </Link>
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-text-muted">{node.hostname}</td>
                      <td className="py-3 pr-4 text-text-muted">
                        {node.ipAddress}:{node.port}
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-1.5">
                          <Badge variant={statusVariant(node.status)}>{node.status}</Badge>
                          {(node.status === 'DEGRADED' || node.agent?.status === 'ERROR') &&
                            getNodeError(node.metadata) && (
                              <span
                                title={`${getNodeError(node.metadata)!.label}: ${getNodeError(node.metadata)!.message}`}
                              >
                                <AlertCircle className="h-3.5 w-3.5 text-danger cursor-help" />
                              </span>
                            )}
                          {node.status === 'PROVISIONING' && (
                            <Loader2 className="h-3.5 w-3.5 text-info animate-spin" />
                          )}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-text-muted">
                        <div className="flex items-center gap-1.5">
                          {node.agent ? `v${node.agent.version}` : '—'}
                          {node.agent?.status === 'UPDATING' && (
                            <Loader2 className="h-3 w-3 text-info animate-spin" />
                          )}
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        {node.role ? (
                          <button
                            className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary hover:bg-primary/10 hover:border-primary/50 transition-all cursor-pointer"
                            onClick={() => setAssignRoleNode(node)}
                            title="Change role"
                          >
                            <ShieldCheck className="h-3 w-3" />
                            {node.role.name}
                          </button>
                        ) : (
                          <button
                            className="text-[10px] text-text-muted hover:text-primary transition-colors cursor-pointer uppercase tracking-wider"
                            onClick={() => setAssignRoleNode(node)}
                          >
                            + Assign
                          </button>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-text-muted">
                        {health ? (
                          <MeterBar
                            value={health.cpuUsagePercent}
                            label={`${node.name} CPU`}
                            valueLabel={`${health.cpuUsagePercent.toFixed(1)}%`}
                            showValue
                            className="w-28"
                          />
                        ) : '—'}
                      </td>
                      <td className="py-3 pr-4 text-text-muted">
                        {health ? (
                          <div className="w-36">
                            <MeterBar value={health.memoryPercent} label={`${node.name} memory`} showValue />
                            <span className="num mt-0.5 block text-[10px] text-text-muted/80">
                              {(health.memoryUsedBytes / 1024 ** 3).toFixed(1)} / {(health.memoryTotalBytes / 1024 ** 3).toFixed(1)} GB
                            </span>
                          </div>
                        ) : '—'}
                      </td>
                      <td className="py-3 pr-4">
                        {userDisk ? (
                          <span
                            className="flex w-36 flex-col gap-0.5"
                            title={`${userDisk.mountPoint} filesystem is ${userDisk.usagePercent}% used${userDiskSeverity === 'normal' ? '' : ' — disk usage anomaly'}`}
                          >
                            <MeterBar
                              value={userDisk.usagePercent}
                              tone={userDiskSeverity === 'critical' ? 'danger' : userDiskSeverity === 'warning' ? 'warning' : 'success'}
                              label={`${node.name} ${userDisk.mountPoint} disk`}
                              valueLabel={`${userDisk.usagePercent.toFixed(0)}%`}
                              glow={userDiskSeverity !== 'normal'}
                              showValue
                            />
                            <span className="flex items-center gap-1 text-[10px] text-text-muted">
                              {userDiskSeverity !== 'normal' && (
                                <AlertTriangle
                                  aria-label={`${userDiskSeverity} disk usage anomaly`}
                                  className={userDiskSeverity === 'critical' ? 'h-3 w-3 text-danger' : 'h-3 w-3 text-warning'}
                                />
                              )}
                              {userDisk.mountPoint}
                            </span>
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        {!updates ? (
                          <Badge variant="default">awaiting agent</Badge>
                        ) : updates.rebootRequired ? (
                          <Badge variant="danger">reboot required</Badge>
                        ) : updates.automaticUpdates === 'enabled' ? (
                          <Badge variant="success">automatic</Badge>
                        ) : updates.automaticUpdates === 'unsupported' ? (
                          <Badge variant="default">unsupported</Badge>
                        ) : (
                          <Badge variant="warning">enable updates</Badge>
                        )}
                      </td>
                      <td className="py-3 pr-4" title={tailscale?.keyExpiry ? `Expires ${tailscale.keyExpiry}` : undefined}>
                        {!tailscale ? (
                          <Badge variant="default">awaiting agent</Badge>
                        ) : !tailscale.expiryEnabled ? (
                          <Badge variant="success">no expiry</Badge>
                        ) : tailscale.expired ? (
                          <Badge variant="danger">expired</Badge>
                        ) : tailscale.daysRemaining === null ? (
                          <Badge variant="default">unknown</Badge>
                        ) : tailscale.requiresRenewal ? (
                          <Badge variant="warning">{tailscale.daysRemaining}d</Badge>
                        ) : (
                          <Badge variant="success">{tailscale.daysRemaining}d</Badge>
                        )}
                      </td>
                      <td className="num py-3 pr-4 text-text-muted">
                        {formatDate(node.lastHeartbeatAt)}
                      </td>
                      <td className="py-3">
                        <div className="flex gap-1">
                          <Link href={`/nodes/${node.id}`}>
                            <Button variant="ghost" size="sm">
                              View
                            </Button>
                          </Link>
                          <Button variant="ghost" size="sm" onClick={() => setEditNode(node)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void deleteNode(node)}>
                            <Trash2 className="h-3.5 w-3.5 text-danger" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      </PageItem>

      {/* ── Discovered Nodes (Network Scan) ── */}
      <PageItem>
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-primary" />
            <h2 className="text-xs font-bold uppercase tracking-wider">Network Discovery</h2>
            <span className="text-[11px] text-text-muted">
              — Unadopted agents found on the local network
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={
              scanning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wifi className="h-3.5 w-3.5" />
              )
            }
            onClick={() => void scanNetwork()}
            disabled={scanning}
          >
            {scanning ? 'Scanning…' : 'Scan Network'}
          </Button>
        </div>

        {discovered.length === 0 ? (
          scanning ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <div className="relative h-16 w-16 overflow-hidden rounded-full border border-primary/30 shadow-[0_0_16px_var(--color-glow)]">
                <div className="absolute inset-0 animate-sweep rounded-full bg-[conic-gradient(from_0deg,transparent_0deg,transparent_280deg,var(--color-primary)_360deg)] opacity-60" />
                <div className="absolute inset-[30%] rounded-full border border-primary/20" />
              </div>
              <p className="text-[11px] uppercase tracking-wider text-primary">Broadcasting discovery probe…</p>
            </div>
          ) : (
            <EmptyState
              compact
              icon={<Wifi className="h-4 w-4" />}
              title="No scan results yet"
              description='Click "Scan Network" to discover unadopted agents on your network.'
            />
          )
        ) : (
          (() => {
            const unadopted = discovered.filter((a) => !a.registered);
            const adopted = discovered.filter((a) => a.registered);

            return unadopted.length === 0 ? (
              <div className="py-6 text-center text-[11px] text-text-muted">
                All {adopted.length} discovered agent{adopted.length !== 1 ? 's' : ''} already
                registered. No new nodes to adopt.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-primary/20 text-left text-[10px] font-bold uppercase tracking-[0.15em] text-text-muted">
                      <th className="pb-3 pr-4">Hostname</th>
                      <th className="pb-3 pr-4">IP Address</th>
                      <th className="pb-3 pr-4">Port</th>
                      <th className="pb-3 pr-4">Agent Version</th>
                      <th className="pb-3">Registration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {unadopted.map((agent) => (
                      <tr key={`${agent.ip}:${agent.port}`} className="hover:bg-surface-hover transition-colors">
                        <td className="py-3 pr-4 font-medium">{agent.fqdn || agent.hostname}</td>
                        <td className="py-3 pr-4 text-text-muted">{agent.ip}</td>
                        <td className="py-3 pr-4 text-text-muted">{agent.port}</td>
                        <td className="py-3 pr-4 text-text-muted">v{agent.version}</td>
                        <td className="py-3 text-text-muted">
                          Use the reviewed key-only agent deploy runbook, then register the authenticated heartbeat.
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {adopted.length > 0 && (
                  <p className="mt-3 text-xs text-text-muted">
                    {adopted.length} already-registered agent{adopted.length !== 1 ? 's' : ''}{' '}
                    hidden from this list.
                  </p>
                )}
              </div>
            );
          })()
        )}
      </Card>
      </PageItem>

      <RegisterNodeModal
        open={registerModalOpen}
        onClose={() => setRegisterModalOpen(false)}
        onRegistered={() => void fetchNodes()}
      />

      <EditNodeModal
        open={!!editNode}
        node={editNode}
        onClose={() => setEditNode(null)}
        onSaved={() => void fetchNodes()}
      />

      <AssignRoleModal
        open={!!assignRoleNode}
        node={assignRoleNode}
        onClose={() => setAssignRoleNode(null)}
        onSaved={(assignedRole) => {
          if (assignRoleNode) {
            roleOverridesRef.current[assignRoleNode.id] = assignedRole;
            setNodes((prev) =>
              prev.map((n) => (n.id === assignRoleNode.id ? { ...n, role: assignedRole } : n)),
            );
          }
          void fetchNodes();
        }}
      />

      <TerminalModal
        open={!!terminalNode}
        onClose={() => setTerminalNode(null)}
        node={terminalNode}
      />
    </PageTransition>
  );
}
