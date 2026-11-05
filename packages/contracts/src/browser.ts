// Public browser contract for the Magnus console API, derived from the control API's
// real responses (the cited file names the server source of each shape). Zod schemas
// only, with no server imports, so it can be exported and pinned by a static console.
//
// Paths are relative to /api/v1. Response objects strip unknown keys when parsed.
// Several columns are JSON-encoded strings on the wire, and the schemas say so.
// Secret-like fields are deliberately not modelled; see docs/console-api.md.
import { z } from 'zod';

export const magnusBrowserContractVersion = 1;

export type ConsoleRole = 'ADMIN' | 'OPERATOR' | 'VIEWER';

const ANY_ROLE = ['ADMIN', 'OPERATOR', 'VIEWER'] as const;
const WRITE_ROLES = ['ADMIN', 'OPERATOR'] as const;
const ADMIN_ONLY = ['ADMIN'] as const;

/** A JS Date passed through c.json, or a value the server built with toISOString(). */
const isoDate = z.iso.datetime();

/** A JSON object held in a column or reported by an agent, with no fixed fields. */
const jsonRecord = z.record(z.string(), z.json());

const ok = <T extends z.ZodType>(data: T) => z.object({ success: z.literal(true), data });

/** Mirrors SENSITIVE_KEYS in services/control-api/src/services/audit-service.ts. */
const SENSITIVE_ENV_KEYS = new Set([
  'token', 'password', 'secret', 'apiKey', 'api_key', 'apiSecret', 'api_secret', 'authorization',
  'nodeToken', 'nodeManagerSecret', 'x-node-token', 'x-api-secret', 'x-resource-drain-key',
  'jwt', 'jwtSecret', 'jwt_secret', 'deployPassword', 'deploy_password', 'credentials',
  'privateKey', 'private_key', 'accessToken', 'access_token', 'refreshToken', 'refresh_token',
]);

// ── Console session ──
// services/control-api/src/routes/console.ts
export const consoleRoleSchema = z.enum(['ADMIN', 'OPERATOR', 'VIEWER']);
export const consoleCapabilitiesSchema = z.object({
  hermes: z.boolean(),
  agentVersion: z.string(),
  magnusVersion: z.string(),
  securityConsoleUrl: z.string().nullable(),
});
export const consoleSessionSchema = z.object({
  userId: z.string().min(1),
  role: consoleRoleSchema,
  capabilities: consoleCapabilitiesSchema,
});
export const consoleSessionResponseSchema = ok(consoleSessionSchema);

// ─── Shared errors ───
// services/control-api/src/middleware/error-handler.ts (routes/ops.ts also sends inline errors without a code)
export const apiErrorSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string().optional(), message: z.string() }),
});

// ── Shared enums ──
// services/control-api/prisma/schema.prisma
export const nodeStatusSchema = z.enum(['ONLINE', 'OFFLINE', 'DEGRADED', 'PROVISIONING', 'DECOMMISSIONED']);

// services/control-api/prisma/schema.prisma
export const agentStatusSchema = z.enum(['RUNNING', 'STOPPED', 'UPDATING', 'ERROR']);

// services/control-api/prisma/schema.prisma
export const commandStatusSchema = z.enum(['PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED']);

// ── Public health ──
// services/control-api/src/routes/health.ts
export const publicHealthResponseSchema = ok(z.object({
  service: z.string(),
  status: z.literal('ok'),
}));

// ── Stats overview ──
// services/control-api/src/services/codex-service.ts
export const codexFleetNodeSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  hostname: z.string(),
  version: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  authStatus: z.enum(['authenticated', 'not_authenticated', 'wrong_auth_mode', 'expired_logged_out', 'error']),
  oauth: z.boolean(),
  checkedAt: z.string(),
});

// services/control-api/src/services/codex-service.ts
export const codexFleetPostureSchema = z.object({
  status: z.enum(['warming', 'ready']),
  generatedAt: isoDate,
  refreshedAt: z.string().nullable(),
  ageMs: z.number().nullable(),
  scanIntervalMs: z.number(),
  scanInProgress: z.boolean(),
  managedNodes: z.number(),
  installations: z.number(),
  authenticatedWithChatgptOauth: z.number(),
  updatesAvailable: z.number(),
  needsLogin: z.number(),
  currentRelease: z.string().nullable(),
  nodes: z.array(codexFleetNodeSchema),
});

// services/control-api/src/routes/stats.ts
export const statsRecentCommandSchema = z.object({
  id: z.string(),
  command: z.string(),
  status: commandStatusSchema,
  createdAt: isoDate,
  node: z.object({ name: z.string() }),
});

// services/control-api/src/routes/stats.ts (today's audit file only; audit lines are read back untyped)
export const statsRecentAuditSchema = z.object({
  id: z.string(),
  action: z.string(),
  timestamp: z.string(),
  targetType: z.string(),
  targetId: z.string(),
});

// services/control-api/src/routes/stats.ts
export const statsOverviewSchema = z.object({
  nodes: z.object({
    total: z.number(),
    online: z.number(),
    offline: z.number(),
    degraded: z.number(),
    provisioning: z.number(),
  }),
  commands: z.object({ total: z.number(), running: z.number(), pending: z.number() }),
  cron: z.object({ total: z.number(), active: z.number() }),
  health: z.object({
    avgCpuPercent: z.number().nullable(),
    avgMemoryPercent: z.number().nullable(),
    reportingNodes: z.number(),
  }),
  codex: codexFleetPostureSchema,
  recentCommands: z.array(statsRecentCommandSchema),
  recentAudit: z.array(statsRecentAuditSchema),
});

// services/control-api/src/routes/stats.ts
export const statsOverviewResponseSchema = ok(statsOverviewSchema);

// ── Nodes ──
// services/control-api/prisma/schema.prisma (token never returned; tags and metadata are JSON strings, and metadata carries secret fingerprints for ADMIN only)
export const nodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  ipAddress: z.string(),
  port: z.number().int(),
  status: nodeStatusSchema,
  os: z.string(),
  arch: z.string(),
  tags: z.string(),
  metadata: z.string(),
  roleId: z.string().nullable(),
  lastHeartbeatAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

// services/control-api/prisma/schema.prisma (capabilities is a JSON string)
export const nodeAgentSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  version: z.string(),
  status: agentStatusSchema,
  pid: z.number().int().nullable(),
  startedAt: isoDate,
  lastCheckIn: isoDate,
  capabilities: z.string(),
});

// services/control-api/src/services/agent-upgrade-readiness.ts
export const readinessProblemSchema = z.object({
  code: z.string(),
  detail: z.string(),
  cause: z.string(),
  remedy: z.string(),
});

// services/control-api/src/services/agent-upgrade-readiness.ts
export const upgradeReadinessSchema = z.object({
  status: z.enum(['ok', 'not-ready', 'unknown']),
  problems: z.array(readinessProblemSchema),
  observedAt: z.string().nullable(),
});

// services/control-api/src/routes/nodes.ts (include agent and role; readiness is null when it cannot be computed)
export const nodeWithRelationsSchema = nodeSchema.extend({
  agent: nodeAgentSchema.nullable(),
  role: z.object({ id: z.string(), name: z.string() }).nullable(),
  upgradeReadiness: upgradeReadinessSchema.nullable(),
});

// services/control-api/src/routes/nodes.ts (pageSize clamped to 100; status upper-cased server-side, an unknown value fails with 500).
export const nodeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  status: z.string().optional(),
  tag: z.string().optional(),
  query: z.string().optional(),
});

// services/control-api/src/routes/nodes.ts
export const nodeListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(nodeWithRelationsSchema),
  meta: z.object({
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
    hasMore: z.boolean(),
  }),
});

// services/control-api/src/routes/nodes.ts
export const nodeDetailResponseSchema = ok(nodeWithRelationsSchema);

// services/control-api/src/schemas/nodes.ts
export const registerNodeRequestSchema = z.object({
  name: z.string().min(1, 'name is required'),
  hostname: z.string().min(1, 'hostname is required'),
  ipAddress: z.string().min(1, 'ipAddress is required'),
  port: z.number().int().min(1).max(65535).optional().default(4100),
  os: z.string().optional(),
  arch: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  agentVersion: z.string().optional(),
});

// services/control-api/src/routes/nodes.ts (the raw body also carries the node token, once, with Cache-Control: no-store)
export const registerNodeResponseSchema = ok(z.object({
  nodeId: z.string(),
  controlApiUrl: z.string(),
}));

// services/control-api/src/schemas/nodes.ts (the server uppercases status; a non-enum value fails in Prisma)
export const updateNodeRequestSchema = z.object({
  name: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: z.string().optional(),
  roleId: z.string().nullable().optional(),
});

// services/control-api/src/routes/nodes.ts (no agent, role or readiness on this response)
export const updateNodeResponseSchema = ok(nodeSchema);

// services/control-api/src/routes/nodes.ts
export const deleteNodeResponseSchema = ok(z.object({ deleted: z.literal(true) }));

