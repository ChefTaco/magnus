/** Local API maintenance has the same durable drain boundary as remote SSH.
 * A verified loopback TLS probe selects inventory identity, never caller input.
 * Process exit/exec completion cannot prove descendant termination.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { probeLocalAgent } from './control-host-node.js';
import { apiParticipantWork } from './resource-participant-work.js';

const ownerId = randomUUID();
const KINDS = ['self-update-check', 'self-update-apply', 'self-update-restart'] as const;
export type ApiLocalKind = typeof KINDS[number];

/** Only this server-created error may carry an operation receipt to HTTP clients. */
export class ApiLocalWorkError extends HttpError {
  readonly workId: string;
  constructor(workId: string, error: unknown) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workId))
      throw new TypeError('A durable work UUID is required');
    super(error instanceof HttpError ? error.status : 500,
      error instanceof HttpError ? error.code : 'LOCAL_WORK_FAILED',
      error instanceof Error ? error.message : 'Local maintenance failed; inspect its durable work receipt');
    this.name = 'ApiLocalWorkError';
    this.workId = workId;
    this.cause = error;
  }
}

async function localHost(): Promise<string> {
  const probe = await probeLocalAgent();
  const host = probe?.verifiedTlsHostname;
  if (!host) throw new HttpError(503, 'LOCAL_WORK_IDENTITY_UNAVAILABLE', 'Verified local agent TLS identity is required for API maintenance');
  return host;
}

export async function reserveApiLocalWork(kind: ApiLocalKind) {
  const host = await localHost();
  const workId = randomUUID();
  const deadline = Date.now() + 60 * 60_000;
  const operationSha256 = createHash('sha256').update(JSON.stringify({ domain: 'magnus.api-local-external.v1',
    host, workId, ownerId, kind, effectBoundary: 'external-unverified' })).digest('hex');
  let reservation: Awaited<ReturnType<typeof apiParticipantWork.reserve>>;
  try {
    reservation = await apiParticipantWork.reserve({ host, workId, ownerId, kind, operationSha256, deadline });
  } catch (error) {
    // The transaction may have committed before its acknowledgment was lost.
    // A missing receipt is honest; losing the only lookup ID is not recoverable.
    throw new ApiLocalWorkError(workId, error);
  }
  return { workId, async run<T>(operation: () => Promise<T>): Promise<T> {
    let started = false;
    try {
      if (await localHost() !== host) throw new HttpError(409, 'LOCAL_WORK_IDENTITY_CHANGED', 'Local API maintenance target changed');
      await apiParticipantWork.start(workId, { ownerId, epoch: reservation.epoch, barrierId: reservation.barrierId,
        operationSha256, fence: reservation.fence!, deadline, requestSha256: reservation.requestSha256!, targetHost: host });
      started = true;
      return await operation();
    } catch (error) {
      throw new ApiLocalWorkError(workId, error);
    } finally {
      // A lost start acknowledgment can leave a running row; finish preserves it
      // as unknown even when the caller did not observe the successful start.
      await apiParticipantWork.finish(workId, { ownerId, disposition: started ? 'unknown' : 'not-started',
        evidenceSha256: createHash('sha256').update(`api-local-observation:${workId}:${started}`).digest('hex') }).catch(() => undefined);
    }
  } };
}

export async function withApiLocalWork<T extends object>(kind: ApiLocalKind, operation: () => Promise<T>): Promise<T & { workId: string }> {
  const work = await reserveApiLocalWork(kind);
  return { ...await work.run(operation), workId: work.workId };
}

export async function apiLocalWorkStatus(workId: string) {
  const row = await getDb().resourceParticipantWork.findFirst({ where: { workId, participant: 'api', kind: { in: [...KINDS] } },
    select: { workId: true, nodeId: true, kind: true, state: true, epoch: true, barrierId: true,
      startedAt: true, settledAt: true, settlement: true } });
  if (!row) throw new HttpError(404, 'LOCAL_WORK_NOT_FOUND', 'API maintenance receipt not found');
  return row;
}
