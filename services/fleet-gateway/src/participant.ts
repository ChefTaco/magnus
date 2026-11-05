/**
 * The gateway's side of resource enrollment. Durable ownership lives in the Magnus API's PostgreSQL
 * database, so a crash here leaves a visible reservation. It keeps the participant name `dashboard`
 * on the wire: the receipts, HMAC domain and stored rows are the same contract that component used.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const DOMAIN = 'magnus.resource-enrollment.v1\n';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const KIND = 'terminal-http';
const MAX_DEADLINE_MS = 59 * 60_000;

export function canonicalDrainJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDrainJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalDrainJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Resource coordination resolved this host to a different node than the one requested. */
export class TargetMismatch extends Error {}

export type ParticipantRequest = (path: string, body: unknown) => Promise<Record<string, unknown>>;
export type WorkDisposition = 'not-started' | 'remote-ended' | 'unknown';
export interface ManagedWork { workId: string; nodeId: string; finish(disposition?: WorkDisposition): Promise<unknown> }

export function createResourceParticipant(secret: string, request: ParticipantRequest, ownerId: string = randomUUID()) {
  if (!UUID.test(ownerId)) throw new Error('Invalid gateway process incarnation');
  return {
    /** Reserve and start durable work. No SSH side effect may occur until this resolves. */
    async begin(host: string, expectedNodeId: string, lifetimeMs: number): Promise<ManagedWork> {
      const workId = randomUUID();
      // The API allows at most an hour ahead of its own clock; leave room for clock skew.
      const deadline = Date.now() + Math.min(lifetimeMs, MAX_DEADLINE_MS);
      // Labels the effect as external, so a closed transport can never count as proof its descendants ended.
      const operationSha256 = createHash('sha256').update(canonicalDrainJson({
        domain: 'magnus.dashboard-external-session.v1', host: host.toLowerCase(), workId, ownerId, kind: KIND,
        effectBoundary: 'external-unverified',
      })).digest('hex');
      const record = await request('/work/reserve', { host, workId, ownerId, kind: KIND, operationSha256, deadline });
      if (typeof record['nodeId'] !== 'string' || !record['nodeId'] || typeof record['nodeFqdn'] !== 'string' || !record['nodeFqdn']
        || record['workId'] !== workId || record['participant'] !== 'dashboard' || record['ownerId'] !== ownerId || record['kind'] !== KIND
        || record['state'] !== 'reserved' || !Number.isSafeInteger(record['epoch']) || (record['epoch'] as number) < 0
        || !(record['barrierId'] === null || (typeof record['barrierId'] === 'string' && UUID.test(record['barrierId'])))
        || typeof record['requestSha256'] !== 'string' || !SHA.test(record['requestSha256'])
        || record['operationSha256'] !== operationSha256 || typeof record['fence'] !== 'string' || !/^[1-9][0-9]{0,19}$/.test(record['fence'])
        || record['deadline'] !== deadline) throw new Error('Invalid managed SSH reservation');
      // The name resolved to another node, so nothing has started: release it and refuse.
      if (record['nodeId'] !== expectedNodeId) {
        const evidenceSha256 = createHash('sha256').update(canonicalDrainJson({ workId, ownerId, disposition: 'not-started', proof: 'target-mismatch' })).digest('hex');
        await request(`/work/${workId}/finish`, { ownerId, disposition: 'not-started', evidenceSha256 }).catch(() => undefined);
        throw new TargetMismatch();
      }
      const admitted = await request(`/work/${workId}/start`, {
        ownerId, epoch: record['epoch'], barrierId: record['barrierId'], operationSha256, fence: record['fence'], deadline, requestSha256: record['requestSha256'],
      });
      if (admitted['workId'] !== workId || admitted['participant'] !== 'dashboard' || admitted['ownerId'] !== ownerId || admitted['kind'] !== KIND
        || admitted['nodeId'] !== record['nodeId'] || admitted['nodeFqdn'] !== record['nodeFqdn'] || admitted['epoch'] !== record['epoch']
        || admitted['barrierId'] !== record['barrierId'] || admitted['operationSha256'] !== operationSha256 || admitted['fence'] !== record['fence']
        || admitted['deadline'] !== deadline || admitted['requestSha256'] !== record['requestSha256'] || admitted['state'] !== 'running') {
        throw new Error('Managed SSH start was not acknowledged');
      }
      let settlement: Promise<unknown> | undefined;
      return {
        workId,
        nodeId: record['nodeId'],
        finish(disposition = 'unknown') {
          const evidenceSha256 = createHash('sha256').update(canonicalDrainJson({ workId, ownerId, disposition, proof: 'transport-observation-only' })).digest('hex');
          // One immutable settlement per handle. An ambiguous failure stays durable remotely.
          settlement ??= request(`/work/${workId}/finish`, { ownerId, disposition, evidenceSha256 });
          return settlement;
        },
      };
    },

    /** Answer a drain challenge from the API's own durable counts, never from local memory. */
    async drain(descriptor: unknown, suppliedKey: string): Promise<Record<string, unknown>> {
      const supplied = Buffer.from(suppliedKey);
      const expected = Buffer.from(secret);
      if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) throw new Error('Invalid drain authentication');
      const value = descriptor as Record<string, unknown> | null;
      const keys = ['version', 'participant', 'nodeId', 'nodeFqdn', 'epoch', 'barrierId', 'challengeId', 'expiresAt'].sort();
      if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== keys.join() || value['version'] !== 1
        || value['participant'] !== 'dashboard' || typeof value['nodeId'] !== 'string' || !value['nodeId']
        || typeof value['nodeFqdn'] !== 'string' || !value['nodeFqdn'] || !Number.isSafeInteger(value['epoch'])
        || typeof value['barrierId'] !== 'string' || !UUID.test(value['barrierId'])
        || typeof value['challengeId'] !== 'string' || !UUID.test(value['challengeId'])
        || !Number.isSafeInteger(value['expiresAt']) || (value['expiresAt'] as number) <= Date.now()) {
        throw new Error('Invalid or expired drain challenge');
      }
      const nonce = randomUUID();
      const snapshot = await request('/status', { nodeId: value['nodeId'], nonce });
      const challenge = snapshot['challenge'] as { challengeId?: unknown; expiresAt?: unknown } | null | undefined;
      const { activeCount, unknownCount, evidenceSha256 } = snapshot;
      if (snapshot['version'] !== 1 || snapshot['nodeId'] !== value['nodeId'] || snapshot['nodeFqdn'] !== value['nodeFqdn']
        || snapshot['nonce'] !== nonce || snapshot['epoch'] !== value['epoch'] || snapshot['barrierId'] !== value['barrierId']
        || challenge?.challengeId !== value['challengeId'] || challenge?.expiresAt !== value['expiresAt']
        || (value['expiresAt'] as number) <= Date.now() || snapshot['state'] !== 'draining'
        || !Number.isSafeInteger(activeCount) || (activeCount as number) < 0
        || !Number.isSafeInteger(unknownCount) || (unknownCount as number) < 0
        || typeof evidenceSha256 !== 'string' || !SHA.test(evidenceSha256)) {
        throw new Error('Drain challenge did not match authoritative durable state');
      }
      const receipt = { ...value, status: activeCount === 0 && unknownCount === 0 ? 'drained' : 'pending', activeCount, unknownCount, evidenceSha256 };
      return { ...receipt, signature: createHmac('sha256', secret).update(DOMAIN + canonicalDrainJson(receipt)).digest('hex') };
    },
  };
}

export type ResourceParticipant = ReturnType<typeof createResourceParticipant>;
