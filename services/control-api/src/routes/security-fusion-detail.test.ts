import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  securityFusionCase: { findUnique: vi.fn(), findMany: vi.fn() },
  securityFusionCaseEvent: { findMany: vi.fn() },
  securityFusionCaseEntity: { findMany: vi.fn() },
  securityFusionCaseActivity: { findMany: vi.fn() },
  securityFusionEvidence: { findMany: vi.fn() },
  securityFusionInvestigation: { findMany: vi.fn() },
  securityFusionAction: { findMany: vi.fn() },
  securityFusionCaseRelationship: { findMany: vi.fn() },
  securityFusionEvent: { findMany: vi.fn() },
  securityFusionEntity: { findMany: vi.fn() },
}));

vi.mock('../db/index.js', () => ({ getDb: () => db }));

import {
  loadSecurityFusionCaseDetail,
  SECURITY_FUSION_CASE_DETAIL_LIMITS,
} from './security-fusion.js';

describe('Security Fusion case detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.securityFusionCase.findUnique.mockResolvedValue({
      id: 'case-1',
      recommendedInvestigationJson: '[]',
      evidenceStepsJson: '[]',
    });
    db.securityFusionCaseEvent.findMany.mockResolvedValue([
      { id: 'link-2', eventId: 'event-2', ruleId: 'rule', confidenceContribution: 0.5 },
      { id: 'link-1', eventId: 'event-1', ruleId: 'rule', confidenceContribution: 0.4 },
    ]);
    db.securityFusionCaseEntity.findMany.mockResolvedValue([]);
    db.securityFusionCaseActivity.findMany.mockResolvedValue([]);
    db.securityFusionEvidence.findMany.mockResolvedValue([]);
    db.securityFusionInvestigation.findMany.mockResolvedValue([]);
    db.securityFusionAction.findMany.mockResolvedValue([]);
    db.securityFusionCaseRelationship.findMany.mockResolvedValue([]);
    db.securityFusionCase.findMany.mockResolvedValue([]);
    db.securityFusionEvent.findMany.mockResolvedValue([]);
    db.securityFusionEntity.findMany.mockResolvedValue([]);
  });

  it('bounds linked event IDs before constructing the database IN query', async () => {
    await loadSecurityFusionCaseDetail('case-1', false);

    expect(db.securityFusionCaseEvent.findMany).toHaveBeenCalledWith({
      where: { caseId: 'case-1' },
      orderBy: { id: 'desc' },
      take: SECURITY_FUSION_CASE_DETAIL_LIMITS.events,
    });
    expect(SECURITY_FUSION_CASE_DETAIL_LIMITS.events).toBeLessThan(999);
    expect(db.securityFusionEvent.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['event-2', 'event-1'] } },
      orderBy: { observedAt: 'asc' },
    });
    expect(db.securityFusionCaseRelationship.findMany).toHaveBeenCalledWith({
      where: { OR: [{ fromCaseId: 'case-1' }, { toCaseId: 'case-1' }] },
      orderBy: { createdAt: 'desc' },
      take: SECURITY_FUSION_CASE_DETAIL_LIMITS.relationships + 1,
    });
  });

  it('truncates relationship expansion before loading related cases', async () => {
    db.securityFusionCaseRelationship.findMany.mockResolvedValue(
      Array.from(
        { length: SECURITY_FUSION_CASE_DETAIL_LIMITS.relationships + 1 },
        (_, index) => ({
          id: `relationship-${index}`,
          fromCaseId: 'case-1',
          toCaseId: `related-${index}`,
          rationaleJson: '{}',
          createdAt: new Date(index),
        }),
      ),
    );

    const detail = await loadSecurityFusionCaseDetail('case-1', false);

    expect(detail.relationships).toHaveLength(SECURITY_FUSION_CASE_DETAIL_LIMITS.relationships);
    expect(detail.relationshipsTruncated).toBe(true);
    const relatedCasesCall = db.securityFusionCase.findMany.mock.calls.at(-1)?.[0];
    expect(relatedCasesCall.where.id.in).toHaveLength(
      SECURITY_FUSION_CASE_DETAIL_LIMITS.relationships,
    );
  });
});
