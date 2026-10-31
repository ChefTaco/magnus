'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api-client';
import FleetMapCanvas from './fleet-map-canvas';
import Link from 'next/link';
import { Loader2, Network, Radar, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, statusVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { GlowPanel } from '@/components/ui/glow-panel';
import { PageHeader } from '@/components/ui/page-header';
import { StatusDot } from '@/components/ui/status-dot';
import { TONE_TEXT, latencyTone } from '@/lib/theme-colors';

interface TopologyNode {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  port: number;
  status: string;
  subnet: string;
  reachable: boolean;
  latencyMs: number | null;
}

interface TopologyEdge {
  from: string;
  to: string;
  latencyMs: number | null;
  type: 'same-subnet' | 'cross-subnet';
}

interface TopologySubnet {
  cidr: string;
  nodeCount: number;
  nodes: string[];
  isGateway: boolean;
}

interface TopologyMap {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  subnets: TopologySubnet[];
  scannedAt: string;
}

export default function FleetMapClient() {

  const [topology, setTopology] = useState<TopologyMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [view, setView] = useState<'canvas' | 'grid'>('canvas');
  const [inFlight, setInFlight] = useState<Array<{ nodeId: string }>>([]);

  const fetchTopology = useCallback(async () => {
    try {
      const data = await api.get<TopologyMap>('topology');
      setTopology(data.data ?? null);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load topology');
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerScan = async () => {
    setScanning(true);
    try {
      const data = await api.post<TopologyMap>('topology/scan');
      setTopology(data.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    fetchTopology();
  }, [fetchTopology]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchTopology, 30_000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchTopology]);

  // Poll in-flight commands for the canvas animation overlay
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.get<{ items?: Array<{ nodeId: string; status: string }> }>(
          'commands?status=running&limit=50',
        );
        if (cancelled) return;
        const items = res.data?.items ?? [];
        setInFlight(items.filter((c) => c.status === 'running').map((c) => ({ nodeId: c.nodeId })));
      } catch {
        if (!cancelled) setInFlight([]);
      }
    };
    load();
    const id = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="skeleton h-10 w-72" />
        <div className="skeleton h-[600px] w-full rounded-panel opacity-70" />
        <span className="sr-only">Loading topology…</span>
      </div>
    );
  }

  if (error && !topology) {
    return (
      <EmptyState
        tone="danger"
        icon={<Network className="h-5 w-5" />}
        title="Topology unavailable"
        description={error}
        action={<Button variant="secondary" size="sm" onClick={() => void fetchTopology()}>Retry</Button>}
      />
    );
  }

  const onlineCount = topology?.nodes.filter((n) => n.reachable).length ?? 0;
  const totalCount = topology?.nodes.length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fleet Map"
        eyebrow="Topology"
        description={
          <>
            Real-time network topology — <span className="num text-primary">{onlineCount}/{totalCount}</span> nodes reachable
            {topology?.scannedAt && (
              <> · Last scan: <span className="num">{new Date(topology.scannedAt).toLocaleTimeString()}</span></>
            )}
          </>
        }
        actions={
          <>
            <div role="group" aria-label="View" className="inline-flex rounded-chip border border-border bg-bg p-0.5" data-testid="fleet-map-view-toggle">
              {(['canvas', 'grid'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={cn(
                    'rounded-chip px-3 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors',
                    view === v ? 'bg-primary/15 text-primary shadow-[0_0_10px_var(--color-glow)]' : 'text-text-muted hover:text-text',
                  )}
                  data-testid={`fleet-map-view-${v}`}
                >
                  {v === 'canvas' ? 'Canvas' : 'Grid'}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-muted">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="accent-[var(--color-primary)]"
              />
              Auto-refresh
            </label>
            <Button
              size="sm"
              onClick={() => void triggerScan()}
              disabled={scanning}
              icon={scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
            >
              {scanning ? 'Scanning...' : 'Scan Now'}
            </Button>
          </>
        }
      />

      {/* Canvas fleet map */}
      {view === 'canvas' && topology && (
        <FleetMapCanvas
          topology={topology}
          inFlight={inFlight}
          selectedNodeId={selectedNode?.id ?? null}
          onSelectNode={(n) =>
            setSelectedNode((current) => (current?.id === n?.id ? null : n))
          }
        />
      )}

      {/* Subnet cards */}
      {view === 'grid' && (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {topology?.subnets.map((subnet) => (
          <GlowPanel key={subnet.cidr} tone={subnet.isGateway ? 'accent' : 'primary'} padding="sm" className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="num text-sm font-bold text-text">{subnet.cidr}</h3>
              {subnet.isGateway && <Badge variant="default" className="border-accent/40 text-accent">Gateway</Badge>}
              <span className="num text-[10px] uppercase tracking-wider text-text-muted">{subnet.nodeCount} nodes</span>
            </div>
            <div className="space-y-1.5">
              {topology.nodes
                .filter((n) => subnet.nodes.includes(n.id))
                .map((node) => (
                  <button
                    key={node.id}
                    onClick={() => setSelectedNode(selectedNode?.id === node.id ? null : node)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-chip border p-2 text-left transition-colors',
                      selectedNode?.id === node.id
                        ? 'border-primary/50 bg-primary/10 shadow-[0_0_10px_var(--color-glow)]'
                        : 'border-transparent hover:border-border hover:bg-surface-hover',
                    )}
                  >
                    <StatusDot status={node.status} pulse={node.reachable && node.status === 'ONLINE'} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-text">{node.name}</div>
                      <div className="num truncate text-[10px] text-text-muted">{node.ip}:{node.port}</div>
                    </div>
                    {node.latencyMs !== null && (
                      <span className={cn('num text-[11px]', TONE_TEXT[latencyTone(node.latencyMs)])}>
                        {node.latencyMs}ms
                      </span>
                    )}
                  </button>
                ))}
            </div>
          </GlowPanel>
        ))}
      </div>
      )}

      {/* Connection matrix */}
      {view === 'grid' && topology && topology.edges.length > 0 && (
        <GlowPanel title="Network Edges" icon={<Network className="h-3.5 w-3.5" />}>
          <div className="max-h-[50vh] overflow-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="sticky top-0 border-b border-primary/30 bg-surface/95 text-left text-[10px] font-bold uppercase tracking-[0.15em] text-text-muted">
                  <th className="px-3 py-2">From</th>
                  <th className="px-3 py-2">To</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2 text-right">Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {topology.edges.map((edge, i) => {
                  const fromNode = topology.nodes.find((n) => n.id === edge.from);
                  const toNode = topology.nodes.find((n) => n.id === edge.to);
                  return (
                    <tr key={i} className="transition-colors hover:bg-primary/[0.03]">
                      <td className="px-3 py-2 text-text">{fromNode?.name ?? edge.from}</td>
                      <td className="px-3 py-2 text-text">{toNode?.name ?? edge.to}</td>
                      <td className="px-3 py-2">
                        <Badge variant="default" className={edge.type === 'same-subnet' ? 'border-primary/40 text-primary' : 'border-accent/40 text-accent'}>
                          {edge.type}
                        </Badge>
                      </td>
                      <td className={cn('num px-3 py-2 text-right', edge.latencyMs !== null ? TONE_TEXT[latencyTone(edge.latencyMs)] : 'text-text-muted')}>
                        {edge.latencyMs !== null ? `${edge.latencyMs}ms` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </GlowPanel>
      )}

      {/* Node detail panel */}
      {selectedNode && (
        <GlowPanel
          tone={selectedNode.status === 'ONLINE' ? 'primary' : selectedNode.status === 'OFFLINE' ? 'danger' : 'warning'}
          title={<span className="flex items-center gap-2"><StatusDot status={selectedNode.status} />{selectedNode.name}</span>}
          action={
            <button onClick={() => setSelectedNode(null)} aria-label="Close node details" className="text-text-muted transition-colors hover:text-text">
              <X className="h-4 w-4" />
            </button>
          }
        >
          <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            {[
              ['Hostname', selectedNode.hostname, ''],
              ['IP', selectedNode.ip, 'num'],
              ['Port', String(selectedNode.port), 'num'],
              ['Subnet', selectedNode.subnet, 'num'],
            ].map(([label, value, cls]) => (
              <div key={label}>
                <dt className="text-[10px] uppercase tracking-wider text-text-muted">{label}</dt>
                <dd className={cn('mt-0.5 truncate text-text', cls)}>{value}</dd>
              </div>
            ))}
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-text-muted">Status</dt>
              <dd className="mt-0.5"><Badge variant={statusVariant(selectedNode.status)}>{selectedNode.status}</Badge></dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-text-muted">Reachable</dt>
              <dd className={cn('mt-0.5 font-bold', selectedNode.reachable ? 'text-success' : 'text-danger')}>{selectedNode.reachable ? 'Yes' : 'No'}</dd>
            </div>
            {selectedNode.latencyMs !== null && (
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-text-muted">Latency</dt>
                <dd className={cn('num mt-0.5', TONE_TEXT[latencyTone(selectedNode.latencyMs)])}>{selectedNode.latencyMs}ms</dd>
              </div>
            )}
            <div className="flex items-end">
              <Link href={`/nodes/${selectedNode.id}`} className="text-[11px] uppercase tracking-wider text-primary hover:underline">
                Open node →
              </Link>
            </div>
          </dl>
        </GlowPanel>
      )}
    </div>
  );
}