// ── Values encoded as JSON strings: JSON.parse first, then apply these ──
// packages/contracts/src/release.ts (state is an open string so newer agents still parse)
export const agentUpgradeReportSchema = z.object({
  state: z.string(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  requestId: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  attempt: z.number().int().optional(),
  updatedAt: z.string().optional(),
});

// packages/contracts/src/release.ts and services/control-api/src/services/agent-upgrade-service.ts
export const storedAgentSelfUpgradeSchema = z.object({
  protocol: z.number().int(),
  launcherProtocol: z.number().int().nullable(),
  layout: z.enum(['versioned', 'legacy', 'container']),
  enabled: z.boolean(),
  reason: z.string().nullable().optional(),
  reasonCode: z.string().nullable().optional(),
  upgrade: agentUpgradeReportSchema.nullable().optional(),
  confirmSeconds: z.number().int().nullable().optional(),
  managedEnrollment: z.object({ nodeId: z.string(), nodeFqdn: z.string() }).nullable().optional(),
  managedEnrollmentState: z.enum(['absent', 'present', 'unknown']).optional(),
  nodeVersion: z.string().nullable().optional(),
  observedAt: z.string().optional(),
});

// Decodes node.metadata for the fields the pages read: services/control-api/src/services/agent-upgrade-service.ts
export const nodeMetadataSchema = z.object({
  agentSelfUpgrade: storedAgentSelfUpgradeSchema.optional(),
  deployError: z.string().optional(),
  upgradeError: z.string().optional(),
  nodeVersion: z.json().optional(),
  nodeManagerSecretState: z.enum(['active', 'previous', 'unknown']).optional(),
  nodeManagerSecretObservedAt: z.string().optional(),
});

// Decodes elements of health.disks: services/control-api/src/types/shared-contracts.ts
export const diskInfoSchema = z.object({
  mountPoint: z.string(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  freeBytes: z.number(),
  usagePercent: z.number(),
  filesystem: z.string(),
  filesystemType: z.string().optional(),
});

// Decodes elements of health.network: services/control-api/src/types/shared-contracts.ts
export const networkInfoSchema = z.object({
  interface: z.string(),
  rxBytes: z.number(),
  txBytes: z.number(),
  rxErrors: z.number(),
  txErrors: z.number(),
  ipAddress: z.string().nullable().optional(),
});

// Decodes elements of health.services: services/control-api/src/types/shared-contracts.ts (details may be an object)
export const serviceInfoSchema = z.object({
  name: z.string(),
  status: z.string(),
  pid: z.number().nullable().optional(),
  memoryBytes: z.number().nullable().optional(),
  cpuPercent: z.number().nullable().optional(),
  details: z.json().optional(),
  targetUser: z.string().nullable().optional(),
  remediationAttempted: z.boolean().optional(),
  remediationSucceeded: z.boolean().optional(),
  requiresRecheck: z.boolean().optional(),
});

// ── Node health ──
// services/control-api/prisma/schema.prisma (BigInt columns become numbers at services/control-api/src/routes/nodes.ts; String columns stay JSON strings)
export const healthSnapshotSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  timestamp: isoDate,
  cpuUsagePercent: z.number(),
  cpuCores: z.number().int(),
  cpuLoadAverage: z.string(),
  memoryTotalBytes: z.number(),
  memoryUsedBytes: z.number(),
  memoryPercent: z.number(),
  swapTotalBytes: z.number(),
  swapUsedBytes: z.number(),
  disks: z.string(),
  network: z.string(),
  services: z.string(),
  wazuh: z.string(),
  systemUpdates: z.string(),
  cockpitAvailable: z.boolean(),
  source: z.string(),
});

// services/control-api/src/routes/nodes.ts (404 NOT_FOUND when the node has no snapshot)
export const nodeHealthResponseSchema = ok(healthSnapshotSchema);

// services/control-api/src/routes/nodes.ts (query; limit defaults to 100 and is clamped to 500)
export const nodeHealthHistoryQuerySchema = z.object({
  limit: z.coerce.number().optional(),
});

// services/control-api/src/routes/nodes.ts (a bare array, newest first)
export const nodeHealthHistoryResponseSchema = ok(z.array(healthSnapshotSchema));

// services/control-api/src/routes/nodes.ts (query)
export const nodeHealthTimeseriesQuerySchema = z.object({
  metric: z.enum(['cpu', 'memory', 'swap', 'disk']).optional(),
  period: z.enum(['1h', '6h', '24h', '7d', '30d']).optional(),
});

// services/control-api/src/routes/nodes.ts (all zeros and empty arrays when there are no samples)
export const nodeHealthTimeseriesResponseSchema = ok(z.object({
  timestamps: z.array(isoDate),
  values: z.array(z.number()),
  min: z.number(),
  max: z.number(),
  avg: z.number(),
}));

// services/control-api/src/routes/health.ts (query; days defaults to 30 and is clamped to 365)
export const nodeForecastQuerySchema = z.object({
  days: z.coerce.number().optional(),
});

// services/control-api/src/types/shared-contracts.ts
export const diskForecastSchema = z.object({
  mountPoint: z.string(),
  currentUsagePercent: z.number(),
  growthRatePerDay: z.number(),
  estimatedFullDate: z.string().nullable(),
  daysUntilFull: z.number().nullable(),
  confidence: z.number(),
  workloadClass: z.enum(['models', 'downloads-cache', 'general']),
  recommendation: z.string(),
});

// services/control-api/src/routes/health.ts
export const nodeForecastResponseSchema = ok(z.object({
  nodeId: z.string(),
  hostname: z.string(),
  lookbackDays: z.number(),
  forecasts: z.array(diskForecastSchema),
}));

// ── GPU ──
// services/control-api/src/schemas/node-responses.ts (validated at ingest, stored as JSON, parsed on read)
export const gpuDeviceSchema = z.object({
  index: z.number().int(),
  vendor: z.enum(['nvidia', 'amd']),
  name: z.string(),
  uuid: z.string().nullable(),
  utilizationPercent: z.number().nullable(),
  fanPercent: z.number().nullable(),
  temperatureCelsius: z.number().nullable(),
});

// services/control-api/src/routes/nodes.ts
export const gpuSnapshotPointSchema = z.object({
  sampledAt: isoDate,
  sampleIntervalSeconds: z.number().int(),
  status: z.enum(['ok', 'unavailable', 'error']),
  devices: z.array(gpuDeviceSchema),
  maxUtilizationPercent: z.number().nullable(),
  maxFanPercent: z.number().nullable(),
});

// services/control-api/src/routes/nodes.ts (query; period defaults to 24h)
export const nodeGpuQuerySchema = z.object({
  period: z.enum(['6h', '24h', '7d']).optional(),
});

// services/control-api/src/routes/nodes.ts
export const nodeGpuResponseSchema = ok(z.object({
  period: z.enum(['6h', '24h', '7d']),
  latest: gpuSnapshotPointSchema.nullable(),
  history: z.array(gpuSnapshotPointSchema),
}));

// ── Fleet posture summaries ──
// services/control-api/src/services/tailscale-node-key-service.ts
export const tailscaleNodeKeyPostureSchema = z.object({
  status: z.string(),
  backendState: z.string(),
  dnsName: z.string().nullable(),
  online: z.boolean().nullable(),
  keyExpiry: z.string().nullable(),
  daysRemaining: z.number().nullable(),
  expiryEnabled: z.boolean(),
  expired: z.boolean(),
  requiresRenewal: z.boolean(),
});

// services/control-api/src/routes/nodes.ts
export const tailscaleInventoryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  nodeStatus: nodeStatusSchema,
  lastHeartbeatAt: isoDate.nullable(),
  observedAt: isoDate.nullable(),
  tailscale: tailscaleNodeKeyPostureSchema.nullable(),
});

// services/control-api/src/routes/nodes.ts
export const tailscaleSummaryResponseSchema = ok(z.object({
  total: z.number(),
  reporting: z.number(),
  expiryEnabled: z.number(),
  expiringSoon: z.number(),
  expired: z.number(),
  warningDays: z.number(),
  nodes: z.array(tailscaleInventoryItemSchema),
}));

// services/control-api/src/routes/nodes.ts
export const systemUpdatePostureSchema = z.object({
  supported: z.boolean(),
  platform: z.string(),
  automaticUpdates: z.enum(['enabled', 'disabled', 'partial', 'unsupported', 'unknown']),
  unattendedUpgradesInstalled: z.boolean(),
  periodicUpdateListsEnabled: z.boolean(),
  periodicUnattendedUpgradeEnabled: z.boolean(),
  fullUpgradePolicyEnabled: z.boolean(),
  timers: z.array(z.object({
    name: z.string(),
    enabled: z.boolean(),
    active: z.boolean(),
    state: z.string(),
  })),
  rebootRequired: z.boolean(),
  rebootRequiredPackages: z.array(z.string()),
});

// services/control-api/src/routes/nodes.ts
export const systemUpdateInventoryItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  nodeStatus: nodeStatusSchema,
  lastHeartbeatAt: isoDate.nullable(),
  observedAt: isoDate.nullable(),
  systemUpdates: systemUpdatePostureSchema.nullable(),
});

// services/control-api/src/routes/nodes.ts
export const systemUpdatesSummaryResponseSchema = ok(z.object({
  total: z.number(),
  reporting: z.number(),
  enabled: z.number(),
  actionNeeded: z.number(),
  rebootRequired: z.number(),
  nodes: z.array(systemUpdateInventoryItemSchema),
}));

// services/control-api/src/routes/nodes.ts (the agent's answer is passed through unvalidated, so older agents may omit fullUpgradePolicyEnabled)
export const enableSystemUpdatesResponseSchema = ok(systemUpdatePostureSchema.partial({ fullUpgradePolicyEnabled: true }));

// ── Fleet readiness ──
// services/control-api/src/services/ops-service.ts
export const readinessHealthSchema = z.object({
  timestamp: isoDate,
  cpuUsagePercent: z.number(),
  memoryPercent: z.number(),
  diskWarnings: z.array(z.object({ mountPoint: z.string(), usagePercent: z.number() })),
});

// services/control-api/src/services/ops-service.ts
export const readinessHermesSchema = z.object({
  status: z.string(),
  version: z.string().nullable(),
  gatewayStatus: z.string(),
  lastDetectedAt: isoDate.nullable(),
});

// services/control-api/src/services/ops-service.ts (includes sentinel nodes __control-api__ and __dashboard__, which the page filters out)
export const fleetReadinessNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  ipAddress: z.string(),
  status: nodeStatusSchema,
  operationalStatus: z.union([nodeStatusSchema, z.literal('STALE')]),
  role: z.string().nullable(),
  agentVersion: z.string().nullable(),
  agentStatus: agentStatusSchema.nullable(),
  nodeVersion: z.json(),
  os: z.string(),
  arch: z.string(),
  lastHeartbeatAt: isoDate.nullable(),
  heartbeatAgeMs: z.number().nullable(),
  stale: z.boolean(),
  deployEligible: z.boolean(),
  destructiveActionsBlocked: z.boolean(),
  health: readinessHealthSchema.nullable(),
  hermes: readinessHermesSchema.nullable(),
  secretFingerprint: z.object({
    match: z.enum(['unknown', 'match', 'mismatch']),
    state: z.enum(['active', 'previous', 'unknown']),
    /** Present for ADMIN only. */
    expectedNodeManagerSecret: z.string().nullable().optional(),
    /** Present for ADMIN only. */
    observedNodeManagerSecret: z.string().nullable().optional(),
  }),
});

// services/control-api/src/routes/ops.ts
export const fleetReadinessResponseSchema = ok(z.object({
  generatedAt: isoDate,
  thresholds: z.object({ staleNodeMs: z.number() }),
  /** Present for ADMIN only. */
  expectedFingerprints: z.object({ nodeManagerSecret: z.string().nullable(), apiSecret: z.string().nullable() }).optional(),
  nodes: z.array(fleetReadinessNodeSchema),
}));

