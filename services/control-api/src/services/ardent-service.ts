import { ArdentNodeStateSchema, type ArdentFleetInstallation } from '@hivemagnus/magnus-contracts';
import { getDb } from '../db/index.js';
import { NodeApiClient } from '../sdk/index.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';

type NodeTarget = { id: string; name: string; hostname: string; ipAddress: string; port: number };

function clientFor(node: NodeTarget): NodeApiClient {
  return new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), resourceNodeId: node.id,
    resourceScope: 'ardent-managed-http', nodeToken: getNodeManagerSecret() });
}

async function nodeTarget(id: string): Promise<NodeTarget> {
  const node = await getDb().node.findFirst({ where: { id, status: { not: 'DECOMMISSIONED' } },
    select: { id: true, name: true, hostname: true, ipAddress: true, port: true } });
  if (!node || SENTINEL_NODE_IDS.includes(node.id)) throw new Error('Managed node not found');
  return node;
}

async function persistObservation(nodeId: string, state: ArdentFleetInstallation): Promise<void> {
  const observedAt = state.reachable ? new Date(state.checkedAt) : undefined;
  await getDb().$transaction(async tx => {
    const installation = await tx.ardentInstallation.upsert({ where: { nodeId },
      create: { nodeId, owner: state.reachable ? state.owner : null, version: state.version,
        installed: state.installed, reachable: state.reachable, error: state.error,
        ...(observedAt ? { observedAt } : {}) },
      update: { reachable: state.reachable, error: state.error, checkedAt: new Date(),
        ...(state.reachable ? { owner: state.owner, version: state.version, installed: state.installed, observedAt } : {}) } });
    if (!state.reachable) return;
    const names = state.profiles.map(profile => profile.id);
    await tx.ardentProfile.deleteMany({ where: { installationId: installation.id, ...(names.length ? { name: { notIn: names } } : {}) } });
    for (const profile of state.profiles) {
      const channels: Record<string, boolean> = profile.channels;
      const summary = { displayName: profile.name, backend: profile.backend, apiPort: profile.apiPort,
        running: profile.running, a2aEnabled: profile.a2aEnabled,
        telegramEnabled: channels['telegram'] === true,
        error: profile.error, observedAt: observedAt ?? new Date() };
      await tx.ardentProfile.upsert({ where: { installationId_name: { installationId: installation.id, name: profile.id } },
        create: { installationId: installation.id, name: profile.id, ...summary }, update: summary });
    }
  });
}

async function inspect(node: NodeTarget, timeoutMs = 15_000): Promise<ArdentFleetInstallation> {
  let state: ArdentFleetInstallation;
  try {
    const response = await clientFor(node).getArdentState(timeoutMs);
    if (!response.success) throw new Error('Node did not return Ardent inventory');
    const parsed = ArdentNodeStateSchema.parse(response.data);
    state = { ...parsed, nodeId: node.id, nodeName: node.name, hostname: node.hostname, reachable: true, error: null };
  } catch (error: unknown) {
    state = { nodeId: node.id, nodeName: node.name, hostname: node.hostname, reachable: false,
      installed: false, version: null, owner: '', profiles: [], checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message.slice(0, 300) : 'Node inventory unavailable' };
  }
  try { await persistObservation(node.id, state); }
  catch { return { ...state, error: 'Ardent inventory observed, but its central reference could not be stored' }; }
  return state;
}

export async function listArdentInstallations(): Promise<ArdentFleetInstallation[]> {
  const db = getDb();
  const nodes = await db.node.findMany({ where: { id: { notIn: SENTINEL_NODE_IDS }, status: { not: 'DECOMMISSIONED' } },
    orderBy: { name: 'asc' }, select: { id: true, name: true, hostname: true, ipAddress: true, port: true } });
  const known = await db.ardentInstallation.findMany({ where: { nodeId: { in: nodes.map(node => node.id) }, installed: true }, select: { nodeId: true } });
  const installed = new Set(known.map(row => row.nodeId));
  // Probe the bounded inventory concurrently. Uninstalled/offline candidates
  // must not hold the entire management page beyond the dashboard proxy limit.
  return Promise.all(nodes.map(node => inspect(node, installed.has(node.id) ? 5_000 : 1_500)));
}

export async function getArdentInstallation(id: string): Promise<ArdentFleetInstallation> {
  return inspect(await nodeTarget(id));
}

export async function getArdentProfileResource(nodeId: string, profile: string, resource: string, query?: Record<string, string>): Promise<unknown> {
  return clientFor(await nodeTarget(nodeId)).getArdentProfileResource<unknown>(profile, resource, query);
}

export async function getArdentArtifact(nodeId: string, profile: string, artifactId: string): Promise<Uint8Array> {
  return clientFor(await nodeTarget(nodeId)).getArdentArtifact(profile, artifactId);
}

export async function performArdentAction(nodeId: string, profile: string, action: string, target?: string, body?: unknown): Promise<unknown> {
  return clientFor(await nodeTarget(nodeId)).performArdentAction<unknown>(profile, action, target, body);
}
