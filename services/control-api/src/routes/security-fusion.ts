import { createHmac, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import {
  securityFusionContainmentPreviewSchema,
  securityFusionEventBatchSchema,
  securityFusionInvestigationDraftSchema,
  securityFusionSourceReportSchema,
  securityFusionSourceSchema,
} from '@hivemagnus/magnus-contracts';
import type { AppVariables } from '../types/index.js';
import { getDb } from '../db/index.js';
import {
  authMiddleware,
  getUser,
  hasPermission,
  requirePermission,
  requireRole,
  safeEqual,
} from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logAuditEvent } from '../services/audit-service.js';
import {
  ingestSecurityFusionBatch,
  preserveEvidence,
  saveInvestigation,
  SECURITY_FUSION_RETENTION_POLICY,
  sha256,
} from '../services/security-fusion-service.js';
import {
  collectorCredentialFingerprint,
  configuredCollectorCredentials,
  validateSecurityFusionBatchEnvelope,
  type CollectorCredential,
} from '../services/security-fusion-ingest.js';
import { dispatchSecurityFusionOutbox } from '../services/security-fusion-outbox.js';
import { securityFusionActionSources } from '../services/security-fusion-actions.js';
import { incMetric } from './metrics.js';

export const securityFusionRouter = new Hono<AppVariables>();

const INGEST_SKEW_MS = 5 * 60_000;
const APPROVAL_TTL_MS = 10 * 60_000;
const SOURCE_STALE_MS = Math.max(
  Number(process.env['SECURITY_FUSION_SOURCE_STALE_MS']) || 5 * 60_000,
  60_000,
);
export const SECURITY_FUSION_CASE_DETAIL_LIMITS = {
  events: 250,
  entities: 250,
  activity: 250,
  evidence: 100,
  investigations: 25,
  actions: 100,
  relationships: SECURITY_FUSION_RETENTION_POLICY.maxCaseRelationships,
} as const;

export function securityFusionIngestSignature(
  secret: string,
  collectorId: string,
  timestamp: string,
  nonce: string,
  raw: string,
): string {
  return createHmac('sha256', secret).update(`${collectorId}.${timestamp}.${nonce}.${raw}`).digest('hex');
}

function json(value: string): unknown {
  try { return JSON.parse(value); } catch { return {}; }
}

function serializeCase(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    recommendedInvestigation: json(String(row['recommendedInvestigationJson'] ?? '[]')),
    evidenceSteps: json(String(row['evidenceStepsJson'] ?? '[]')),
    recommendedInvestigationJson: undefined,
    evidenceStepsJson: undefined,
  };
}

function serializeSourceState<T extends {
  status: string;
  lastSuccessAt: Date | null;
}>(row: T): T & { status: string } {
  if (
    row.status === 'healthy'
    && row.lastSuccessAt
    && Date.now() - row.lastSuccessAt.getTime() > SOURCE_STALE_MS
  ) {
    return { ...row, status: 'stale' };
  }
  return row;
}

export function serializeSecurityFusionEvent(
  row: Record<string, unknown>,
  includeEvidenceAttributes: boolean,
): Record<string, unknown> {
  const attributes = json(String(row['attributesJson'] ?? '{}'));
  return {
    ...row,
    attributes: includeEvidenceAttributes
      ? attributes
      : { redacted: true },
    attributesJson: undefined,
  };
}

