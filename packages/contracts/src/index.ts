import { z } from 'zod';

export const dependencyHealthItemSchema = z.object({
  name: z.string(),
  status: z.enum(['pass', 'warn', 'fail', 'skip']),
  message: z.string(),
  latencyMs: z.number().optional(),
});

export const dependencyHealthSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  generatedAt: z.string(),
  checks: z.array(dependencyHealthItemSchema),
});

export const fleetReadinessNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  ipAddress: z.string(),
  status: z.string(),
  operationalStatus: z.string(),
  agentVersion: z.string().nullable(),
  agentStatus: z.string().nullable(),
  os: z.string(),
  arch: z.string(),
  lastHeartbeatAt: z.string().nullable(),
  heartbeatAgeMs: z.number().nullable(),
  stale: z.boolean(),
  deployEligible: z.boolean(),
  destructiveActionsBlocked: z.boolean(),
});

export const fleetReadinessSchema = z.object({
  generatedAt: z.string(),
  thresholds: z.object({ staleNodeMs: z.number() }),
  expectedFingerprints: z.object({
    nodeManagerSecret: z.string().nullable(),
    apiSecret: z.string().nullable(),
  }),
  nodes: z.array(fleetReadinessNodeSchema),
});

export const apiErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});
export const apiSuccessSchema = <T extends z.ZodTypeAny>(data: T) => z.object({
  success: z.literal(true), data,
  meta: z.object({ total: z.number().optional(), page: z.number().optional(), pageSize: z.number().optional(), hasMore: z.boolean().optional() }).optional(),
});
export const timelineItemSchema = z.object({
  type: z.string(), severity: z.string(), title: z.string(), node: z.string().optional(), timestamp: z.string(), href: z.string(),
}).passthrough();
export const incidentSummarySchema = z.object({ generatedAt: z.string() }).passthrough();
export const hermesEffectiveStateSchema = z.object({ generatedAt: z.string() }).passthrough();
export const rolloutStatusSchema = z.object({
  id: z.string(), type: z.string(), strategy: z.string(), status: z.string(), totalNodes: z.number(), completedNodes: z.number(), failedNodes: z.number(),
  metadata: z.record(z.string(), z.unknown()), createdBy: z.string(), createdAt: z.coerce.date(), startedAt: z.coerce.date().nullable(), completedAt: z.coerce.date().nullable(),
  targets: z.array(z.object({ id: z.string(), nodeId: z.string(), hostname: z.string(), status: z.string(), error: z.string().nullable(), startedAt: z.coerce.date().nullable(), completedAt: z.coerce.date().nullable() })),
});
export const agentHeartbeatAcceptanceSchema = z.object({ accepted: z.boolean(), acceptedAt: z.string().nullable(), error: z.string().nullable().optional() });

export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;
export type DependencyHealthItem = z.infer<typeof dependencyHealthItemSchema>;
export type FleetReadiness = z.infer<typeof fleetReadinessSchema>;
export type FleetReadinessNode = z.infer<typeof fleetReadinessNodeSchema>;
export type TimelineItem = z.infer<typeof timelineItemSchema>;
export type IncidentSummary = z.infer<typeof incidentSummarySchema>;
export type HermesEffectiveState = z.infer<typeof hermesEffectiveStateSchema>;
export type RolloutStatus = z.infer<typeof rolloutStatusSchema>;

export const securityFusionSourceSchema = z.enum([
  'unifi_dns',
  'unifi_ids',
  'netflow',
  'wazuh',
  'tailscale',
  'magnus',
  'hive',
  'mattermost',
  'magnus_ui',
  'security_console',
]);
export const securityFusionSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export const securityFusionEntityTypeSchema = z.enum(['user', 'host', 'device', 'ip', 'service', 'account', 'domain']);
export const securityFusionCaseStatusSchema = z.enum([
  'new', 'triage', 'investigating', 'contained', 'monitoring', 'resolved', 'false_positive',
]);

export const securityFusionEntityRefSchema = z.object({
  type: securityFusionEntityTypeSchema,
  value: z.string().min(1).max(512),
  label: z.string().min(1).max(160).optional(),
});

