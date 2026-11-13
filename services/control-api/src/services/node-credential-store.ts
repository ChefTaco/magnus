/** Database access for per-node credentials. Kept narrow so the rules in node-credential-service.ts can be tested without PostgreSQL. */
import { getDb, type Prisma } from '../db/index.js';

export type NodeCredentialStatus = 'ACTIVE' | 'RETIRING' | 'REVOKED';
export type NodeCredentialOrigin = 'ENROLLMENT_TOKEN' | 'LEGACY_UPGRADE' | 'ROTATION';

export interface CredentialNode { id: string; name: string; hostname: string; ipAddress: string; port: number; status: string }
export interface CredentialRow {
  id: string; nodeId: string; keyId: string; publicKey: string; status: NodeCredentialStatus; origin: NodeCredentialOrigin;
  boundFqdn: string; createdAt: Date; lastUsedAt: Date | null; retireAt: Date | null; revokedAt: Date | null; revokedBy: string | null;
  /** The agent holding this key signs its evidence with it, as its last signed heartbeat said. */
  evidenceSigning: boolean; evidenceSigningAt: Date | null;
}
export type PendingBindingStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export interface PendingBindingRow {
  id: string; nodeId: string; keyId: string; publicKey: string; fqdn: string; peerAddress: string; recordedAddress: string;
  status: PendingBindingStatus; attempts: number; createdAt: Date; lastSeenAt: Date; decidedAt: Date | null; decidedBy: string | null;
  decisionReason: string | null;
}
export type LegacyChannel = 'request' | 'evidence' | 'outbound';
export interface LegacyUseRow { nodeId: string; channel: LegacyChannel; count: number; firstUsedAt: Date; lastUsedAt: Date; lastDetail: string | null }
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

  /** Record what the agent holding this key said in a signed heartbeat about signing its evidence. */
  async setEvidenceSigning(keyId: string, value: boolean, at: Date): Promise<void> {
    await getDb().nodeCredential.updateMany({ where: { keyId, evidenceSigning: !value },
      data: { evidenceSigning: value, evidenceSigningAt: value ? at : null } });
  },

  /** Remember a refused automatic binding for an administrator; repeated attempts update one row. */
  async recordPendingBinding(input: { nodeId: string; keyId: string; publicKey: string; fqdn: string; peerAddress: string; recordedAddress: string; now: Date }):
    Promise<{ row: PendingBindingRow; created: boolean }> {
    const db = getDb();
    const existing = await db.nodePendingBinding.findUnique({ where: { nodeId_keyId: { nodeId: input.nodeId, keyId: input.keyId } } });
    if (existing) {
      const row = await db.nodePendingBinding.update({ where: { id: existing.id }, data: { attempts: { increment: 1 }, lastSeenAt: input.now,
        ...(existing.status === 'PENDING' ? { peerAddress: input.peerAddress, recordedAddress: input.recordedAddress, fqdn: input.fqdn } : {}) } });
      return { row: row as PendingBindingRow, created: false };
    }
    try {
      const row = await db.nodePendingBinding.create({ data: { nodeId: input.nodeId, keyId: input.keyId, publicKey: input.publicKey, fqdn: input.fqdn,
        peerAddress: input.peerAddress, recordedAddress: input.recordedAddress, createdAt: input.now, lastSeenAt: input.now } });
      // Bounded: at most 10 open requests per node; the oldest go first.
      const open = await db.nodePendingBinding.findMany({ where: { nodeId: input.nodeId, status: 'PENDING' }, orderBy: { lastSeenAt: 'desc' }, skip: 10, select: { id: true } });
      if (open.length > 0) await db.nodePendingBinding.deleteMany({ where: { id: { in: open.map(entry => entry.id) } } });
      return { row: row as PendingBindingRow, created: true };
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
      const row = await db.nodePendingBinding.findUniqueOrThrow({ where: { nodeId_keyId: { nodeId: input.nodeId, keyId: input.keyId } } });
      return { row: row as PendingBindingRow, created: false };
    }
  },

  async pendingBindings(filter: { status?: PendingBindingStatus; nodeId?: string } = {}): Promise<PendingBindingRow[]> {
    return (await getDb().nodePendingBinding.findMany({ where: { ...(filter.status ? { status: filter.status } : {}), ...(filter.nodeId ? { nodeId: filter.nodeId } : {}) },
      orderBy: { lastSeenAt: 'desc' }, take: 200 })) as PendingBindingRow[];
  },

  async pendingBinding(id: string): Promise<PendingBindingRow | null> {
    return (await getDb().nodePendingBinding.findUnique({ where: { id } })) as PendingBindingRow | null;
  },

  /**
   * Approve: bind the pending key as the node's first credential, in one transaction with the
   * decision. Refused when the node has a credential by now (first writer wins, as for the agent).
   */
  async approvePendingBinding(id: string, actorId: string, now: Date): Promise<{ outcome: 'bound' | 'exists' | 'key-in-use' | 'not-pending'; row: PendingBindingRow | null }> {
    try {
      return await getDb().$transaction(async tx => {
        const pending = await tx.nodePendingBinding.findUnique({ where: { id } });
        if (!pending) return { outcome: 'not-pending' as const, row: null };
        await lockNode(tx, pending.nodeId);
        const current = await tx.nodePendingBinding.findUnique({ where: { id } });
        if (!current || current.status !== 'PENDING') return { outcome: 'not-pending' as const, row: current as PendingBindingRow | null };
        if (await tx.nodeCredential.count({ where: { nodeId: current.nodeId } }) > 0) return { outcome: 'exists' as const, row: current as PendingBindingRow };
        await tx.nodeCredential.create({ data: { nodeId: current.nodeId, keyId: current.keyId, publicKey: current.publicKey,
          boundFqdn: current.fqdn, origin: 'LEGACY_UPGRADE', status: 'ACTIVE' } });
        const row = await tx.nodePendingBinding.update({ where: { id }, data: { status: 'APPROVED', decidedAt: now, decidedBy: actorId } });
        // Any other open request for the node is moot now.
        await tx.nodePendingBinding.updateMany({ where: { nodeId: current.nodeId, status: 'PENDING', id: { not: id } },
          data: { status: 'REJECTED', decidedAt: now, decidedBy: actorId, decisionReason: 'another key was approved' } });
        return { outcome: 'bound' as const, row: row as PendingBindingRow };
      });
    } catch (error) {
      if (uniqueViolation(error)) return { outcome: 'key-in-use', row: null };
      throw error;
    }
  },

  async rejectPendingBinding(id: string, actorId: string, reason: string | null, now: Date): Promise<PendingBindingRow | null> {
    const changed = await getDb().nodePendingBinding.updateMany({ where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', decidedAt: now, decidedBy: actorId, decisionReason: reason } });
    if (changed.count !== 1) return null;
    return (await getDb().nodePendingBinding.findUnique({ where: { id } })) as PendingBindingRow | null;
  },

  /** Add counted uses of a shared credential; one upsert per node and channel. */
  async addLegacyUse(entries: Array<{ nodeId: string; channel: LegacyChannel; count: number; first: Date; last: Date; detail: string | null }>): Promise<void> {
    const db = getDb();
    const known = new Set((await db.node.findMany({ where: { id: { in: [...new Set(entries.map(entry => entry.nodeId))] } }, select: { id: true } })).map(node => node.id));
    for (const entry of entries) {
      if (!known.has(entry.nodeId)) continue;
      await db.nodeLegacyCredentialUse.upsert({ where: { nodeId_channel: { nodeId: entry.nodeId, channel: entry.channel } },
        create: { nodeId: entry.nodeId, channel: entry.channel, count: entry.count, firstUsedAt: entry.first, lastUsedAt: entry.last, lastDetail: entry.detail },
        update: { count: { increment: entry.count }, lastUsedAt: entry.last, lastDetail: entry.detail } });
    }
  },

  async legacyUse(nodeIds?: string[]): Promise<LegacyUseRow[]> {
    return (await getDb().nodeLegacyCredentialUse.findMany({ where: nodeIds ? { nodeId: { in: nodeIds } } : {}, orderBy: { lastUsedAt: 'desc' } })) as LegacyUseRow[];
  },

  /** Inventory nodes that are not decommissioned, with their credential rows, for the fleet summary. */
  async fleet(): Promise<Array<CredentialNode & { credentials: CredentialRow[] }>> {
    const nodes = await getDb().node.findMany({ where: { status: { not: 'DECOMMISSIONED' } }, select: { ...nodeSelect, credentials: true } });
    return nodes.map(node => ({ ...node, credentials: node.credentials.map(row) }));
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