async function verifyIngest(c: Context<AppVariables>, raw: string): Promise<CollectorCredential> {
  let credentials: Map<string, CollectorCredential>;
  try {
    credentials = configuredCollectorCredentials();
  } catch {
    throw new HttpError(503, 'SECURITY_FUSION_DISABLED', 'Security Fusion collector credentials are invalid');
  }
  if (credentials.size === 0) {
    throw new HttpError(503, 'SECURITY_FUSION_DISABLED', 'Security Fusion ingest is not configured');
  }
  const collectorId = c.req.header('x-security-collector-id') ?? '';
  const credential = credentials.get(collectorId);
  if (!credential) throw new HttpError(401, 'INVALID_INGEST_SIGNATURE', 'Invalid signed ingest request');
  const timestamp = c.req.header('x-security-timestamp') ?? '';
  const nonce = c.req.header('x-security-nonce') ?? '';
  const signature = c.req.header('x-security-signature') ?? '';
  const timestampMs = Date.parse(timestamp);
  if (!nonce || nonce.length > 160 || !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > INGEST_SKEW_MS) {
    throw new HttpError(401, 'INVALID_INGEST_SIGNATURE', 'Stale or malformed signed ingest request');
  }
  const expected = securityFusionIngestSignature(credential.secret, collectorId, timestamp, nonce, raw);
  if (!safeEqual(expected, signature)) throw new HttpError(401, 'INVALID_INGEST_SIGNATURE', 'Invalid signed ingest request');
  try {
    await getDb().$transaction(async (db) => {
      const existing = await db.securityFusionCollector.findUnique({ where: { id: collectorId } });
      if (existing?.revokedAt || existing?.status === 'revoked') {
        throw new HttpError(401, 'COLLECTOR_REVOKED', 'Collector identity has been revoked');
      }
      await db.securityFusionCollector.upsert({
        where: { id: collectorId },
        create: {
          id: collectorId,
          displayName: credential.displayName,
          credentialFingerprint: collectorCredentialFingerprint(credential.secret),
          allowedSourcesJson: JSON.stringify(credential.allowedSources),
          schemaVersion: credential.schemaVersion,
          dataClassification: credential.dataClassification,
          status: 'active',
          lastReceiptAt: new Date(),
        },
        update: {
          displayName: credential.displayName,
          credentialFingerprint: collectorCredentialFingerprint(credential.secret),
          allowedSourcesJson: JSON.stringify(credential.allowedSources),
          schemaVersion: credential.schemaVersion,
          dataClassification: credential.dataClassification,
          lastReceiptAt: new Date(),
        },
      });
      await db.securityFusionNonce.create({
        data: { nonce, collectorId, expiresAt: new Date(Date.now() + INGEST_SKEW_MS) },
      });
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, 'INGEST_REPLAY', 'Ingest nonce has already been used');
  }
  return credential;
}

securityFusionRouter.post('/ingest/events', async (c) => {
  const raw = await c.req.text();
  const credential = await verifyIngest(c, raw);
  try {
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(raw); } catch { throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }
    validateSecurityFusionBatchEnvelope(parsedJson, Buffer.byteLength(raw, 'utf8'));
    const parsed = securityFusionEventBatchSchema.safeParse(parsedJson);
    if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map((issue) => issue.message).join('; '));
    if (parsed.data.collectorId !== credential.collectorId) {
      throw new HttpError(403, 'COLLECTOR_IDENTITY_MISMATCH', 'Signed collector identity does not match the batch');
    }
    const disallowed = parsed.data.events.find((event) => !credential.allowedSources.includes(event.source));
    const checkpointSources = Object.keys(parsed.data.checkpoints ?? {});
    if (disallowed || checkpointSources.some((source) => !credential.allowedSources.includes(source as never))) {
      throw new HttpError(403, 'COLLECTOR_SOURCE_FORBIDDEN', 'Collector is not authorized for one or more source types');
    }
    const result = await ingestSecurityFusionBatch(parsed.data);
    await getDb().securityFusionCollector.update({
      where: { id: credential.collectorId },
      data: { lastSuccessAt: new Date(), lastErrorAt: null, lastError: null },
    });
    return c.json({ success: true, data: result }, 202);
  } catch (error) {
    const message = error instanceof HttpError ? error.code : 'INGEST_FAILED';
    await getDb().securityFusionCollector.update({
      where: { id: credential.collectorId },
      data: { lastErrorAt: new Date(), lastError: message },
    }).catch(() => undefined);
    throw error;
  }
});

securityFusionRouter.get('/ingest/checkpoints', async (c) => {
  const credential = await verifyIngest(c, '');
  const states = await getDb().securityFusionSourceState.findMany({
    where: { checkpoint: { not: null }, source: { in: credential.allowedSources } },
    select: { source: true, checkpoint: true },
  });
  return c.json({ success: true, data: Object.fromEntries(states.map((state) => [state.source, state.checkpoint])) });
});

