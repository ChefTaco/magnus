import { optional } from '../utils/optional.js';
import { ARDENT_RUNTIME_CONTRACTS_VERSION, ARDENT_RUNTIME_GATES, ARDENT_STUDIO_CAPABILITY, ARDENT_UNSUPPORTED_CAPABILITY, ardentProfileCapabilities,
  type ArdentProfileCapabilities, type ArdentRuntimeGate, ArdentNodeStateSchema, ArdentContextReleaseSchema, ArdentContextAdoptionInputSchema, ArdentSkillReceiptsSchema, type ArdentFleetInstallation, type ArdentSkillReceipts } from '@hivemagnus/magnus-contracts';
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

/** `headers` is request attribution only (x-request-id, traceparent, x-hive-execution), passed to the profile. */
export async function getArdentProfileResource(nodeId: string, profile: string, resource: string, query?: Record<string, string>,
  headers?: Record<string, string>): Promise<unknown> {
  return clientFor(await nodeTarget(nodeId)).getArdentProfileResource<unknown>(profile, resource, query, headers);
}

/** An unbuffered task event stream or artifact byte stream (v1 octets or v2 ranged content), straight from the node agent. */
export async function streamArdentProfileResource(nodeId: string, profile: string, resource: string,
  options: { after?: string; lastEventId?: string; signal?: AbortSignal; range?: string; ifRange?: string; headers?: Record<string, string> } = {}): Promise<Response> {
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
  if (reported < level) throw new HttpError(409, 'AGENT_UPGRADE_REQUIRED', level >= ARDENT_STUDIO_CAPABILITY.runtimeContracts
    ? `Upgrade the Magnus agent on ${node.name} to use Ardent recovery, lineage, execution context and artifact transfer v2`
    : level >= ARDENT_STUDIO_CAPABILITY.skillInstall
    ? `Upgrade the Magnus agent on ${node.name} to install HiveSkills catalog skills on Ardent`
    : level > ARDENT_STUDIO_CAPABILITY.bridge
      ? `Upgrade the Magnus agent on ${node.name} to use Ardent missions, previews, pause and development history`
      : `Upgrade the Magnus agent on ${node.name} to use Ardent sessions and streams`);
  studioCapability.set(nodeId, { level: reported, at: Date.now() });
}

/** Whether the node agent reports at least `level`, without refusing; false when it cannot be asked. */
export async function ardentStudioAgentAt(nodeId: string, level: number): Promise<boolean> {
  try { await requireArdentStudioAgent(nodeId, level); return true; }
  catch { return false; } // no-reason-needed: an agent that cannot be asked offers nothing optional
}

const profileRuntime = new Map<string, { version: string | null; capabilities: ArdentProfileCapabilities; at: number }>();
/** A profile that offers a capability is remembered for a minute, one that lacks it for 10 seconds, so an upgrade shows soon. */
const PROFILE_RUNTIME_TTL_MS = { offered: 60_000, lacking: 10_000 };

/**
 * A profile's Ardent version and capabilities (ardentProfileCapabilities) from its GET /status through the node
 * agent. Throws when the profile cannot be read.
 */
export async function ardentProfileRuntime(nodeId: string, profile: string, gate?: ArdentRuntimeGate): Promise<{ version: string | null; capabilities: ArdentProfileCapabilities }> {
  const key = `${nodeId}:${profile}`;
  const seen = profileRuntime.get(key);
  if (seen) {
    const offered = gate === undefined || seen.capabilities[gate] >= ARDENT_RUNTIME_GATES[gate].level;
    if (Date.now() - seen.at < (offered ? PROFILE_RUNTIME_TTL_MS.offered : PROFILE_RUNTIME_TTL_MS.lacking)) return seen;
  }
  const status = await getArdentProfileResource(nodeId, profile, 'status');
  const runtime = ardentProfileCapabilities(status, null);
  profileRuntime.set(key, { ...runtime, at: Date.now() });
  return runtime;
}

/**
 * Refuse a route or action the profile lacks: 409 AGENT_UPGRADE_REQUIRED below node agent studio level 4, and
 * 409 unsupported_capability, with the capability and the required and installed Ardent versions in error.details,
 * on a profile older than Ardent 3.2.0. The operations it already had keep working.
 */
export async function requireArdentProfileCapability(nodeId: string, profile: string, gate: ArdentRuntimeGate): Promise<void> {
  await requireArdentStudioAgent(nodeId, ARDENT_STUDIO_CAPABILITY.runtimeContracts);
  let runtime: Awaited<ReturnType<typeof ardentProfileRuntime>>;
  try { runtime = await ardentProfileRuntime(nodeId, profile, gate); }
  catch (error: unknown) {
    if (error instanceof Error && error.message === 'Managed node not found') throw new HttpError(404, 'NOT_FOUND', 'Managed node not found');
    throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', `The Ardent profile's status could not be read: ${error instanceof Error ? error.message.slice(0, 200) : 'unavailable'}`);
  }
  const { level, capability } = ARDENT_RUNTIME_GATES[gate];
  if (runtime.capabilities[gate] >= level) return;
  throw new HttpError(409, ARDENT_UNSUPPORTED_CAPABILITY,
    `Ardent profile ${profile} runs ${runtime.version ?? 'an unknown version'}; ${capability} needs Ardent ${ARDENT_RUNTIME_CONTRACTS_VERSION} or later`,
    { capability, required_version: ARDENT_RUNTIME_CONTRACTS_VERSION, installed_version: runtime.version });
}

/** Whether an execution context and trace may travel with an action: a studio 4 agent and a profile with lineage. Never throws. */
export async function ardentAcceptsExecution(nodeId: string, profile: string): Promise<boolean> {
  if (!await ardentStudioAgentAt(nodeId, ARDENT_STUDIO_CAPABILITY.runtimeContracts)) return false;
  try { return (await ardentProfileRuntime(nodeId, profile, 'lineage')).capabilities.lineage >= ARDENT_RUNTIME_GATES.lineage.level; }
  catch { return false; } // no-reason-needed: a profile whose status cannot be read gets the action without attribution
}

/** Drop cached agent capabilities so a test can reconfigure a node. */
export function resetArdentStudioCapabilities(): void {
  studioCapability.clear();
  profileRuntime.clear();
}

export async function performArdentAction(nodeId: string, profile: string, action: string, target?: string, body?: unknown,
  extras?: { execution?: unknown; trace?: { request_id?: string; traceparent?: string } }): Promise<unknown> {
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
  return clientFor(await nodeTarget(nodeId)).performArdentAction<unknown>(profile, action, target, body, extras);
}

export async function getArdentContextRelease(nodeId: string, profile: string): Promise<unknown> {
  return ArdentContextReleaseSchema.parse(await clientFor(await nodeTarget(nodeId)).getArdentContextRelease(profile));
}

export async function getArdentContextAdoption(nodeId: string, profile: string, releaseId: string): Promise<unknown> {
  return clientFor(await nodeTarget(nodeId)).getArdentContextAdoption(profile, releaseId);
}

/** A profile's HiveSkills receipts from its node agent. Throws an HTTPError 404 from agents that predate the route. */
export async function getArdentSkillReceipts(nodeId: string, profile: string): Promise<ArdentSkillReceipts> {
  return ArdentSkillReceiptsSchema.parse(await clientFor(await nodeTarget(nodeId)).getArdentSkillReceipts(profile));
}