export const securityFusionEventSchema = z.object({
  schemaVersion: z.literal('1.0'),
  eventId: z.string().min(1).max(160),
  source: securityFusionSourceSchema,
  sourceEventId: z.string().min(1).max(512),
  kind: z.string().min(1).max(160),
  observedAt: z.string().datetime({ offset: true }),
  severity: securityFusionSeveritySchema,
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(2000),
  entities: z.array(securityFusionEntityRefSchema).max(32).default([]),
  attributes: z.record(z.string(), z.unknown()).default({}),
  evidence: z.array(z.object({
    sourceLocator: z.string().max(1000),
    mediaType: z.string().max(120).default('application/json'),
    snapshot: z.record(z.string(), z.unknown()).optional(),
  })).max(16).default([]),
});

export const securityFusionEventBatchSchema = z.object({
  schemaVersion: z.literal('1.0'),
  collectorId: z.string().min(1).max(160),
  sentAt: z.string().datetime({ offset: true }),
  events: z.array(securityFusionEventSchema).min(1).max(100),
  checkpoints: z.partialRecord(securityFusionSourceSchema, z.string().max(2000)).optional(),
});

export const securityFusionSourceStatusSchema = z.enum([
  'unconfigured',
  'configured',
  'healthy',
  'degraded',
  'error',
]);

export const securityFusionSourceReportSchema = z.object({
  schemaVersion: z.literal('1.0'),
  collectorId: z.string().min(1).max(160),
  sentAt: z.string().datetime({ offset: true }),
  sources: z.array(z.object({
    source: securityFusionSourceSchema,
    status: securityFusionSourceStatusSchema,
    lastEventAt: z.string().datetime({ offset: true }).optional(),
    checkpoint: z.string().max(2000).optional(),
    error: z.string().max(500).optional(),
  })).min(1).max(8),
});

export const securityFusionInvestigationDraftSchema = z.object({
  summary: z.string().min(1).max(4000),
  hypotheses: z.array(z.string().min(1).max(1000)).max(12),
  prioritizedChecks: z.array(z.string().min(1).max(1000)).max(20),
  proposedActions: z.array(z.object({
    kind: z.enum(['service_restart', 'host_isolation', 'credential_rotation', 'network_block', 'other']),
    description: z.string().min(1).max(1200),
    risk: z.enum(['low', 'medium', 'high', 'critical']),
    reversible: z.boolean(),
    requiresApproval: z.literal(true),
    executable: z.literal(false),
  })).max(12),
  evidenceSteps: z.array(z.string().min(1).max(1000)).max(20),
});

export const securityFusionContainmentPreviewSchema = z.object({
  caseId: z.string().min(1),
  nodeId: z.string().min(1),
  kind: z.enum(['service_restart', 'host_isolation']),
  serviceName: z.string().regex(/^[a-zA-Z0-9@_.-]+$/).optional(),
  isolationMinutes: z.number().int().min(1).max(30).optional(),
  rationale: z.string().min(10).max(2000),
}).superRefine((value, context) => {
  if (value.kind === 'service_restart' && !value.serviceName) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceName'], message: 'serviceName is required for service restart' });
  }
});

export type SecurityFusionSource = z.infer<typeof securityFusionSourceSchema>;
export type SecurityFusionSeverity = z.infer<typeof securityFusionSeveritySchema>;
export type SecurityFusionEntityRef = z.infer<typeof securityFusionEntityRefSchema>;
export type SecurityFusionEvent = z.infer<typeof securityFusionEventSchema>;
export type SecurityFusionEventBatch = z.infer<typeof securityFusionEventBatchSchema>;
export type SecurityFusionSourceStatus = z.infer<typeof securityFusionSourceStatusSchema>;
export type SecurityFusionSourceReport = z.infer<typeof securityFusionSourceReportSchema>;
export type SecurityFusionInvestigationDraft = z.infer<typeof securityFusionInvestigationDraftSchema>;
export type SecurityFusionContainmentPreview = z.infer<typeof securityFusionContainmentPreviewSchema>;

export * from './magnus-observations.js';
export * from './ardent-client.js';
export * from './ardent.js';

/** Minimal read-only target export; fleet registration remains on Magnus. */
export const securityInventoryTargetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  hostname: z.string().min(1),
  baseUrl: z
    .string()
    .url()
    .refine(
      (value) => new URL(value).protocol === "https:",
      "Agent TLS required",
    ),
  tags: z.string(),
  metadata: z.string(),
});
export const securityInventoryExportSchema = z.object({
  data: z.array(securityInventoryTargetSchema).max(10000),
});
export type SecurityInventoryTarget = z.infer<
  typeof securityInventoryTargetSchema
>;
export type SecurityInventoryExport = z.infer<
  typeof securityInventoryExportSchema
>;