securityFusionRouter.post('/ingest/source-status', async (c) => {
  const raw = await c.req.text();
  const credential = await verifyIngest(c, raw);
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw); } catch { throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid JSON body'); }
  const parsed = securityFusionSourceReportSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  if (parsed.data.collectorId !== credential.collectorId) {
    throw new HttpError(403, 'COLLECTOR_IDENTITY_MISMATCH', 'Signed collector identity does not match the report');
  }
  if (parsed.data.sources.some((item) => !credential.allowedSources.includes(item.source))) {
    throw new HttpError(403, 'COLLECTOR_SOURCE_FORBIDDEN', 'Collector is not authorized for one or more source types');
  }
  const now = new Date();
  await getDb().$transaction(parsed.data.sources.map((item) => getDb().securityFusionSourceState.upsert({
    where: { source: item.source },
    create: {
      id: item.source,
      source: item.source,
      status: item.status,
      checkpoint: item.checkpoint,
      lastEventAt: item.lastEventAt ? new Date(item.lastEventAt) : null,
      lastSuccessAt: item.status === 'healthy' ? now : null,
      lastErrorAt: item.status === 'error' || item.status === 'degraded' ? now : null,
      lastError: item.error ?? null,
    },
    update: {
      status: item.status,
      ...(item.checkpoint === undefined ? {} : { checkpoint: item.checkpoint }),
      ...(item.lastEventAt === undefined ? {} : { lastEventAt: new Date(item.lastEventAt) }),
      ...(item.status === 'healthy' ? { lastSuccessAt: now, lastErrorAt: null, lastError: null } : {}),
      ...(item.status === 'error' || item.status === 'degraded'
        ? { lastErrorAt: now, lastError: item.error ?? item.status }
        : {}),
      ...(item.status === 'configured' || item.status === 'unconfigured'
        ? { lastErrorAt: null, lastError: null }
        : {}),
    },
  })));
  const failed = parsed.data.sources.find((item) => item.status === 'error' || item.status === 'degraded');
  await getDb().securityFusionCollector.update({
    where: { id: credential.collectorId },
    data: failed
      ? { lastErrorAt: now, lastError: `${failed.source}: ${failed.error ?? failed.status}` }
      : { lastSuccessAt: now, lastErrorAt: null, lastError: null },
  });
  return c.json({ success: true, data: { updated: parsed.data.sources.length } }, 202);
});

securityFusionRouter.use('*', authMiddleware);
securityFusionRouter.use('*', requirePermission('security-fusion:read'));

securityFusionRouter.get('/overview', async (c) => {
  const db = getDb();
  const [openCases, sources, bySeverity] = await Promise.all([
    db.securityFusionCase.findMany({ where: { archivedAt: null, status: { notIn: ['resolved', 'false_positive'] } }, orderBy: { lastSeenAt: 'desc' }, take: 12 }),
    db.securityFusionSourceState.findMany({ orderBy: { source: 'asc' } }),
    db.securityFusionCase.groupBy({ by: ['severity'], where: { archivedAt: null, status: { notIn: ['resolved', 'false_positive'] } }, _count: { id: true } }),
  ]);
  return c.json({ success: true, data: { generatedAt: new Date().toISOString(), openCases: openCases.map((row) => serializeCase(row as unknown as Record<string, unknown>)), sources: sources.map(serializeSourceState), bySeverity } });
});

securityFusionRouter.get('/sources', async (c) => {
  const rows = await getDb().securityFusionSourceState.findMany({ orderBy: { source: 'asc' } });
  const known = new Map(rows.map((row) => [row.source, row]));
  return c.json({
    success: true,
    data: securityFusionSourceSchema.options.map((source) => {
      const state = known.get(source);
      return state ? serializeSourceState(state) : { id: source, source, status: 'unconfigured' };
    }),
  });
});

securityFusionRouter.get('/source-registry', async (c) => {
  const collectors = await getDb().securityFusionCollector.findMany({
    orderBy: { displayName: 'asc' },
  });
  return c.json({
    success: true,
    data: collectors.map((collector) => ({
      ...collector,
      allowedSources: json(collector.allowedSourcesJson),
      allowedSourcesJson: undefined,
      credentialFingerprint: undefined,
      cursorHealth: collector.lastErrorAt ? 'error' : collector.lastSuccessAt ? 'healthy' : 'pending',
    })),
  });
});