// ── Hermes inventory ──
// services/control-api/src/types/shared-contracts.ts (agent-reported and cast without validation, so every field may be absent)
export const hermesRuntimeConfigurationSchema = z.object({
  configPresent: z.boolean().optional(),
  configPath: z.string().nullable().optional(),
  envPath: z.string().nullable().optional(),
  envKeys: z.array(z.string()).optional(),
  modelProvider: z.string().nullable().optional(),
  modelName: z.string().nullable().optional(),
  modelBaseUrl: z.string().nullable().optional(),
  openaiRuntime: z.enum(['auto', 'codex_app_server']).nullable().optional(),
  magnusRouterConfigured: z.boolean().optional(),
  memoryProvider: z.string().nullable().optional(),
  hiveMemConfigured: z.boolean().optional(),
  hiveMemPluginInstalled: z.boolean().optional(),
  hiveMemApiUrl: z.string().nullable().optional(),
  hiveMemToken: z.object({
    status: z.enum(['missing', 'valid', 'expiring', 'expired', 'rejected', 'unreachable', 'unknown']),
    expiresAt: z.string().nullable(),
    checkedAt: z.string(),
  }).nullable().optional(),
  magnusSkills: z.object({
    status: z.enum(['available', 'not_configured']),
    message: z.string(),
  }).optional(),
});

// services/control-api/src/services/hermes-service.ts (installation is present only on the profile list)
export const hermesProfileSchema = z.object({
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
  description: z.string(),
  profileHome: z.string(),
  isDefault: z.boolean(),
  providerSummary: z.string().nullable(),
  modelSummary: z.string().nullable(),
  distribution: z.string().nullable(),
  gatewayStatus: z.string(),
  apiServerEnabled: z.boolean(),
  apiServerHost: z.string(),
  apiServerPort: z.number().int().nullable(),
  apiServerKeyConfigured: z.boolean(),
  /** Present for ADMIN only. */
  apiServerKeyFingerprint: z.string().nullable().optional(),
  capabilities: jsonRecord,
  envStatus: jsonRecord,
  metadata: jsonRecord,
  lastSyncedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  installation: z.object({
    id: z.string(),
    hostname: z.string(),
    displayName: z.string().nullable(),
    status: z.string(),
  }).optional(),
});

// services/control-api/src/services/hermes-service.ts (status columns are free strings in the database)
export const hermesInstallationSchema = z.object({
  id: z.string(),
  nodeId: z.string().nullable(),
  hostname: z.string(),
  sshPort: z.number().int(),
  displayName: z.string().nullable(),
  installMode: z.string(),
  hermesHome: z.string(),
  hermesBin: z.string(),
  version: z.string().nullable(),
  status: z.string(),
  gatewayStatus: z.string(),
  dashboardHost: z.string(),
  dashboardPort: z.number().int(),
  dashboardStatus: z.string(),
  apiServerEnabled: z.boolean(),
  apiServerHost: z.string(),
  apiServerPort: z.number().int().nullable(),
  lastDetectedAt: isoDate.nullable(),
  lastSyncedAt: isoDate.nullable(),
  metadata: jsonRecord,
  rawStatus: jsonRecord,
  configuration: hermesRuntimeConfigurationSchema.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  profiles: z.array(hermesProfileSchema).optional(),
});

// services/control-api/src/routes/hermes.ts
export const hermesInstallationsResponseSchema = ok(z.array(hermesInstallationSchema));

// services/control-api/src/routes/hermes.ts
export const hermesProfilesResponseSchema = ok(z.array(hermesProfileSchema));

// ── AI insights ──
// services/control-api/src/services/ai-insights-service.ts
export const aiInsightSchema = z.object({
  title: z.string(),
  body: z.string(),
  severity: z.enum(['critical', 'warning', 'info', 'success']),
  category: z.string(),
  nodeId: z.string().optional(),
});

// services/control-api/src/routes/assistant.ts (when generation fails this is still a 200 with one fallback insight)
export const aiInsightsResponseSchema = ok(z.object({
  insights: z.array(aiInsightSchema),
  generatedAt: z.string(),
  conversationId: z.string().optional(),
}));

// services/control-api/src/services/ai-insights-service.ts (stored as the request sent it: the server checks only title and body)
export const pinnedInsightSchema = z.object({
  id: z.string(),
  pinnedAt: z.string(),
  title: z.string(),
  body: z.string(),
  severity: z.string().optional(),
  category: z.string().optional(),
  nodeId: z.string().nullish(),
  generatedAt: z.string().nullish(),
});

// services/control-api/src/routes/assistant.ts
export const pinnedInsightsResponseSchema = ok(z.object({ pins: z.array(pinnedInsightSchema) }));

// services/control-api/src/routes/assistant.ts (title and body must be non-blank after trim; severity and category follow the handler's declared type)
export const pinInsightRequestSchema = z.object({
  title: z.string().refine((value) => value.trim().length > 0, 'title and body are required'),
  body: z.string().refine((value) => value.trim().length > 0, 'title and body are required'),
  severity: z.enum(['critical', 'warning', 'info', 'success']),
  category: z.string(),
  nodeId: z.string().optional(),
  generatedAt: z.string().optional(),
});

// services/control-api/src/routes/assistant.ts
export const pinInsightResponseSchema = ok(pinnedInsightSchema);

// services/control-api/src/routes/assistant.ts (no data key)
export const unpinInsightResponseSchema = z.object({ success: z.literal(true) });

// ── Roles ──
// services/control-api/src/routes/roles.ts
export const roleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  libraryFileIds: z.array(z.string()),
  skillNames: z.array(z.string()),
  aptPackages: z.array(z.string()),
  npmPackages: z.array(z.string()),
  dockerEnabled: z.boolean(),
  dockerNonRoot: z.boolean(),
  dockerImage: z.string().nullable(),
  dockerVolumes: z.array(z.string()),
  firewallEnabled: z.boolean(),
  firewallMode: z.string(),
  firewallAllowRules: z.array(z.string()),
  status: z.string(),
  createdAt: isoDate,
  updatedAt: isoDate,
  _count: z.object({ nodes: z.number() }),
  envConfigKeys: z.array(z.string()),
  /** Present for ADMIN only. A PATCH below ADMIN merges: a key left out or left blank keeps its value. */
  envConfig: z.record(z.string(), z.string()).optional(),
});

// services/control-api/src/routes/roles.ts
export const roleListResponseSchema = ok(z.array(roleSchema));

// services/control-api/src/routes/roles.ts (steps are parsed from a JSON string)
export const roleApplicationSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  roleId: z.string(),
  action: z.string(),
  status: z.string(),
  steps: z.array(z.json()),
  error: z.string().nullable(),
  startedAt: isoDate.nullable(),
  completedAt: isoDate.nullable(),
  createdAt: isoDate,
});

// services/control-api/src/schemas/roles.ts
export const assignRoleRequestSchema = z.object({
  nodeIds: z.array(z.string().min(1)).min(1, 'At least one nodeId is required'),
  defer: z.boolean().optional().default(false),
});

// services/control-api/src/routes/roles.ts (applications is empty when deferred or when the role is not active)
export const assignRoleResponseSchema = ok(z.object({
  assigned: z.number(),
  deferred: z.boolean(),
  applications: z.array(roleApplicationSchema),
}));

// services/control-api/src/schemas/roles.ts
export const unassignRoleRequestSchema = z.object({
  nodeIds: z.array(z.string().min(1)).min(1, 'At least one nodeId is required'),
});

// services/control-api/src/routes/roles.ts
export const unassignRoleResponseSchema = ok(z.object({
  unassigned: z.number(),
  applications: z.array(roleApplicationSchema),
}));

// services/control-api/src/routes/roles.ts (query)
export const roleApplicationListQuerySchema = z.object({
  roleId: z.string().optional(),
  nodeId: z.string().optional(),
  status: z.string().optional(),
});

// services/control-api/src/routes/roles.ts (at most 50, newest first)
export const roleApplicationListResponseSchema = ok(z.array(roleApplicationSchema.extend({
  role: z.object({ name: z.string() }),
  node: z.object({ name: z.string() }),
})));

export const quickCommandRequestSchema = z.object({
  command: z.string().min(1, 'command is required'),
  args: z.array(z.string()).optional().default([]),
  timeoutSeconds: z.number().int().min(1).max(600).optional().default(120),
  workingDirectory: z.string().optional(),
});

// services/control-api/src/schemas/commands.ts
export const nodeEnvironmentSchema = z.record(z.string(), z.string()).superRefine((environment, ctx) => {
  for (const key of Object.keys(environment)) {
    if (!SENSITIVE_ENV_KEYS.has(key) && !SENSITIVE_ENV_KEYS.has(key.toLowerCase())) continue;
    ctx.addIssue({
      code: 'custom',
      path: [key],
      message: `Environment variable "${key}" is secret-named and is never stored or dispatched; `
        + 'provision the secret on the node and reference it instead',
    });
  }
});

// services/control-api/src/schemas/commands.ts (a key is required, here or in the x-idempotency-key header)
export const dispatchCommandRequestSchema = z.object({
  idempotencyKey: z.string().optional(),
  nodeIds: z.array(z.string().min(1)).min(1, 'At least one nodeId is required'),
  command: z.string().min(1, 'command is required'),
  args: z.array(z.string()).optional().default([]),
  workingDirectory: z.string().optional(),
  environment: nodeEnvironmentSchema.optional().default({}),
  timeoutSeconds: z.number().int().min(1).max(3600).optional().default(300),
  riskLevel: z.enum(['low', 'medium', 'high']).optional().default('medium'),
  dryRun: z.boolean().optional().default(false),
});

// ── Control node self-update ──
// services/control-api/src/routes/self-update.ts
export const selfUpdateVersionResponseSchema = ok(z.object({
  controlApiVersion: z.string(),
  agentVersion: z.string(),
}));

// services/control-api/src/services/self-update-service.ts
export const selfUpdateStatusResponseSchema = ok(z.object({
  controlApiVersion: z.string(),
  agentVersion: z.string(),
  gitBranch: z.string().nullable(),
  gitCommit: z.string().nullable(),
  lastChecked: z.string().nullable(),
  isGitRepo: z.boolean(),
  legacyGitSelfUpdate: z.boolean(),
  upgradeCommand: z.string(),
}));

// ── Agent upgrades ──
// services/control-api/src/services/agent-upgrade-service.ts
export const releaseVerificationSchema = z.object({
  verified: z.boolean(),
  integrity: z.string().nullable(),
  reason: z.string().nullable(),
});

// services/control-api/src/services/agent-upgrade-preflight.ts
export const preflightProblemSchema = z.object({
  code: z.string(),
  detail: z.string(),
  blocking: z.boolean(),
});

