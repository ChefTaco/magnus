import { describe, expect, it } from 'vitest';
import {
  canTransitionSecurityFusionAction,
  SECURITY_FUSION_ACTION_TRANSITIONS,
  securityFusionActionSources,
} from './security-fusion-actions.js';

describe('Security Fusion action transition table', () => {
  it('allows the approval and durable-dispatch path', () => {
    expect(canTransitionSecurityFusionAction('previewed', 'pending_approval')).toBe(true);
    expect(canTransitionSecurityFusionAction('pending_approval', 'dispatch_pending')).toBe(true);
    expect(canTransitionSecurityFusionAction('dispatch_pending', 'executing')).toBe(true);
    expect(canTransitionSecurityFusionAction('executing', 'succeeded')).toBe(true);
  });

  it('allows rejection only while approval is pending', () => {
    expect(canTransitionSecurityFusionAction('pending_approval', 'rejected')).toBe(true);
    expect(canTransitionSecurityFusionAction('executing', 'rejected')).toBe(false);
    expect(canTransitionSecurityFusionAction('succeeded', 'rejected')).toBe(false);
    expect(canTransitionSecurityFusionAction('failed', 'rejected')).toBe(false);
    expect(securityFusionActionSources('rejected')).toEqual(['pending_approval']);
  });

  it('makes every terminal state immutable', () => {
    for (const status of ['rejected', 'cancelled', 'failed', 'released'] as const) {
      expect(SECURITY_FUSION_ACTION_TRANSITIONS[status]).toEqual([]);
    }
  });
});