securityFusionRouter.post('/source-registry/:id/revoke', requireRole('ADMIN'), async (c) => {
  const collectorId = c.req.param('id')!;
  const revokedAt = new Date();
  const result = await getDb().securityFusionCollector.updateMany({
    where: { id: collectorId, status: { not: 'revoked' }, revokedAt: null },
    data: { status: 'revoked', revokedAt },
  });
  if (result.count !== 1) {
    throw new HttpError(409, 'INVALID_COLLECTOR_STATE', 'Collector is missing or already revoked');
  }
  await logAuditEvent({
    action: 'security_fusion.collector.revoke',
    actorId: getUser(c).userId,
    targetType: 'security-fusion-collector',
    targetId: collectorId,
    details: { revokedAt: revokedAt.toISOString() },
  });
  return c.json({ success: true, data: { id: collectorId, status: 'revoked', revokedAt } });
});

securityFusionRouter.get('/events', async (c) => {
  const source = c.req.query('source');
  const kind = c.req.query('kind');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 250);
  const rows = await getDb().securityFusionEvent.findMany({
    where: { ...(source ? { source } : {}), ...(kind ? { kind: { contains: kind } } : {}) },
    orderBy: { observedAt: 'desc' }, take: limit,
  });
  const includeEvidenceAttributes = hasPermission(getUser(c), 'security-fusion:evidence:read');
  return c.json({ success: true, data: rows.map((row) => serializeSecurityFusionEvent(row as unknown as Record<string, unknown>, includeEvidenceAttributes)) });
});

securityFusionRouter.get('/entities', async (c) => {
  const type = c.req.query('type');
  const rows = await getDb().securityFusionEntity.findMany({ where: type ? { type } : {}, orderBy: { lastSeenAt: 'desc' }, take: 100 });
  return c.json({ success: true, data: rows.map((row) => ({ ...row, aliases: json(row.aliasesJson), aliasesJson: undefined })) });
});

securityFusionRouter.get('/entities/:id', async (c) => {
  const entity = await getDb().securityFusionEntity.findUnique({ where: { id: c.req.param('id') } });
  if (!entity) throw new HttpError(404, 'NOT_FOUND', 'Security entity not found');
  const links = await getDb().securityFusionCaseEntity.findMany({
    where: { entityId: entity.id },
    orderBy: { id: 'desc' },
    take: SECURITY_FUSION_RETENTION_POLICY.maxCaseRelationships + 1,
  });
  const relationshipsTruncated =
    links.length > SECURITY_FUSION_RETENTION_POLICY.maxCaseRelationships;
  if (relationshipsTruncated) incMetric('securityFusionRelationshipTruncated');
  const cases = await getDb().securityFusionCase.findMany({
    where: {
      archivedAt: null,
      id: {
        in: links
          .slice(0, SECURITY_FUSION_RETENTION_POLICY.maxCaseRelationships)
          .map((link) => link.caseId),
      },
    },
    orderBy: { lastSeenAt: 'desc' },
  });
  return c.json({ success: true, data: {
    ...entity,
    aliases: json(entity.aliasesJson),
    cases: cases.map((row) => serializeCase(row as unknown as Record<string, unknown>)),
    relationshipsTruncated,
    relationshipLimit: SECURITY_FUSION_RETENTION_POLICY.maxCaseRelationships,
  } });
});

securityFusionRouter.get('/cases', async (c) => {
  const status = c.req.query('status');
  const archived = c.req.query('archived') === 'true';
  const rows = await getDb().securityFusionCase.findMany({
    where: {
      ...(status ? { status } : {}),
      archivedAt: archived ? { not: null } : null,
    },
    orderBy: { lastSeenAt: 'desc' },
    take: 100,
  });
  return c.json({ success: true, data: rows.map((row) => serializeCase(row as unknown as Record<string, unknown>)) });
});