// packages/contracts/src/release.ts (fenceProof omitted: it is agent signature material)
export const agentUpgradePreflightReportSchema = z.object({
  preflightProtocol: z.number().int(),
  version: z.string(),
  target: z.string().nullable().optional(),
  layout: z.enum(['versioned', 'legacy', 'container']).optional(),
  launcherProtocol: z.number().int().nullable().optional(),
  enabled: z.boolean().optional(),
  reason: z.string().nullable().optional(),
  reasonCode: z.string().nullable().optional(),
  writable: z.object({ ok: z.boolean(), blocked: z.array(z.string()).optional() }).optional(),
  disk: z.object({ freeBytes: z.number(), requiredBytes: z.number(), low: z.boolean() }).optional(),
  npm: z.object({
    present: z.boolean(),
    version: z.string().nullable().optional(),
    problem: z.string().nullable().optional(),
  }).optional(),
  fromVersionComplete: z.boolean().optional(),
  ledger: z.object({
    readable: z.boolean(),
    activeLock: z.object({ commandId: z.string(), receipt: z.string() }).nullable().optional(),
    nonTerminalReceipts: z.number().int().optional(),
    unresolvedReceipts: z.number().int().optional(),
    truncated: z.boolean().optional(),
    error: z.string().nullable().optional(),
  }).optional(),
  fenceHighWater: z.record(z.string(), z.string()).optional(),
  managedEnrollment: z.object({ nodeId: z.string(), nodeFqdn: z.string() }).nullable().optional(),
  managedEnrollmentState: z.enum(['absent', 'present', 'unknown']).optional(),
  engines: z.object({
    node: z.string(),
    range: z.string().nullable(),
    compatible: z.boolean().nullable(),
    problem: z.string().nullable().optional(),
  }).optional(),
});

// services/control-api/src/services/agent-upgrade-preflight.ts
export const nodePreflightSchema = z.object({
  status: z.enum(['ok', 'warning', 'blocked', 'unavailable', 'unreachable']),
  checkedAt: z.string(),
  problems: z.array(preflightProblemSchema),
  detail: z.string().optional(),
  report: agentUpgradePreflightReportSchema.optional(),
  fencesVerified: z.boolean().optional(),
  healed: z.array(z.string()).optional(),
});

// services/control-api/src/services/agent-upgrade-service.ts (preflight reaches ADMIN only: services/control-api/src/routes/agent-upgrades.ts)
export const upgradeCandidateSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  version: z.string(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  code: z.string().nullable(),
  upgrade: agentUpgradeReportSchema.nullable(),
  layout: z.enum(['versioned', 'legacy', 'container']).nullable(),
  managed: z.boolean().optional(),
  preflight: nodePreflightSchema.nullable().optional(),
  leaseHistory: z.boolean().optional(),
  heldLeases: z.number().optional(),
});

// services/control-api/src/services/agent-upgrade-service.ts

export const upgradeRunNodeStateSchema = z.enum(['pending', 'requested', 'watching', 'ambiguous', 'confirmed', 'reverted', 'failed', 'refused', 'skipped']);

// services/control-api/src/services/agent-upgrade-service.ts
export const upgradeRunNodeSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  from: z.string(),
  state: upgradeRunNodeStateSchema,
  requestId: z.string(),
  detail: z.string().nullable(),
  code: z.string().nullable().optional(),
  dispatchedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  awaitingReport: z.boolean().optional(),
  failureClass: z.enum(['release', 'node']).nullable().optional(),
  fenceUnreported: z.boolean().optional(),
  attempts: z.number().optional(),
});

// services/control-api/src/services/agent-upgrade-service.ts
export const upgradeRunAttentionSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  state: z.union([upgradeRunNodeStateSchema, z.literal('excluded')]),
  code: z.string(),
  failureClass: z.enum(['release', 'node']),
  detail: z.string().nullable(),
  cause: z.string(),
  remedy: z.string(),
  unknownCode: z.boolean().optional(),
});

// services/control-api/src/services/agent-upgrade-service.ts
export const upgradeRunSchema = z.object({
  id: z.string(),
  version: z.string(),
  integrity: z.string(),
  actorId: z.string(),
  status: z.enum(['running', 'succeeded', 'partial', 'failed', 'stopped', 'interrupted']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  concurrency: z.number(),
  message: z.string().nullable(),
  summary: z.string().nullable().optional(),
  canaryNodeId: z.string().nullable().optional(),
  owner: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
  stopRequestedBy: z.string().nullable().optional(),
  retryOf: z.string().nullable().optional(),
  allowRetryReverted: z.boolean().optional(),
  suspectedRelease: z.string().nullable().optional(),
  excluded: z.array(z.object({
    nodeId: z.string(),
    name: z.string(),
    reason: z.string(),
    code: z.string().nullable().optional(),
  })).optional(),
  maxFailures: z.number().optional(),
  warnings: z.array(z.object({
    nodeId: z.string(),
    name: z.string(),
    code: z.string(),
    detail: z.string(),
  })).optional(),
  attention: z.array(upgradeRunAttentionSchema).optional(),
  nodes: z.array(upgradeRunNodeSchema),
});

// services/control-api/src/routes/agent-upgrades.ts (query)
export const upgradeEligibilityQuerySchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).optional(),
  allowRetryReverted: z.enum(['true', 'false']).optional(),
});

// services/control-api/src/routes/agent-upgrades.ts
export const upgradeEligibilityResponseSchema = ok(z.object({
  version: z.string(),
  serverVersion: z.string(),
  upgradesEnabled: z.boolean(),
  disabledReason: z.string().nullable(),
  prerelease: z.boolean(),
  release: releaseVerificationSchema,
  nodes: z.array(upgradeCandidateSchema),
  latestRun: upgradeRunSchema.nullable(),
}));

// services/control-api/src/routes/agent-upgrades.ts
export const startUpgradeRequestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).optional(),
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/).optional(),
  nodeIds: z.array(z.string().min(1).max(128)).min(1, 'nodeIds must name at least one node; leave it out for every eligible agent').max(1000).optional(),
  canaryNodeId: z.string().min(1).max(128).optional(),
  allowPrerelease: z.boolean().optional(),
  allowRetryReverted: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  maxFailures: z.number().int().min(1).max(1000).optional(),
}).strict();

// services/control-api/src/routes/agent-upgrades.ts and services/control-api/src/services/agent-upgrade-service.ts

export const upgradeCheckReportSchema = z.object({
  dryRun: z.literal(true),
  version: z.string(),
  release: releaseVerificationSchema,
  eligible: z.number(),
  blocked: z.number(),
  nodes: z.array(upgradeCandidateSchema.extend({
    cause: z.string().nullable(),
    remedy: z.string().nullable(),
  })),
});

// services/control-api/src/routes/agent-upgrades.ts (200 with the report when dryRun is true, otherwise 202 with the run)
export const startUpgradeResponseSchema = ok(z.union([upgradeCheckReportSchema, upgradeRunSchema]));

// services/control-api/src/routes/agent-upgrades.ts
export const upgradeRunResponseSchema = ok(upgradeRunSchema);

// services/control-api/src/routes/agent-upgrades.ts
export const retryUpgradeRequestSchema = z.object({
  canaryNodeId: z.string().min(1).max(128).optional(),
  allowRetryReverted: z.boolean().optional(),
  maxFailures: z.number().int().min(1).max(1000).optional(),
  acknowledgeSuspicion: z.boolean().optional(),
}).strict();

// ── Live events ──
// services/control-api/src/routes/events-stream.ts (query; comma-separated channel prefixes)
export const eventStreamQuerySchema = z.object({
  channels: z.string().optional(),
});

// services/control-api/src/routes/events-stream.ts (the first frame, event name "connected")
export const eventStreamConnectedSchema = z.object({
  timestamp: isoDate,
});

// services/control-api/src/routes/events-stream.ts (one SSE data line, not a whole body; the event name is the channel and payloads have no shared shape)
export const eventStreamDataSchema = z.json();

// services/control-api/prisma/schema.prisma
export const cronJobStatusSchema = z.enum(['ACTIVE', 'PAUSED', 'ERROR']);

// services/control-api/src/schemas/commands.ts
export const cancelCommandRequestSchema = z.object({
  reason: z.string().optional(),
});

// services/control-api/src/routes/commands.ts (server clamps hours to 1-720 and pageSize to 1-100; status is upper-cased)
export const commandsListQuerySchema = z.object({
  nodeId: z.string().optional(),
  status: z.string().optional(),
  hours: z.coerce.number().min(1).max(720).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

// services/control-api/prisma/schema.prisma (`environment` is stripped by every command route; args is a JSON-encoded string on the wire)
export const remoteCommandSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  command: z.string(),
  args: z.string(),
  workingDirectory: z.string().nullable(),
  timeoutSeconds: z.number().int(),
  status: commandStatusSchema,
  riskLevel: z.string(),
  idempotencyKey: z.string(),
  correlationId: z.string().nullable(),
  createdBy: z.string(),
  approvedBy: z.string().nullable(),
  executionDeadline: z.iso.datetime().nullable(),
  coordinationJson: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});

// services/control-api/prisma/schema.prisma
export const commandResultSchema = z.object({
  id: z.string(),
  commandId: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int(),
  truncated: z.boolean(),
});

// services/control-api/src/routes/commands.ts
export const commandListItemSchema = remoteCommandSchema.extend({
  node: z.object({ id: z.string(), name: z.string(), hostname: z.string() }),
  result: z.object({ exitCode: z.number().int(), durationMs: z.number().int() }).nullable(),
});

// services/control-api/src/routes/commands.ts
export const commandsListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(commandListItemSchema),
  meta: z.object({ count: z.number().int(), hours: z.number(), pageSize: z.number().int() }),
});

// services/control-api/src/routes/commands.ts
export const commandDryRunResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    dryRun: z.literal(true),
    command: z.string(),
    args: z.array(z.string()),
    timeoutSeconds: z.number().int(),
    riskLevel: z.enum(['low', 'medium', 'high']),
    targets: z.array(z.object({
      id: z.string(),
      name: z.string(),
      status: nodeStatusSchema,
      stale: z.boolean(),
      allowed: z.boolean(),
    })),
  }),
});

// services/control-api/src/routes/commands.ts
export const commandDispatchedResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    commands: z.array(z.object({ id: z.string(), nodeId: z.string(), status: z.literal('QUEUED') })),
  }),
});

// services/control-api/src/routes/commands.ts (200 with dryRun, otherwise 201)
export const commandDispatchResponseSchema = z.union([commandDryRunResponseSchema, commandDispatchedResponseSchema]);

// services/control-api/src/routes/commands.ts
export const commandDetailResponseSchema = z.object({
  success: z.literal(true),
  data: remoteCommandSchema.extend({ result: commandResultSchema.nullable() }),
});

