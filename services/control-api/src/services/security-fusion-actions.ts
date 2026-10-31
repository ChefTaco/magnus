export const SECURITY_FUSION_ACTION_TRANSITIONS = {
  previewed: ['pending_approval', 'cancelled'],
  pending_approval: ['dispatch_pending', 'rejected', 'cancelled'],
  dispatch_pending: ['executing', 'verifying', 'succeeded', 'failed'],
  executing: ['verifying', 'succeeded', 'failed', 'release_pending'],
  verifying: ['succeeded', 'failed'],
  succeeded: ['release_pending'],
  release_pending: ['releasing', 'released', 'failed'],
  releasing: ['released', 'failed'],
  rejected: [],
  cancelled: [],
  failed: [],
  released: [],
} as const;

export type SecurityFusionActionStatus = keyof typeof SECURITY_FUSION_ACTION_TRANSITIONS;

export function canTransitionSecurityFusionAction(
  from: SecurityFusionActionStatus,
  to: SecurityFusionActionStatus,
): boolean {
  return (SECURITY_FUSION_ACTION_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function securityFusionActionSources(
  to: SecurityFusionActionStatus,
): SecurityFusionActionStatus[] {
  return (Object.keys(SECURITY_FUSION_ACTION_TRANSITIONS) as SecurityFusionActionStatus[])
    .filter((from) => canTransitionSecurityFusionAction(from, to));
}