export async function loadSecurityFusionCaseDetail(caseId: string, includeEvidence: boolean) {
  const caseRow = await getDb().securityFusionCase.findUnique({ where: { id: caseId } });
  if (!caseRow) throw new HttpError(404, 'NOT_FOUND', 'Security case not found');
  const [caseEvents, caseEntities, activity, evidence, investigations, actions, relationshipRows] = await Promise.all([
    getDb().securityFusionCaseEvent.findMany({
      where: { caseId },
      orderBy: { id: 'desc' },
      take: SECURITY_FUSION_CASE_DETAIL_LIMITS.events,
    }),
    getDb().securityFusionCaseEntity.findMany({
      where: { caseId },
      orderBy: { id: 'desc' },
      take: SECURITY_FUSION_CASE_DETAIL_LIMITS.entities,
    }),
    getDb().securityFusionCaseActivity.findMany({
      where: { caseId },
      orderBy: { createdAt: 'desc' },
      take: SECURITY_FUSION_CASE_DETAIL_LIMITS.activity,
    }),
    getDb().securityFusionEvidence.findMany({
      where: { caseId },
      orderBy: { preservedAt: 'desc' },
      take: SECURITY_FUSION_CASE_DETAIL_LIMITS.evidence,
    }),
    getDb().securityFusionInvestigation.findMany({
      where: { caseId },
      orderBy: { revision: 'desc' },
      take: SECURITY_FUSION_CASE_DETAIL_LIMITS.investigations,
    }),
    getDb().securityFusionAction.findMany({
      where: { caseId },
      orderBy: { createdAt: 'desc' },
      take: SECURITY_FUSION_CASE_DETAIL_LIMITS.actions,
    }),
    getDb().securityFusionCaseRelationship.findMany({
      where: { OR: [{ fromCaseId: caseId }, { toCaseId: caseId }] },
      orderBy: { createdAt: 'desc' },
      take: SECURITY_FUSION_CASE_DETAIL_LIMITS.relationships + 1,
    }),
  ]);
  const relationshipsTruncated =
    relationshipRows.length > SECURITY_FUSION_CASE_DETAIL_LIMITS.relationships;
  if (relationshipsTruncated) incMetric('securityFusionRelationshipTruncated');
  const relationships = relationshipRows.slice(0, SECURITY_FUSION_CASE_DETAIL_LIMITS.relationships);
  const relatedCaseIds = [...new Set(relationships.map((row) =>
    row.fromCaseId === caseId ? row.toCaseId : row.fromCaseId
  ))];
  const [events, entities, relatedCases] = await Promise.all([
    getDb().securityFusionEvent.findMany({ where: { id: { in: caseEvents.map((row) => row.eventId) } }, orderBy: { observedAt: 'asc' } }),
    getDb().securityFusionEntity.findMany({ where: { id: { in: caseEntities.map((row) => row.entityId) } }, orderBy: { type: 'asc' } }),
    getDb().securityFusionCase.findMany({
      where: { id: { in: relatedCaseIds } },
      orderBy: { lastSeenAt: 'desc' },
    }),
  ]);
  const contributions = new Map(caseEvents.map((row) => [row.eventId, { ruleId: row.ruleId, confidenceContribution: row.confidenceContribution }]));
  return {
    case: serializeCase(caseRow as unknown as Record<string, unknown>),
    events: events.map((row) => ({ ...serializeSecurityFusionEvent(row as unknown as Record<string, unknown>, includeEvidence), ...contributions.get(row.id) })),
    entities,
    activity: activity.reverse().map((row) => ({ ...row, detail: json(row.detailJson), detailJson: undefined })),
    evidence: includeEvidence ? evidence : evidence.map((row) => ({ id: row.id, caseId: row.caseId, eventId: row.eventId, mediaType: row.mediaType, sha256: row.sha256, preservedAt: row.preservedAt, expiresAt: row.expiresAt, restricted: true })),
    investigations: investigations.map((row) => ({ ...row, draft: json(row.draftJson), draftJson: undefined })),
    actions: actions.map((row) => ({ ...row, preview: json(row.previewJson), result: row.resultJson ? json(row.resultJson) : null, approvalTokenHash: undefined })),
    relationships: relationships.map((row) => ({
      ...row,
      rationale: json(row.rationaleJson),
      rationaleJson: undefined,
    })),
    relatedCases: relatedCases.map((row) => serializeCase(row as unknown as Record<string, unknown>)),
    relationshipsTruncated,
    limits: SECURITY_FUSION_CASE_DETAIL_LIMITS,
  };
}