// services/control-api/src/routes/commands.ts
export const commandResultResponseSchema = z.object({
  success: z.literal(true),
  data: commandResultSchema,
});

// services/control-api/src/services/command-lifecycle.ts
export const commandCancelResponseSchema = z.object({
  success: z.literal(true),
  data: remoteCommandSchema,
});

// ─── Logs ───
// services/control-api/src/schemas/logs.ts
export const logQueryRequestSchema = z.object({
  nodeId: z.string().optional(),
  source: z.string().optional(),
  level: z.string().optional(),
  search: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
  cursor: z.string().optional(),
});

// services/control-api/prisma/schema.prisma (metadata is a JSON-encoded string here, unlike the SSE payload)
export const logEntrySchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  source: z.string(),
  level: z.string(),
  message: z.string(),
  metadata: z.string(),
  timestamp: z.iso.datetime(),
});

// services/control-api/src/routes/logs.ts
export const logQueryResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    logs: z.array(logEntrySchema),
    total: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().optional(),
  }),
});

// services/control-api/src/routes/logs.ts (each value is comma-separated)
export const logStreamQuerySchema = z.object({
  nodeIds: z.string().optional(),
  sources: z.string().optional(),
  levels: z.string().optional(),
});

// services/control-api/src/routes/logs.ts and services/control-api/src/middleware/request-logger.ts (id is always empty; metadata is an object)
export const logStreamEntrySchema = z.object({
  id: z.literal(''),
  nodeId: z.string(),
  source: z.string(),
  level: z.string(),
  message: z.string(),
  metadata: z.record(z.string(), z.json()),
  timestamp: z.iso.datetime(),
});

// services/control-api/src/routes/logs.ts
export const logStreamHeartbeatSchema = z.literal('');

// ─── Cron ───
// services/control-api/src/schemas/managed-cron.ts
export const managedCronRegistrationSchema = z.object({
  revision: z.number().int().positive().max(2147483647),
  timezone: z.literal('UTC'),
  timeoutSeconds: z.number().int().min(1).max(3600),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
}).strict();

// services/control-api/src/schemas/cron.ts
export const createCronRequestSchema = z.object({
  nodeId: z.string().min(1, 'nodeId is required'),
  name: z.string().min(1, 'name is required'),
  description: z.string().optional().default(''),
  schedule: z.string().min(1, 'schedule (cron expression) is required'),
  command: z.string().min(1, 'command is required'),
  args: z.array(z.string()).optional().default([]),
  workingDirectory: z.string().nullable().optional(),
  environment: nodeEnvironmentSchema.optional().default({}),
  timeoutSeconds: z.number().int().min(1).max(7200).optional().default(600),
  managed: managedCronRegistrationSchema.optional(),
});

// services/control-api/src/schemas/cron.ts
export const updateCronRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  schedule: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  status: z.enum(['active', 'paused', 'error', 'ACTIVE', 'PAUSED', 'ERROR']).optional(),
  timeoutSeconds: z.number().int().min(1).max(7200).optional(),
  workingDirectory: z.string().nullable().optional(),
  environment: nodeEnvironmentSchema.optional(),
  managed: managedCronRegistrationSchema.optional(),
});

// services/control-api/src/routes/cron.ts
export const cronListQuerySchema = z.object({
  nodeId: z.string().optional(),
});

// services/control-api/prisma/schema.prisma (args is a JSON-encoded string)
export const cronJobSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  name: z.string(),
  description: z.string(),
  schedule: z.string(),
  command: z.string(),
  args: z.string(),
  workingDirectory: z.string().nullable(),
  timeoutSeconds: z.number().int(),
  status: cronJobStatusSchema,
  lastRunAt: z.iso.datetime().nullable(),
  lastRunExitCode: z.number().int().nullable(),
  nextRunAt: z.iso.datetime().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  environmentKeys: z.array(z.string()),
  /** A JSON-encoded string, present for ADMIN only. A PATCH below ADMIN merges: a key left out or left blank keeps its value. */
  environment: z.string().optional(),
});

// services/control-api/prisma/schema.prisma
export const cronJobExecutionSchema = z.object({
  id: z.string(),
  cronJobId: z.string(),
  nodeId: z.string(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nullable(),
});

// services/control-api/src/routes/cron.ts
export const cronListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(cronJobSchema.extend({ node: z.object({ name: z.string() }) })),
});

// services/control-api/src/routes/cron.ts
export const cronDetailResponseSchema = z.object({
  success: z.literal(true),
  data: cronJobSchema.extend({ executions: z.array(cronJobExecutionSchema) }),
});

// services/control-api/src/routes/cron.ts
export const cronCreateResponseSchema = z.object({
  success: z.literal(true),
  data: cronJobSchema,
});

// services/control-api/src/routes/cron.ts
export const cronUpdateResponseSchema = z.object({
  success: z.literal(true),
  data: cronJobSchema.extend({ node: nodeSchema }),
});

// services/control-api/src/routes/cron.ts
export const cronDeleteResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ deleted: z.literal(true) }),
});

// services/control-api/src/routes/scan.ts and packages/agent/src/executors/cron-manager.ts (agent data, not validated by the control API)
export const scannedCronJobSchema = z.object({
  user: z.string(),
  name: z.string(),
  schedule: z.string(),
  command: z.string(),
});

// services/control-api/src/routes/scan.ts
export const cronScanNodeResultSchema = z.discriminatedUnion('status', [
  z.object({
    nodeId: z.string(),
    nodeName: z.string(),
    status: z.literal('done'),
    jobs: z.array(scannedCronJobSchema),
  }),
  z.object({
    nodeId: z.string(),
    nodeName: z.string(),
    status: z.literal('error'),
    jobs: z.array(scannedCronJobSchema).max(0),
    error: z.string(),
  }),
]);

// services/control-api/src/routes/scan.ts
export const cronScanResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(cronScanNodeResultSchema),
});

// ─── Files ───
// services/control-api/src/schemas/files.ts
export const fileUpdateRequestSchema = z.object({
  nodeIds: z.array(z.string().min(1)).min(1, 'At least one nodeId is required'),
  filePath: z.string().min(1, 'filePath is required'),
  content: z.string(),
  createIfMissing: z.boolean().optional().default(true),
  previewOnly: z.boolean().optional().default(false),
  backup: z.boolean().optional().default(true),
});

// services/control-api/src/routes/files.ts
export const fileUpdatePreviewResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    previewOnly: z.literal(true),
    filePath: z.string(),
    policy: z.enum(['safe-app-path', 'sensitive-system-path']),
    targetCount: z.number().int(),
    backupPlanned: z.boolean(),
    contentBytes: z.number().int(),
  }),
});

// services/control-api/src/routes/files.ts and services/control-api/prisma/schema.prisma (spread of the created row, so completedAt stays null even when completed)
export const filePatchTaskSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  filePath: z.string(),
  direction: z.literal('push'),
  content: z.string().nullable(),
  checksum: z.string().nullable(),
  previousChecksum: z.string().nullable(),
  status: z.enum(['completed', 'failed']),
  error: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

// services/control-api/src/routes/files.ts (201 with success:true, including partial failure; 502 with success:false when every task failed)
export const fileUpdateTasksResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(filePatchTaskSchema),
});

// services/control-api/src/routes/files.ts
export const fileUpdateResponseSchema = z.union([fileUpdatePreviewResponseSchema, fileUpdateTasksResponseSchema]);

// services/control-api/src/routes/files.ts
export const fileReadQuerySchema = z.object({
  nodeId: z.string().min(1),
  filePath: z.string().min(1),
});

// services/control-api/src/routes/files.ts and packages/agent/src/executors/file-sync-executor.ts (old-agent fallback at routes/files.ts has checksum '' and sizeBytes in characters)
export const fileReadResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    nodeId: z.string(),
    filePath: z.string(),
    content: z.string(),
    checksum: z.string(),
    sizeBytes: z.number(),
    modifiedAt: z.iso.datetime(),
  }),
});

// services/control-api/src/schemas/commands.ts

// services/control-api/src/schemas/node-responses.ts (server re-parses and strips the agent result before returning it)
export const quickCommandResultSchema = z.object({
  commandId: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().min(0),
  truncated: z.boolean(),
  signature: z.string().regex(/^[a-f0-9]{64}$/i),
  coordination: z.object({
    version: z.literal(1),
    resourceKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/),
    fence: z.string().regex(/^[1-9][0-9]{0,18}$/),
    expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  completion: z.object({
    registryVersion: z.literal(1),
    registrySha256: z.string().regex(/^[a-f0-9]{64}$/),
    descriptorId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  }).optional(),
});

// ─── Library (used by the files and cron pages) ───
// services/control-api/src/schemas/library.ts
export const createLibraryFileRequestSchema = z.object({
  name: z.string().min(1, 'File name is required'),
  fileName: z.string().min(1, 'File name is required'),
  mimeType: z.string().optional().default('text/markdown'),
  content: z.string().optional().default(''),
  categoryId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
});

// services/control-api/src/schemas/library.ts
export const updateLibraryFileRequestSchema = z.object({
  name: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  mimeType: z.string().optional(),
  content: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

// services/control-api/src/routes/library.ts (pageSize is not capped by the server)
export const libraryFilesQuerySchema = z.object({
  query: z.string().optional(),
  categoryId: z.string().optional(),
  mimeType: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).optional(),
});

// services/control-api/prisma/schema.prisma and services/control-api/src/routes/library.ts (no content; tags parsed to an array)
export const libraryFileSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  categoryId: z.string().nullable(),
  tags: z.array(z.string()),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  category: z.object({ id: z.string(), name: z.string(), color: z.string() }).nullable(),
});

// services/control-api/src/routes/library.ts
export const libraryFileSchema = libraryFileSummarySchema.extend({
  content: z.string(),
});

// services/control-api/src/routes/library.ts
export const libraryFilesListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(libraryFileSummarySchema),
  meta: z.object({ total: z.number().int(), page: z.number().int(), pageSize: z.number().int(), hasMore: z.boolean() }),
});

// services/control-api/src/routes/library.ts
export const libraryFileResponseSchema = z.object({
  success: z.literal(true),
  data: libraryFileSchema,
});

// ─── Audit ───
// services/control-api/src/routes/audit.ts
export const auditDaysResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
});

// services/control-api/src/routes/audit.ts and services/control-api/src/services/audit-service.ts (a bad date is a 500; server clamps page to 1-100 and pageSize to 1-200)
export const auditListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  action: z.string().optional(),
  actorId: z.string().optional(),
});

