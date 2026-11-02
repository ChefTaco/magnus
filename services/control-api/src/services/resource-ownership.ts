/**
 * The inputs of every "has this node left the legacy path" decision, read in
 * one place. Coordination only; this never grants action approval.
 *
 * Two rules exist on purpose and must not be merged without a migration plan:
 * - `stickyEnrollmentObserved`: any non-legacy enrollment row or any durable
 *   ownership history (command lease, managed cron definition, participant
 *   work in any state, including work released by signed reconciliation).
 *   legacy-admission answers agents with it, and agents store an `enrolled`
 *   answer as a sticky local marker; managed cron uses it too. It only ever
 *   widens, so it can never hand legacy access back to an agent that once
 *   heard `enrolled`.
 * - `legacyAdmissionPossible` (command-resource-leases) plus lease history:
 *   what admitResourceCommand and participant reservation use. Participant
 *   work is reserved on legacy nodes by design (console terminals, API SSH),
 *   so these paths cannot count it without refusing every SSH session after
 *   the first one.
 * A node where the two disagree (participant or cron history, no completed
 * enrollment) is one whose agent may refuse direct requests that the server
 * still sends; upgrade eligibility reports it, and completing the node's
 * enrollment drain resolves it.
 */
import type { Prisma } from '../db/generated/prisma/client.js';

export interface OwnershipHistory { lease: boolean; managedCron: boolean; participantWork: boolean }

export async function readOwnershipHistory(tx: Prisma.TransactionClient, nodeId: string): Promise<OwnershipHistory> {
  const [lease, managedCron, participantWork] = await Promise.all([
    tx.commandResourceLease.findFirst({ where: { nodeId }, select: { id: true } }),
    tx.managedCronDefinition.findFirst({ where: { nodeId }, select: { cronJobId: true } }),
    tx.resourceParticipantWork.findFirst({ where: { nodeId }, select: { workId: true } }),
  ]);
  return { lease: Boolean(lease), managedCron: Boolean(managedCron), participantWork: Boolean(participantWork) };
}

/** The sticky rule: what legacy-admission tells an agent (`enrolled`) and what managed cron requires. */
export function stickyEnrollmentObserved(enrollment: { state: string } | null | undefined, history: OwnershipHistory): boolean {
  return Boolean(enrollment && enrollment.state !== 'legacy') || history.lease || history.managedCron || history.participantWork;
}

/** Why the sticky rule holds, for operator-facing reasons. */
export function stickyEnrollmentCause(enrollment: { state: string } | null | undefined, history: OwnershipHistory): string | null {
  const causes = [enrollment && enrollment.state !== 'legacy' ? `a ${enrollment.state} enrollment` : null,
    history.lease ? 'command lease history' : null, history.managedCron ? 'managed cron history' : null,
    history.participantWork ? 'participant work history' : null].filter(Boolean);
  return causes.length ? causes.join(', ') : null;
}
