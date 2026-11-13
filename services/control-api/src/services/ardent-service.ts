import { optional } from '../utils/optional.js';
import { ARDENT_STUDIO_CAPABILITY, ArdentNodeStateSchema, ArdentContextReleaseSchema, ArdentContextAdoptionInputSchema, type ArdentFleetInstallation } from '@hivemagnus/magnus-contracts';
import { getDb } from '../db/index.js';
import { NodeApiClient } from '../sdk/index.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { getNodeManagerSecret } from '../utils/env.js';
import { SENTINEL_NODE_IDS } from '../utils/sentinel-nodes.js';
import { HttpError } from '../middleware/error-handler.js';
import { ardentCommandOwners, commandReconciliationKey } from './ardent-command-owner.js';
import { serverCanSignDecisions } from './server-authorization.js';
import { ardentHiveMemCredentialStatuses } from './ardent-hivemem-renewal.js';

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
        ...(state.reachable ? { owner: state.owner, version: state.version, installed: state.installed, ...optional("observedAt", observedAt) } : {}) } });
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
  return withCommandOwners(await Promise.all(nodes.map(node => inspect(node, installed.has(node.id) ? 5_000 : 1_500))));
}

export async function getArdentInstallation(id: string): Promise<ArdentFleetInstallation> {
  return (await withCommandOwners([await inspect(await nodeTarget(id))]))[0]!;
}

/**
 * Each installation with the command owners that hold its node, so a blocked node says why, and each
 * profile with the HiveMem credential Magnus keeps renewed for it (null when there is none).
 */
async function withCommandOwners(installations: ArdentFleetInstallation[]): Promise<ArdentFleetInstallation[]> {
  const nodeIds = installations.map(item => item.nodeId);
  const owners = await ardentCommandOwners(nodeIds);
  const credentials = await ardentHiveMemCredentialStatuses(nodeIds);
  // Agents with a node key verify decisions signed with the server key; older ones need COMMAND_RECONCILIATION_SECRET.
  const commandReconciliation = { configured: commandReconciliationKey() !== null || serverCanSignDecisions() };
  return installations.map(item => ({ ...item, commandOwners: owners.get(item.nodeId) ?? [], commandReconciliation,
    profiles: item.profiles.map(profile => ({ ...profile, hivemem: credentials.get(`${item.nodeId}:${profile.id}`) ?? null })) }));
}

export async function getArdentProfileResource(nodeId: string, profile: string, resource: string, query?: Record<string, string>): Promise<unknown> {
  return clientFor(await nodeTarget(nodeId)).getArdentProfileResource<unknown>(profile, resource, query);
}

/** An unbuffered task event stream or artifact byte stream, straight from the node agent. */
export async function streamArdentProfileResource(nodeId: string, profile: string, resource: string,
  options: { after?: string; lastEventId?: string; signal?: AbortSignal } = {}): Promise<Response> {
  return clientFor(await nodeTarget(nodeId)).streamArdentProfileResource(profile, resource, options);
}

const studioCapability = new Map<string, { level: number; at: number }>();
const STUDIO_CAPABILITY_TTL_MS = 60_000;

/**
 * Refuse Studio bridge work on an agent below `level` (see ARDENT_STUDIO_CAPABILITY:
 * 1 sessions and streams, 2 missions, pause, previews and development). A
 * sufficient answer is cached briefly; an insufficient one is not, so an upgraded
 * agent is seen at once.
 */
export async function requireArdentStudioAgent(nodeId: string, level: number = ARDENT_STUDIO_CAPABILITY.bridge): Promise<void> {
  const seen = studioCapability.get(nodeId);
  if (seen !== undefined && seen.level >= level && Date.now() - seen.at < STUDIO_CAPABILITY_TTL_MS) return;
  const node = await nodeTarget(nodeId);
  let reported = 0;
  try { reported = await clientFor(node).ardentStudioLevel(); }
  catch (error: unknown) {
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 300) : 'Node agent unavailable');
  }
  if (reported < level) throw new HttpError(409, 'AGENT_UPGRADE_REQUIRED', level >= ARDENT_STUDIO_CAPABILITY.skillInstall
    ? `Upgrade the Magnus agent on ${node.name} to install HiveSkills catalog skills on Ardent`
    : level > ARDENT_STUDIO_CAPABILITY.bridge
      ? `Upgrade the Magnus agent on ${node.name} to use Ardent missions, previews, pause and development history`
      : `Upgrade the Magnus agent on ${node.name} to use Ardent sessions and streams`);
  studioCapability.set(nodeId, { level: reported, at: Date.now() });
}

/** Drop cached agent capabilities so a test can reconfigure a node. */
export function resetArdentStudioCapabilities(): void {
  studioCapability.clear();
}

export async function performArdentAction(nodeId: string, profile: string, action: string, target?: string, body?: unknown): Promise<unknown> {
  if (['context-stage', 'context-adopt', 'context-rollback'].includes(action)) {
    if (target !== undefined) throw new Error('Context adoption does not accept an arbitrary target');
    const input = ArdentContextAdoptionInputSchema.parse(body);
    const node = await nodeTarget(nodeId);
    const enrollment = await getDb().resourceEnrollment.findUnique({ where: { nodeId } });
    const client = enrollment?.state === 'enrolled'
      ? new NodeApiClient({ baseUrl: getNodeBaseUrl(node.ipAddress, node.port), resourceNodeId: node.id,
        resourceActorId: 'system:ardent-context-adoption', nodeToken: getNodeManagerSecret() }) : clientFor(node);
    return client.performArdentContextAction(profile, action, input);
  }
  return clientFor(await nodeTarget(nodeId)).performArdentAction<unknown>(profile, action, target, body);
}

export async function getArdentContextRelease(nodeId: string, profile: string): Promise<unknown> {
  return ArdentContextReleaseSchema.parse(await clientFor(await nodeTarget(nodeId)).getArdentContextRelease(profile));
}

export async function getArdentContextAdoption(nodeId: string, profile: string, releaseId: string): Promise<unknown> {
  return clientFor(await nodeTarget(nodeId)).getArdentContextAdoption(profile, releaseId);
}