// services/control-api/src/services/audit-service.ts
export const auditVerificationSchema = z.object({
  valid: z.boolean(),
  totalEntries: z.number().int(),
  brokenAtIndex: z.number().int(),
  legacyEntries: z.number().int(),
  state: z.enum(['verified', 'legacy-partial', 'invalid']),
});

// services/control-api/src/services/audit-service.ts (rows are raw JSONL, so details, ipAddress and the chain fields are tolerant of legacy or damaged records)
export const auditEventSchema = z.object({
  id: z.string(),
  action: z.string(),
  actorId: z.string(),
  actorType: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  details: z.json().optional(),
  ipAddress: z.string().nullable().optional(),
  timestamp: z.string(),
  prevHash: z.string().optional(),
  integrity: z.string().optional(),
  chainVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  verificationState: z.enum(['verified', 'legacy-partial', 'invalid']),
});

// services/control-api/src/routes/audit.ts
export const auditListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(auditEventSchema),
  meta: z.object({
    verification: auditVerificationSchema,
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    hasMore: z.boolean(),
  }),
});

// ─── Incidents: reads ───
// services/control-api/src/services/ops-service.ts (selected node, null without nodeId or when absent).
export const incidentSummaryNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  status: z.enum(['ONLINE', 'OFFLINE', 'DEGRADED', 'PROVISIONING', 'DECOMMISSIONED']),
  lastHeartbeatAt: z.iso.datetime().nullable(),
});

// services/control-api/src/services/ops-service.ts (artifact projections; level, severity and metric are free-form DB strings).
export const incidentArtifactsSchema = z.object({
  commands: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED']),
      command: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
  logs: z.array(
    z.object({
      id: z.string(),
      level: z.string(),
      source: z.string(),
      message: z.string(),
      timestamp: z.iso.datetime(),
    }),
  ),
  anomalies: z.array(
    z.object({
      id: z.string(),
      metric: z.string(),
      severity: z.string(),
      value: z.number(),
      createdAt: z.iso.datetime(),
    }),
  ),
  notifications: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      severity: z.string(),
      title: z.string(),
      createdAt: z.iso.datetime(),
    }),
  ),
});

// services/control-api/src/services/ops-service.ts
export const incidentSummarySchema = z.object({
  generatedAt: z.iso.datetime(),
  node: incidentSummaryNodeSchema.nullable(),
  windowHours: z.number(),
  likelyCauses: z.array(z.string()),
  blastRadius: z.string(),
  artifacts: incidentArtifactsSchema,
});

// services/control-api/src/routes/ops.ts (hours is clamped to 168, not rejected; non-numeric hours fails with 500).
export const incidentSummaryQuerySchema = z.object({
  nodeId: z.string().optional(),
  hours: z.coerce.number().positive().max(168).optional(),
});

// services/control-api/src/routes/ops.ts
export const incidentSummaryResponseSchema = z.object({
  success: z.literal(true),
  data: incidentSummarySchema,
});

// services/control-api/src/services/ops-service.ts (latencyMs is omitted for skipped, rate-limiter and retention checks).
export const dependencyHealthCheckSchema = z.object({
  name: z.string(),
  status: z.enum(['pass', 'warn', 'fail', 'skip']),
  message: z.string(),
  latencyMs: z.number().optional(),
});

// services/control-api/src/services/ops-service.ts
export const dependencyHealthSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  checks: z.array(dependencyHealthCheckSchema),
  generatedAt: z.iso.datetime(),
});

// services/control-api/src/services/ops-service.ts (no id field; node absent for deploy, null when the source column is null; audit timestamp comes from a file).
export const timelineItemSchema = z.object({
  type: z.enum(['notification', 'command', 'deploy', 'hermes', 'log', 'audit']),
  severity: z.string(),
  title: z.string(),
  node: z.string().nullable().optional(),
  timestamp: z.string(),
  href: z.string(),
});

// services/control-api/src/routes/ops.ts (limit defaults to 80, clamped to 200 rather than rejected; non-numeric limit returns an empty list).
export const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

// services/control-api/src/routes/ops.ts
export const timelineResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(timelineItemSchema),
});

// services/control-api/src/services/incident-evidence.ts (json is a serialized string, not an object; id is an AnomalyEvent id).
export const incidentEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  sha256: z.string(),
  bytes: z.number(),
  json: z.string(),
  markdown: z.string(),
});

// services/control-api/src/routes/ops.ts
export const incidentEvidenceResponseSchema = z.object({
  success: z.literal(true),
  data: incidentEvidenceSchema,
});

// ─── Incidents: lessons ───
// services/control-api/prisma/schema.prisma (evidenceIds is a JSON-encoded string array on the wire).
export const incidentLessonSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  nodeId: z.string().nullable(),
  symptom: z.string(),
  cause: z.string(),
  runbookVersion: z.string(),
  evidenceIds: z.string(),
  reviewedBy: z.string(),
  expiresAt: z.iso.datetime(),
  supersededAt: z.iso.datetime().nullable(),
  memoryId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

// services/control-api/src/routes/ops.ts (query is truncated to 500 chars server-side; an absent query always matches nothing).
export const lessonSuggestionsQuerySchema = z.object({
  query: z.string().max(500).optional(),
});

// services/control-api/src/services/incident-lessons.ts
export const lessonSuggestionsSchema = z.object({
  advisoryOnly: z.literal(true),
  lessons: z.array(incidentLessonSchema),
});

// services/control-api/src/routes/ops.ts
export const lessonSuggestionsResponseSchema = z.object({
  success: z.literal(true),
  data: lessonSuggestionsSchema,
});

// services/control-api/src/services/incident-lessons.ts
export const lessonReviewedTextSchema = z
  .string()
  .trim()
  .min(5)
  .max(1200)
  .refine(
    (s) =>
      !/(?:https?:\/\/|bearer\s|password\s*[:=]|token\s*[:=]|secret\s*[:=]|-----BEGIN|\beyJ[A-Za-z0-9_-]+\.)/i.test(
        s,
      ),
    'Remove credentials, URLs, raw logs and private evidence from the reviewed text',
  );

// services/control-api/src/services/incident-lessons.ts
export const publishLessonRequestSchema = z
  .object({
    incidentId: z.string().min(1).max(200),
    symptom: lessonReviewedTextSchema,
    cause: lessonReviewedTextSchema,
    runbookVersion: z.enum(['diagnostics.v1', 'restart-service.v1']),
    evidenceIds: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/))
      .min(1)
      .max(20),
    expiresAt: z.iso.datetime(),
    reviewed: z.literal(true),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.expiresAt) > Date.now() && Date.parse(v.expiresAt) - Date.now() <= 90 * 86400000,
    'Review expiry must be within 90 days',
  );

// services/control-api/src/services/incident-lessons.ts (three outcomes; only the ambiguous one carries message).
export const publishedLessonSchema = z.discriminatedUnion('publication', [
  incidentLessonSchema.extend({ publication: z.literal('unconfigured') }),
  incidentLessonSchema.extend({ publication: z.literal('published'), memoryId: z.string() }),
  incidentLessonSchema.extend({ publication: z.literal('unknown'), message: z.string() }),
]);

// services/control-api/src/routes/ops.ts (HTTP 201).
export const publishLessonResponseSchema = z.object({
  success: z.literal(true),
  data: publishedLessonSchema,
});

// ─── Rollouts ───
// services/control-api/src/routes/rollout.ts (type, strategy and status are DB strings; status seen: created, running, paused, completed, failed, cancelled).
export const rolloutSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  rolloutStrategy: z.string(),
  status: z.string(),
  totalNodes: z.number().int(),
  completedNodes: z.number().int(),
  failedNodes: z.number().int(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});

// services/control-api/src/routes/rollout.ts
export const rolloutListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(rolloutSummarySchema),
});

// services/control-api/src/services/rollout-service.ts (row spread keeps node, plus hostname; evidence parsed from JSON; status seen: pending, queued, verifying, completed, failed, cancelled).
export const rolloutTargetSchema = z.object({
  id: z.string(),
  rolloutId: z.string(),
  nodeId: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  commandId: z.string().nullable(),
  evidence: z.record(z.string(), z.json()),
  node: z.object({ hostname: z.string() }),
  hostname: z.string(),
});

// services/control-api/src/services/rollout-service.ts (metadata is parsed open-ended JSON and includes command text and args; strategy duplicates rolloutStrategy).
export const rolloutDetailSchema = rolloutSummarySchema.extend({
  strategy: z.string(),
  metadata: z.record(z.string(), z.json()),
  targets: z.array(rolloutTargetSchema),
});

// services/control-api/src/routes/rollout.ts
export const rolloutDetailResponseSchema = z.object({
  success: z.literal(true),
  data: rolloutDetailSchema,
});

// services/control-api/src/routes/rollout.ts (body is not read).
export const rolloutActionResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ id: z.string(), action: z.enum(['pause', 'resume', 'abort']) }),
});

// ─── Application operations ───
// services/control-api/src/services/application-probes.ts
export const applicationProbeCheckSchema = z.object({
  name: z.string(),
  status: z.enum(['pass', 'fail', 'unknown', 'unconfigured']),
  detail: z.string(),
  method: z.enum(['GET', 'POST']).optional(),
  path: z.string().optional(),
  httpStatus: z.number().int().nullable().optional(),
  durationMs: z.number().optional(),
  gpuQueueDepth: z.number().int().optional(),
});

// services/control-api/src/services/application-probes.ts (every key optional: the route sends {} when there is no observation row yet).
export const applicationProbeResultSchema = z.object({
  status: z.enum(['pass', 'fail', 'unknown', 'unconfigured']).optional(),
  observedAt: z.string().optional(),
  checks: z.array(applicationProbeCheckSchema).optional(),
  releaseRevision: z.string().nullable().optional(),
  probeContractSha256: z.string().optional(),
});

// services/control-api/src/routes/ops.ts (status is forced to unknown once the observation is older than 180s).
export const applicationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  serviceId: z.string(),
  nodeId: z.string(),
  kind: z.enum(['http', 'workflow-queue', 'backend-pool', 'hive-router', 'hivemem']),
  status: z.enum(['pass', 'fail', 'unknown', 'unconfigured']),
  observedAt: z.iso.datetime().nullable(),
  result: applicationProbeResultSchema,
});

// services/control-api/src/services/application-probes.ts
export const applicationCollectorSchema = z.object({
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  durationMs: z.number(),
  configured: z.number().int(),
  errors: z.number().int(),
  running: z.boolean(),
});

// services/control-api/src/routes/ops.ts (envelope carries meta.collector).
export const applicationListResponseSchema = z.object({
  success: z.literal(true),
  meta: z.object({ collector: applicationCollectorSchema }),
  data: z.array(applicationSchema),
});

