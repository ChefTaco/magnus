/** Database access for per-node credentials. Kept narrow so the rules in node-credential-service.ts can be tested without PostgreSQL. */
import { getDb, type Prisma } from '../db/index.js';

export type NodeCredentialStatus = 'ACTIVE' | 'RETIRING' | 'REVOKED';
export type NodeCredentialOrigin = 'ENROLLMENT_TOKEN' | 'LEGACY_UPGRADE' | 'ROTATION';

export interface CredentialNode { id: string; name: string; hostname: string; ipAddress: string; port: number; status: string }
export interface CredentialRow {
  id: string; nodeId: string; keyId: string; publicKey: string; status: NodeCredentialStatus; origin: NodeCredentialOrigin;
  boundFqdn: string; createdAt: Date; lastUsedAt: Date | null; retireAt: Date | null; revokedAt: Date | null; revokedBy: string | null;
}
export interface NewCredential { nodeId: string; keyId: string; publicKey: string; boundFqdn: string }
export type BindOutcome = 'bound' | 'same' | 'exists' | 'key-in-use';
export type TokenBindOutcome = 'bound' | 'same' | 'invalid' | 'expired' | 'used' | 'key-in-use';

const nodeSelect = { id: true, name: true, hostname: true, ipAddress: true, port: true, status: true } as const;
const row = (value: unknown): CredentialRow => value as CredentialRow;

