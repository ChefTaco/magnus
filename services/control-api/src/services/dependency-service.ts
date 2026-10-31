/**
 * dependency-service.ts — Node dependency mapping.
 *
 * Discovers service dependencies between nodes by:
 * 1. Querying each agent for listening ports + active connections
 * 2. Matching connections to known node IPs/ports
 * 3. Building a dependency graph (e.g., app → database → cache)
 */

import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';
import { boundedJson } from './application-probes.js';
import { lookup } from 'node:dns/promises';
import { normalizeIpAddress } from '../utils/ip.js';
import { getDb } from '../db/index.js';
import { getNodeManagerSecret } from '../utils/env.js';

// ── Types ──

export interface ServicePort {
  port: number;
  protocol: string;
  process: string;
  pid?: number;
}

export interface NodeConnection {
  localPort: number;
  remoteIp: string;
  remotePort: number;
  state: string;
}

export interface DependencyNode {
  id: string;
  name: string;
  ip: string;
  services: ServicePort[];
  collection: { status: 'pass' | 'unknown'; observedAt: string; reason: string | null };
}

export interface DependencyEdge {
  from: string;       // source node ID
  to: string;         // destination node ID
  fromPort: number;
  toPort: number;
  service: string;    // detected service name (e.g., "postgres", "redis")
  connectionCount: number;
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  discoveredAt: string;
  status: 'complete' | 'partial';
}

// ── Well-known port lookup ──

const KNOWN_SERVICES: Record<number, string> = {
  22: 'ssh', 80: 'http', 443: 'https', 3000: 'webapp',
  3306: 'mysql', 5432: 'postgres', 6379: 'redis', 6380: 'redis',
  27017: 'mongodb', 9200: 'elasticsearch', 8080: 'http-alt',
  5672: 'rabbitmq', 9092: 'kafka', 2181: 'zookeeper',
  8443: 'https-alt', 4100: 'magnus-agent', 4000: 'magnus-api',
  11434: 'ollama',
};

function detectService(port: number, process?: string): string {
  if (process) {
    const lower = process.toLowerCase();
    if (lower.includes('postgres') || lower.includes('psql')) return 'postgres';
    if (lower.includes('mysql') || lower.includes('mariadb')) return 'mysql';
    if (lower.includes('redis')) return 'redis';
    if (lower.includes('mongo')) return 'mongodb';
    if (lower.includes('nginx')) return 'nginx';
    if (lower.includes('node')) return 'node';
  }
  return KNOWN_SERVICES[port] ?? `port-${port}`;
}

/**
 * Query an agent for its network connections via the agent API.
 * Falls back to empty arrays on error.
 */
async function queryAgentConnections(
  nodeIp: string,
  nodePort: number,
): Promise<{ services: ServicePort[]; connections: NodeConnection[]; collection: DependencyNode['collection'] }> {
  const observedAt = new Date().toISOString();
  const unknown = (reason: string) => ({ services: [], connections: [], collection: { status: 'unknown' as const, observedAt, reason } });
  try {
    const address = `https://${nodeIp}:${nodePort}`;
    const resp = await fetch(`${address}/api/v1/network-info`, {
      headers: { 'x-node-token': getNodeManagerSecret() },
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return unknown(`Agent returned HTTP ${resp.status}`);
    const data = (await boundedJson(resp)) as {
      listeningPorts?: ServicePort[];
      connections?: NodeConnection[];
    };
    if (!Array.isArray(data.listeningPorts) || !Array.isArray(data.connections)) return unknown('Invalid network observation');
    return {
      collection: { status: 'pass', observedAt, reason: null },
      services: data.listeningPorts ?? [],
      connections: data.connections ?? [],
    };
  } catch {
    return unknown('Agent network observation unavailable');
  }
}

/**
 * Build a dependency graph across all registered nodes.
 */
export async function buildDependencyGraph(): Promise<DependencyGraph> {
  const db = getDb();
  const nodes = await db.node.findMany({
    take: 1000,
    where: { id: { notIn: SENTINEL_NODE_IDS } },
    select: { id: true, name: true, hostname: true, ipAddress: true, port: true },
  });

  // Map IP → node ID for matching connections
  const ipToNode = new Map<string, { id: string; name: string }>();
  for (const n of nodes) {
    ipToNode.set(normalizeIpAddress(n.ipAddress), { id: n.id, name: n.name });
  }

  await Promise.allSettled(nodes.map(async n => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const addresses = await Promise.race([Promise.allSettled([...new Set([n.ipAddress,n.hostname])].map(host => lookup(host,{all:true}))).then(results => results.flatMap(r => r.status === 'fulfilled' ? r.value : [])), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 2000); })]);
      for (const address of addresses) ipToNode.set(normalizeIpAddress(address.address), { id: n.id, name: n.name });
    } finally { if (timer) clearTimeout(timer); }
  }));

  // Query all agents in parallel
  const results = await Promise.allSettled(
    nodes.map(async (n) => {
      const info = await queryAgentConnections(n.ipAddress, n.port);
      return { nodeId: n.id, ...info };
    }),
  );

  const depNodes: DependencyNode[] = [];
  const edgeMap = new Map<string, DependencyEdge>();

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { nodeId, services, connections, collection } = r.value;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) continue;

    depNodes.push({ id: nodeId, name: node.name, ip: node.ipAddress, services, collection });

    // Match connections to known nodes
    for (const conn of connections) {
      if (conn.state !== 'ESTABLISHED') continue;
      const target = ipToNode.get(normalizeIpAddress(conn.remoteIp));
      if (!target || target.id === nodeId) continue;

      const edgeKey = `${nodeId}→${target.id}:${conn.remotePort}`;
      const existing = edgeMap.get(edgeKey);
      if (existing) {
        existing.connectionCount++;
      } else {
        const destination = results.find(r => r.status === 'fulfilled' && r.value.nodeId === target.id);
        const proc = destination?.status === 'fulfilled' ? destination.value.services.find(s => s.port === conn.remotePort) : undefined;
        edgeMap.set(edgeKey, {
          from: nodeId,
          to: target.id,
          fromPort: conn.localPort,
          toPort: conn.remotePort,
          service: detectService(conn.remotePort, proc?.process),
          connectionCount: 1,
        });
      }
    }
  }

  return {
    nodes: depNodes,
    edges: [...edgeMap.values()],
    discoveredAt: new Date().toISOString(),
    status: depNodes.some(n => n.collection.status !== 'pass') ? 'partial' : 'complete',
  };
}