// services/control-api/src/routes/ops.ts (body is not read; 409 uses apiErrorSchema without code when unconfigured; a failed canary is still 200 with status fail).
export const applicationCanaryResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.enum(['pass', 'fail']),
    durationMs: z.number(),
    totalTokens: z.number().nullable(),
  }),
});

// services/control-api/prisma/schema.prisma (nodeIds and serviceIds are JSON-encoded string arrays on the wire).
export const maintenanceWindowSchema = z.object({
  id: z.string(),
  reason: z.string(),
  nodeIds: z.string(),
  serviceIds: z.string(),
  actorId: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  cancelledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

// services/control-api/src/routes/ops.ts
export const maintenanceListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(maintenanceWindowSchema),
});

// services/control-api/src/services/maintenance-service.ts
export const createMaintenanceRequestSchema = z
  .object({
    reason: z.string().trim().min(5).max(500),
    nodeIds: z.array(z.string().min(1).max(200)).min(1).max(100),
    serviceIds: z.array(z.string().min(1).max(160)).max(100).default([]),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.endsAt) > Date.parse(v.startsAt) &&
      Date.parse(v.endsAt) - Date.parse(v.startsAt) <= 7 * 86400000,
    'Maintenance must have a positive duration no longer than seven days',
  );

// services/control-api/src/routes/ops.ts (POST is HTTP 201; cancel at ops.ts is 200 with the same body and reads no request body).
export const maintenanceWindowResponseSchema = z.object({
  success: z.literal(true),
  data: maintenanceWindowSchema,
});

// services/control-api/src/services/operational-observations.ts
export const capacityAdviceSchema = z.object({
  advisoryOnly: z.literal(true),
  generatedAt: z.iso.datetime(),
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      hostname: z.string(),
      observedAt: z.iso.datetime().nullable(),
      capacity: z.enum(['unknown', 'constrained', 'available']),
      recommendation: z.string(),
    }),
  ),
});

// services/control-api/src/routes/ops.ts
export const capacityAdviceResponseSchema = z.object({
  success: z.literal(true),
  data: capacityAdviceSchema,
});

// services/control-api/src/services/dependency-service.ts (collection object).
export const dependencyCollectionSchema = z.object({
  status: z.enum(['pass', 'unknown']),
  observedAt: z.iso.datetime(),
  reason: z.string().nullable(),
});

// services/control-api/src/services/dependency-service.ts
export const dependencyGraphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      ip: z.string(),
      services: z.array(
        z.object({
          port: z.number().int(),
          protocol: z.string(),
          process: z.string(),
          pid: z.number().int().optional(),
        }),
      ),
      collection: dependencyCollectionSchema,
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      fromPort: z.number().int(),
      toPort: z.number().int(),
      service: z.string(),
      connectionCount: z.number().int(),
    }),
  ),
  discoveredAt: z.iso.datetime(),
  status: z.enum(['complete', 'partial']),
});

// services/control-api/src/routes/dependencies.ts (reduced projection, only for the plugin read service credential).
export const dependencyGraphRedactedSchema = z.object({
  discoveredAt: z.iso.datetime(),
  status: z.enum(['complete', 'partial']),
  nodes: z.array(
    z.object({ id: z.string(), name: z.string(), collection: dependencyCollectionSchema }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      service: z.string(),
      connectionCount: z.number().int(),
    }),
  ),
});

// services/control-api/src/routes/dependencies.ts
export const dependencyGraphResponseSchema = z.object({
  success: z.literal(true),
  data: z.union([dependencyGraphSchema, dependencyGraphRedactedSchema]),
});

// services/control-api/src/routes/ops.ts (mount is required and at most 4096 chars; otherwise 400 via apiErrorSchema without code).
export const storageEvidenceQuerySchema = z.object({
  mount: z.string().min(1).max(4096),
});

// packages/agent/src/collectors/storage-evidence.ts (agent body relayed verbatim by routes/ops.ts; the two branches differ on status and elapsedMs).
export const storageEvidenceSchema = z.discriminatedUnion('shared', [
  z.object({
    shared: z.literal(true),
    target: z.string(),
    source: z.string(),
    fstype: z.string(),
    volumeId: z.string(),
    observedAt: z.iso.datetime(),
    status: z.literal('unknown'),
    directories: z.array(z.object({ path: z.string(), bytes: z.number() })),
    explanation: z.string(),
  }),
  z.object({
    shared: z.literal(false),
    target: z.string(),
    source: z.string(),
    fstype: z.string(),
    volumeId: z.string(),
    observedAt: z.iso.datetime(),
    elapsedMs: z.number(),
    status: z.enum(['pass', 'partial']),
    directories: z.array(z.object({ path: z.string(), bytes: z.number() })),
    explanation: z.string(),
  }),
]);

// packages/agent/src/collectors/storage-evidence.ts

export const storageEvidenceResponseSchema = z.object({
  success: z.literal(true),
  data: storageEvidenceSchema,
});

// packages/agent/src/collectors/storage-evidence.ts (relayed as HTTP 502 by routes/ops.ts: error is a bare string here, unlike apiErrorSchema).
export const storageEvidenceAgentErrorSchema = z.object({
  success: z.literal(false),
  error: z.string(),
});

// ─── Governor operations: cron ───

// services/control-api/prisma/schema.prisma (args and environment are JSON-encoded strings; status is uppercase on the wire).

// services/control-api/src/services/skill-service.ts (manifest.json is parsed without validation, so only name is guaranteed).
export const skillListItemSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  entryPoint: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  files: z.array(z.string()),
  installations: z.array(
    z.object({ nodeId: z.string(), status: z.string(), version: z.string() }),
  ),
});

// services/control-api/src/routes/skills.ts
export const skillListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(skillListItemSchema),
});

// services/control-api/src/routes/ops.ts
export const dependencyHealthResponseSchema = z.object({
  success: z.literal(true),
  data: dependencyHealthSchema,
});

// services/control-api/src/routes/quick-command.ts
export const quickCommandResponseSchema = z.object({
  success: z.literal(true),
  data: quickCommandResultSchema,
});

// ── Route table ──

export interface MagnusBrowserRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Relative to /api/v1, with `{name}` for each path parameter. */
  path: string;
  query?: z.ZodType;
  request?: z.ZodType;
  /** The full response body, including the envelope. Null when the route is a stream. */
  response: z.ZodType | null;
  /** An empty list means no authentication is needed. */
  roles: readonly ConsoleRole[];
  /** Status of the success response when it is not 200. */
  successStatus?: 201 | 202;
  /** Server-sent event payloads by event name, when the route is a stream. Read with fetch: EventSource cannot send the bearer token. */
  events?: Readonly<Record<string, z.ZodType>>;
  /** How the server behaves where the schema alone cannot say. */
  note?: string;
}