async function lockNode(tx: Prisma.TransactionClient, nodeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`node-credential:${nodeId}`}, 0))`;
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

export const nodeCredentialStore = {
  async credentialByKeyId(keyId: string): Promise<{ credential: CredentialRow; node: CredentialNode } | null> {
    const found = await getDb().nodeCredential.findUnique({ where: { keyId }, include: { node: { select: nodeSelect } } });
    if (!found) return null;
    const { node, ...credential } = found;
    return { credential: row(credential), node };
  },

  async credentialsOfNode(nodeId: string): Promise<CredentialRow[]> {
    return (await getDb().nodeCredential.findMany({ where: { nodeId }, orderBy: { createdAt: 'desc' } })).map(row);
  },

  /** Which of these nodes have a credential row of any status (and so are closed to the shared secret). */
  async nodesWithCredentials(nodeIds: string[]): Promise<Set<string>> {
    if (nodeIds.length === 0) return new Set();
    const rows = await getDb().nodeCredential.findMany({ where: { nodeId: { in: nodeIds } }, select: { nodeId: true }, distinct: ['nodeId'] });
    return new Set(rows.map(entry => entry.nodeId));
  },

  /** Nodes a shared-secret caller would be speaking for when it names this id or FQDN. */
  async nodesClaimedBy(claims: { nodeId?: string; fqdn?: string }): Promise<CredentialNode[]> {
    const or: Prisma.NodeWhereInput[] = [];
    if (claims.nodeId) or.push({ id: claims.nodeId });
    if (claims.fqdn) or.push({ hostname: { equals: claims.fqdn, mode: 'insensitive' } }, { name: { equals: claims.fqdn, mode: 'insensitive' } },
      { credentials: { some: { boundFqdn: claims.fqdn.toLowerCase() } } });
    if (or.length === 0) return [];
    return getDb().node.findMany({ where: { OR: or }, select: nodeSelect, take: 20 });
  },

  async otherNodeHasHostname(nodeId: string, fqdn: string): Promise<boolean> {
    return (await getDb().node.count({ where: { id: { not: nodeId }, hostname: { equals: fqdn, mode: 'insensitive' } } })) > 0;
  },

  async nodeById(nodeId: string): Promise<CredentialNode | null> {
    return getDb().node.findUnique({ where: { id: nodeId }, select: nodeSelect });
  },

  /** Inventory nodes an agent reporting `fqdn` may be, with the same aliases the heartbeat uses. */
  async nodesForFqdn(aliases: string[], shortName: string): Promise<CredentialNode[]> {
    return getDb().node.findMany({ where: { status: { not: 'DECOMMISSIONED' },
      OR: [{ hostname: { in: aliases } }, { name: { in: aliases } }, { name: shortName }] }, select: nodeSelect, take: 5 });
  },

  async nodesByAddress(address: string): Promise<CredentialNode[]> {
    return getDb().node.findMany({ where: { status: { not: 'DECOMMISSIONED' }, ipAddress: address }, select: nodeSelect, take: 5 });
  },

  /** Bind a node's first key. Refused when the node already has any credential row (first writer wins). */
  async bindFirst(input: NewCredential, origin: NodeCredentialOrigin): Promise<BindOutcome> {
    try {
      return await getDb().$transaction(async tx => {
        await lockNode(tx, input.nodeId);
        const existing = await tx.nodeCredential.findMany({ where: { nodeId: input.nodeId } });
        if (existing.some(entry => entry.keyId === input.keyId && entry.status === 'ACTIVE')) return 'same';
        if (existing.length > 0) return 'exists';
        await tx.nodeCredential.create({ data: { ...input, origin, status: 'ACTIVE' } });
        return 'bound';
      });
    } catch (error) {
      if (uniqueViolation(error)) return 'key-in-use';
      throw error;
    }
  },

  async createEnrollmentToken(input: { nodeId: string; tokenSha256: string; expiresAt: Date; createdBy: string }): Promise<void> {
    await getDb().$transaction(async tx => {
      // One open token per node: issuing another withdraws the earlier ones.
      await tx.nodeEnrollmentToken.deleteMany({ where: { nodeId: input.nodeId, usedAt: null } });
      await tx.nodeEnrollmentToken.create({ data: input });
    });
  },

  /** Spend a one-time token and make its key the node's only valid one. */
  async bindWithToken(input: { tokenSha256: string; keyId: string; publicKey: string; boundFqdn: string; now: Date }):
    Promise<{ outcome: TokenBindOutcome; nodeId?: string; tokenId?: string }> {
    try {
      return await getDb().$transaction(async tx => {
        const token = await tx.nodeEnrollmentToken.findUnique({ where: { tokenSha256: input.tokenSha256 } });
        if (!token) return { outcome: 'invalid' as const };
        await lockNode(tx, token.nodeId);
        const current = await tx.nodeEnrollmentToken.findUnique({ where: { id: token.id } });
        if (!current) return { outcome: 'invalid' as const };
        if (current.usedAt) {
          const same = current.usedKeyId === input.keyId
            && await tx.nodeCredential.findFirst({ where: { keyId: input.keyId, nodeId: current.nodeId, status: 'ACTIVE' } });
          return { outcome: same ? 'same' as const : 'used' as const, nodeId: current.nodeId, tokenId: current.id };
        }
        if (current.expiresAt.getTime() <= input.now.getTime()) return { outcome: 'expired' as const, nodeId: current.nodeId, tokenId: current.id };
        const spent = await tx.nodeEnrollmentToken.updateMany({ where: { id: current.id, usedAt: null }, data: { usedAt: input.now, usedKeyId: input.keyId } });
        if (spent.count !== 1) return { outcome: 'used' as const, nodeId: current.nodeId, tokenId: current.id };
        await tx.nodeCredential.updateMany({ where: { nodeId: current.nodeId, status: { in: ['ACTIVE', 'RETIRING'] } },
          data: { status: 'REVOKED', revokedAt: input.now, revokedBy: `enrollment-token:${current.id}` } });
        await tx.nodeCredential.create({ data: { nodeId: current.nodeId, keyId: input.keyId, publicKey: input.publicKey,
          boundFqdn: input.boundFqdn, origin: 'ENROLLMENT_TOKEN', status: 'ACTIVE' } });
        return { outcome: 'bound' as const, nodeId: current.nodeId, tokenId: current.id };
      });
    } catch (error) {
      if (uniqueViolation(error)) return { outcome: 'key-in-use' };
      throw error;
    }
  },

  /** Replace the node's ACTIVE key; the old one stays valid until `retireAt`. */
  async rotate(input: NewCredential & { currentKeyId: string; retireAt: Date }): Promise<'rotated' | 'same' | 'stale' | 'key-in-use'> {
    try {
      return await getDb().$transaction(async tx => {
        await lockNode(tx, input.nodeId);
        const active = await tx.nodeCredential.findFirst({ where: { nodeId: input.nodeId, status: 'ACTIVE' } });
        if (active?.keyId === input.keyId) return 'same';
        if (!active || active.keyId !== input.currentKeyId) return 'stale';
        await tx.nodeCredential.update({ where: { id: active.id }, data: { status: 'RETIRING', retireAt: input.retireAt } });
        await tx.nodeCredential.create({ data: { nodeId: input.nodeId, keyId: input.keyId, publicKey: input.publicKey,
          boundFqdn: input.boundFqdn, origin: 'ROTATION', status: 'ACTIVE' } });
        return 'rotated';
      });
    } catch (error) {
      if (uniqueViolation(error)) return 'key-in-use';
      throw error;
    }
  },

  async revoke(nodeId: string, keyId: string | null, revokedBy: string, now: Date): Promise<number> {
    return (await getDb().nodeCredential.updateMany({ where: { nodeId, ...(keyId ? { keyId } : {}), status: { in: ['ACTIVE', 'RETIRING'] } },
      data: { status: 'REVOKED', revokedAt: now, revokedBy } })).count;
  },

  /** Remove every credential row and open token: the node is a shared-secret node again. */
  async reset(nodeId: string): Promise<number> {
    return getDb().$transaction(async tx => {
      await lockNode(tx, nodeId);
      await tx.nodeEnrollmentToken.deleteMany({ where: { nodeId } });
      return (await tx.nodeCredential.deleteMany({ where: { nodeId } })).count;
    });
  },

  async touch(keyId: string, at: Date): Promise<void> {
    await getDb().nodeCredential.updateMany({ where: { keyId }, data: { lastUsedAt: at } });
  },

  /** When this installation first ran with node credentials; recorded on the first call. */
  async legacyUpgradeStartedAt(): Promise<Date> {
    const db = getDb();
    const state = await db.nodeAuthState.upsert({ where: { id: 'node-auth' }, update: {}, create: { id: 'node-auth' } });
    return state.legacyUpgradeStartedAt;
  },

  /** Credential summary per node for read models. */
  async summaries(nodeIds: string[]): Promise<Map<string, CredentialRow[]>> {
    const result = new Map<string, CredentialRow[]>();
    if (nodeIds.length === 0) return result;
    for (const entry of await getDb().nodeCredential.findMany({ where: { nodeId: { in: nodeIds } }, orderBy: { createdAt: 'desc' } }))
      result.set(entry.nodeId, [...(result.get(entry.nodeId) ?? []), row(entry)]);
    return result;
  },
};