securityFusionRouter.get('/cases/:id', async (c) => {
  const detail = await loadSecurityFusionCaseDetail(
    c.req.param('id'),
    hasPermission(getUser(c), 'security-fusion:evidence:read'),
  );
  return c.json({ success: true, data: detail });
});

securityFusionRouter.patch('/cases/:id', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const body = await c.req.json() as { status?: string; assignedTo?: string | null };
  const allowed = ['new', 'triage', 'investigating', 'contained', 'monitoring', 'resolved', 'false_positive'];
  if (body.status && !allowed.includes(body.status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid case status');
  const user = getUser(c);
  const row = await getDb().securityFusionCase.update({
    where: { id: c.req.param('id') },
    data: { ...(body.status ? { status: body.status, resolvedAt: ['resolved', 'false_positive'].includes(body.status) ? new Date() : null } : {}), ...(body.assignedTo !== undefined ? { assignedTo: body.assignedTo } : {}) },
  });
  await getDb().securityFusionCaseActivity.create({ data: { caseId: row.id, kind: 'case.updated', actorId: user.userId, detailJson: JSON.stringify(body) } });
  return c.json({ success: true, data: serializeCase(row as unknown as Record<string, unknown>) });
});

securityFusionRouter.post('/cases/:id/investigations', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const parsed = securityFusionInvestigationDraftSchema.safeParse(await c.req.json());
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map((issue) => issue.message).join('; '));
  const row = await saveInvestigation(c.req.param('id')!, getUser(c).userId, parsed.data);
  return c.json({ success: true, data: { ...row, draft: parsed.data, draftJson: undefined } }, 201);
});

securityFusionRouter.post('/cases/:id/evidence/:eventId/preserve', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const caseId = c.req.param('id')!;
  const row = await preserveEvidence(caseId, c.req.param('eventId')!, getUser(c).userId);
  await logAuditEvent({ action: 'security_fusion.evidence.preserve', actorId: getUser(c).userId, targetType: 'security-case', targetId: caseId, details: { evidenceId: row.id, sha256: row.sha256, byteSize: row.byteSize } });
  return c.json({ success: true, data: row }, 201);
});

securityFusionRouter.get('/evidence', requirePermission('security-fusion:evidence:read'), async (c) => {
  return c.json({ success: true, data: await getDb().securityFusionEvidence.findMany({ orderBy: { preservedAt: 'desc' }, take: 250 }) });
});

securityFusionRouter.get('/deletion-receipts', requirePermission('security-fusion:evidence:read'), async (c) => {
  const [receipts, chainHead] = await Promise.all([
    getDb().securityFusionDeletionReceipt.findMany({
      orderBy: { chainSequence: 'desc' },
      take: 250,
    }),
    getDb().securityFusionReceiptChainHead.findUnique({
      where: { id: 'security-fusion' },
      select: { headSha256: true, chainSequence: true, updatedAt: true },
    }),
  ]);
  return c.json({
    success: true,
    data: { receipts, chainHead },
  });
});

securityFusionRouter.get('/policies', async (c) => c.json({ success: true, data: {
  eventRetentionDays: SECURITY_FUSION_RETENTION_POLICY.eventDays,
  preservedEvidenceDays: SECURITY_FUSION_RETENTION_POLICY.evidenceDays,
  caseArchiveDays: SECURITY_FUSION_RETENTION_POLICY.caseArchiveDays,
  archiveGraceDays: SECURITY_FUSION_RETENTION_POLICY.archiveGraceDays,
  deletionReceiptDays: SECURITY_FUSION_RETENTION_POLICY.deletionReceiptDays,
  perCaseCeilings: {
    events: SECURITY_FUSION_RETENTION_POLICY.maxCaseEvents,
    entities: SECURITY_FUSION_RETENTION_POLICY.maxCaseEntities,
    relationships: SECURITY_FUSION_RETENTION_POLICY.maxCaseRelationships,
    preservedEvidence: SECURITY_FUSION_RETENTION_POLICY.maxPreservedEvidence,
    preservedEvidenceBytes: SECURITY_FUSION_RETENTION_POLICY.maxPreservedEvidenceBytes,
  },
  approvalTtlMinutes: 10,
  isolation: { defaultMinutes: 15, maximumMinutes: 30, defaultPolicy: 'blocked' },
  allowedActions: ['service_restart', 'host_isolation'],
  deniedActions: ['credential_rotation', 'network_block', 'arbitrary_command'],
} }));