export const magnusBrowserRoutes: readonly MagnusBrowserRoute[] = [
  // Session
  { method: 'GET', path: '/console/session', response: consoleSessionResponseSchema, roles: ANY_ROLE },

  // Overview
  { method: 'GET', path: '/stats/overview', response: statsOverviewResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/nodes/tailscale/summary', response: tailscaleSummaryResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/assistant/insights', response: aiInsightsResponseSchema, roles: ANY_ROLE, note: 'Can run an AI generation on a cache miss. A failed generation is a 200 with one fallback insight.' },
  { method: 'GET', path: '/assistant/insights/pins', response: pinnedInsightsResponseSchema, roles: ANY_ROLE },
  { method: 'POST', path: '/assistant/insights/pins', request: pinInsightRequestSchema, response: pinInsightResponseSchema, roles: WRITE_ROLES },
  { method: 'DELETE', path: '/assistant/insights/pins/{id}', response: unpinInsightResponseSchema, roles: WRITE_ROLES },
  { method: 'GET', path: '/events/stream', query: eventStreamQuerySchema, response: null, roles: ANY_ROLE, events: { connected: eventStreamConnectedSchema, '*': eventStreamDataSchema }, note: 'The event name is the channel, and payloads have no shared shape. Oathweave streams close on logout and at token expiry: reconnect with a fresh token.' },

  // Mission control
  { method: 'GET', path: '/ops/dependency-health', response: dependencyHealthResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/orchestra/installations', response: hermesInstallationsResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/orchestra/profiles', response: hermesProfilesResponseSchema, roles: ANY_ROLE },

  // Fleet readiness
  { method: 'GET', path: '/ops/readiness', response: fleetReadinessResponseSchema, roles: ANY_ROLE, note: 'Includes the sentinel nodes __control-api__ and __dashboard__.' },

  // Nodes list
  { method: 'GET', path: '/nodes', query: nodeListQuerySchema, response: nodeListResponseSchema, roles: ANY_ROLE, note: 'tags, metadata and agent.capabilities are JSON-encoded strings. An unknown status fails with 500.' },
  { method: 'GET', path: '/nodes/system-updates/summary', response: systemUpdatesSummaryResponseSchema, roles: ANY_ROLE },
  { method: 'POST', path: '/nodes/register', request: registerNodeRequestSchema, response: registerNodeResponseSchema, roles: WRITE_ROLES, successStatus: 201, note: 'The raw body also carries the per-node token. It is shown once, with Cache-Control: no-store, and this schema strips it.' },
  { method: 'GET', path: '/health', response: publicHealthResponseSchema, roles: [] },
  { method: 'GET', path: '/self-update/version', response: selfUpdateVersionResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/self-update/status', response: selfUpdateStatusResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/agents/upgrade/eligibility', query: upgradeEligibilityQuerySchema, response: upgradeEligibilityResponseSchema, roles: ANY_ROLE, note: 'Candidates carry preflight for ADMIN only.' },
  { method: 'POST', path: '/agents/upgrade', request: startUpgradeRequestSchema, response: startUpgradeResponseSchema, roles: ADMIN_ONLY, note: '200 with the report when dryRun is true, otherwise 202 with the run.' },
  { method: 'GET', path: '/agents/upgrade/runs/{id}', response: upgradeRunResponseSchema, roles: ANY_ROLE },
  { method: 'POST', path: '/agents/upgrade/runs/{id}/stop', response: upgradeRunResponseSchema, roles: ADMIN_ONLY, successStatus: 202 },
  { method: 'POST', path: '/agents/upgrade/runs/{id}/retry', request: retryUpgradeRequestSchema, response: upgradeRunResponseSchema, roles: ADMIN_ONLY, successStatus: 202 },

  // Node detail
  { method: 'GET', path: '/nodes/{nodeId}', response: nodeDetailResponseSchema, roles: ANY_ROLE },
  { method: 'PATCH', path: '/nodes/{nodeId}', request: updateNodeRequestSchema, response: updateNodeResponseSchema, roles: WRITE_ROLES },
  { method: 'DELETE', path: '/nodes/{nodeId}', response: deleteNodeResponseSchema, roles: ADMIN_ONLY },
  { method: 'POST', path: '/nodes/{nodeId}/system-updates/enable', response: enableSystemUpdatesResponseSchema, roles: WRITE_ROLES, note: 'The node must be ONLINE, otherwise 409 INVALID_STATE.' },
  { method: 'GET', path: '/nodes/{nodeId}/gpu', query: nodeGpuQuerySchema, response: nodeGpuResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/nodes/{nodeId}/health', response: nodeHealthResponseSchema, roles: ANY_ROLE, note: '404 when the node has no snapshot.' },
  { method: 'GET', path: '/nodes/{nodeId}/health/history', query: nodeHealthHistoryQuerySchema, response: nodeHealthHistoryResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/nodes/{nodeId}/health/timeseries', query: nodeHealthTimeseriesQuerySchema, response: nodeHealthTimeseriesResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/health/{nodeId}/forecast', query: nodeForecastQuerySchema, response: nodeForecastResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/hermes/installations', response: hermesInstallationsResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/roles', response: roleListResponseSchema, roles: ANY_ROLE },
  { method: 'POST', path: '/roles/{roleId}/assign', request: assignRoleRequestSchema, response: assignRoleResponseSchema, roles: WRITE_ROLES },
  { method: 'POST', path: '/roles/{roleId}/unassign', request: unassignRoleRequestSchema, response: unassignRoleResponseSchema, roles: WRITE_ROLES },
  { method: 'GET', path: '/roles/applications/list', query: roleApplicationListQuerySchema, response: roleApplicationListResponseSchema, roles: ANY_ROLE },
  { method: 'POST', path: '/quick-command/{nodeId}/exec', request: quickCommandRequestSchema, response: quickCommandResponseSchema, roles: WRITE_ROLES, note: 'A non-zero exitCode is still 200. 409 INVALID_STATE if the node is not ONLINE, 502 NODE_EXEC_FAILED on agent failure. Limited to 30 per minute.' },

  // Commands
  { method: 'GET', path: '/commands', query: commandsListQuerySchema, response: commandsListResponseSchema, roles: ANY_ROLE },
  { method: 'POST', path: '/commands', request: dispatchCommandRequestSchema, response: commandDispatchResponseSchema, roles: WRITE_ROLES, successStatus: 201, note: 'An idempotency key is required, in the body or the x-idempotency-key header. 200 when dryRun is true. Nodes that are not ONLINE are skipped, so commands can be empty. 409 STALE_NODE_BLOCKED or DUPLICATE_REQUEST. Limited to 60 per minute.' },
  { method: 'GET', path: '/commands/{commandId}', response: commandDetailResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/commands/{commandId}/result', response: commandResultResponseSchema, roles: ANY_ROLE, note: '404 until the result exists.' },
  { method: 'POST', path: '/commands/{commandId}/cancel', request: cancelCommandRequestSchema, response: commandCancelResponseSchema, roles: WRITE_ROLES, note: 'A JSON body is mandatory: send {} at minimum, because an empty body answers 500. Only PENDING or QUEUED can be cancelled, otherwise 409 INVALID_STATE.' },

  // Logs
  { method: 'POST', path: '/logs/query', request: logQueryRequestSchema, response: logQueryResponseSchema, roles: ANY_ROLE, note: 'POST even though it is a read. nextCursor is omitted unless the page is full.' },
  { method: 'GET', path: '/logs/stream', query: logStreamQuerySchema, response: null, roles: ANY_ROLE, events: { log: logStreamEntrySchema, heartbeat: logStreamHeartbeatSchema }, note: 'JSON-parse the log event data; heartbeat data is empty, every 30 seconds. There is no replay. Oathweave streams close on logout and at token expiry: reconnect with a fresh token.' },

  // Cron
  { method: 'POST', path: '/scan/cron', response: cronScanResponseSchema, roles: WRITE_ROLES, note: 'Always 200 with success true: per-node failures are status error entries. No request body. Reads the live crontab on ONLINE nodes.' },
  { method: 'GET', path: '/cron', query: cronListQuerySchema, response: cronListResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/cron/{cronId}', response: cronDetailResponseSchema, roles: ANY_ROLE, note: 'At most 10 executions, newest first.' },
  { method: 'POST', path: '/cron', request: createCronRequestSchema, response: cronCreateResponseSchema, roles: WRITE_ROLES, successStatus: 201, note: 'Optional x-idempotency-key header. 409 MANAGED_CRON_REQUIRED if the node is managed and managed is absent.' },
  { method: 'PATCH', path: '/cron/{cronId}', request: updateCronRequestSchema, response: cronUpdateResponseSchema, roles: WRITE_ROLES },
  { method: 'DELETE', path: '/cron/{cronId}', response: cronDeleteResponseSchema, roles: WRITE_ROLES },

  // Files
  { method: 'GET', path: '/files/read', query: fileReadQuerySchema, response: fileReadResponseSchema, roles: WRITE_ROLES, note: 'ADMIN or OPERATOR even though it is a read. The returned filePath is the resolved path, which can differ from the request.' },
  { method: 'POST', path: '/files/update', request: fileUpdateRequestSchema, response: fileUpdateResponseSchema, roles: WRITE_ROLES, note: '200 preview. 201 tasks, which can include failed entries or be empty. 502 with this same success:false tasks body when all tasks fail. Optional x-idempotency-key header. Body limit 1 MiB by default.' },
  { method: 'GET', path: '/library/files', query: libraryFilesQuerySchema, response: libraryFilesListResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/library/files/{fileId}', response: libraryFileResponseSchema, roles: ANY_ROLE },
  { method: 'POST', path: '/library/files', request: createLibraryFileRequestSchema, response: libraryFileResponseSchema, roles: WRITE_ROLES, successStatus: 201 },
  { method: 'PATCH', path: '/library/files/{fileId}', request: updateLibraryFileRequestSchema, response: libraryFileResponseSchema, roles: WRITE_ROLES },

  // Audit
  { method: 'GET', path: '/audit/days', response: auditDaysResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/audit', query: auditListQuerySchema, response: auditListResponseSchema, roles: ANY_ROLE, note: 'One UTC day at a time, today by default; a bad date answers 500. Verification covers the whole day regardless of filters.' },

  // Incidents
  { method: 'GET', path: '/ops/incident-summary', query: incidentSummaryQuerySchema, response: incidentSummaryResponseSchema, roles: ANY_ROLE, note: 'Non-numeric hours answers 500.' },
  { method: 'GET', path: '/ops/timeline', query: timelineQuerySchema, response: timelineResponseSchema, roles: ANY_ROLE, note: 'Each href is a console-relative path without MAGNUS_CONSOLE_BASE_PATH: map or prefix it.' },
  { method: 'GET', path: '/ops/incidents/{id}/evidence', response: incidentEvidenceResponseSchema, roles: WRITE_ROLES },
  { method: 'GET', path: '/ops/lessons', query: lessonSuggestionsQuerySchema, response: lessonSuggestionsResponseSchema, roles: WRITE_ROLES },
  { method: 'POST', path: '/ops/lessons', request: publishLessonRequestSchema, response: publishLessonResponseSchema, roles: WRITE_ROLES, successStatus: 201 },

  // Rollouts
  { method: 'GET', path: '/rollouts', response: rolloutListResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/rollouts/{id}', response: rolloutDetailResponseSchema, roles: ANY_ROLE },
  { method: 'POST', path: '/rollouts/{id}/pause', response: rolloutActionResponseSchema, roles: WRITE_ROLES },
  { method: 'POST', path: '/rollouts/{id}/resume', response: rolloutActionResponseSchema, roles: WRITE_ROLES },
  { method: 'POST', path: '/rollouts/{id}/abort', response: rolloutActionResponseSchema, roles: ADMIN_ONLY },

  // Application operations
  { method: 'GET', path: '/ops/applications', response: applicationListResponseSchema, roles: ANY_ROLE },
  { method: 'POST', path: '/ops/applications/{id}/canary', response: applicationCanaryResponseSchema, roles: WRITE_ROLES, note: 'A failed canary is still 200 with status fail. 409 without an error code when unconfigured.' },
  { method: 'GET', path: '/ops/maintenance', response: maintenanceListResponseSchema, roles: ANY_ROLE },
  { method: 'POST', path: '/ops/maintenance', request: createMaintenanceRequestSchema, response: maintenanceWindowResponseSchema, roles: WRITE_ROLES, successStatus: 201 },
  { method: 'POST', path: '/ops/maintenance/{id}/cancel', response: maintenanceWindowResponseSchema, roles: WRITE_ROLES },
  { method: 'GET', path: '/ops/capacity-advice', response: capacityAdviceResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/dependencies', response: dependencyGraphResponseSchema, roles: ANY_ROLE },
  { method: 'GET', path: '/ops/storage-evidence/{nodeId}', query: storageEvidenceQuerySchema, response: storageEvidenceResponseSchema, roles: WRITE_ROLES, note: 'On agent failure, 502 with storageEvidenceAgentErrorSchema, whose error is a bare string.' },

  // Governor operations
  { method: 'GET', path: '/skills', response: skillListResponseSchema, roles: ANY_ROLE },
];

/** The released route for a concrete /api/v1-relative path. Throws when there is none. */
export function magnusBrowserRoute(path: string, method = 'GET'): MagnusBrowserRoute {
  if (/[\\#]/u.test(path) || path.includes('..')) throw new Error('Invalid Magnus browser path');
  const pathname = path.split('?')[0]!;
  const upper = method.toUpperCase();
  const pattern = (value: string) => new RegExp(`^${value.replace(/\{[^}]+\}/gu, '[^/]+')}$`, 'u');
  // An exact path wins over a parameterized one, as /nodes/tags does over /nodes/{nodeId}.
  const candidates = magnusBrowserRoutes.filter((route) => route.method === upper);
  const route = candidates.find((value) => value.path === pathname)
    ?? candidates.find((value) => pattern(value.path).test(pathname));
  if (!route) throw new Error('Magnus browser route has no released contract');
  return route;
}

/** The schema for a route's JSON body. Throws for a stream, which has none. */
export function magnusBrowserResponseSchema(path: string, method = 'GET'): z.ZodType {
  const { response } = magnusBrowserRoute(path, method);
  if (!response) throw new Error('Magnus browser route is a stream');
  return response;
}
