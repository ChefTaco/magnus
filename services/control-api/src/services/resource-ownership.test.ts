import { describe, expect, it } from 'vitest';
import { stickyEnrollmentCause, stickyEnrollmentObserved } from './resource-ownership.js';

const none = { lease: false, managedCron: false, participantWork: false };

describe('sticky enrollment rule', () => {
  it('counts any non-legacy enrollment and any ownership history, including released participant work', () => {
    expect(stickyEnrollmentObserved(null, none)).toBe(false);
    expect(stickyEnrollmentObserved({ state: 'legacy' }, none)).toBe(false);
    expect(stickyEnrollmentObserved({ state: 'draining' }, none)).toBe(true);
    expect(stickyEnrollmentObserved(null, { ...none, participantWork: true })).toBe(true);
    expect(stickyEnrollmentObserved(null, { ...none, managedCron: true })).toBe(true);
    expect(stickyEnrollmentObserved(null, { ...none, lease: true })).toBe(true);
  });

  it('names its causes', () => {
    expect(stickyEnrollmentCause({ state: 'draining' }, { ...none, participantWork: true })).toBe('a draining enrollment, participant work history');
    expect(stickyEnrollmentCause(null, none)).toBeNull();
  });
});