securityFusionRouter.post('/cases/:id/actions/preview', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const parsed = securityFusionContainmentPreviewSchema.safeParse({ ...(await c.req.json()), caseId: c.req.param('id') });
  if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', parsed.error.issues.map((issue) => issue.message).join('; '));
  const node = await getDb().node.findUnique({ where: { id: parsed.data.nodeId } });
  if (!node || node.status !== 'ONLINE' || !node.lastHeartbeatAt || Date.now() - node.lastHeartbeatAt.getTime() > 120_000) {
    throw new HttpError(409, 'TARGET_NOT_READY', 'Containment target must be online with a fresh heartbeat');
  }
  const metadata = json(node.metadata) as Record<string, unknown>;
  const tags = json(node.tags);
  const tagList = Array.isArray(tags) ? tags.map(String) : [];
  if (parsed.data.kind === 'service_restart') {
    const allowlist = (process.env['SECURITY_FUSION_RESTART_ALLOWLIST'] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    const snapshot = await getDb().healthSnapshot.findFirst({ where: { nodeId: node.id, timestamp: { gte: new Date(Date.now() - 120_000), lte: new Date() } }, orderBy: { timestamp: 'desc' } });
    const reportedServices = snapshot ? json(snapshot.services) : [];
    const active = Array.isArray(reportedServices)
      ? reportedServices.some((service) => {
        const row = service as Record<string, unknown>;
        return typeof row['name'] === 'string' && row['name'].replace(/\.service$/, '') === parsed.data.serviceName?.replace(/\.service$/, '') && row['status'] === 'active';
      })
      : false;
    if (!parsed.data.serviceName || !allowlist.includes(parsed.data.serviceName) || !active) {
      throw new HttpError(403, 'SERVICE_RESTART_BLOCKED', 'Service must be globally allowlisted and currently reported active');
    }
  }
  if (parsed.data.kind === 'host_isolation') {
    const protectedNode = tagList.some((tag) => ['control-plane', 'network-infrastructure'].includes(tag));
    if (metadata['securityIsolationPolicy'] !== 'allow' || metadata['securityIsolationCapable'] !== true || protectedNode) {
      throw new HttpError(403, 'ISOLATION_BLOCKED', 'Isolation requires explicit policy and capability; control-plane and network nodes are protected');
    }
  }
  const preview = {
    ...parsed.data, node: { id: node.id, name: node.name, hostname: node.hostname },
    rollbackPlan: parsed.data.kind === 'host_isolation'
      ? `Automatic release after ${parsed.data.isolationMinutes ?? 15} minutes; ADMIN may release immediately.`
      : 'Verify the service returns active and the node heartbeat remains fresh.',
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  };
  const previewJson = JSON.stringify(preview);
  const row = await getDb().securityFusionAction.create({
    data: {
      caseId: parsed.data.caseId, nodeId: node.id, kind: parsed.data.kind,
      serviceName: parsed.data.serviceName, isolationMinutes: parsed.data.isolationMinutes ?? (parsed.data.kind === 'host_isolation' ? 15 : null),
      rationale: parsed.data.rationale, rollbackPlan: preview.rollbackPlan, previewJson,
      previewSha256: sha256(previewJson), requestedBy: getUser(c).userId,
    },
  });
  return c.json({ success: true, data: { ...row, preview, previewJson: undefined } }, 201);
});

