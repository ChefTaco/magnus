import { describe, expect, it } from 'vitest';
import {
  securityFusionContainmentPreviewSchema,
  securityFusionEventBatchSchema,
  securityFusionInvestigationDraftSchema,
  securityFusionSourceReportSchema,
} from '@hivemagnus/magnus-contracts';
import { securityFusionIngestSignature, serializeSecurityFusionEvent } from './security-fusion.js';
import {
  configuredCollectorCredentials,
  validateSecurityFusionBatchEnvelope,
} from '../services/security-fusion-ingest.js';

describe('Security Fusion boundaries', () => {
  it('signs the collector identity, timestamp, nonce, and exact body bytes', () => {
    const first = securityFusionIngestSignature('secret', 'collector-a', '2026-07-26T12:00:00.000Z', 'nonce-1', '{"a":1}');
    expect(first).toHaveLength(64);
    expect(securityFusionIngestSignature('secret', 'collector-b', '2026-07-26T12:00:00.000Z', 'nonce-1', '{"a":1}')).not.toBe(first);
    expect(securityFusionIngestSignature('secret', 'collector-a', '2026-07-26T12:00:00.000Z', 'nonce-1', '{"a":2}')).not.toBe(first);
    expect(securityFusionIngestSignature('secret', 'collector-a', '2026-07-26T12:00:00.000Z', 'nonce-2', '{"a":1}')).not.toBe(first);
  });

  it('rejects unsupported sources and oversized batches', () => {
    const event = {
      schemaVersion: '1.0', eventId: 'one', source: 'packet_capture', sourceEventId: 'one',
      kind: 'packet.raw', observedAt: '2026-07-26T12:00:00.000Z', severity: 'info',
      confidence: 0.5, summary: 'raw packet', entities: [], attributes: {}, evidence: [],
    };
    expect(securityFusionEventBatchSchema.safeParse({
      schemaVersion: '1.0', collectorId: 'test', sentAt: '2026-07-26T12:00:00.000Z', events: [event],
    }).success).toBe(false);
    expect(securityFusionEventBatchSchema.safeParse({
      schemaVersion: '1.0', collectorId: 'test', sentAt: '2026-07-26T12:00:00.000Z',
      events: Array.from({ length: 101 }, (_, index) => ({ ...event, source: 'wazuh', eventId: String(index), sourceEventId: String(index) })),
    }).success).toBe(false);
  });

  it('rejects oversized individual events and deeply nested attributes', () => {
    const base = {
      schemaVersion: '1.0', eventId: 'one', source: 'wazuh', sourceEventId: 'one',
      kind: 'wazuh.alert', observedAt: '2026-07-26T12:00:00.000Z', severity: 'high',
      confidence: 0.8, summary: 'finding', entities: [], evidence: [],
    };
    expect(() => validateSecurityFusionBatchEnvelope({
      events: [{ ...base, attributes: { payload: 'x'.repeat(40_000) } }],
    }, 41_000)).toThrow(/individual event/i);
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 10; depth += 1) nested = { child: nested };
    expect(() => validateSecurityFusionBatchEnvelope({
      events: [{ ...base, attributes: nested }],
    }, 1000)).toThrow(/nesting/i);
  });

  it('loads independently revocable collector identities with source bindings', () => {
    const credentials = configuredCollectorCredentials({
      SECURITY_FUSION_COLLECTOR_CREDENTIALS_JSON: JSON.stringify({
        'collector-a': { secret: 'a-secret-that-is-long-enough', allowedSources: ['wazuh'] },
        'collector-b': { secret: 'b-secret-that-is-long-enough', allowedSources: ['tailscale'] },
      }),
    });
    expect(credentials.get('collector-a')?.secret).not.toBe(credentials.get('collector-b')?.secret);
    expect(credentials.get('collector-a')?.allowedSources).toEqual(['wazuh']);
    expect(credentials.get('collector-b')?.allowedSources).toEqual(['tailscale']);
  });

  it('accepts bounded per-source health reports', () => {
    expect(securityFusionSourceReportSchema.safeParse({
      schemaVersion: '1.0',
      collectorId: 'collector-a',
      sentAt: '2026-07-27T20:00:00.000Z',
      sources: [{
        source: 'magnus_ui',
        status: 'error',
        error: 'export returned 401',
      }],
    }).success).toBe(true);
    expect(securityFusionSourceReportSchema.safeParse({
      schemaVersion: '1.0',
      collectorId: 'collector-a',
      sentAt: '2026-07-27T20:00:00.000Z',
      sources: [{ source: 'unknown', status: 'healthy' }],
    }).success).toBe(false);
  });

  it('removes event attribute values from principals without evidence access', () => {
    const row = {
      id: 'event-1',
      attributesJson: JSON.stringify({ sourceIp: '192.0.2.10', username: 'private-user' }),
    };
    expect(serializeSecurityFusionEvent(row, false)).toMatchObject({
      id: 'event-1',
      attributes: { redacted: true },
    });
    expect(JSON.stringify(serializeSecurityFusionEvent(row, false))).not.toContain('private-user');
    expect(serializeSecurityFusionEvent(row, true)).toMatchObject({
      attributes: { sourceIp: '192.0.2.10', username: 'private-user' },
    });
  });

  it('requires restart targets and keeps Hermes proposals non-executable', () => {
    expect(securityFusionContainmentPreviewSchema.safeParse({
      caseId: 'case', nodeId: 'node', kind: 'service_restart', rationale: 'Required operational rationale',
    }).success).toBe(false);
    expect(securityFusionInvestigationDraftSchema.safeParse({
      summary: 'Assessment', hypotheses: [], prioritizedChecks: [],
      proposedActions: [{
        kind: 'service_restart', description: 'Restart service', risk: 'medium',
        reversible: true, requiresApproval: true, executable: true,
      }],
      evidenceSteps: [],
    }).success).toBe(false);
  });
});
