/**
 * topology-service.ts — Fleet network topology autodiscovery.
 *
 * Builds a topology map from registered nodes:
 * - Subnet grouping (by /24 CIDR)
 * - Node reachability (TCP probe on agent port)
 * - Latency measurement between control-api and each node
 * - Gateway detection (subnet with most cross-subnet connections)
 */

import { getDb } from '../db/index.js';
import { connect, type Socket } from 'node:net';

// ── Types ──

export interface TopologyNode {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  port: number;
  status: string;
  subnet: string;
  reachable: boolean;
  latencyMs: number | null;
  lastHeartbeatAt: string | null;
}

export interface TopologySubnet {
  cidr: string;
  nodeCount: number;
  nodes: string[]; // node IDs
  isGateway: boolean;
}

export interface TopologyEdge {
  from: string; // node ID
  to: string;   // node ID
  latencyMs: number | null;
  type: 'same-subnet' | 'cross-subnet';
}

export interface TopologyMap {
  nodes: TopologyNode[];
  subnets: TopologySubnet[];
  edges: TopologyEdge[];
  scannedAt: string;
}

// ── Helpers ──

function getSubnet(ip: string): string {
  const parts = ip.split('.');
  if (parts.length !== 4) return 'unknown/24';
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

/**
 * TCP probe — attempt to connect to host:port with timeout.
 * Returns latency in ms on success, null on failure.
 */
function probeNode(host: string, port: number, timeoutMs = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const start = performance.now();
    let resolved = false;

    const socket: Socket = connect({ host, port, timeout: timeoutMs }, () => {
      if (!resolved) {
        resolved = true;
        const latency = Math.round(performance.now() - start);
        socket.destroy();
        resolve(latency);
      }
    });

    socket.on('error', () => {
      if (!resolved) { resolved = true; resolve(null); }
    });

    socket.on('timeout', () => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(null); }
    });

    setTimeout(() => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(null); }
    }, timeoutMs);
  });
}

// ── Core ──

/**
 * Scan all registered nodes and build a topology map.
 */
export async function scanTopology(probeTimeoutMs = 3000): Promise<TopologyMap> {
  const db = getDb();
  const nodes = await db.node.findMany({
    where: { status: { not: 'DECOMMISSIONED' } },
    select: { id: true, name: true, hostname: true, ipAddress: true, port: true, status: true, lastHeartbeatAt: true },
  });

  // Probe all nodes concurrently
  const probeResults = await Promise.allSettled(
    nodes.map(async (n) => {
      const latency = await probeNode(n.ipAddress, n.port, probeTimeoutMs);
      return { nodeId: n.id, reachable: latency !== null, latencyMs: latency };
    }),
  );

  const probeMap = new Map<string, { reachable: boolean; latencyMs: number | null }>();
  for (const r of probeResults) {
    if (r.status === 'fulfilled') {
      probeMap.set(r.value.nodeId, { reachable: r.value.reachable, latencyMs: r.value.latencyMs });
    }
  }

  // Build topology nodes
  const topoNodes: TopologyNode[] = nodes.map((n) => {
    const probe = probeMap.get(n.id) ?? { reachable: false, latencyMs: null };
    return {
      id: n.id,
      name: n.name,
      hostname: n.hostname,
      ip: n.ipAddress,
      port: n.port,
      status: n.status,
      subnet: getSubnet(n.ipAddress),
      reachable: probe.reachable,
      latencyMs: probe.latencyMs,
      lastHeartbeatAt: n.lastHeartbeatAt?.toISOString() ?? null,
    };
  });

  // Group by subnet
  const subnetMap = new Map<string, string[]>();
  for (const n of topoNodes) {
    const list = subnetMap.get(n.subnet) ?? [];
    list.push(n.id);
    subnetMap.set(n.subnet, list);
  }

  // Detect gateway subnet (largest or most varied connectivity)
  const maxSubnetSize = Math.max(...[...subnetMap.values()].map((v) => v.length), 0);
  const subnets: TopologySubnet[] = [...subnetMap.entries()].map(([cidr, nodeIds]) => ({
    cidr,
    nodeCount: nodeIds.length,
    nodes: nodeIds,
    isGateway: nodeIds.length === maxSubnetSize && subnetMap.size > 1,
  }));

  // Build edges: nodes within same subnet are same-subnet edges, across subnets are cross-subnet
  const edges: TopologyEdge[] = [];
  const nodeSubnet = new Map(topoNodes.map((n) => [n.id, n.subnet]));

  for (let i = 0; i < topoNodes.length; i++) {
    for (let j = i + 1; j < topoNodes.length; j++) {
      const a = topoNodes[i]!;
      const b = topoNodes[j]!;
      const sameSubnet = nodeSubnet.get(a.id) === nodeSubnet.get(b.id);
      // Only create edges within same subnet automatically;
      // cross-subnet edges only between reachable nodes
      if (sameSubnet || (a.reachable && b.reachable)) {
        edges.push({
          from: a.id,
          to: b.id,
          latencyMs: a.latencyMs !== null && b.latencyMs !== null
            ? Math.round((a.latencyMs + b.latencyMs) / 2)
            : null,
          type: sameSubnet ? 'same-subnet' : 'cross-subnet',
        });
      }
    }
  }

  return {
    nodes: topoNodes,
    subnets,
    edges,
    scannedAt: new Date().toISOString(),
  };
}
