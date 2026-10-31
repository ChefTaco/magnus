import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';
import { magnusObservationSchema } from '@hivemagnus/magnus-contracts';
import { getDb } from '../db/index.js';
import { getApplicationConfigs } from './operations-config.js';

export async function getOperationalObservations() {
  const db = getDb();
  const [nodes, count, applications] = await Promise.all([
    db.node.findMany({
      where: { id: { notIn: SENTINEL_NODE_IDS } },
      take: 10000,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        hostname: true,
        status: true,
        lastHeartbeatAt: true,
        agent: { select: { version: true } },
      },
    }),
    db.node.count({ where: { id: { notIn: SENTINEL_NODE_IDS } } }),
    db.applicationObservation.findMany({ take: 10000, orderBy: { id: 'asc' } }),
  ]);
  const configs = getApplicationConfigs();
  return magnusObservationSchema.parse({
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    complete: count <= 10000,
    nodes: nodes.map((n) => ({
      id: n.id,
      hostname: n.hostname,
      status: n.status,
      lastHeartbeatAt: n.lastHeartbeatAt?.toISOString() ?? null,
      agentVersion: n.agent?.version ?? null,
    })),
    deployments: configs.map((config) => {
      const current = applications.find((a) => a.id === config.id);
      let revision: unknown = null;
      try {
        revision = JSON.parse(current?.resultJson ?? '{}').releaseRevision;
      } catch {
        /* unknown */
      }
      const fresh = current?.observedAt && Date.now() - current.observedAt.getTime() < 180000;
      return {
        id: config.id,
        projectId: config.projectId,
        serviceId: config.serviceId,
        nodeId: config.nodeId,
        status: fresh ? current.status : 'unknown',
        observedAt: current?.observedAt?.toISOString() ?? null,
        releaseRevision: typeof revision === 'string' ? revision : null,
        dependsOn: config.dependsOn,
      };
    }),
  });
}

export async function getCapacityAdvice() {
  const nodes = await getDb().node.findMany({
    where: { id: { notIn: SENTINEL_NODE_IDS } },
    take: 1000,
    orderBy: { id: 'asc' },
    select: {
      id: true,
      hostname: true,
      gpuSnapshots: {
        take: 1,
        orderBy: { sampledAt: 'desc' },
        select: { sampledAt: true, devices: true },
      },
    },
  });
  return {
    advisoryOnly: true,
    generatedAt: new Date().toISOString(),
    nodes: nodes.map((node) => {
      const sample = node.gpuSnapshots[0];
      let devices: Array<{
        utilizationPercent?: number | null;
        temperatureCelsius?: number | null;
        fanPercent?: number | null;
      }> = [];
      try {
        const parsed = JSON.parse(sample?.devices ?? '[]');
        if (Array.isArray(parsed)) devices = parsed;
      } catch {
        /* unknown */
      }
      const fresh = sample && Date.now() - sample.sampledAt.getTime() < 120000;
      const known =
        fresh &&
        devices.length > 0 &&
        devices.every(
          (d) =>
            d &&
            typeof d === 'object' &&
            Number.isFinite(d.utilizationPercent) &&
            Number.isFinite(d.temperatureCelsius),
        );
      const pressure =
        known &&
        devices.some(
          (d) =>
            (d.utilizationPercent ?? 0) >= 90 ||
            (d.temperatureCelsius ?? 0) >= 85 ||
            (d.fanPercent ?? 0) >= 95,
        );
      return {
        nodeId: node.id,
        hostname: node.hostname,
        observedAt: sample?.sampledAt.toISOString() ?? null,
        capacity: !known ? 'unknown' : pressure ? 'constrained' : 'available',
        recommendation: !known
          ? 'Collect fresh supported GPU sensors before scheduling'
          : pressure
            ? 'Consider another endpoint or wait; workload owner decides'
            : 'No observed GPU pressure; workload owner must still check memory and model requirements',
      };
    }),
  };
}
