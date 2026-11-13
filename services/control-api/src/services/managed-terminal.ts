import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { managedTerminalAuthoritySchema, managedTerminalOperation, managedTerminalReceiptPayload,
  managedTerminalReceiptSchema, type ManagedTerminalAction } from '@hivemagnus/magnus-contracts';
import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';
import { lockResourceNode } from './resource-node-lock.js';
import { assertNodeAdmissionOpen } from './admission-fence.js';
import { getNodeBaseUrl } from '../utils/node-url.js';
import { RESULT_SIGNING_SECRET } from '../utils/env.js';
import { nodeEvidencePolicy } from './node-evidence-policy.js';
import { agentFetch } from './node-agent-auth.js';
import { hasFreshOnlineHealth } from './resource-node-health.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export function isManagedTerminalWork(work: { kind: string; workId: string; ownerId: string; nodeFqdn: string | null; operationSha256: string | null }): boolean {
  return work.kind === 'terminal-http' && Boolean(work.nodeFqdn) && work.operationSha256 === sha(managedTerminalOperation({
    workId: work.workId, ownerId: work.ownerId, host: work.nodeFqdn! }));
}
function fail(): never { throw new HttpError(409, 'MANAGED_TERMINAL_AUTHORITY_REQUIRED', 'Current full-node terminal authority is required'); }
export function terminalAuthority(work: { workId: string; ownerId: string; nodeId: string; nodeFqdn: string | null;
  epoch: number; barrierId: string | null; operationSha256: string | null; requestSha256: string | null; fence: bigint | null; deadline: Date | null }) {
  const value = { ...work, fence: work.fence?.toString(), deadline: work.deadline?.getTime() };
  return managedTerminalAuthoritySchema.parse(Object.fromEntries(Object.keys(managedTerminalAuthoritySchema.shape)
    .map(key => [key, value[key as keyof typeof value]])));
}

export async function claimManagedTerminal(raw: unknown, nonce: string) {
  const authority = managedTerminalAuthoritySchema.parse(raw);
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, authority.nodeId);
    await assertNodeAdmissionOpen(tx, authority.nodeId);
    const work = await tx.resourceParticipantWork.findUnique({ where: { workId: authority.workId } });
    const node = await tx.node.findUnique({ where: { id: authority.nodeId } });
    const enrollment = await tx.resourceEnrollment.findUnique({ where: { nodeId: authority.nodeId } });
    if (!work || !node || !hasFreshOnlineHealth(node) || node.hostname !== authority.nodeFqdn || enrollment?.state !== 'enrolled'
      || enrollment.epoch !== work.epoch || enrollment.barrierId !== work.barrierId || work.participant !== 'dashboard'
      || work.state !== 'running' || work.managedTerminalClaimedAt || !isManagedTerminalWork(work)
      || JSON.stringify(terminalAuthority(work)) !== JSON.stringify(authority) || authority.deadline <= Date.now()) fail();
    await tx.resourceParticipantWork.update({ where: { workId: work.workId }, data: { managedTerminalClaimedAt: new Date() } });
    return { ...authority, nonce, admitted: true };
  });
}

export async function settleManagedTerminal(raw: unknown) {
  const receipt = managedTerminalReceiptSchema.parse(raw);
  const { signature, nodeSignature, ...unsigned } = receipt;
  const payload = managedTerminalReceiptPayload(unsigned);
  // The receipt names its node: the node key signs it, the shared result key only for older agents.
  if (!(await nodeEvidencePolicy(receipt.nodeId)).verify('terminal-receipt', payload, nodeSignature, () => RESULT_SIGNING_SECRET.length >= 32
    && timingSafeEqual(Buffer.from(signature, 'hex'), createHmac('sha256', RESULT_SIGNING_SECRET).update(payload).digest()))) fail();
  return getDb().$transaction(async tx => {
    await lockResourceNode(tx, receipt.nodeId);
    const work = await tx.resourceParticipantWork.findUnique({ where: { workId: receipt.workId } });
    if (!work || !work.managedTerminalClaimedAt || !work.startedAt || !isManagedTerminalWork(work)
      || !['running', 'unknown', 'released'].includes(work.state)
      || JSON.stringify(terminalAuthority(work)) !== JSON.stringify(managedTerminalAuthoritySchema.parse(
        Object.fromEntries(Object.keys(managedTerminalAuthoritySchema.shape).map(key => [key, receipt[key as keyof typeof receipt]]))))
      || receipt.startedAt < work.managedTerminalClaimedAt.getTime() - 60_000 || receipt.terminalAt > Date.now() + 60_000) fail();
    const serialized = JSON.stringify({ payload, signature });
    if (work.state === 'released') {
      if (work.nodeSessionReceiptJson !== serialized) fail();
      return { workId: work.workId, state: 'released' };
    }
    await tx.resourceParticipantWork.update({ where: { workId: work.workId }, data: { state: 'released',
      settledAt: new Date(receipt.terminalAt), settlement: 'signed-restricted-terminal-process',
      nodeSessionReceiptSha256: sha(serialized), nodeSessionReceiptJson: serialized } });
    return { workId: work.workId, state: 'released' };
  });
}

/** Fixed node endpoint and credential, never chosen by a terminal client. No content is logged. */
export async function relayManagedTerminal(workId: string, ownerId: string, action: ManagedTerminalAction) {
  const work = await getDb().resourceParticipantWork.findUnique({ where: { workId } });
  if (!work || work.participant !== 'dashboard' || work.ownerId !== ownerId || !isManagedTerminalWork(work)
    || !['running', 'unknown', 'released'].includes(work.state)) fail();
  if (['input', 'resize', 'open'].includes(action.action) && (work.state !== 'running' || !work.deadline || work.deadline.getTime() <= Date.now())) fail();
  const node = await getDb().node.findUniqueOrThrow({ where: { id: work.nodeId } });
  if (node.hostname !== work.nodeFqdn || node.status !== 'ONLINE') fail();
  const url = getNodeBaseUrl(node.ipAddress, node.port).replace(/\/$/, '') + '/api/v1/terminal/session';
  if (new URL(url).protocol !== 'https:') fail();
  try {
  const response = await agentFetch({ nodeId: node.id }, url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authority: terminalAuthority(work), ...action }) });
  // The agent limits a read to 24 KiB before base64 encoding. Other replies are metadata only.
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (!reader) fail();
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 64 * 1024) fail(); chunks.push(value); }
  } finally { await reader.cancel().catch(() => undefined); }
  if (response.status !== 200) throw new HttpError(409, 'MANAGED_TERMINAL_UNAVAILABLE', 'The node refused the managed terminal operation');
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { success: boolean; data: Record<string, unknown> };
  if (body.success !== true || !body.data) fail();
  if (body.data['receipt']) await settleManagedTerminal(body.data['receipt']);
  return body.data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Never surface an upstream parser error: it may quote terminal bytes.
    throw new HttpError(503, 'MANAGED_TERMINAL_UNAVAILABLE', 'Managed terminal transport is unavailable');
  }
}
