/**
 * Agent identity: how the products of a suite name one agent profile. Magnus
 * owns the fleet key (`<nodeId>~<profile>`), knows which runtime serves the
 * profile and, for an Ardent profile it enrolled in HiveMem, the HiveMem actor
 * and workspace. Everything else stays null until Magnus records it.
 *
 * Nothing here reads a credential: the HiveMem record holds only identifiers.
 */
import type { z } from 'zod';
import { AGENT_REF_PART_PATTERN, agentActorIdSchema, type agentIdentitySchema } from '@hivemagnus/magnus-contracts/browser';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';

export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

export interface AgentIdentityAccess {
  /** Whether the caller may read Ardent profiles. Without it, an Ardent profile is unknown, as on the Ardent routes. */
  ardent: boolean;
}

/** `<nodeId>~<profile>`, each part `[A-Za-z0-9._-]{1,128}`. Anything else is a 400. */
export function parseAgentRef(ref: string): { nodeId: string; profile: string } {
  const parts = ref.split('~');
  const [nodeId, profile] = parts;
  if (parts.length !== 2 || !nodeId || !profile || !AGENT_REF_PART_PATTERN.test(nodeId) || !AGENT_REF_PART_PATTERN.test(profile))
    throw new HttpError(400, 'INVALID_AGENT_REF', 'agentRef must be <nodeId>~<profile>, each part [A-Za-z0-9._-]{1,128}');
  return { nodeId, profile };
}

export function parseActorId(value: string | undefined): string {
  const parsed = agentActorIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'actorId must match [a-z0-9_-]{2,32}');
  return parsed.data;
}

function identity(nodeId: string, profile: string, runtime: AgentIdentity['runtime'],
  hivemem: { agentId: string; workspaceId: string } | null): AgentIdentity {
  return {
    agentRef: `${nodeId}~${profile}`, nodeId, profile, runtime,
    actorId: hivemem?.agentId ?? null, workspaceId: hivemem?.workspaceId ?? null,
    // Magnus issues no per-agent Oathweave client or Emberpath key, so it has neither to report.
    oathweaveSubject: null, emberpathClientKeyId: null,
  };
}

async function ardentIdentity(nodeId: string, profile: string): Promise<AgentIdentity | null> {
  const db = getDb();
  const row = await db.ardentProfile.findFirst({ where: { name: profile, installation: { nodeId } }, select: { name: true } });
  if (!row) return null;
  const hivemem = await db.ardentHiveMemCredential.findUnique({
    where: { nodeId_profile: { nodeId, profile } }, select: { agentId: true, workspaceId: true },
  });
  return identity(nodeId, profile, 'ardent', hivemem);
}

async function hermesIdentity(nodeId: string, profile: string): Promise<AgentIdentity | null> {
  const rows = await getDb().hermesProfile.findMany({ where: { name: profile, installation: { nodeId } }, select: { id: true }, take: 2 });
  if (rows.length > 1) throw new HttpError(409, 'AGENT_REF_AMBIGUOUS', 'More than one Hermes installation on this node has that profile');
  return rows.length ? identity(nodeId, profile, 'hermes', null) : null;
}

/**
 * The identity of an agent profile, or null when Magnus does not know it. An
 * Ardent profile wins over a Hermes profile of the same name on the node,
 * because the reference is the one Ardent Studio writes.
 */
export async function resolveAgentIdentity(ref: string, access: AgentIdentityAccess): Promise<AgentIdentity | null> {
  const { nodeId, profile } = parseAgentRef(ref);
  return (access.ardent ? await ardentIdentity(nodeId, profile) : null) ?? await hermesIdentity(nodeId, profile);
}

/** The agent whose HiveMem actor this is, or null. Only Ardent profiles have one today. */
export async function findAgentIdentityByActorId(actorId: string, access: AgentIdentityAccess): Promise<AgentIdentity | null> {
  const id = parseActorId(actorId);
  if (!access.ardent) return null;
  const records = await getDb().ardentHiveMemCredential.findMany({
    where: { agentId: id }, select: { nodeId: true, profile: true }, orderBy: { createdAt: 'asc' }, take: 2,
  });
  const matches = (await Promise.all(records.map(record => ardentIdentity(record.nodeId, record.profile))))
    .filter((match): match is AgentIdentity => match !== null && match.actorId === id);
  if (matches.length > 1) throw new HttpError(409, 'AGENT_REF_AMBIGUOUS', 'More than one agent profile has that HiveMem actor');
  return matches[0] ?? null;
}
