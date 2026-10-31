import { createHash, randomUUID } from 'node:crypto';
import { apiParticipantWork } from './resource-participant-work.js';
/** Compatibility status check only. Execution MUST use withApiSshOwnership.
 * Fail closed for enrolled targets until SSH descendants have durable receipts.
 * This never changes SSH server access, credentials or direct operator SSH.
 */
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { resourceLeasesRequested } from './command-resource-leases.js';
export async function assertUnenrolledSshTarget(hostname: string): Promise<void> {
  if (typeof hostname !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(hostname))
    throw new HttpError(400, 'INVALID_SSH_TARGET', 'A canonical inventory host is required');
  // Activation must first drain all legacy SSH sessions. New unowned SSH cannot
  // start while enrollment is globally enabled, even on a not-yet-enrolled node.
  if (resourceLeasesRequested()) throw new HttpError(409, 'MANAGED_SSH_UNAVAILABLE', 'Managed SSH requires the pending durable session ownership integration');
  const db = getDb();
  if (!await db.commandResourceLease.findFirst({ select: { id: true } })
    && !await db.resourceEnrollment.findFirst({ where: { state: { not: 'legacy' } }, select: { nodeId: true } })
    && !await db.admissionFence.findFirst({ select: { nodeId: true } })) return;
  const nodes = await db.node.findMany({ where: { OR: [{ hostname: hostname.toLowerCase() }, { ipAddress: hostname.toLowerCase() }] }, select: { id: true } });
  if (nodes.length !== 1 || await db.commandResourceLease.findFirst({ where: { nodeId: nodes[0]!.id }, select: { id: true } })
    || await db.resourceEnrollment.findFirst({ where: { nodeId: nodes[0]!.id, state: { not: 'legacy' } }, select: { nodeId: true } })
    || await db.admissionFence.findUnique({ where: { nodeId: nodes[0]!.id }, select: { nodeId: true } }))
    throw new HttpError(409, 'MANAGED_SSH_UNAVAILABLE', 'Enrolled or unidentified target requires durable managed SSH ownership');
}

/** One API process incarnation; a replacement process never inherits its grants. */
const apiOwnerId = randomUUID();
export type ApiSshKind = 'ssh-command' | 'agent-deploy' | 'agent-upgrade' | 'control-deploy' | 'agent-migrate';
/**
 * Wrap the WHOLE session, including connection, preparation and SFTP. A start
 * reply lost before the callback runs remains held; it is never resubmitted.
 * Unknown non-agent bootstrap is deliberately unsupported for enrollment, not
 * assigned a fabricated canonical node. Only the two install entrypoints opt in.
 */
export async function withApiSshOwnership<T>(host: string, kind: ApiSshKind, operation: () => Promise<T>): Promise<T> {
  if (typeof host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(host))
    throw new HttpError(400, 'INVALID_SSH_TARGET', 'A canonical inventory host is required');
  const db = getDb();
  const nodes = await db.node.findMany({ where: { OR: [{ hostname: host.toLowerCase() }, { ipAddress: host.toLowerCase() }] }, select: { id: true }, take: 2 });
  if (!nodes.length && (kind === 'agent-deploy' || kind === 'control-deploy')) {
    // This legacy bootstrap is not an enrollment participant. An API drain can
    // never acknowledge zero from these records while bootstrap remains enabled.
    // Existing global/sticky policy still denies unidentified protected targets.
    await assertUnenrolledSshTarget(host);
    return operation();
  }
  if (nodes.length !== 1) throw new HttpError(409, 'RESOURCE_TARGET_INVALID', 'Exact unambiguous inventory target required');
  const workId = randomUUID();
  const deadline = Date.now() + 60 * 60_000;
  const operationSha256 = createHash('sha256').update(JSON.stringify({ domain: 'magnus.api-external-ssh.v1',
    host: host.toLowerCase(), workId, ownerId: apiOwnerId, kind, effectBoundary: 'external-unverified' })).digest('hex');
  const reserved = await apiParticipantWork.reserve({ host, workId, ownerId: apiOwnerId, kind, operationSha256, deadline });
  await apiParticipantWork.start(workId, { ownerId: apiOwnerId, epoch: reserved.epoch, barrierId: reserved.barrierId,
    operationSha256, fence: reserved.fence!, deadline, requestSha256: reserved.requestSha256!, targetHost: host });
  // No transport or preparation occurs until the committed single-use grant.
  try { return await operation(); }
  finally {
    // A failed settlement leaves the durable running row held. Do not replace a
    // real remote result with a retry-looking error; no retry or release occurs.
    await apiParticipantWork.finish(workId, { ownerId: apiOwnerId, disposition: 'unknown',
      evidenceSha256: createHash('sha256').update(`api-ssh-descendants-unverified:${workId}`).digest('hex') }).catch(() => undefined);
  }
}