securityFusionRouter.post('/actions/:id/request', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  // Legacy local-mode rows retain their non-null token columns, but no token is
  // ever disclosed or accepted. Containment execution belongs to the isolated
  // external approval boundary even during rollback to local read mode.
  const tokenHash = sha256(randomBytes(32).toString('hex'));
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  const row = await getDb().$transaction(async (db) => {
    const action = await db.securityFusionAction.findUnique({ where: { id: c.req.param('id') } });
    if (!action) throw new HttpError(409, 'INVALID_ACTION_STATE', 'Action is not previewable');
    const transitioned = await db.securityFusionAction.updateMany({
      where: { id: action.id, status: { in: securityFusionActionSources('pending_approval') } },
      data: { status: 'pending_approval', approvalTokenHash: tokenHash, approvalExpiresAt: expiresAt },
    });
    if (transitioned.count !== 1) {
      throw new HttpError(409, 'INVALID_ACTION_STATE', 'Action is not previewable');
    }
    await db.securityFusionActionApproval.create({
      data: {
        actionId: action.id,
        previewSha256: action.previewSha256,
        tokenHash,
        requestedBy: getUser(c).userId,
        expiresAt,
      },
    });
    return { ...action, status: 'pending_approval', approvalExpiresAt: expiresAt };
  });
  return c.json({ success: true, data: { id: row.id, status: row.status, approvalExpiresAt: row.approvalExpiresAt } });
});

securityFusionRouter.post('/actions/:id/approve', requireRole('ADMIN'), async () => {
  throw new HttpError(403, 'TELEGRAM_APPROVAL_REQUIRED',
    'Containment execution requires explicit permission through the external approval channel');
});

securityFusionRouter.post('/actions/:id/reject', requireRole('ADMIN'), async () => {
  throw new HttpError(403, 'TELEGRAM_DECISION_REQUIRED',
    'Decide the exact containment plan through the external approval channel');
});

securityFusionRouter.post('/actions/:id/cancel', requireRole('ADMIN', 'OPERATOR'), async (c) => {
  const actionId = c.req.param('id');
  const row = await getDb().securityFusionAction.updateMany({ where: { id: actionId, status: { in: securityFusionActionSources('cancelled') } }, data: { status: 'cancelled', approvalTokenHash: null } });
  if (row.count === 0) throw new HttpError(409, 'INVALID_ACTION_STATE', 'Only unexecuted actions may be cancelled');
  await getDb().securityFusionActionApproval.updateMany({ where: { actionId, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date() } });
  return c.json({ success: true, data: { id: actionId, status: 'cancelled' } });
});

securityFusionRouter.post('/actions/:id/release', requireRole('ADMIN'), async (c) => {
  const user = getUser(c);
  const claimed = await getDb().$transaction(async (db) => {
    const action = await db.securityFusionAction.findUnique({ where: { id: c.req.param('id') } });
    if (!action || action.kind !== 'host_isolation') {
      throw new HttpError(409, 'INVALID_ACTION_STATE', 'Only an executed isolation may be released');
    }
    const transitioned = await db.securityFusionAction.updateMany({
      where: { id: action.id, status: { in: securityFusionActionSources('release_pending') } },
      data: { status: 'release_pending' },
    });
    if (transitioned.count !== 1) {
      throw new HttpError(409, 'INVALID_ACTION_STATE', 'Only an executed isolation may be released');
    }
    const outbox = await db.securityFusionCommandOutbox.create({
      data: { actionId: action.id, operation: 'release', actorId: user.userId },
    });
    return { action, outbox };
  });
  await dispatchSecurityFusionOutbox();
  const dispatched = await getDb().securityFusionCommandOutbox.findUnique({ where: { id: claimed.outbox.id } });
  await getDb().securityFusionCaseActivity.create({
    data: { caseId: claimed.action.caseId, kind: 'isolation.release_requested', actorId: user.userId, detailJson: JSON.stringify({ actionId: claimed.action.id, outboxId: claimed.outbox.id, commandId: dispatched?.remoteCommandId ?? null }) },
  });
  return c.json({ success: true, data: { id: claimed.action.id, status: dispatched?.status === 'dispatched' ? 'releasing' : 'release_pending', commandId: dispatched?.remoteCommandId ?? null } }, 202);
});
