import { NextResponse } from 'next/server';
import { readNodes } from '@/lib/control-nodes-store';
import { DEFAULT_CONTROL_NODE } from '@/lib/control-nodes';
import { controlNodeFetchById } from '@/lib/control-node-server';

interface OverviewStats {
  nodes: { total: number; online: number; offline: number; degraded: number; provisioning: number };
  commands: { total: number; running: number; pending: number };
  cron: { total: number; active: number };
  health: { avgCpuPercent: number | null; avgMemoryPercent: number | null; reportingNodes: number };
}

interface FleetResult {
  nodeId: string;
  nodeName: string;
  stats: OverviewStats | null;
  error?: string;
}

async function fetchNodeStats(
  nodeId: string,
): Promise<OverviewStats | null> {
  const res = await controlNodeFetchById(nodeId, 'stats/overview', {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);

  if (!res || !res.ok) return null;
  const json = (await res.json()) as { success?: boolean; data?: OverviewStats };
  return json.data ?? null;
}

/**
 * GET /api/federation
 * Query all configured control nodes in parallel and return aggregated cross-fleet stats.
 */
export async function GET() {
  const stored = await readNodes();
  const allNodes = stored.length > 0 ? stored : [DEFAULT_CONTROL_NODE];

  const results: FleetResult[] = await Promise.all(
    allNodes.map(async (node) => {
      try {
        const stats = await fetchNodeStats(node.id);
        return { nodeId: node.id, nodeName: node.name, stats };
      } catch {
        return { nodeId: node.id, nodeName: node.name, stats: null, error: 'unreachable' };
      }
    }),
  );

  // Aggregate across all fleets
  const fleets = results.filter((r) => r.stats !== null);
  const aggregated: OverviewStats = {
    nodes: { total: 0, online: 0, offline: 0, degraded: 0, provisioning: 0 },
    commands: { total: 0, running: 0, pending: 0 },
    cron: { total: 0, active: 0 },
    health: { avgCpuPercent: null, avgMemoryPercent: null, reportingNodes: 0 },
  };

  let totalCpu = 0;
  let totalMem = 0;
  let totalReporting = 0;

  for (const r of fleets) {
    const s = r.stats!;
    aggregated.nodes.total += s.nodes.total;
    aggregated.nodes.online += s.nodes.online;
    aggregated.nodes.offline += s.nodes.offline;
    aggregated.nodes.degraded += s.nodes.degraded;
    aggregated.nodes.provisioning += s.nodes.provisioning;
    aggregated.commands.total += s.commands.total;
    aggregated.commands.running += s.commands.running;
    aggregated.commands.pending += s.commands.pending;
    aggregated.cron.total += s.cron.total;
    aggregated.cron.active += s.cron.active;
    if (s.health.avgCpuPercent !== null && s.health.reportingNodes > 0) {
      totalCpu += s.health.avgCpuPercent * s.health.reportingNodes;
      totalMem += (s.health.avgMemoryPercent ?? 0) * s.health.reportingNodes;
      totalReporting += s.health.reportingNodes;
    }
  }

  if (totalReporting > 0) {
    aggregated.health.avgCpuPercent = Math.round((totalCpu / totalReporting) * 100) / 100;
    aggregated.health.avgMemoryPercent = Math.round((totalMem / totalReporting) * 100) / 100;
    aggregated.health.reportingNodes = totalReporting;
  }

  return NextResponse.json({
    success: true,
    data: {
      aggregated,
      fleets: results,
      totalFleets: allNodes.length,
      healthyFleets: fleets.length,
    },
  });
}
