import { describe, expect, it } from 'vitest';
import type { SecurityFusionEvent } from '@hivemagnus/magnus-contracts';
import {
  boundSecurityFusionRelationships,
  correlationFamily,
  evaluateSecurityFusionEvidenceAdmission,
  isSecurityRelevantServiceStatus,
  SECURITY_FUSION_RETENTION_POLICY,
} from './security-fusion-service.js';

describe('Security Fusion Magnus service conversion', () => {
  it('ignores optional checks that are unavailable on a node', () => {
    expect(isSecurityRelevantServiceStatus('unknown')).toBe(false);
    expect(isSecurityRelevantServiceStatus('active')).toBe(false);
    expect(isSecurityRelevantServiceStatus(undefined)).toBe(false);
  });

  it('retains real inactive and failed service observations', () => {
    expect(isSecurityRelevantServiceStatus('failed')).toBe(true);
    expect(isSecurityRelevantServiceStatus('inactive')).toBe(true);
  });

  it('does not open cases for routine DNS and flow summaries', () => {
    const routineEvent: SecurityFusionEvent = {
      schemaVersion: '1.0',
      eventId: 'event',
      source: 'netflow',
      sourceEventId: 'source-event',
      kind: 'unifi.firewall.flow.summary',
      observedAt: '2026-07-27T20:00:00.000Z',
      severity: 'info',
      confidence: 0.72,
      summary: 'Routine aggregate',
      entities: [{ type: 'ip', value: '10.0.0.5' }],
      attributes: { observationCount: 500 },
      evidence: [],
    };
    expect(correlationFamily(routineEvent, new Set(['netflow']))).toBeNull();
    expect(correlationFamily({ ...routineEvent, severity: 'medium' }, new Set(['netflow'])))
      .toBe('suspicious-dns-egress');
    expect(correlationFamily(routineEvent, new Set(['netflow', 'wazuh'])))
      .toBe('suspicious-dns-egress');
  });
});

describe('Security Fusion retention ceilings', () => {
  it('accepts the exact byte boundary and rejects the next byte', () => {
    expect(evaluateSecurityFusionEvidenceAdmission(
      0,
      SECURITY_FUSION_RETENTION_POLICY.maxPreservedEvidenceBytes - 1,
      1,
    )).toBe('accepted');
    expect(evaluateSecurityFusionEvidenceAdmission(
      0,
      SECURITY_FUSION_RETENTION_POLICY.maxPreservedEvidenceBytes,
      1,
    )).toBe('byte_limit');
  });

  it('rejects evidence when the per-case count is already full', () => {
    expect(evaluateSecurityFusionEvidenceAdmission(
      SECURITY_FUSION_RETENTION_POLICY.maxPreservedEvidence,
      0,
      1,
    )).toBe('count_limit');
  });

  it('returns only the configured maximum relationship expansion', () => {
    const expanded = boundSecurityFusionRelationships(
      Array.from(
        { length: SECURITY_FUSION_RETENTION_POLICY.maxCaseRelationships + 1 },
        (_, index) => index,
      ),
    );
    expect(expanded.rows).toHaveLength(
      SECURITY_FUSION_RETENTION_POLICY.maxCaseRelationships,
    );
    expect(expanded.truncated).toBe(true);
  });
});
