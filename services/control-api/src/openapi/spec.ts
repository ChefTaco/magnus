import { skillJobRequest } from '../routes/hiveskills.js';
import { embermendOperationSchema } from '@hivemagnus/magnus-contracts/embermend';
import { z as zSchema } from 'zod';
import { agentIdentitySchema } from '@hivemagnus/magnus-contracts/browser';
import { managedTerminalActionSchema, managedTerminalAuthoritySchema, managedTerminalReceiptSchema } from '@hivemagnus/magnus-contracts';
import { dashboardReserveSchema, dashboardStartSchema, dashboardFinishSchema, apiDrainAttestationSchema,
  schedulerBoundaryAttestationSchema } from '../services/resource-enrollment.js';
import { ardentScopeActivationSchema } from '../services/ardent-scope-enrollment.js';
import { participantWorkReconciliationSchema, historicalParticipantWorkReconciliationSchema } from '../schemas/resource-participant-reconciliation.js';
import {
  sharedResourceLeaseIdentitySchema,
  sharedResourceLeaseViewSchema,
  sharedResourceReconciliationSchema,
  sharedResourceReserveSchema,
  sharedResourceTerminalEvidenceSchema,
} from '../schemas/shared-resource-lease.js';
import { managedCronRegistrationSchema, schedulerSourceSettlementSchema } from '../schemas/managed-cron.js';
import { legacyAdmissionRequestSchema, resourceClaimSchema } from '../security/managed-http.js';
import { ardentAgentDeployRequestSchema, ardentAgentOperationSchema, magnusObservationSchema, responseRequestSchema } from '@hivemagnus/magnus-contracts';
import { maintenanceSchema } from '../services/maintenance-service.js';
import { rolloutInputSchema } from '../services/rollout-service.js';
import { lessonSchema } from '../services/incident-lessons.js';
/**
 * OpenAPI 3.1 specification for the Magnus Control API.
 *
 * Generates the spec programmatically from the existing Zod validation schemas,
 * ensuring documentation stays in sync with actual request validation.
 *
 * @see https://spec.openapis.org/oas/v3.1.0
 */

import type { ZodSchema } from 'zod';
import {
  dispatchCommandSchema,
  cancelCommandSchema,
  reconcileCommandResourceSchema,
  quickCommandSchema,
  createCronSchema,
  updateCronSchema,
  deployNodeSchema,
  deployControlNodeSchema,
  registerNodeSchema,
  updateNodeSchema,
  migrateNodeSchema,
  createRoleSchema,
  updateRoleSchema,
  assignRoleSchema,
  unassignRoleSchema,
  applyRoleSchema,
  fileUpdateSchema,
  createSkillSchema,
  updateSkillSchema,
  updateSkillFileSchema,
  pushSkillSchema,
  publishVersionSchema,
  setTagSchema,
  createCategorySchema,
  updateCategorySchema,
  createLibraryFileSchema,
  updateLibraryFileSchema,
  moveFilesSchema,
  deployLibrarySchema,
  logQuerySchema,
  logIngestSchema,
  notificationReadSchema,
  heartbeatHealthSchema,
} from '../schemas/index.js';
import {
  loginSchema,
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
} from '../schemas/users.js';
import { CONTROL_API_VERSION } from '../config/version.js';

// ─── Helpers ────────────────────────────────────────────────────────

type JsonSchema = Record<string, unknown>;

/** Convert a Zod schema to OpenAPI 3.1-compatible JSON Schema (strips $schema). */
function zod(schema: ZodSchema): JsonSchema {
  const js = zSchema.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input', reused: 'inline', unrepresentable: 'any' }) as JsonSchema;
  delete js['$schema'];
  return js;
}

/** Shorthand for a $ref pointer. */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** JSON request body referencing a component schema. */
function jsonBody(schemaName: string, description?: string) {
  return {
    required: true,
    ...(description && { description }),
    content: { 'application/json': { schema: ref(schemaName) } },
  };
}

/** Standard success response with optional data schema. */
function success(description: string, dataSchema?: JsonSchema | { $ref: string }) {
  const props: Record<string, unknown> = { success: { type: 'boolean', enum: [true] } };
  if (dataSchema) props['data'] = dataSchema;
  return {
    description,
    content: {
      'application/json': {
        schema: { type: 'object', properties: props },
      },
    },
  };
}

/** Paginated success response. */
function paginated(description: string, itemSchema?: JsonSchema | { $ref: string }) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean', enum: [true] },
            data: { type: 'array', items: itemSchema ?? { type: 'object' } },
            meta: ref('PaginationMeta'),
          },
        },
      },
    },
  };
}

/** Shorthand error responses. */
const err400 = { description: 'Validation error', content: { 'application/json': { schema: ref('ApiError') } } };
const err401 = { description: 'Unauthorized — missing or invalid credentials', content: { 'application/json': { schema: ref('ApiError') } } };
const err403 = { description: 'Forbidden — insufficient role/permissions', content: { 'application/json': { schema: ref('ApiError') } } };
const err404 = { description: 'Resource not found', content: { 'application/json': { schema: ref('ApiError') } } };
const err409 = { description: 'Conflict — duplicate or conflicting resource', content: { 'application/json': { schema: ref('ApiError') } } };

/** Standard query-string parameter. */
function qp(name: string, description: string, opts?: { type?: string; required?: boolean; format?: string; enum?: string[] }) {
  return {
    name,
    in: 'query' as const,
    description,
    required: opts?.required ?? false,
    schema: {
      type: opts?.type ?? 'string',
      ...(opts?.format && { format: opts.format }),
      ...(opts?.enum && { enum: opts.enum }),
    },
  };
}

/** Standard path parameter. */
function pp(name: string, description: string) {
  return { name, in: 'path' as const, required: true, schema: { type: 'string' }, description };
}

const apiSecretAuth = [{ apiSecret: [] }];
const sharedResourceAuth = [{ sharedResourceBearer: [] }, { apiSecret: [] }, { bearerAuth: [] }];
const nodeTokenAuth = [{ nodeToken: [] }];

// ─── Tags ───────────────────────────────────────────────────────────

const tags = [
  { name: 'Operations', description: 'Durable rollouts, scoped maintenance and redacted operational evidence' },
  { name: 'Health', description: 'Service health checks' },
  { name: 'Auth', description: 'Authentication (legacy mode)' },
  { name: 'Users', description: 'User CRUD and password management' },
  { name: 'Nodes', description: 'Fleet node management' },
  { name: 'Heartbeat', description: 'Agent heartbeat ingestion' },
  { name: 'Commands', description: 'Command dispatch and execution' },
  { name: 'Quick Command', description: 'Synchronous command execution on a node' },
  { name: 'Cron', description: 'Cron job management' },
  { name: 'Files', description: 'Remote file read/write' },
  { name: 'Skills', description: 'Skill lifecycle and registry' },
  { name: 'Logs', description: 'Log query, ingest, and live tail' },
  { name: 'Audit', description: 'Immutable audit trail' },
  { name: 'Library', description: 'Document library (categories + files)' },
  { name: 'Roles', description: 'Node role management and application' },
  { name: 'Notifications', description: 'Node issue alerts' },
  { name: 'Deploy', description: 'Agent and control-node deployment' },
  { name: 'Discovery', description: 'Network agent discovery (UDP)' },
  { name: 'Scan', description: 'Fleet-wide skill/cron scanning' },
  { name: 'Stats', description: 'Fleet statistics overview' },
  { name: 'Self-Update', description: 'Control-node version management' },
  { name: 'Terminal', description: 'SSH terminal ticket (WebSocket auth)' },
  {
    name: 'Hermes Agent',
    description:
      'Hermes Agent fleet management. Resources are mounted under both ' +
      '`/hermes/*` (legacy alias) and `/orchestra/*`. Covers installations, ' +
      'profiles, skill assignments, toolset policies, roles, providers, ' +
      'credential pools, MCP servers, messaging bindings, cron jobs, ' +
      'plugin installs, and event hooks. Most resources accept an optional ' +
      '`profileId` to scope a configuration to a single profile (empty = installation-wide).',
  },
  { name: 'Codex Agent', description: 'Fleet Codex CLI version and ChatGPT OAuth lifecycle management' },
  { name: 'Magnus Ardent', description: 'Node-scoped Ardent profile inventory and managed actions' },
  { name: 'Agent identity', description: 'How the products of a suite name one agent profile: fleet reference, runtime and HiveMem actor' },
];

// ─── Component Schemas ──────────────────────────────────────────────

const componentSchemas: Record<string, JsonSchema> = {
  AgentIdentity: zod(agentIdentitySchema),
  ResourceClaim: zod(resourceClaimSchema),
  ResourceLegacyAdmission: zod(legacyAdmissionRequestSchema),
  SharedResourceReserve: zod(sharedResourceReserveSchema),
  SharedResourceLeaseIdentity: zod(sharedResourceLeaseIdentitySchema),
  SharedResourceLeaseView: zod(sharedResourceLeaseViewSchema),
  SharedResourceTerminalEvidence: zod(sharedResourceTerminalEvidenceSchema),
  SharedResourceReconciliation: zod(sharedResourceReconciliationSchema),
  // ── Request body schemas (generated from Zod) ──
  DispatchCommand: zod(dispatchCommandSchema),
  CancelCommand: zod(cancelCommandSchema),
  ReconcileCommandResource: zod(reconcileCommandResourceSchema),
  QuickCommand: zod(quickCommandSchema),
  CreateCron: zod(createCronSchema),
  UpdateCron: zod(updateCronSchema),
  ManagedCronRegistration: zod(managedCronRegistrationSchema),
  SchedulerSourceSettlement: zod(schedulerSourceSettlementSchema),
  DeployNode: zod(deployNodeSchema),
  DeployControlNode: zod(deployControlNodeSchema),
  RegisterNode: zod(registerNodeSchema),
  UpdateNode: zod(updateNodeSchema),
  MigrateNode: zod(migrateNodeSchema),
  CreateRole: zod(createRoleSchema),
  UpdateRole: zod(updateRoleSchema),
  AssignRole: zod(assignRoleSchema),
  UnassignRole: zod(unassignRoleSchema),
  ApplyRole: zod(applyRoleSchema),
  FileUpdate: zod(fileUpdateSchema),
  CreateSkill: zod(createSkillSchema),
  UpdateSkill: zod(updateSkillSchema),
  UpdateSkillFile: zod(updateSkillFileSchema),
  PushSkill: zod(pushSkillSchema),
  PublishVersion: zod(publishVersionSchema),
  SetTag: zod(setTagSchema),
  CreateCategory: zod(createCategorySchema),
  UpdateCategory: zod(updateCategorySchema),
  CreateLibraryFile: zod(createLibraryFileSchema),
  UpdateLibraryFile: zod(updateLibraryFileSchema),
  MoveFiles: zod(moveFilesSchema),
  DeployLibrary: zod(deployLibrarySchema),
  LogQuery: zod(logQuerySchema),
  LogIngest: zod(logIngestSchema),
  NotificationRead: zod(notificationReadSchema),
  HeartbeatHealth: zod(heartbeatHealthSchema),
  Login: zod(loginSchema),
  CreateUser: zod(createUserSchema),
  UpdateUser: zod(updateUserSchema),
  ChangePassword: zod(changePasswordSchema),

  // ── Response envelope schemas ──
  ApiError: {
    type: 'object',
    required: ['success', 'error'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', description: 'Machine-readable error code', examples: ['VALIDATION_ERROR', 'NOT_FOUND', 'FORBIDDEN'] },
          message: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
  PaginationMeta: {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      page: { type: 'integer' },
      pageSize: { type: 'integer' },
      hasMore: { type: 'boolean' },
    },
  },

  // ── Common entity shapes ──
  Node: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      hostname: { type: 'string' },
      ipAddress: { type: 'string' },
      port: { type: 'integer' },
      status: { type: 'string', enum: ['ONLINE', 'OFFLINE', 'DEGRADED', 'MAINTENANCE'] },
      os: { type: 'string' },
      arch: { type: 'string' },
      tags: { type: 'string', description: 'JSON-encoded string array' },
      metadata: { type: 'string', description: 'JSON-encoded object' },
      roleId: { type: 'string', nullable: true },
      lastHeartbeatAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      agent: { type: 'object', nullable: true, properties: { version: { type: 'string' }, status: { type: 'string' } } },
      health: { type: 'object', nullable: true, description: 'GET /nodes only: headline figures of the newest snapshot, null until the node reports one', properties: { timestamp: { type: 'string', format: 'date-time' }, cpuUsagePercent: { type: 'number' }, cpuCores: { type: 'integer' }, memoryTotalBytes: { type: 'number' }, memoryUsedBytes: { type: 'number' }, memoryPercent: { type: 'number' }, swapTotalBytes: { type: 'number' }, swapUsedBytes: { type: 'number' }, disks: { type: 'string', description: 'JSON-encoded disk array' } } },
    },
  },
  User: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      email: { type: 'string', format: 'email' },
      name: { type: 'string' },
      role: { type: 'string', enum: ['ADMIN', 'OPERATOR', 'VIEWER'] },
      active: { type: 'boolean' },
      lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  CronJob: {
    type: 'object',
    properties: {
      managed: { type: 'object', nullable: true, properties: { revision: { type: 'integer', minimum: 1 },
        enabled: { type: 'boolean' }, expiresAt: { type: 'string', format: 'date-time' }, timezone: { type: 'string', enum: ['UTC'] } } },
      id: { type: 'string' },
      nodeId: { type: 'string' },
      name: { type: 'string' },
      schedule: { type: 'string' },
      command: { type: 'string' },
      status: { type: 'string', enum: ['active', 'paused', 'error', 'DELETED'] },
      lastRunAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  RemoteCommand: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      command: { type: 'string' },
      status: { type: 'string', enum: ['PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'] },
      riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  CommandResult: {
    type: 'object',
    properties: {
      commandId: { type: 'string' },
      exitCode: { type: 'integer' },
      stdout: { type: 'string' },
      stderr: { type: 'string' },
      durationMs: { type: 'number' },
      truncated: { type: 'boolean' },
    },
  },
  Skill: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      version: { type: 'string' },
      description: { type: 'string' },
      entryPoint: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      installedCount: { type: 'integer' },
    },
  },
  LibraryFile: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      fileName: { type: 'string' },
      mimeType: { type: 'string' },
      content: { type: 'string' },
      categoryId: { type: 'string', nullable: true },
      tags: { type: 'string', description: 'JSON-encoded string array' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  LibraryCategory: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      color: { type: 'string' },
      sortOrder: { type: 'integer' },
      _count: { type: 'object', properties: { files: { type: 'integer' } } },
    },
  },
  Role: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string' },
      aptPackages: { type: 'string', description: 'JSON-encoded string array' },
      skillNames: { type: 'string', description: 'JSON-encoded string array' },
      dockerEnabled: { type: 'boolean' },
      firewallEnabled: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
      _count: { type: 'object', properties: { nodes: { type: 'integer' } } },
    },
  },
  Notification: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      type: { type: 'string' },
      severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
      title: { type: 'string' },
      message: { type: 'string' },
      isRead: { type: 'boolean' },
      nodeId: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  HealthSnapshot: {
    type: 'object',
    properties: {
      cpuUsagePercent: { type: 'number' },
      cpuCores: { type: 'integer' },
      memoryUsagePercent: { type: 'number' },
      memoryTotalBytes: { type: 'string', description: 'BigInt serialized as string' },
      memoryUsedBytes: { type: 'string', description: 'BigInt serialized as string' },
      diskUsagePercent: { type: 'number' },
      diskTotalBytes: { type: 'number' },
      diskUsedBytes: { type: 'number' },
      timestamp: { type: 'string', format: 'date-time' },
    },
  },
  GpuTelemetry: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['6h', '24h', '7d'] },
      latest: { type: ['object', 'null'] },
      history: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sampledAt: { type: 'string', format: 'date-time' },
            sampleIntervalSeconds: { type: 'integer', enum: [30] },
            status: { type: 'string', enum: ['ok', 'unavailable', 'error'] },
            maxUtilizationPercent: { type: ['number', 'null'], minimum: 0, maximum: 100 },
            maxFanPercent: { type: ['number', 'null'], minimum: 0, maximum: 100 },
            devices: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  },
  TailscaleNodeKeyPosture: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      backendState: { type: 'string' },
      dnsName: { type: 'string', nullable: true },
      online: { type: 'boolean', nullable: true },
      keyExpiry: { type: 'string', format: 'date-time', nullable: true },
      daysRemaining: { type: 'integer', nullable: true },
      expiryEnabled: { type: 'boolean' },
      expired: { type: 'boolean' },
      requiresRenewal: { type: 'boolean' },
    },
  },
  TailscaleExpirySummary: {
    type: 'object',
    properties: {
      total: { type: 'integer' },
      reporting: { type: 'integer' },
      expiryEnabled: { type: 'integer' },
      expiringSoon: { type: 'integer' },
      expired: { type: 'integer' },
      warningDays: { type: 'integer', enum: [30] },
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            hostname: { type: 'string' },
            nodeStatus: { type: 'string' },
            lastHeartbeatAt: { type: 'string', format: 'date-time', nullable: true },
            observedAt: { type: 'string', format: 'date-time', nullable: true },
            tailscale: { ...ref('TailscaleNodeKeyPosture'), nullable: true },
          },
        },
      },
    },
  },
  AuditEvent: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      action: { type: 'string' },
      actorId: { type: 'string' },
      actorType: { type: 'string' },
      targetType: { type: 'string' },
      targetId: { type: 'string' },
      details: { type: 'object' },
      ipAddress: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
    },
  },
  LogEntry: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      nodeId: { type: 'string' },
      source: { type: 'string' },
      level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
      message: { type: 'string' },
      metadata: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
    },
  },
};

// ─── Paths ──────────────────────────────────────────────────────────

const paths: Record<string, Record<string, unknown>> = {
  '/shared-resource-leases/reserve': {
    post: { tags: ['Operations'], summary: 'Atomically reserve global repository, provider and GPU resources',
      description: 'Allocates monotonic fences for a canonical-sorted resource set under PostgreSQL advisory locks after verifying a short-lived Ed25519 assertion from the Hermes mission authority. Exact operation replay returns the original ownership; deadlines and uncertain outcomes never release it.',
      security: sharedResourceAuth, requestBody: jsonBody('SharedResourceReserve'),
      responses: { 201: success('Durable shared-resource ownership', ref('SharedResourceLeaseView')), 400: err400, 401: err401, 403: err403,
        409: err409, 503: { description: 'Hermes mission authority trust is unavailable' } } },
  },
  '/shared-resource-leases/operation/{operationId}': {
    get: { tags: ['Operations'], summary: 'Recover exact global shared-resource ownership by operation ID', security: sharedResourceAuth,
      description: 'Returns only the authenticated owner\'s exact durable operation, including immutable terminal or reconciliation evidence and its decision or record identity after release. Administrator read recovery remains separate from normal lifecycle mutations.',
      parameters: [pp('operationId', 'Exact shared-resource operation ID')],
      responses: { 200: success('Durable lease state and fences', ref('SharedResourceLeaseView')), 401: err401, 403: err403, 404: err404 } },
  },
  '/shared-resource-leases/{leaseId}': {
    get: { tags: ['Operations'], summary: 'Inspect exact global shared-resource ownership', security: sharedResourceAuth,
      parameters: [pp('leaseId', 'Shared-resource lease ID')],
      responses: { 200: success('Durable lease state and fences', ref('SharedResourceLeaseView')), 401: err401, 403: err403, 404: err404 } },
  },
  '/shared-resource-leases/{leaseId}/start': {
    post: { tags: ['Operations'], summary: 'Acknowledge exact current fences before a provider mutation', security: sharedResourceAuth,
      description: 'Transitions reserved ownership to running only while every supplied generation is current and the deadline remains open. Provider services must separately reject stale propagated generations.',
      requestBody: jsonBody('SharedResourceLeaseIdentity'), parameters: [pp('leaseId', 'Shared-resource lease ID')],
      responses: { 200: success('Current started ownership', ref('SharedResourceLeaseView')), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 } },
  },
  '/shared-resource-leases/{leaseId}/unknown': {
    post: { tags: ['Operations'], summary: 'Retain ownership after an ambiguous provider outcome', security: sharedResourceAuth,
      requestBody: jsonBody('SharedResourceLeaseIdentity'), parameters: [pp('leaseId', 'Shared-resource lease ID')],
      responses: { 200: success('Unknown ownership retained', ref('SharedResourceLeaseView')), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 } },
  },
  '/shared-resource-leases/{leaseId}/settle': {
    post: { tags: ['Operations'], summary: 'Release ownership with exact Ed25519 terminal evidence', security: sharedResourceAuth,
      description: 'Accepts only a configured issuer/key authorized for every resource, bound to the mission, task, operation, request digest, action, deadline and exact fence generations.',
      requestBody: jsonBody('SharedResourceTerminalEvidence'), parameters: [pp('leaseId', 'Shared-resource lease ID')],
      responses: { 200: success('Signed terminal settlement', ref('SharedResourceLeaseView')), 400: err400, 401: err401, 403: err403,
        404: err404, 409: err409, 503: { description: 'Terminal evidence trust is unavailable' } } },
  },
  '/shared-resource-leases/{leaseId}/reconcile': {
    post: { tags: ['Operations'], summary: 'Administrator: release exact unresolved ownership after reviewed reconciliation',
      security: apiSecretAuth, description: 'Requires a fresh, dedicated-domain HMAC assertion. Age, deadline, transport state and unsigned observations never release ownership.',
      requestBody: jsonBody('SharedResourceReconciliation'), parameters: [pp('leaseId', 'Shared-resource lease ID')],
      responses: { 200: success('Reviewed shared-resource settlement', ref('SharedResourceLeaseView')), 400: err400, 401: err401, 403: err403,
        404: err404, 409: err409, 503: { description: 'Dedicated reconciliation authority is unavailable' } } },
  },
  '/ops/observations': { get: { tags: ['Operations'], summary: 'Versioned bounded observations for an external collector', security: apiSecretAuth, responses: { '200': success('Operational observations v1', zod(magnusObservationSchema)), '401': err401, '403': err403 } } },
  '/ops/applications': { get: { tags: ['Operations'], summary: 'Sanitized configured application readiness', security: apiSecretAuth, responses: { '200': success('Application observations'), '401': err401 } } },
  '/ops/capacity-advice': { get: { tags: ['Operations'], summary: 'Freshness-qualified advisory GPU capacity', security: apiSecretAuth, responses: { '200': success('Capacity advice'), '401': err401 } } },
  '/ops/engineering/catalog': { get: { tags: ['Operations'], summary: 'Operator-owned engineering dependency and runbook catalog', security: apiSecretAuth, responses: { '200': success('Engineering catalog'), '401': err401, '403': err403 } } },
  '/ops/engineering/dependency-impact': { post: { tags: ['Operations'], summary: 'Magnus-probed dependency impact and recovery order assessment', security: apiSecretAuth, responses: { '200': success('Dependency impact'), '400': err400, '403': err403 } } },
  '/ops/engineering/runbook-assessment': { post: { tags: ['Operations'], summary: 'Durable runbook execution and direct postcondition assessment', security: apiSecretAuth, responses: { '200': success('Runbook assessment'), '400': err400, '403': err403 } } },
  '/ops/engineering/delivery-assessment': { post: { tags: ['Operations'], summary: 'Pinned-ledger and release-canary delivery assessment', security: apiSecretAuth, responses: { '200': success('Delivery assessment'), '400': err400, '403': err403 } } },
  '/ops/engineering/forecast-assessment': { post: { tags: ['Operations'], summary: 'Direct retained-metric forecast assessment', security: apiSecretAuth, responses: { '200': success('Forecast assessment'), '400': err400, '403': err403 } } },
  '/ops/engineering/restore-assessment': { post: { tags: ['Operations'], summary: 'Immutable-store disposable recovery exercise assessment', security: apiSecretAuth, responses: { '200': success('Restore assessment'), '400': err400, '403': err403 } } },
  '/ops/codex-fleet-status': { get: { tags: ['Operations', 'Codex Agent'], summary: 'Five-minute cached Codex version, update, and ChatGPT OAuth posture', security: apiSecretAuth, responses: { '200': success('Cached Codex fleet posture'), '401': err401 } } },
  '/ops/maintenance': {
    get: { tags: ['Operations'], summary: 'Maintenance history', security: apiSecretAuth, responses: { '200': success('Maintenance windows'), '401': err401 } },
    post: { tags: ['Operations'], summary: 'Create scoped expiring maintenance (operator/admin)', security: apiSecretAuth, requestBody: { required: true, content: { 'application/json': { schema: zod(maintenanceSchema) } } }, responses: { '201': success('Created window'), '400': err400, '403': err403 } },
  },
  '/ops/maintenance/{id}/cancel': { post: { tags: ['Operations'], summary: 'Cancel maintenance (operator/admin)', parameters: [pp('id','Maintenance window ID')], security: apiSecretAuth, responses: { '200': success('Cancelled window'), '403': err403 } } },
  '/ops/incidents/{id}/evidence': { get: { tags: ['Operations'], summary: 'Export bounded redacted incident evidence (operator/admin)', parameters: [pp('id','Anomaly event ID')], security: apiSecretAuth, responses: { '200': success('Checksummed Markdown and JSON'), '403': err403, '404': err404 } } },
  '/ops/lessons': {
    get: { tags: ['Operations'], summary: 'Current reviewed incident lessons (operator/admin)', parameters: [qp('query','Symptom keywords')], security: apiSecretAuth, responses: { '200': success('Advisory lesson suggestions'), '403': err403 } },
    post: { tags: ['Operations'], summary: 'Publish explicitly reviewed lesson (operator/admin)', security: apiSecretAuth, requestBody: { required: true, content: { 'application/json': { schema: zod(lessonSchema) } } }, responses: { '201': success('Lesson and publication status'), '400': err400, '403': err403 } },
  },
  '/ops/lessons/{id}/supersede': { post: { tags: ['Operations'], summary: 'Invalidate a reviewed lesson (operator/admin)', parameters: [pp('id','Lesson ID')], security: apiSecretAuth, responses: { '200': success('Invalidation status'), '403': err403 } } },
  '/ops/storage-evidence/{nodeId}': { get: { tags: ['Operations'], summary: 'On-demand bounded read-only mount investigation (operator/admin)', parameters: [pp('nodeId','Inventory node ID'), qp('mount','Exact persistent mount path',{required:true})], security: apiSecretAuth, responses: { '200': success('Storage evidence'), '400': err400, '403': err403 } } },
  '/ops/applications/{id}/canary': { post: { tags: ['Operations'], summary: 'Explicit one-token eight-second Hive inference canary (operator/admin)', parameters: [pp('id','Configured application ID')], security: apiSecretAuth, responses: { '200': success('Normalized canary evidence'), '403': err403, '409': err409 } } },
  '/rollouts': { post: { tags: ['Operations'], summary: 'Admit a recoverable command rollout (operator/admin)', security: apiSecretAuth, requestBody: { required: true, content: { 'application/json': { schema: zod(rolloutInputSchema) } } }, responses: { '200': success('Durable rollout'), '400': err400, '403': err403, '409': err409 } } },
  '/remediation/executions/{id}/approve': { post: { tags: ['Operations'], summary: 'Retired approval path; use the signed approval bridge', parameters: [pp('id','Remediation execution ID')], security: apiSecretAuth, responses: { '403': err403 } } },

  '/team-approvals/plans': { get: { tags: ['Operations'], summary: 'List up to 20 unexpired backend-owned plans for approval-bridge review', security: [{ bearerAuth: [] }], responses: { '200': success('Validated pending plans'), '403': err403 } } },
  '/team-approvals/plans/{id}': { get: { tags: ['Operations'], summary: 'Fetch an immutable expiring remediation plan (approval bridge only)', parameters: [pp('id', 'Backend plan ID')], security: [{ bearerAuth: [] }], responses: { '200': success('Exact plan and digest'), '403': err403, '404': err404, '409': err409 } } },
  '/team-approvals/decisions': { post: { tags: ['Operations'], summary: 'Record a signed approval decision with exact plan and operator binding', description: 'Requires the configured approval-bridge plugin principal (`MAGNUS_APPROVAL_BRIDGE_CONSUMER`) plus a separately signed Ed25519 decision. Repeated identical delivery returns its original durable receipt; this endpoint grants no general operator access.', security: [{ bearerAuth: [] }], responses: { '200': success('Durable decision receipt'), '400': err400, '403': err403, '409': err409 } } },

  // ──────────────── Health ────────────────
  '/health': {
    get: {
      tags: ['Health'],
      summary: 'Minimal service readiness',
      description: 'Dependency-free public readiness response. Detailed operational health requires authentication.',
      responses: {
        200: success('Service is ready', {
          type: 'object',
          properties: {
            service: { type: 'string', enum: ['magnus-control-api'] },
            status: { type: 'string', enum: ['ok'] },
          },
        }),
      },
    },
  },
  '/health/watchdog': {
    get: {
      tags: ['Health'], summary: 'Minimal monitoring-loop readiness',
      description: 'Public status only. Returns 503 until all monitoring loops have reported recent progress; exposes no fleet or dependency details.',
      responses: { 200: success('Monitoring loops are progressing', { type: 'object', properties: { service: { type: 'string' }, status: { type: 'string', enum: ['ok'] } } }),
        503: { description: 'Monitoring progress is missing or stale' } },
    },
  },
  '/health/details': {
    get: {
      tags: ['Health'],
      summary: 'Detailed service health',
      description: 'Returns authenticated database, Docker, CORS, migration, version, and uptime diagnostics.',
      security: apiSecretAuth,
      responses: {
        200: success('Detailed service health', {
          type: 'object',
          properties: {
            service: { type: 'string' },
            status: { type: 'string', enum: ['healthy', 'degraded'] },
            version: { type: 'string' },
            uptime: { type: 'number' },
            timestamp: { type: 'string', format: 'date-time' },
            checks: { type: 'array', items: { type: 'object' } },
          },
        }),
        401: err401,
      },
    },
  },

  // ──────────────── Auth ────────────────
  '/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Login (legacy mode)',
      description: 'Authenticate with email + password. Returns a signed HS256 JWT.',
      requestBody: jsonBody('Login'),
      responses: {
        200: success('Login successful', { type: 'object', properties: { token: { type: 'string' }, user: ref('User') } }),
        401: err401,
      },
    },
  },

  // ──────────────── Users ────────────────
  '/users': {
    get: {
      tags: ['Users'],
      summary: 'List users',
      description: 'Returns all users (excludes the system user). Requires ADMIN role.',
      security: apiSecretAuth,
      responses: {
        200: success('User list', { type: 'array', items: ref('User') }),
        401: err401,
        403: err403,
      },
    },
    post: {
      tags: ['Users'],
      summary: 'Create user',
      description: 'Create a new user with email, name, password, and optional role. Requires ADMIN role.',
      security: apiSecretAuth,
      requestBody: jsonBody('CreateUser'),
      responses: {
        201: success('User created', ref('User')),
        400: err400,
        401: err401,
        403: err403,
        409: err409,
      },
    },
  },
  '/users/{id}': {
    get: {
      tags: ['Users'],
      summary: 'Get user',
      description: 'Returns a single user by ID. ADMIN can view any user; non-admins can only view themselves.',
      security: apiSecretAuth,
      parameters: [pp('id', 'User ID')],
      responses: {
        200: success('User details', ref('User')),
        401: err401,
        403: err403,
        404: err404,
      },
    },
    patch: {
      tags: ['Users'],
      summary: 'Update user',
      description: 'Update user name, role, or active status. Requires ADMIN role.',
      security: apiSecretAuth,
      parameters: [pp('id', 'User ID')],
      requestBody: jsonBody('UpdateUser'),
      responses: {
        200: success('User updated', ref('User')),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
    delete: {
      tags: ['Users'],
      summary: 'Delete user',
      description: 'Permanently delete a user. Requires ADMIN role.',
      security: apiSecretAuth,
      parameters: [pp('id', 'User ID')],
      responses: {
        200: success('User deleted'),
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },
  '/users/{id}/password': {
    put: {
      tags: ['Users'],
      summary: 'Change password',
      description: 'Change a user password. ADMINs can change any password (currentPassword optional). Non-admins must provide currentPassword and can only change their own.',
      security: apiSecretAuth,
      parameters: [pp('id', 'User ID')],
      requestBody: jsonBody('ChangePassword'),
      responses: {
        200: success('Password changed'),
        400: err400,
        401: err401,
        403: err403,
      },
    },
  },

  // ──────────────── Nodes ────────────────
  '/nodes': {
    get: {
      tags: ['Nodes'],
      summary: 'List nodes',
      description: 'Returns all fleet nodes with agent info and health metadata. Supports pagination and status filtering. Each node has `upgradeReadiness`: `status` (ok, not-ready, or unknown for agents that do not report it) and `problems` with a code, a detail, a cause and a remedy, such as an enrollment stuck draining, a marker the server does not share, a fence ahead of the server, an unresolved ledger, low disk or missing npm. Each node also has `health`, the headline figures of its newest snapshot, or null when it has none, so a list needs no request per row.',
      security: apiSecretAuth,
      parameters: [
        qp('page', 'Page number (1-based)', { type: 'integer' }),
        qp('pageSize', 'Items per page (max 100)', { type: 'integer' }),
        qp('status', 'Filter by node status', { enum: ['ONLINE', 'OFFLINE', 'DEGRADED', 'MAINTENANCE'] }),
      ],
      responses: {
        200: paginated('Node list', ref('Node')),
        401: err401,
      },
    },
  },
  '/nodes/tailscale/summary': {
    get: {
      tags: ['Nodes'],
      summary: 'Get Tailscale node-key renewal posture',
      description: 'Returns each managed node\'s latest Tailscale node-key expiry posture and flags renewals due within 30 days.',
      security: apiSecretAuth,
      responses: {
        200: success('Tailscale renewal summary', ref('TailscaleExpirySummary')),
        401: err401,
      },
    },
  },
  '/nodes/register': {
    post: {
      tags: ['Nodes'],
      summary: 'Register node',
      description: 'Manually register a new fleet node. Returns the node record and a signed JWT node token for agent authentication.',
      security: apiSecretAuth,
      requestBody: jsonBody('RegisterNode'),
      responses: {
        201: success('Node registered', {
          type: 'object',
          properties: { node: ref('Node'), token: { type: 'string', description: 'Signed JWT for agent auth' } },
        }),
        400: err400,
        401: err401,
        403: err403,
      },
    },
  },
  '/nodes/{nodeId}': {
    get: {
      tags: ['Nodes'],
      summary: 'Get node',
      description: 'Returns a single node by ID, including agent info, latest health snapshot, and role.',
      security: apiSecretAuth,
      parameters: [pp('nodeId', 'Node ID')],
      responses: {
        200: success('Node details', ref('Node')),
        401: err401,
        404: err404,
      },
    },
    patch: {
      tags: ['Nodes'],
      summary: 'Update node',
      description: 'Update node name, tags, metadata, status, or assigned role.',
      security: apiSecretAuth,
      parameters: [pp('nodeId', 'Node ID')],
      requestBody: jsonBody('UpdateNode'),
      responses: {
        200: success('Node updated', ref('Node')),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
    delete: {
      tags: ['Nodes'],
      summary: 'Delete node',
      description: 'Hard-delete a node and all related records (health snapshots, commands, cron jobs, etc.). Requires ADMIN role.',
      security: apiSecretAuth,
      parameters: [pp('nodeId', 'Node ID')],
      responses: {
        200: success('Node deleted'),
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },
  '/nodes/{nodeId}/repair-address': {
    post: {
      tags: ['Nodes'],
      summary: 'Repair node IP address',
      description: 'Re-resolve the IP address for a node via DNS lookup or manual override.',
      security: apiSecretAuth,
      parameters: [pp('nodeId', 'Node ID')],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                ipAddress: { type: 'string', description: 'Manual IP override (skips DNS)' },
              },
            },
          },
        },
      },
      responses: {
        200: success('IP address repaired', ref('Node')),
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },
  '/nodes/{nodeId}/health': {
    get: {
      tags: ['Nodes'],
      summary: 'Get latest health snapshot',
      description: 'Returns the most recent health snapshot for a node.',
      security: apiSecretAuth,
      parameters: [pp('nodeId', 'Node ID')],
      responses: {
        200: success('Health snapshot', ref('HealthSnapshot')),
        401: err401,
        404: err404,
      },
    },
  },
  '/nodes/{nodeId}/gpu': {
    get: {
      tags: ['Nodes'],
      summary: 'Get GPU telemetry history',
      description: 'Returns heartbeat-cadence GPU load, fan, and temperature samples for a node.',
      security: apiSecretAuth,
      parameters: [
        pp('nodeId', 'Node ID'),
        qp('period', 'History period (default 24h)', { type: 'string', enum: ['6h', '24h', '7d'] }),
      ],
      responses: {
        200: success('GPU telemetry', ref('GpuTelemetry')),
        400: err400,
        401: err401,
      },
    },
  },
  '/nodes/{nodeId}/health/history': {
    get: {
      tags: ['Nodes'],
      summary: 'Get health history',
      description: 'Returns recent health snapshots for a node, ordered newest first.',
      security: apiSecretAuth,
      parameters: [
        pp('nodeId', 'Node ID'),
        qp('limit', 'Max snapshots to return (default 100, max 500)', { type: 'integer' }),
      ],
      responses: {
        200: success('Health history', { type: 'array', items: ref('HealthSnapshot') }),
        401: err401,
        404: err404,
      },
    },
  },
  '/nodes/{nodeId}/migrate': {
    post: {
      tags: ['Nodes'],
      summary: 'Migrate node',
      description: 'Migrate an agent to a different control node. SSHs into the host, updates the agent .env, restarts the service, and deletes local records. Requires ADMIN role.',
      security: apiSecretAuth,
      parameters: [pp('nodeId', 'Node ID')],
      requestBody: jsonBody('MigrateNode'),
      responses: {
        200: success('Node migrated'),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },

  // ──────────────── Heartbeat ────────────────
  '/heartbeat': {
    post: {
      tags: ['Heartbeat'],
      summary: 'Agent heartbeat',
      description: 'Receives periodic heartbeats from fleet agents. Auto-registers unknown agents. Uses shared-secret auth via `x-node-token` header (not JWT).',
      security: nodeTokenAuth,
      requestBody: {
        required: true,
        description: 'Agent identification + health data',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['agentVersion'],
              properties: {
                agentVersion: { type: 'string', maxLength: 64 },
                hostname: { type: 'string' },
                fqdn: { type: 'string', maxLength: 253 },
                uptime: { type: 'number' },
                health: ref('HeartbeatHealth'),
              },
              additionalProperties: true,
            },
          },
        },
      },
      responses: {
        200: success('Heartbeat accepted', {
          type: 'object',
          properties: { nodeId: { type: 'string' }, status: { type: 'string' } },
        }),
        400: err400,
        401: err401,
      },
    },
  },

  // ──────────────── Commands ────────────────
  '/commands': {
    post: {
      tags: ['Commands'],
      summary: 'Dispatch command',
      description: 'Queue a command for execution on one or more nodes via BullMQ. Requires an `x-idempotency-key` header to prevent duplicate dispatches.',
      security: apiSecretAuth,
      parameters: [{ name: 'x-idempotency-key', in: 'header', required: true, schema: { type: 'string' }, description: 'Unique idempotency key (24h TTL)' }],
      requestBody: jsonBody('DispatchCommand'),
      responses: {
        201: success('Command queued', ref('RemoteCommand')),
        400: err400,
        401: err401,
        403: err403,
        409: err409,
      },
    },
  },
  '/commands/{commandId}': {
    get: {
      tags: ['Commands'],
      summary: 'Get command',
      description: 'Returns a command record by ID (environment variables are stripped from the response).',
      security: apiSecretAuth,
      parameters: [pp('commandId', 'Command ID')],
      responses: {
        200: success('Command details', ref('RemoteCommand')),
        401: err401,
        404: err404,
      },
    },
  },
  '/commands/{commandId}/result': {
    get: {
      tags: ['Commands'],
      summary: 'Get command result',
      description: 'Returns the execution result (stdout, stderr, exit code, duration) for a completed command.',
      security: apiSecretAuth,
      parameters: [pp('commandId', 'Command ID')],
      responses: {
        200: success('Execution result', ref('CommandResult')),
        401: err401,
        404: err404,
      },
    },
  },
  '/resource-leases/enrollment/dashboard/readiness': {
    post: { tags: ['Commands'], summary: 'Dashboard participant: read-only deployment schema readiness',
      description: 'Checks all three durable participant tables. Does not create enrollment, proofs or work; ready does not mean enrollment is allowed.',
      security: [{ resourceDrainKey: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: zod(zSchema.object({}).strict()) } } },
      responses: { 200: success('Protocol and schema available'), 400: err400, 401: err401,
        503: { description: 'Dedicated participant credential or schema unavailable' } } },
  },
  '/resource-leases/enrollment/node-status': {
    post: { tags: ['Commands'], summary: 'Node credential: versioned authoritative enrollment status', security: nodeTokenAuth,
      description: 'Durable enrollment coordination only; never execution approval. Responses are uncached. Participant credentials are distinct from operator and node credentials.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(zSchema.object({ nodeFqdn: zSchema.string().min(1).max(253), nonce: zSchema.string().guid() }).strict()) } } },
      responses: { 200: success('Authoritative durable status'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409, 503: { description: 'Dedicated participant configuration unavailable' } } },
  },
  '/resource-leases/enrollment/terminal-claim': {
    post: { tags: ['Commands'], summary: 'Node credential: consume the exact full-node terminal grant once', security: nodeTokenAuth,
      requestBody: { required: true, content: { 'application/json': { schema: zod(zSchema.object({ authority: managedTerminalAuthoritySchema, nonce: zSchema.string().guid() }).strict()) } } },
      responses: { 200: success('Single-use terminal authority'), 400: err400, 401: err401, 409: err409 } },
  },
  '/resource-leases/enrollment/terminal-receipt': {
    post: { tags: ['Commands'], summary: 'Node credential: settle a stopped restricted terminal process group', security: nodeTokenAuth,
      requestBody: { required: true, content: { 'application/json': { schema: zod(managedTerminalReceiptSchema) } } },
      responses: { 200: success('Original terminal owner released'), 400: err400, 401: err401, 409: err409 } },
  },
  '/resource-leases/enrollment/dashboard/terminal/{workId}': {
    post: { tags: ['Commands'], summary: 'Gateway credential: owner-bound managed terminal I/O relay', security: [{ resourceDrainKey: [] }],
      description: 'The target and node credential come only from inventory. Terminal bytes remain in memory and are never audited or stored in receipts.',
      parameters: [{ name: 'workId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { schema: zod(zSchema.object({ ownerId: zSchema.string().guid(), operation: managedTerminalActionSchema }).strict()) } } },
      responses: { 200: success('Bounded terminal bytes or lifecycle metadata'), 400: err400, 401: err401, 409: err409 } },
  },
  '/resource-leases/transfer/authority-snapshot': {
    post: { tags: ['Commands'], summary: 'Node credential: read-only lease and writer inventory', security: nodeTokenAuth,
      description: 'Counts held command leases, participant writers, unsettled managed cron occurrences, and global shared leases under the shared-admission and canonical node locks. Reports node and Control API shared-admission fence state. Independent writers and OS schedules remain outside this fence; zero counts are not handover authority.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(zSchema.object({ nodeFqdn: zSchema.string().min(1).max(253), nonce: zSchema.string().guid() }).strict()) } } },
      responses: { 200: success('Incomplete authority inventory'), 400: err400, 401: err401, 409: err409 } },
  },
  '/resource-leases/enrollment/dashboard/status': {
    post: { tags: ['Commands'], summary: 'Dashboard participant: durable counts and current challenge', security: [{ resourceDrainKey: [] }],
      description: 'Durable enrollment coordination only; never execution approval. Responses are uncached. Participant credentials are distinct from operator and node credentials.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(zSchema.object({ nodeId: zSchema.string().min(1).max(128), nonce: zSchema.string().guid() }).strict()) } } },
      responses: { 200: success('Authoritative durable status'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409, 503: { description: 'Dedicated participant configuration unavailable' } } },
  },
  '/resource-leases/enrollment/dashboard/work/reserve': {
    post: { tags: ['Commands'], summary: 'Dashboard participant: reserve before any SSH connection', security: [{ resourceDrainKey: [] }],
      description: 'Durable enrollment coordination only; never execution approval. Responses are uncached. Participant credentials are distinct from operator and node credentials.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(dashboardReserveSchema) } } },
      responses: { 200: success('Authoritative durable status'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409, 503: { description: 'Dedicated participant configuration unavailable' } } },
  },
  '/resource-leases/enrollment/dashboard/work/{workId}/start': {
    post: { tags: ['Commands'], summary: 'Dashboard participant: single-use connection start grant', security: [{ resourceDrainKey: [] }],
      description: 'Durable enrollment coordination only; never execution approval. Responses are uncached. Participant credentials are distinct from operator and node credentials.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(dashboardStartSchema) } } },
      parameters: [pp('workId', 'Canonical durable identity')],
      responses: { 200: success('Authoritative durable status'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409, 503: { description: 'Dedicated participant configuration unavailable' } } },
  },
  '/resource-leases/enrollment/dashboard/work/{workId}/finish': {
    post: { tags: ['Commands'], summary: 'Dashboard participant: retain unknown descendant effects', security: [{ resourceDrainKey: [] }],
      description: 'Durable enrollment coordination only; never execution approval. Responses are uncached. Participant credentials are distinct from operator and node credentials.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(dashboardFinishSchema) } } },
      parameters: [pp('workId', 'Canonical durable identity')],
      responses: { 200: success('Authoritative durable status'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409, 503: { description: 'Dedicated participant configuration unavailable' } } },
  },
  '/resource-leases/enrollment/work/{workId}/reconcile': {
    post: { tags: ['Commands'], summary: 'Administrator: reconcile exact unresolved participant work', security: apiSecretAuth,
      description: 'Releases only exact started API or dashboard work using a fresh purpose-domain signed assertion and reviewed evidence reference. Transport close, process age, unsigned evidence, and conflicting decisions cannot release ownership.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(participantWorkReconciliationSchema) } } },
      parameters: [pp('workId', 'Canonical durable participant work identity')],
      responses: { 200: success('Immutable participant reconciliation'), 400: err400, 401: err401, 403: err403,
        404: err404, 409: err409, 503: { description: 'Dedicated reconciliation authority is unavailable' } } },
  },
  '/resource-leases/enrollment/work/{workId}/historical': {
    get: { tags: ['Commands'], summary: 'Administrator: inspect exact preinstrumentation participant work', security: apiSecretAuth,
      description: 'Returns the complete stored-row digest and eligible historical identity without inferring the unknown request or its effects.',
      parameters: [pp('workId', 'Canonical durable participant work identity')],
      responses: { 200: success('Historical participant work identity'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 } },
  },
  '/resource-leases/enrollment/work/{workId}/historical-reconcile': {
    post: { tags: ['Commands'], summary: 'Administrator: reconcile exact preinstrumentation dashboard work', security: apiSecretAuth,
      description: 'Requires a fresh dedicated signature binding the stored row and three independently retained observations of absent descendants. The original effect outcome remains unknown.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(historicalParticipantWorkReconciliationSchema) } } },
      parameters: [pp('workId', 'Canonical durable participant work identity')],
      responses: { 200: success('Immutable historical participant reconciliation'), 400: err400, 401: err401, 403: err403,
        404: err404, 409: err409, 503: { description: 'Dedicated reconciliation authority is unavailable' } } },
  },
  '/resource-leases/enrollment/{nodeId}': {
    get: { tags: ['Commands'], summary: 'Inspect staged drain state and missing participants', security: apiSecretAuth,
      description: 'Durable enrollment coordination only; never execution approval. Responses are uncached. Participant credentials are distinct from operator and node credentials.',
      parameters: [pp('nodeId', 'Canonical durable identity')],
      responses: { 200: success('Authoritative durable status'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409, 503: { description: 'Dedicated participant configuration unavailable' } } },
  },
  '/resource-leases/enrollment/{nodeId}/ardent-scope': {
    get: { tags: ['Commands'], summary: 'Inspect the Ardent-only enrollment decision', security: apiSecretAuth,
      description: 'Reports the separate Ardent scope and whole-node drain state without exposing participant receipts.',
      parameters: [pp('nodeId', 'Canonical durable identity')],
      responses: { 200: success('Ardent scope state'), 400: err400, 401: err401, 403: err403, 404: err404 } },
  },
  '/resource-leases/enrollment/{nodeId}/ardent-scope/evidence': {
    get: { tags: ['Commands'], summary: 'Administrator: read what an Ardent-only activation signs', security: apiSecretAuth,
      description: 'Changes nothing. Returns the drain epoch and barrier, the scheduler snapshot digest and receiptSha256, the SHA-256 of each participant (agent, api, dashboard) drain receipt, listed only when the receipt verifies exactly as activation checks it. Receipts expire with their drain challenge, so read this just before signing. ready is false while activation would be refused, with each reason in blockers.',
      parameters: [pp('nodeId', 'Canonical durable identity')],
      responses: { 200: success('Ardent scope activation evidence'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 } },
  },
  '/resource-leases/enrollment/{nodeId}/ardent-scope/activate': {
    post: { tags: ['Commands'], summary: 'Administrator: activate one-way Ardent-only claims', security: apiSecretAuth,
      description: 'Requires a dedicated signed decision bound to the current drain epoch, API, agent and dashboard receipts, reviewed evidence, and an explicit scheduler exclusion. Other node mutations remain blocked.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(ardentScopeActivationSchema) } } },
      parameters: [pp('nodeId', 'Canonical durable identity')],
      responses: { 200: success('Ardent scope activation'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 } },
  },
  '/resource-leases/enrollment/{nodeId}/begin': {
    post: { tags: ['Commands'], summary: 'Administrator: begin a one-way durable drain barrier', security: apiSecretAuth,
      description: 'Durable enrollment coordination only; never execution approval. Responses are uncached. Participant credentials are distinct from operator and node credentials.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(zSchema.object({}).strict()) } } },
      parameters: [pp('nodeId', 'Canonical durable identity')],
      responses: { 200: success('Authoritative durable status'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409, 503: { description: 'Dedicated participant configuration unavailable' } } },
  },
  '/resource-leases/enrollment/{nodeId}/refresh': {
    post: { tags: ['Commands'], summary: 'Administrator: pull fixed authenticated participant evidence', security: apiSecretAuth,
      description: 'Pulls the current signed participant receipt. A pending receipt does not authorize enrollment or execution.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(zSchema.object({ participant: zSchema.enum(['agent', 'api', 'dashboard', 'scheduler']) }).strict()) } } },
      parameters: [pp('nodeId', 'Canonical durable identity')],
      responses: { 200: success('Authoritative durable status'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409, 503: { description: 'Dedicated participant configuration unavailable' } } },
  },
  '/resource-leases/enrollment/{nodeId}/api-attest': {
    post: { tags: ['Commands'], summary: 'Administrator: accept reviewed API drain evidence', security: apiSecretAuth,
      description: 'Requires a fresh dedicated signature bound to the exact API challenge, epoch, barrier, zero durable work, and three reviewed observations.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(apiDrainAttestationSchema) } } },
      parameters: [pp('nodeId', 'Canonical durable identity')],
      responses: { 200: success('Verified API participant attestation'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 } },
  },
  '/resource-leases/enrollment/{nodeId}/scheduler-boundary-attest': {
    post: { tags: ['Commands'], summary: 'Administrator: accept reviewed external scheduler ownership boundary', security: apiSecretAuth,
      description: 'Requires a fresh dedicated signature over the exact node scheduler receipt, external source inventory, epoch and barrier. External schedules remain active and outside Magnus scheduler ownership.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(schedulerBoundaryAttestationSchema) } } },
      parameters: [pp('nodeId', 'Canonical durable identity')],
      responses: { 200: success('Verified scheduler boundary attestation'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 } },
  },
  '/resource-leases/enrollment/{nodeId}/complete': {
    post: { tags: ['Commands'], summary: 'Administrator: complete only with all authoritative participants', security: apiSecretAuth,
      description: 'Revalidates three fresh drain receipts and a separately reviewed, signed scheduler boundary receipt, exact barrier and zero unsettled Magnus work before the one-way enrolled transition. External host schedules remain outside this claim.',
      requestBody: { required: true, content: { 'application/json': { schema: zod(zSchema.object({}).strict()) } } },
      parameters: [pp('nodeId', 'Canonical durable identity')],
      responses: { 200: success('Authoritative durable status'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409, 503: { description: 'Dedicated participant configuration unavailable' } } },
  },
  '/resource-leases/claim': {
    post: { tags: ['Commands'], summary: 'Confirm an existing exact resource owner (node credential)',
      description: 'Does not create ownership or grant remediation approval. Requires a running, unexpired owner bound to the node, command digest and fence.',
      security: nodeTokenAuth, requestBody: jsonBody('ResourceClaim'),
      responses: { 200: success('Exact admitted claim'), 400: err400, 401: err401, 409: err409 } },
  },
  '/resource-leases/recovery-claim': {
    post: { tags: ['Commands'], summary: 'Confirm exact retained skill-publication recovery (node credential)',
      description: 'Does not create, revive or dispatch ownership. It permits only evidence recovery for the original native skill-install request after the node has retained the matching local receipt.',
      security: nodeTokenAuth, requestBody: jsonBody('ResourceClaim'),
      responses: { 200: success('Exact recovery claim'), 400: err400, 401: err401, 409: err409 } },
  },
  '/resource-leases/legacy-admission': {
    post: { tags: ['Commands'], summary: 'Check exact legacy node admission (node credential)',
      description: 'Uncached nonce-bound decision. Denies if enrollment is enabled or any sticky lease history exists, including a first reservation rejected during preflight. Node must hold its local legacy-inflight barrier until execution ends.',
      security: nodeTokenAuth, requestBody: jsonBody('ResourceLegacyAdmission'),
      responses: { 200: success('Authoritative enrollment decision'), 400: err400, 401: err401, 409: err409 } },
  },
  '/resource-leases/ssh-admission': {
    get: { tags: ['Commands'], summary: 'Check legacy SSH admission (operator/admin)',
      description: 'Fail closed for enrolled or ambiguous inventory targets. Enrollment-enabled mode denies managed SSH until durable session coordination is available.',
      security: apiSecretAuth, parameters: [qp('host', 'Exact inventory hostname or IP', { required: true })],
      responses: { 200: success('Unenrolled legacy target allowed'), 400: err400, 401: err401, 403: err403, 409: err409 } },
  },
  '/commands/{commandId}/resource-lease': {
    get: {
      tags: ['Commands'], summary: 'Inspect durable finite-command resource ownership',
      description: 'Returns ownership, deadline and evidence hashes without command content. Enrollment defaults off; unknown ownership survives process restarts and deadlines.',
      security: apiSecretAuth, parameters: [pp('commandId', 'Command ID')],
      responses: { 200: success('Resource ownership'), 401: err401, 404: err404 },
    },
  },
  '/commands/{commandId}/reconcile-resource': {
    post: {
      tags: ['Commands'], summary: 'Reconcile ownership against signed node evidence (operator/admin)',
      description: 'An empty object reads the node receipt. A separately signed, exact request/fence-bound assertion may reconcile an unknown node receipt. Only verified evidence releases ownership; this grants no remediation approval and never replays a command.',
      security: apiSecretAuth, parameters: [pp('commandId', 'Command ID')],
      requestBody: jsonBody('ReconcileCommandResource'),
      responses: { 200: success('Receipt and resource settlement'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 },
    },
  },
  '/commands/{commandId}/cancel': {
    post: {
      tags: ['Commands'],
      summary: 'Cancel command',
      description: 'Cancel a PENDING or QUEUED command. Already-running or completed commands cannot be cancelled.',
      security: apiSecretAuth,
      parameters: [pp('commandId', 'Command ID')],
      requestBody: jsonBody('CancelCommand'),
      responses: {
        200: success('Command cancelled', ref('RemoteCommand')),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },

  // ──────────────── Quick Command ────────────────
  '/quick-command/{nodeId}/exec': {
    post: {
      tags: ['Quick Command'],
      summary: 'Execute command synchronously',
      description: 'Execute a command directly on a node and wait for the result. Bypasses the BullMQ queue for interactive use.',
      security: apiSecretAuth,
      parameters: [pp('nodeId', 'Target node ID')],
      requestBody: jsonBody('QuickCommand'),
      responses: {
        200: success('Command result', ref('CommandResult')),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },

  // ──────────────── Cron ────────────────
  '/cron': {
    get: {
      tags: ['Cron'],
      summary: 'List cron jobs',
      description: 'Returns all cron jobs, optionally filtered by nodeId.',
      security: apiSecretAuth,
      parameters: [qp('nodeId', 'Filter by node ID')],
      responses: {
        200: success('Cron job list', { type: 'array', items: ref('CronJob') }),
        401: err401,
      },
    },
    post: {
      tags: ['Cron'],
      summary: 'Create cron job',
      description: 'Create a cron job. Legacy nodes retain best-effort raw sync. Activated or ownership-history nodes require the finite managed block and enable only after exact staged and activation acknowledgements.',
      security: apiSecretAuth,
      requestBody: jsonBody('CreateCron'),
      responses: {
        201: success('Cron job created', ref('CronJob')),
        400: err400,
        401: err401,
        403: err403,
        409: err409,
      },
    },
  },
  '/cron/{cronId}': {
    get: {
      tags: ['Cron'],
      summary: 'Get cron job',
      description: 'Returns a cron job with its last 10 execution records.',
      security: apiSecretAuth,
      parameters: [pp('cronId', 'Cron job ID')],
      responses: {
        200: success('Cron job details', ref('CronJob')),
        401: err401,
        404: err404,
      },
    },
    patch: {
      tags: ['Cron'],
      summary: 'Update cron job',
      description: 'Update a cron job. Activated or ownership-history nodes require a new finite managed revision for execution-bearing changes and exact acknowledgement for activation or revocation.',
      security: apiSecretAuth,
      parameters: [pp('cronId', 'Cron job ID')],
      requestBody: jsonBody('UpdateCron'),
      responses: {
        200: success('Cron job updated', ref('CronJob')),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
        409: err409,
      },
    },
    delete: {
      tags: ['Cron'],
      summary: 'Delete cron job',
      description: 'Delete a cron job and notify the agent to remove it from the system crontab.',
      security: apiSecretAuth,
      parameters: [pp('cronId', 'Cron job ID')],
      responses: {
        200: success('Cron job deleted'),
        401: err401,
        403: err403,
        404: err404,
        409: err409,
      },
    },
  },
  '/cron/{cronId}/managed': {
    post: {
      tags: ['Cron'],
      summary: 'Install an acknowledged managed cron revision',
      description: 'Before enrollment, converts an exact legacy Magnus cron by removing its wake-up and staging a disabled definition. After enrollment, obtains exact signed stage and activation receipts under durable resource ownership before enabling central occurrence admission.',
      security: apiSecretAuth,
      parameters: [pp('cronId', 'Cron job ID')],
      requestBody: jsonBody('ManagedCronRegistration'),
      responses: { 200: success('Managed cron revision acknowledged'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 },
    },
  },
  '/cron/scheduler-sources/reconcile': {
    post: {
      tags: ['Cron'],
      summary: 'Reconcile one remembered foreign scheduler source',
      description: 'Forwards an independently signed evidence decision bound to the exact drain epoch, barrier, source hash and count. Fresh decisions clear only retained uncertainty; an expired exact decision can retrieve only its retained terminal receipt. It never edits or stops the foreign scheduler, and a source observed again becomes a blocker again.',
      security: apiSecretAuth,
      requestBody: jsonBody('SchedulerSourceSettlement'),
      responses: { 200: success('Foreign scheduler source reconciled'), 400: err400, 401: err401, 403: err403, 409: err409 },
    },
  },

  // ──────────────── Files ────────────────
  '/files/update': {
    post: {
      tags: ['Files'],
      summary: 'Push file to nodes',
      description: 'Write file content to one or more nodes. Supports write and command-based fallback modes.',
      security: apiSecretAuth,
      requestBody: jsonBody('FileUpdate'),
      responses: {
        200: success('File update results', {
          type: 'object',
          properties: {
            results: { type: 'array', items: { type: 'object', properties: { nodeId: { type: 'string' }, success: { type: 'boolean' }, error: { type: 'string' } } } },
          },
        }),
        400: err400,
        401: err401,
        403: err403,
      },
    },
  },
  '/files/read': {
    get: {
      tags: ['Files'],
      summary: 'Read file from node',
      description: 'Read file content from a specific node.',
      security: apiSecretAuth,
      parameters: [
        qp('nodeId', 'Node to read from', { required: true }),
        qp('filePath', 'Absolute file path on the node', { required: true }),
      ],
      responses: {
        200: success('File content', { type: 'object', properties: { content: { type: 'string' }, checksum: { type: 'string' } } }),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },

  // ──────────────── Skills ────────────────
  '/skills': {
    get: {
      tags: ['Skills'],
      summary: 'List skills',
      description: 'Returns all skills from the filesystem merged with installation counts from the database.',
      security: apiSecretAuth,
      responses: {
        200: success('Skill list', { type: 'array', items: ref('Skill') }),
        401: err401,
      },
    },
    post: {
      tags: ['Skills'],
      summary: 'Create skill',
      description: 'Create a new skill directory with a manifest file.',
      security: apiSecretAuth,
      requestBody: jsonBody('CreateSkill'),
      responses: {
        201: success('Skill created', ref('Skill')),
        400: err400,
        401: err401,
        403: err403,
        409: err409,
      },
    },
  },
  '/skills/push': {
    post: {
      tags: ['Skills'],
      summary: 'Push skill to nodes',
      description: 'Install a skill on one or more nodes. Creates SkillInstallation records and dispatches to agents.',
      security: apiSecretAuth,
      parameters: [{ name: 'x-idempotency-key', in: 'header', required: true, schema: { type: 'string' }, description: 'Idempotency key' }],
      requestBody: jsonBody('PushSkill'),
      responses: {
        200: success('Skill push initiated'),
        400: err400,
        401: err401,
        403: err403,
      },
    },
  },
  '/skills/installations/{nodeId}': {
    get: {
      tags: ['Skills'],
      summary: 'Get node installations',
      description: 'Returns all skill installations for a specific node.',
      security: apiSecretAuth,
      parameters: [pp('nodeId', 'Node ID')],
      responses: {
        200: success('Installation list', { type: 'array', items: { type: 'object' } }),
        401: err401,
      },
    },
  },
  '/skills/{name}': {
    get: {
      tags: ['Skills'],
      summary: 'Get skill',
      description: 'Returns a single skill by name.',
      security: apiSecretAuth,
      parameters: [pp('name', 'Skill name')],
      responses: {
        200: success('Skill details', ref('Skill')),
        401: err401,
        404: err404,
      },
    },
    patch: {
      tags: ['Skills'],
      summary: 'Update skill',
      description: 'Update skill manifest (version, description, tags, etc.).',
      security: apiSecretAuth,
      parameters: [pp('name', 'Skill name')],
      requestBody: jsonBody('UpdateSkill'),
      responses: {
        200: success('Skill updated', ref('Skill')),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
    delete: {
      tags: ['Skills'],
      summary: 'Delete skill',
      description: 'Delete a skill directory and all installation records. Requires ADMIN role.',
      security: apiSecretAuth,
      parameters: [pp('name', 'Skill name')],
      responses: {
        200: success('Skill deleted'),
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },
  '/skills/{name}/files/{fileName}': {
    get: {
      tags: ['Skills'],
      summary: 'Read skill file',
      description: 'Read a file from a skill directory.',
      security: apiSecretAuth,
      parameters: [pp('name', 'Skill name'), pp('fileName', 'File name within the skill')],
      responses: {
        200: success('File content', { type: 'object', properties: { content: { type: 'string' } } }),
        401: err401,
        404: err404,
      },
    },
    put: {
      tags: ['Skills'],
      summary: 'Update skill file',
      description: 'Create or update a file within a skill directory.',
      security: apiSecretAuth,
      parameters: [pp('name', 'Skill name'), pp('fileName', 'File name')],
      requestBody: jsonBody('UpdateSkillFile'),
      responses: {
        200: success('File updated'),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },

  // ── Skill Registry ──
  '/hermes-registry/clients': { post: { tags: ['Hermes Agent'], summary: 'Enroll a host-bound registry credential', security: apiSecretAuth,
    responses: { 201: success('One-time bearer and pull/submit scopes'), 400: err400, 403: err403 } } },
  '/hermes-registry/manifest': { get: { tags: ['Hermes Agent'], summary: 'Get host-bound desired Hermes revisions', security: [{ hermesRegistryToken: [] }],
    responses: { 200: success('Desired components'), 401: err401, 403: err403 } } },
  '/hermes-registry/profiles': { get: { tags: ['Hermes Agent'], summary: 'Get profiles permitted to submit local skill changes', security: [{ hermesRegistryToken: [] }],
    responses: { 200: success('Bound installation profiles'), 401: err401 } } },
  '/hermes-registry/tool-surface': { post: { tags: ['Hermes Agent'], summary: 'Report the real enabled Hermes tool surface by profile and platform', security: [{ hermesRegistryToken: [] }],
    responses: { 200: success('Observed tool surface'), 400: err400, 403: err403 } } },
  '/hermes-registry/policy': { get: { tags: ['Hermes Agent'], summary: 'Get host-bound Hermes toolset and MCP tool policy', security: [{ hermesRegistryToken: [] }],
    responses: { 200: success('Tool policies'), 401: err401, 403: err403 } } },
  '/hermes-registry/policy/receipts': { post: { tags: ['Hermes Agent'], summary: 'Report native tool policy reconciliation', security: [{ hermesRegistryToken: [] }],
    responses: { 200: success('Policy receipt'), 400: err400, 403: err403 } } },
  '/hermes-registry/capture': { post: { tags: ['Hermes Agent'], summary: 'Capture a complete local Hermes skill revision', security: [{ hermesRegistryToken: [] }],
    responses: { 201: success('Immutable revision or admission hold'), 400: err400, 403: err403 } } },
  '/hermes-registry/artifacts/{kind}/{slug}/{revision}': { get: { tags: ['Hermes Agent'], summary: 'Download an assigned immutable artifact', security: [{ hermesRegistryToken: [] }],
    responses: { 200: success('Hashed artifact'), 401: err401, 403: err403, 404: err404 } } },
  '/hermes-registry/receipts': { post: { tags: ['Hermes Agent'], summary: 'Report a component reconciliation receipt', security: [{ hermesRegistryToken: [] }],
    responses: { 201: success('Durable receipt ID'), 400: err400, 403: err403 } } },
  '/hermes-registry/inventory': { post: { tags: ['Hermes Agent'], summary: 'Report plugin and MCP source inventory', security: [{ hermesRegistryToken: [] }],
    responses: { 200: success('Inventory count'), 400: err400, 403: err403 } } },
  '/hermes-registry/core/slot': { post: { tags: ['Hermes Agent'], summary: 'Lease a stable Hermes core rollout slot', security: [{ hermesRegistryToken: [] }],
    responses: { 200: success('Rollout slot and pinned release'), 401: err401, 403: err403 } } },
  '/hermes-registry/core/receipts': { post: { tags: ['Hermes Agent'], summary: 'Settle a core slot with native update and health evidence', security: [{ hermesRegistryToken: [] }],
    responses: { 200: success('Settled core rollout slot'), 400: err400, 403: err403 } } },
  '/hermes-registry/revisions': { post: { tags: ['Hermes Agent'], summary: 'Publish a scanned skill, plugin, or MCP revision', security: apiSecretAuth,
    responses: { 201: success('Immutable revision and admission status'), 400: err400, 403: err403 } } },
  '/hermes-registry/sources/refresh': { post: { tags: ['Hermes Agent'], summary: 'Check admitted plugin and MCP Git sources for compatible pinned commits', security: apiSecretAuth,
    responses: { 200: success('Extension source refresh results'), 400: err400, 403: err403 } } },
  '/hermes-registry/targets': { post: { tags: ['Hermes Agent'], summary: 'Assign or pin a revision to a named host profile', security: apiSecretAuth,
    responses: { 200: success('Target'), 400: err400, 403: err403 } } },
  '/hermes-registry/status': { get: { tags: ['Hermes Agent'], summary: 'Inspect registry revisions, scoped clients, and drift', security: apiSecretAuth,
    responses: { 200: success('Registry status'), 401: err401 } } },
  '/hermes-registry/profile-groups/{profileId}': { put: { tags: ['Hermes Agent'], summary: 'Set exact tag-matching profile groups', security: apiSecretAuth,
    responses: { 200: success('Profile groups'), 400: err400, 403: err403 } } },
  '/hermes-registry/revisions/{kind}/{slug}/{revision}/consent': { post: { tags: ['Hermes Agent'], summary: 'Record operator consent before plugin or MCP contract promotion', security: apiSecretAuth,
    responses: { 200: success('Consent status'), 400: err400, 403: err403 } } },
  '/skills/registry': {
    get: {
      tags: ['Skills'],
      summary: 'List registry entries',
      description: 'Returns all skill registry entries with versions and tags.',
      security: apiSecretAuth,
      responses: {
        200: success('Registry list', { type: 'array', items: { type: 'object' } }),
        401: err401,
      },
    },
  },
  '/skills/registry/sync': {
    post: {
      tags: ['Skills'],
      summary: 'Sync filesystem to registry',
      description: 'Scans the skills directory and creates registry entries for any skills not yet registered.',
      security: apiSecretAuth,
      responses: {
        200: success('Sync results', { type: 'object', properties: { created: { type: 'integer' }, existing: { type: 'integer' } } }),
        401: err401,
        403: err403,
      },
    },
  },
  '/skills/registry/{slug}': {
    get: {
      tags: ['Skills'],
      summary: 'Get registry entry',
      description: 'Returns a single skill registry entry with all versions.',
      security: apiSecretAuth,
      parameters: [pp('slug', 'Skill slug')],
      responses: {
        200: success('Registry entry', { type: 'object' }),
        401: err401,
        404: err404,
      },
    },
    delete: {
      tags: ['Skills'],
      summary: 'Delete registry entry',
      description: 'Delete a skill registry entry and all associated versions and tags. Requires ADMIN role.',
      security: apiSecretAuth,
      parameters: [pp('slug', 'Skill slug')],
      responses: {
        200: success('Registry entry deleted'),
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },
  '/skills/registry/{slug}/publish': {
    post: {
      tags: ['Skills'],
      summary: 'Publish version',
      description: 'Publish a new immutable version of a skill with content-hash integrity. Optionally apply tags.',
      security: apiSecretAuth,
      parameters: [pp('slug', 'Skill slug')],
      requestBody: jsonBody('PublishVersion'),
      responses: {
        201: success('Version published', { type: 'object' }),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
        409: err409,
      },
    },
  },
  '/skills/registry/{slug}/versions': {
    get: {
      tags: ['Skills'],
      summary: 'List versions',
      description: 'Returns the version history for a skill in the registry.',
      security: apiSecretAuth,
      parameters: [pp('slug', 'Skill slug')],
      responses: {
        200: success('Version list', { type: 'array', items: { type: 'object' } }),
        401: err401,
        404: err404,
      },
    },
  },
  '/skills/registry/{slug}/versions/{version}': {
    get: {
      tags: ['Skills'],
      summary: 'Get version detail',
      description: 'Returns a specific version snapshot.',
      security: apiSecretAuth,
      parameters: [pp('slug', 'Skill slug'), pp('version', 'Semver version string')],
      responses: {
        200: success('Version detail', { type: 'object' }),
        401: err401,
        404: err404,
      },
    },
  },
  '/skills/registry/{slug}/tags': {
    post: {
      tags: ['Skills'],
      summary: 'Set tag',
      description: 'Set or move a mutable tag (e.g., `latest`, `stable`) to point to a specific version.',
      security: apiSecretAuth,
      parameters: [pp('slug', 'Skill slug')],
      requestBody: jsonBody('SetTag'),
      responses: {
        200: success('Tag set'),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },

  // ──────────────── Logs ────────────────
  '/logs/query': {
    post: {
      tags: ['Logs'],
      summary: 'Query logs',
      description: 'Search and filter log entries with pagination. Supports filtering by node, source, level, time range, and full-text search.',
      security: apiSecretAuth,
      requestBody: jsonBody('LogQuery'),
      responses: {
        200: paginated('Log entries', ref('LogEntry')),
        400: err400,
        401: err401,
      },
    },
  },
  '/logs/ingest': {
    post: {
      tags: ['Logs'],
      summary: 'Ingest log entries',
      description: 'Ingest one or more log entries from agents. Accepts a single object or an array.',
      security: apiSecretAuth,
      requestBody: jsonBody('LogIngest'),
      responses: {
        200: success('Logs ingested', { type: 'object', properties: { ingested: { type: 'integer' } } }),
        400: err400,
        401: err401,
      },
    },
  },
  '/logs/stream': {
    get: {
      tags: ['Logs'],
      summary: 'Live log stream (SSE)',
      description: 'Server-Sent Events stream of real-time log entries. Supports filtering by nodeIds, sources, and levels via query parameters. Sends a heartbeat comment every 30 seconds.',
      security: apiSecretAuth,
      parameters: [
        qp('nodeIds', 'Comma-separated node IDs to filter'),
        qp('sources', 'Comma-separated source names to filter'),
        qp('levels', 'Comma-separated log levels to filter'),
      ],
      responses: {
        200: {
          description: 'SSE event stream',
          content: { 'text/event-stream': { schema: { type: 'string' } } },
        },
        401: err401,
      },
    },
  },

  // ──────────────── Audit ────────────────
  '/audit': {
    get: {
      tags: ['Audit'],
      summary: 'Query audit events',
      description: 'Query the immutable audit trail. Events are stored as append-only JSONL files.',
      security: apiSecretAuth,
      parameters: [
        qp('page', 'Page number', { type: 'integer' }),
        qp('pageSize', 'Items per page', { type: 'integer' }),
        qp('date', 'Filter by date (YYYY-MM-DD)'),
        qp('action', 'Filter by audit action'),
        qp('actorId', 'Filter by actor ID'),
      ],
      responses: {
        200: paginated('Audit events', ref('AuditEvent')),
        401: err401,
      },
    },
  },
  '/audit/days': {
    get: {
      tags: ['Audit'],
      summary: 'List audit log days',
      description: 'Returns the list of date keys (YYYY-MM-DD) for which audit log files exist.',
      security: apiSecretAuth,
      responses: {
        200: success('Available days', { type: 'array', items: { type: 'string', format: 'date' } }),
        401: err401,
      },
    },
  },

  // ──────────────── Library ────────────────
  '/library/categories': {
    get: {
      tags: ['Library'],
      summary: 'List categories',
      description: 'Returns all library categories with file counts.',
      security: apiSecretAuth,
      responses: {
        200: success('Category list', { type: 'array', items: ref('LibraryCategory') }),
        401: err401,
      },
    },
    post: {
      tags: ['Library'],
      summary: 'Create category',
      description: 'Create a new organizational category for library files.',
      security: apiSecretAuth,
      requestBody: jsonBody('CreateCategory'),
      responses: {
        201: success('Category created', ref('LibraryCategory')),
        400: err400,
        401: err401,
        403: err403,
      },
    },
  },
  '/library/categories/{categoryId}': {
    patch: {
      tags: ['Library'],
      summary: 'Update category',
      security: apiSecretAuth,
      parameters: [pp('categoryId', 'Category ID')],
      requestBody: jsonBody('UpdateCategory'),
      responses: {
        200: success('Category updated', ref('LibraryCategory')),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
    delete: {
      tags: ['Library'],
      summary: 'Delete category',
      description: 'Delete a category. Files in this category have their categoryId unset. Requires ADMIN role.',
      security: apiSecretAuth,
      parameters: [pp('categoryId', 'Category ID')],
      responses: {
        200: success('Category deleted'),
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },
  '/library/files': {
    get: {
      tags: ['Library'],
      summary: 'List/search files',
      description: 'List and search library files. Supports category filter, MIME type filter, and full-text search.',
      security: apiSecretAuth,
      parameters: [
        qp('query', 'Full-text search term'),
        qp('categoryId', 'Filter by category ID'),
        qp('mimeType', 'Filter by MIME type'),
        qp('page', 'Page number', { type: 'integer' }),
        qp('pageSize', 'Items per page', { type: 'integer' }),
      ],
      responses: {
        200: paginated('Library files', ref('LibraryFile')),
        401: err401,
      },
    },
    post: {
      tags: ['Library'],
      summary: 'Create/upload file',
      description: 'Create a new library file with optional content and category assignment.',
      security: apiSecretAuth,
      requestBody: jsonBody('CreateLibraryFile'),
      responses: {
        201: success('File created', ref('LibraryFile')),
        400: err400,
        401: err401,
        403: err403,
      },
    },
  },
  '/library/files/move': {
    post: {
      tags: ['Library'],
      summary: 'Move files to category',
      description: 'Bulk-move files to a category (or unset their category).',
      security: apiSecretAuth,
      requestBody: jsonBody('MoveFiles'),
      responses: {
        200: success('Files moved'),
        400: err400,
        401: err401,
        403: err403,
      },
    },
  },
  '/library/files/{fileId}': {
    get: {
      tags: ['Library'],
      summary: 'Get file',
      description: 'Returns a single library file including its content.',
      security: apiSecretAuth,
      parameters: [pp('fileId', 'File ID')],
      responses: {
        200: success('File details', ref('LibraryFile')),
        401: err401,
        404: err404,
      },
    },
    patch: {
      tags: ['Library'],
      summary: 'Update file',
      security: apiSecretAuth,
      parameters: [pp('fileId', 'File ID')],
      requestBody: jsonBody('UpdateLibraryFile'),
      responses: {
        200: success('File updated', ref('LibraryFile')),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
    delete: {
      tags: ['Library'],
      summary: 'Delete file',
      description: 'Permanently delete a library file. Requires ADMIN role.',
      security: apiSecretAuth,
      parameters: [pp('fileId', 'File ID')],
      responses: {
        200: success('File deleted'),
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },
  '/library/deploy': {
    post: {
      tags: ['Library'],
      summary: 'Deploy library item',
      description: 'Deploy a library file (as a skill or cron job) to one or more nodes.',
      security: apiSecretAuth,
      parameters: [{ name: 'x-idempotency-key', in: 'header', required: true, schema: { type: 'string' }, description: 'Idempotency key' }],
      requestBody: jsonBody('DeployLibrary'),
      responses: {
        200: success('Deployment initiated'),
        400: err400,
        401: err401,
        403: err403,
      },
    },
  },

  // ──────────────── Roles ────────────────
  '/roles': {
    get: {
      tags: ['Roles'],
      summary: 'List roles',
      description: 'Returns all node roles with assigned node counts.',
      security: apiSecretAuth,
      responses: {
        200: success('Role list', { type: 'array', items: ref('Role') }),
        401: err401,
      },
    },
    post: {
      tags: ['Roles'],
      summary: 'Create role',
      description: 'Create a node role definition with packages, skills, Docker, and firewall configuration.',
      security: apiSecretAuth,
      requestBody: jsonBody('CreateRole'),
      responses: {
        201: success('Role created', ref('Role')),
        400: err400,
        401: err401,
        403: err403,
      },
    },
  },
  '/roles/applications/list': {
    get: {
      tags: ['Roles'],
      summary: 'List role applications',
      description: 'Returns role application records, optionally filtered by roleId, nodeId, or status.',
      security: apiSecretAuth,
      parameters: [
        qp('roleId', 'Filter by role ID'),
        qp('nodeId', 'Filter by node ID'),
        qp('status', 'Filter by status', { enum: ['pending', 'running', 'completed', 'failed'] }),
      ],
      responses: {
        200: success('Application list', { type: 'array', items: { type: 'object' } }),
        401: err401,
      },
    },
  },
  '/roles/applications/{appId}': {
    get: {
      tags: ['Roles'],
      summary: 'Get application status',
      description: 'Returns a single role application record with step logs.',
      security: apiSecretAuth,
      parameters: [pp('appId', 'Application ID')],
      responses: {
        200: success('Application details', { type: 'object' }),
        401: err401,
        404: err404,
      },
    },
  },
  '/roles/{roleId}': {
    get: {
      tags: ['Roles'],
      summary: 'Get role',
      description: 'Returns a role with its configuration and list of assigned nodes.',
      security: apiSecretAuth,
      parameters: [pp('roleId', 'Role ID')],
      responses: {
        200: success('Role details', ref('Role')),
        401: err401,
        404: err404,
      },
    },
    patch: {
      tags: ['Roles'],
      summary: 'Update role',
      security: apiSecretAuth,
      parameters: [pp('roleId', 'Role ID')],
      requestBody: jsonBody('UpdateRole'),
      responses: {
        200: success('Role updated', ref('Role')),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
    delete: {
      tags: ['Roles'],
      summary: 'Delete role',
      description: 'Delete a role and unassign all nodes. Requires ADMIN role.',
      security: apiSecretAuth,
      parameters: [pp('roleId', 'Role ID')],
      responses: {
        200: success('Role deleted'),
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },
  '/roles/{roleId}/assign': {
    post: {
      tags: ['Roles'],
      summary: 'Assign role to nodes',
      description: 'Assign a role to one or more nodes. Optionally triggers immediate application (defer=false).',
      security: apiSecretAuth,
      parameters: [
        pp('roleId', 'Role ID'),
        { name: 'x-idempotency-key', in: 'header', required: true, schema: { type: 'string' }, description: 'Idempotency key' },
      ],
      requestBody: jsonBody('AssignRole'),
      responses: {
        200: success('Role assigned'),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },
  '/roles/{roleId}/unassign': {
    post: {
      tags: ['Roles'],
      summary: 'Unassign role from nodes',
      description: 'Remove a role assignment from nodes and trigger removal on agents.',
      security: apiSecretAuth,
      parameters: [pp('roleId', 'Role ID')],
      requestBody: jsonBody('UnassignRole'),
      responses: {
        200: success('Role unassigned'),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },
  '/roles/{roleId}/apply': {
    post: {
      tags: ['Roles'],
      summary: 'Apply role to nodes',
      description: 'Manually trigger role application on assigned nodes. If nodeIds is omitted, applies to all assigned nodes.',
      security: apiSecretAuth,
      parameters: [
        pp('roleId', 'Role ID'),
        { name: 'x-idempotency-key', in: 'header', required: true, schema: { type: 'string' }, description: 'Idempotency key' },
      ],
      requestBody: jsonBody('ApplyRole'),
      responses: {
        200: success('Role application initiated'),
        400: err400,
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },

  // ──────────────── Notifications ────────────────
  '/notifications': {
    get: {
      tags: ['Notifications'],
      summary: 'List notifications',
      description: 'Returns notifications with optional filtering by read status, severity, type, and node.',
      security: apiSecretAuth,
      parameters: [
        qp('page', 'Page number', { type: 'integer' }),
        qp('pageSize', 'Items per page', { type: 'integer' }),
        qp('isRead', 'Filter: true/false'),
        qp('severity', 'Filter by severity', { enum: ['info', 'warning', 'critical'] }),
        qp('type', 'Filter by notification type'),
        qp('nodeId', 'Filter by node ID'),
      ],
      responses: {
        200: paginated('Notifications', ref('Notification')),
        401: err401,
      },
    },
  },
  '/notifications/unread-count': {
    get: {
      tags: ['Notifications'],
      summary: 'Unread count',
      description: 'Returns the number of unread notifications.',
      security: apiSecretAuth,
      responses: {
        200: success('Unread count', { type: 'object', properties: { count: { type: 'integer' } } }),
        401: err401,
      },
    },
  },
  '/notifications/read': {
    post: {
      tags: ['Notifications'],
      summary: 'Mark as read',
      description: 'Mark specific notifications as read by their IDs.',
      security: apiSecretAuth,
      requestBody: jsonBody('NotificationRead'),
      responses: {
        200: success('Marked as read'),
        400: err400,
        401: err401,
      },
    },
  },
  '/notifications/read-all': {
    post: {
      tags: ['Notifications'],
      summary: 'Mark all as read',
      description: 'Mark all notifications as read.',
      security: apiSecretAuth,
      responses: {
        200: success('All marked as read'),
        401: err401,
      },
    },
  },

  // ──────────────── Deploy ────────────────
  '/deploy': {
    post: {
      tags: ['Deploy'],
      summary: 'Deploy agent',
      description: 'Deploy a Magnus agent to a remote host via SSH. Returns 202 — deployment runs asynchronously.',
      security: apiSecretAuth,
      parameters: [{ name: 'x-idempotency-key', in: 'header', required: true, schema: { type: 'string' }, description: 'Idempotency key' }],
      requestBody: jsonBody('DeployNode'),
      responses: {
        202: success('Deployment started'),
        400: err400,
        401: err401,
        403: err403,
      },
    },
  },
  '/deploy/status/{nodeId}': {
    get: {
      tags: ['Deploy'],
      summary: 'Agent deploy status',
      description: 'Check the current status of an agent deployment.',
      security: apiSecretAuth,
      parameters: [pp('nodeId', 'Node ID')],
      responses: {
        200: success('Deploy status', { type: 'object', properties: { status: { type: 'string' }, logs: { type: 'array', items: { type: 'string' } } } }),
        401: err401,
        404: err404,
      },
    },
  },
  '/deploy/control-node': {
    post: {
      tags: ['Deploy'],
      summary: 'Deploy control node',
      description: 'Deploy a new Control API instance to a remote host via SSH. Installs Node.js, Redis, and sets up a systemd service.',
      security: apiSecretAuth,
      parameters: [{ name: 'x-idempotency-key', in: 'header', required: true, schema: { type: 'string' }, description: 'Idempotency key' }],
      requestBody: jsonBody('DeployControlNode'),
      responses: {
        202: success('Deployment started', { type: 'object', properties: { deployId: { type: 'string' } } }),
        400: err400,
        401: err401,
        403: err403,
      },
    },
  },
  '/deploy/control-node/status/{deployId}': {
    get: {
      tags: ['Deploy'],
      summary: 'Control node deploy status',
      description: 'Check progress of a control-node deployment.',
      security: apiSecretAuth,
      parameters: [pp('deployId', 'Deploy ID')],
      responses: {
        200: success('Deploy progress', {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
            steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, status: { type: 'string' } } } },
          },
        }),
        401: err401,
        404: err404,
      },
    },
  },

  // ──────────────── Discovery ────────────────
  '/discovery/scan': {
    post: {
      tags: ['Discovery'],
      summary: 'Network scan',
      description: 'Broadcast a UDP discovery packet on the local network and collect agent responses. Default timeout 5 seconds.',
      security: apiSecretAuth,
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { timeoutMs: { type: 'integer', description: 'Scan timeout in milliseconds (default 5000)' } },
            },
          },
        },
      },
      responses: {
        200: success('Discovered agents', {
          type: 'array',
          items: {
            type: 'object',
            properties: { hostname: { type: 'string' }, ip: { type: 'string' }, port: { type: 'integer' }, version: { type: 'string' } },
          },
        }),
        401: err401,
        403: err403,
      },
    },
  },

  // ──────────────── Scan ────────────────
  '/scan/skills': {
    post: {
      tags: ['Scan'],
      summary: 'Scan fleet skills',
      description: 'Query all online nodes for their installed skills and aggregate results.',
      security: apiSecretAuth,
      responses: {
        200: success('Scan results', { type: 'array', items: { type: 'object' } }),
        401: err401,
        403: err403,
      },
    },
  },
  '/scan/cron': {
    post: {
      tags: ['Scan'],
      summary: 'Scan fleet cron jobs',
      description: 'Query all online nodes for MAGNUS cron jobs on their system crontabs.',
      security: apiSecretAuth,
      responses: {
        200: success('Scan results', { type: 'array', items: { type: 'object' } }),
        401: err401,
        403: err403,
      },
    },
  },

  // ──────────────── Stats ────────────────
  '/console/session': {
    get: {
      tags: ['Stats'],
      summary: 'Role and capabilities of the signed-in browser console user',
      security: [{ bearerAuth: [] }, { apiSecret: [] }],
      responses: {
        '200': success('Mapped role and console capabilities', {
          type: 'object',
          required: ['userId', 'role', 'capabilities'],
          properties: {
            userId: { type: 'string' },
            role: { type: 'string', enum: ['ADMIN', 'OPERATOR', 'VIEWER'] },
            capabilities: {
              type: 'object',
              required: ['hermes', 'terminal', 'agentVersion', 'magnusVersion', 'securityConsoleUrl'],
              properties: {
                hermes: { type: 'boolean' },
                terminal: { type: 'boolean', description: 'The fleet gateway is deployed and this person may use it.' },
                agentVersion: { type: 'string' },
                magnusVersion: { type: 'string' },
                securityConsoleUrl: { type: ['string', 'null'] },
              },
            },
          },
        }),
        '401': err401,
        '403': err403,
      },
    },
  },
  '/stats/overview': {
    get: {
      tags: ['Stats'],
      summary: 'Fleet overview',
      description: 'Returns aggregated fleet statistics: node counts by status, command stats, cron/skill counts, health averages, and recent activity.',
      security: apiSecretAuth,
      responses: {
        200: success('Fleet statistics', {
          type: 'object',
          properties: {
            nodes: { type: 'object', properties: { total: { type: 'integer' }, online: { type: 'integer' }, offline: { type: 'integer' }, degraded: { type: 'integer' } } },
            commands: { type: 'object', properties: { total: { type: 'integer' }, pending: { type: 'integer' }, completed: { type: 'integer' }, failed: { type: 'integer' } } },
            cronJobs: { type: 'integer' },
            skills: { type: 'integer' },
          },
        }),
        401: err401,
      },
    },
  },

  // ──────────────── Self-Update ────────────────
  '/system/updates': {
    get: {
      tags: ['Updates'],
      summary: 'Available releases and agent version skew',
      description: 'Result of the daily npm registry check (MAGNUS_UPDATE_CHECK): the newest release of the running major, a newer major if any, release notes, new required settings and slow or one-way migrations. Also lists agents that run a different version than this server ships with, and the command that fixes it.',
      security: apiSecretAuth,
      responses: { 200: success('Update status', { type: 'object', properties: {
        version: { type: 'string' },
        server: { type: 'object', properties: { enabled: { type: 'boolean' }, current: { type: 'string' }, latest: { type: ['string', 'null'] },
          latestMajor: { type: ['string', 'null'] }, updateAvailable: { type: 'boolean' }, command: { type: 'string' } } },
        agents: { type: 'object', properties: { expected: { type: 'string' }, current: { type: 'integer' },
          behind: { type: 'array', items: { type: 'object' } }, ahead: { type: 'array', items: { type: 'object' } },
          upgradesEnabled: { type: 'boolean' }, fixCommand: { type: ['string', 'null'] } } },
      } }), 401: err401 },
    },
  },
  '/system/updates/check': {
    post: {
      tags: ['Updates'],
      summary: 'Check the registry now',
      description: 'Refreshes the update check immediately (ADMIN or OPERATOR).',
      security: apiSecretAuth,
      responses: { 200: success('Update status'), 401: err401, 403: err403 },
    },
  },
  '/agents/{agentRef}/identity': {
    get: {
      tags: ['Agent identity'],
      summary: 'Resolve an agent reference',
      description: 'The identity of one agent profile: `agentRef` (`<nodeId>~<profile>`, each part `[A-Za-z0-9._-]{1,128}`), its runtime (`ardent` or `hermes`), and its HiveMem actor and workspace once Magnus enrolled an Ardent profile in HiveMem. `oathweaveSubject` and `emberpathClientKeyId` are null: Magnus issues neither per agent. Any role may read it; an Ardent profile is visible to ADMIN only, as on the Ardent routes, and wins over a Hermes profile of the same name on the node. Never carries a credential.',
      security: apiSecretAuth,
      parameters: [pp('agentRef', '`<nodeId>~<profile>`')],
      responses: { 200: success('Agent identity', ref('AgentIdentity')), 400: err400, 401: err401, 403: err403, 404: err404,
        409: { ...err409, description: 'AGENT_REF_AMBIGUOUS: two Hermes installations on the node have the profile' } },
    },
  },
  '/agents/identity': {
    get: {
      tags: ['Agent identity'],
      summary: 'Find an agent by HiveMem actor',
      description: 'Reverse lookup: the agent whose HiveMem actor ID (`[a-z0-9_-]{2,32}`) is `actorId`. Only Ardent profiles Magnus enrolled in HiveMem have one, so a match needs ADMIN.',
      security: apiSecretAuth,
      parameters: [qp('actorId', 'HiveMem actor ID', { required: true })],
      responses: { 200: success('Agent identity', ref('AgentIdentity')), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 },
    },
  },
  '/agents/upgrade/eligibility': {
    get: {
      tags: ['Agent upgrades'],
      summary: 'Which agents can take a version',
      description: 'For every node: its agent version and whether it can upgrade itself to `version` (default: the agent version bundled with this server) now, or why not: offline, not set up with `magnus-agent install-service`, MAGNUS_AGENT_SELF_UPGRADE=false, another major version, already current, already reverted this version, a closed release admission fence, a resource enrollment that is not complete (for example "stuck in draining since <date>"), held participant work or command leases, or an agent whose sticky managed-enrollment marker the server does not share. Each blocked node has a `code` from the upgrade problem catalogue. `preflight` is the latest result of the agent check for this version, when one is recent, and only for ADMIN. `release.verified` is false when the registry does not have the version.',
      security: apiSecretAuth,
      parameters: [qp('version', 'Target agent version (X.Y.Z)'), qp('allowRetryReverted', '`true` to offer nodes that already reverted this version')],
      responses: { 200: success('Eligibility', { type: 'object', properties: {
        version: { type: 'string' }, serverVersion: { type: 'string' }, upgradesEnabled: { type: 'boolean' }, disabledReason: { type: ['string', 'null'] },
        prerelease: { type: 'boolean' },
        release: { type: 'object', properties: { verified: { type: 'boolean' }, integrity: { type: ['string', 'null'] }, reason: { type: ['string', 'null'] } } },
        nodes: { type: 'array', items: { type: 'object', properties: { nodeId: { type: 'string' }, name: { type: 'string' },
          version: { type: 'string' }, eligible: { type: 'boolean' }, reason: { type: ['string', 'null'] }, code: { type: ['string', 'null'] }, preflight: { type: ['object', 'null'], description: 'status: ok, warning, blocked, unavailable (older agent) or unreachable; problems: code, detail, blocking' } } } },
        latestRun: { type: ['object', 'null'] },
      } }), 400: err400, 401: err401 },
    },
  },
  '/agents/upgrade': {
    post: {
      tags: ['Agent upgrades'],
      summary: 'Upgrade agents',
      description: 'Starts an upgrade run (ADMIN, MAGNUS_AGENT_UPGRADES=true): every selected node is checked first, then one canary, then MAGNUS_AGENT_UPGRADE_CONCURRENCY agents at a time. Each agent installs the exact version and npm integrity and switches back by itself if the new version does not report a heartbeat in time. With `dryRun` it returns 200 with the full per-node report and starts nothing. Only evidence about the release stops a run: an integrity or source failure at once, a release failure on the canary, `maxFailures` ambiguous canaries with nothing confirmed (at least two, reported as suspect but unproven in `suspectedRelease`; nodes that cannot report their fence go last and do not count while another may still confirm), and after the canary `maxFailures` reverts, failed installs or trials that never confirm. A problem of one node is recorded and the run goes on: a refused canary hands the role to the next node, transient refusals are tried again at the end of the wave, and a node whose reply was lost is watched by request id (`watching`, then `ambiguous`) without holding a batch slot past its window. The final status is `succeeded`, `partial` (node-level problems, nothing against the release), `failed` (release evidence), `stopped` or `interrupted`, and `attention` lists each node with a code, a cause and a remedy; a run is `succeeded` only if every selected node is confirmed or has an informational reason. `warnings` lists what the check found that does not stop a node. Only one run at a time. Selected nodes that are not eligible are listed in `excluded`; unknown node ids are a 400.',
      security: apiSecretAuth,
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: {
        version: { type: 'string', description: 'Agent version (default: the one bundled with this server)' },
        integrity: { type: 'string', description: 'npm sha512 integrity (default: read from the registry)' },
        nodeIds: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Only these nodes (leave out for every eligible agent)' },
        canaryNodeId: { type: 'string', description: 'Upgrade this node first' },
        allowPrerelease: { type: 'boolean', description: 'Required for a prerelease version' },
        allowRetryReverted: { type: 'boolean', description: 'Also upgrade nodes that already reverted this version' },
        dryRun: { type: 'boolean', description: 'Report on every selected node and start nothing' },
        maxFailures: { type: 'integer', minimum: 1, maximum: 1000, description: 'Release failures that stop this run (default MAGNUS_AGENT_UPGRADE_MAX_FAILURES)' },
      } } } } },
      responses: { 200: success('Dry run report'), 202: success('Run started'), 400: err400, 401: err401, 403: err403, 409: err409 },
    },
  },
  '/agents/upgrade/runs/latest': {
    get: {
      tags: ['Agent upgrades'],
      summary: 'Latest upgrade run',
      security: apiSecretAuth,
      responses: { 200: success('Run (or null)'), 401: err401 },
    },
  },
  '/agents/upgrade/runs/{id}': {
    get: {
      tags: ['Agent upgrades'],
      summary: 'Upgrade run status',
      description: 'Run status (running, succeeded, failed, stopped or interrupted) and per-node state: pending, requested, confirmed, reverted, failed, refused or skipped, with the agent error code and message. A run whose server stopped renewing its lease (restart, interrupted CLI) is shown as interrupted; its requested nodes are settled from their heartbeat reports.',
      security: apiSecretAuth,
      parameters: [pp('id', 'Run ID')],
      responses: { 200: success('Run'), 401: err401, 404: err404 },
    },
  },
  '/agents/upgrade/runs/{id}/stop': {
    post: {
      tags: ['Agent upgrades'],
      summary: 'Stop an upgrade run',
      description: 'ADMIN. The run stops before its next batch; nodes already asked to upgrade finish their trial.',
      security: apiSecretAuth,
      parameters: [pp('id', 'Run ID')],
      responses: { 202: success('Stop requested'), 401: err401, 403: err403, 404: err404, 409: err409 },
    },
  },
  '/agents/upgrade/runs/{id}/retry': {
    post: {
      tags: ['Agent upgrades'],
      summary: 'Retry an upgrade run',
      description: 'ADMIN. Starts a new run with the same version and integrity for the nodes of a finished run that were not upgraded: failed, refused, skipped, ambiguous and interrupted ones, and those the check held back (reverted nodes only with allowRetryReverted).',
      security: apiSecretAuth,
      parameters: [pp('id', 'Run ID')],
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: {
        canaryNodeId: { type: 'string' }, allowRetryReverted: { type: 'boolean' }, maxFailures: { type: 'integer', minimum: 1, maximum: 1000 }, acknowledgeSuspicion: { type: 'boolean', description: 'After a run that stopped on ambiguous answers from older agents, include older agents again; without this they are held back with RETRY_HELD_SUSPECTED' },
      } } } } },
      responses: { 202: success('Run started'), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 },
    },
  },
  '/self-update/status': {
    get: {
      tags: ['Self-Update'],
      summary: 'Version and update status',
      description: 'Returns the current Control Node version, git branch/commit info, and whether updates are available.',
      security: apiSecretAuth,
      responses: {
        200: success('Status', {
          type: 'object',
          properties: {
            version: { type: 'string' },
            gitBranch: { type: 'string' },
            gitCommit: { type: 'string' },
            updateAvailable: { type: 'boolean' },
          },
        }),
        401: err401,
      },
    },
  },
  '/self-update/version': {
    get: {
      tags: ['Self-Update'],
      summary: 'Version check (lightweight)',
      description: 'Returns only the current version string.',
      security: apiSecretAuth,
      responses: {
        200: success('Version', { type: 'object', properties: { version: { type: 'string' } } }),
        401: err401,
      },
    },
  },
  '/self-update/check': {
    post: {
      tags: ['Self-Update'],
      summary: 'Check for updates',
      description: 'Runs `git fetch` and compares with the remote to determine if updates are available.',
      security: apiSecretAuth,
      responses: {
        200: success('Check result', {
          type: 'object',
          properties: {
            updateAvailable: { type: 'boolean' },
            currentCommit: { type: 'string' },
            remoteCommit: { type: 'string' },
            behindBy: { type: 'integer' },
          },
        }),
        401: err401,
        403: err403,
      },
    },
  },
  '/self-update/apply': {
    post: {
      tags: ['Self-Update'],
      summary: 'Apply update',
      description: 'Source checkouts only, and only with MAGNUS_LEGACY_GIT_SELF_UPDATE=true (otherwise 410 SELF_UPDATE_RETIRED): pull latest code, run `npm ci`, build, and optionally restart the process. npm installs upgrade with `magnus upgrade`. Requires ADMIN role.',
      security: apiSecretAuth,
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { restart: { type: 'boolean', description: 'Restart after build (default false)' } },
            },
          },
        },
      },
      responses: {
        200: success('Update applied'),
        401: err401,
        403: err403,
      },
    },
  },
  '/self-update/restart': {
    post: {
      tags: ['Self-Update'],
      summary: 'Restart process',
      description: 'Restart the Control Node process. Requires ADMIN role.',
      security: apiSecretAuth,
      responses: {
        200: success('Restarting'),
        401: err401,
        403: err403,
      },
    },
  },

  // ──────────────── Terminal ────────────────
  '/terminal/ticket': {
    post: {
      tags: ['Terminal'],
      summary: 'Issue terminal ticket',
      description: 'Issue a one-time ticket (30s TTL) for authenticating a WebSocket terminal session. The ticket is passed as a `?ticket=` query parameter when connecting to the WebSocket endpoint.',
      security: apiSecretAuth,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['nodeId'],
              properties: { nodeId: { type: 'string', description: 'Target node ID for the SSH session' } },
            },
          },
        },
      },
      responses: {
        200: success('Ticket issued', {
          type: 'object',
          properties: {
            ticket: { type: 'string', description: 'One-time auth ticket' },
            expiresIn: { type: 'integer', description: 'Seconds until ticket expires' },
          },
        }),
        401: err401,
      },
    },
  },

  // ─── Hermes / Orchestra ─────────────────────────────────────────
  '/orchestra/jobs': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'List Hermes operation jobs',
      description:
        'Filter by `status`, `type`, `category` (prefix-match on type — e.g. `install`, `skill`, `provider`, `cron`), `installationId`, or `profileId`. ' +
        'Mounted under both `/hermes/jobs` and `/orchestra/jobs`.',
      security: apiSecretAuth,
      parameters: [
        { name: 'status', in: 'query', schema: { type: 'string' } },
        { name: 'type', in: 'query', schema: { type: 'string' } },
        { name: 'category', in: 'query', schema: { type: 'string' } },
        { name: 'installationId', in: 'query', schema: { type: 'string' } },
        { name: 'profileId', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      ],
      responses: {
        200: success('Operation jobs', { type: 'array', items: { type: 'object' } }),
        401: err401,
      },
    },
  },
  '/orchestra/profiles/{id}/api-server/status': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'Get API Server status for a profile',
      security: apiSecretAuth,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: success('API Server status', {
          type: 'object',
          properties: {
            profileId: { type: 'string' },
            installationId: { type: 'string' },
            enabled: { type: 'boolean' },
            host: { type: 'string' },
            port: { type: 'integer', nullable: true },
            keyConfigured: { type: 'boolean' },
            keyFingerprint: { type: 'string', nullable: true, description: 'Present for ADMIN only.' },
            lastSyncedAt: { type: 'string', format: 'date-time', nullable: true },
          },
        }),
        401: err401,
        404: err404,
      },
    },
  },
  '/orchestra/profiles/{id}/api-server/rotate-key': {
    post: {
      tags: ['Hermes Agent'],
      summary: 'Rotate the Hermes API Server key for a profile (ADMIN)',
      description: 'Re-enables the API Server with a fresh API key on the same host/port. If `apiKey` is omitted, a new 32-byte key is generated.',
      security: apiSecretAuth,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { apiKey: { type: 'string', minLength: 16, maxLength: 4096 } },
            },
          },
        },
      },
      responses: {
        202: success('Job queued', { type: 'object' }),
        401: err401,
        403: err403,
        404: err404,
      },
    },
  },
  '/orchestra/skill-assignments': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'List skill assignments for an installation/profile',
      security: apiSecretAuth,
      parameters: [
        { name: 'installationId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'profileId', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: success('Skill assignments', { type: 'array', items: { type: 'object' } }), 401: err401 },
    },
    post: {
      tags: ['Hermes Agent'],
      summary: 'Create a skill assignment (ADMIN/OPERATOR)',
      description:
        'Creates a Hermes skill assignment. See `src/schemas/orchestra.ts` for the full request body; ' +
        'this OpenAPI doc covers the path/auth shape only.',
      security: apiSecretAuth,
      responses: { 201: success('Skill assignment created', { type: 'object' }), 401: err401, 403: err403 },
    },
  },
  '/orchestra/toolset-policies': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'List toolset policies for an installation/profile',
      security: apiSecretAuth,
      parameters: [
        { name: 'installationId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'profileId', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: success('Toolset policies', { type: 'array', items: { type: 'object' } }), 401: err401 },
    },
  },
  '/orchestra/roles': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'List Hermes roles',
      security: apiSecretAuth,
      responses: { 200: success('Roles', { type: 'array', items: { type: 'object' } }), 401: err401 },
    },
  },
  '/orchestra/roles/{id}/child-preview': { get: { tags: ['Hermes Agent'], summary: 'Preview role skill revisions and actual inherited native subagent tools',
    security: apiSecretAuth, parameters: [pp('id', 'Role ID'),
      { name: 'installationId', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'profileId', in: 'query', schema: { type: 'string' } },
      { name: 'platform', in: 'query', schema: { type: 'string', default: 'cli' } }],
    responses: { 200: success('Role briefing and observed tool surface'), 400: err400, 404: err404 } } },
  '/orchestra/provider-configs': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'Get the provider routing config for an installation/profile',
      security: apiSecretAuth,
      parameters: [
        { name: 'installationId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'profileId', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: success('Provider config', { type: 'object' }), 401: err401 },
    },
  },
  '/orchestra/credential-pools': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'List Hermes credential pools (ADMIN-only mutations)',
      security: apiSecretAuth,
      responses: { 200: success('Credential pools', { type: 'array', items: { type: 'object' } }), 401: err401 },
    },
  },
  '/orchestra/mcp-servers': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'List Hermes MCP server definitions',
      security: apiSecretAuth,
      responses: { 200: success('MCP servers', { type: 'array', items: { type: 'object' } }), 401: err401 },
    },
  },
  '/orchestra/messaging-bindings': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'List Hermes messaging bindings',
      security: apiSecretAuth,
      parameters: [
        { name: 'installationId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'profileId', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: success('Messaging bindings', { type: 'array', items: { type: 'object' } }), 401: err401 },
    },
  },
  '/orchestra/cron-jobs': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'List Hermes cron jobs',
      security: apiSecretAuth,
      parameters: [
        { name: 'installationId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'profileId', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: success('Cron jobs', { type: 'array', items: { type: 'object' } }), 401: err401 },
    },
  },
  '/orchestra/plugins': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'List installed Hermes plugins',
      security: apiSecretAuth,
      parameters: [
        { name: 'installationId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'profileId', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: success('Plugin installs', { type: 'array', items: { type: 'object' } }), 401: err401 },
    },
  },
  '/orchestra/hooks': {
    get: {
      tags: ['Hermes Agent'],
      summary: 'List Hermes event hooks',
      security: apiSecretAuth,
      parameters: [
        { name: 'installationId', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'profileId', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: success('Hooks', { type: 'array', items: { type: 'object' } }), 401: err401 },
    },
  },
  '/ardent/installations': {
    get: { tags: ['Magnus Ardent'], summary: 'Inspect Ardent installations on managed nodes',
      description: 'Admin-only node inventory. Node fetch failures remain distinct from a successful empty installation. capabilities.studio is the node agent\'s bridge level: 1 for sessions, task streams, streamed artifacts and New Agent; 2 also for missions, task pause and resume, previews, development history and artifact manifests.',
      security: apiSecretAuth, responses: { 200: success('Ardent installation observations', { type: 'array', items: { type: 'object' } }), 401: err401, 403: err403 } },
  },
  '/ardent/installations/{nodeId}': {
    get: { tags: ['Magnus Ardent'], summary: 'Inspect one node Ardent installation', security: apiSecretAuth,
      description: 'Includes commandOwners, the command owners holding the node (oldest first; an unknown one blocks every managed Ardent action until it is reconciled), and commandReconciliation.configured, whether this server can sign a reconciliation decision. Each profile carries hivemem: null when Magnus manages no HiveMem credential for it, otherwise {agentId, workspaceId, expiresAt, lastRenewedAt, lastAttemptAt, nextRenewalAt, failures, lastError, state} with state ok, renewal-failing or expired.',
      parameters: [pp('nodeId', 'Managed node ID')],
      responses: { 200: success('Ardent installation observation'), 401: err401, 403: err403, 404: err404 } },
  },
  '/ardent/profiles': {
    get: { tags: ['Magnus Ardent'], summary: 'List Ardent profiles reported by managed nodes', security: apiSecretAuth,
      description: 'Each profile carries hivemem, its Magnus-managed HiveMem credential status (null when there is none), as in the installation read.',
      responses: { 200: success('Ardent profile summaries', { type: 'array', items: { type: 'object' } }), 401: err401, 403: err403 } },
  },
  '/ardent/installations/{nodeId}/profiles/{name}/{resource}': {
    get: { tags: ['Magnus Ardent'], summary: 'Read an allowlisted Ardent profile resource through its node agent',
      description: 'The node agent injects the profile-local management token. Browser clients receive only the authorized response body. Resources: openapi, status, profile, config, config/schema, providers, channels, peers, peers/config, memory/status, skills, sessions, sessions/{id}/messages, tasks, tasks/{id}, tasks/{id}/events, identity/soul, identity/identity and their history; with a node agent at studio level 2 (Ardent 2.2.0) also tasks/{id}/artifacts, artifacts/{sha256}/manifest and development. Those, and sessions with context, answer 409 AGENT_UPGRADE_REQUIRED on an older agent. A linked service identity reads status, profile, skills, memory/status, sessions, tasks, identity/soul, identity/identity and the studio level 2 resources, and config ({revision, text}, the same text a person sees, with secrets only as environment variable names or references) only with x-acting-subject naming a linked ADMIN (403 ACTING_ADMIN_REQUIRED otherwise).',
      security: apiSecretAuth, parameters: [pp('nodeId', 'Managed node ID'), pp('name', 'Profile name'), pp('resource', 'Allowlisted profile resource'),
        { name: 'after', in: 'query', schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,400}$' }, description: 'Page cursor: an event sequence, or development\'s next' },
        { name: 'limit', in: 'query', schema: { type: 'string', pattern: '^\\d{1,3}$' } },
        { name: 'kind', in: 'query', schema: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' }, description: 'development only: one record kind' },
        { name: 'context', in: 'query', schema: { type: 'string', enum: ['direct', 'mission', 'preview'] }, description: 'sessions only: the session context (default direct)' }],
      responses: { 200: success('Ardent profile resource'), 400: err400, 401: err401, 403: err403, 404: err404, 409: { description: 'Node agent must be upgraded' }, 503: { description: 'Node or profile API unavailable' } } },
  },
  '/ardent/installations/{nodeId}/profiles/{name}/tasks/{taskId}/stream': {
    get: { tags: ['Magnus Ardent'], summary: 'Stream a task\'s live events',
      description: 'Server-sent events relayed unbuffered from the profile API through the node agent, for tasks, missions and previews alike: task.text (a snapshot of the current step on connect), task.delta (live reply text, never replayed), task.event (journal events with an id) and task.done (the final task). Ardent ends a stream after 60 seconds; reconnect with after or Last-Event-ID set to the last task.event id. Answers 409 AGENT_UPGRADE_REQUIRED when the node agent predates the bridge.',
      security: apiSecretAuth, parameters: [pp('nodeId', 'Managed node ID'), pp('name', 'Profile name'), pp('taskId', 'Ardent task UUID'),
        { name: 'after', in: 'query', schema: { type: 'string', pattern: '^\\d{1,15}$' }, description: 'Resume after this journal sequence' },
        { name: 'Last-Event-ID', in: 'header', schema: { type: 'string', pattern: '^\\d{1,15}$' } }],
      responses: { 200: { description: 'Task event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
        400: err400, 401: err401, 403: err403, 404: err404, 409: { description: 'Node agent must be upgraded' }, 503: { description: 'Node or profile API unavailable' } } },
  },
  '/ardent/installations/{nodeId}/profiles/{name}/artifacts/{artifactId}': {
    get: { tags: ['Magnus Ardent'], summary: 'Download a profile artifact by SHA-256 ID',
      description: 'Admin-only byte transfer through the node agent, streamed without buffering. The agent caps size with MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES (default 64 MiB). The Ardent profile token stays on the node.',
      security: apiSecretAuth, parameters: [pp('nodeId', 'Managed node ID'), pp('name', 'Profile name'), pp('artifactId', 'Artifact SHA-256 ID')],
      responses: { 200: { description: 'Artifact bytes', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        401: err401, 403: err403, 404: err404, 503: { description: 'Node or profile API unavailable' } } },
  },
  '/ardent/installations/{nodeId}/profiles/{name}/context-release': {
    get: { tags: ['Magnus Ardent'], summary: 'Inspect the pinned context-only adoption payload without changing a profile',
      security: apiSecretAuth, parameters: [pp('nodeId', 'Managed node ID'), pp('name', 'Profile name')],
      responses: { 200: success('Context release digests and service compatibility'), 401: err401, 403: err403, 503: { description: 'Context release unavailable' } } },
  },
  '/ardent/installations/{nodeId}/profiles/{name}/context-adoptions/{releaseId}': {
    get: { tags: ['Magnus Ardent'], summary: 'Inspect a retained context-adoption journal without retrying work',
      description: 'A journal phase is diagnostic state, not a signed completion receipt or permission to clear an unsettled resource lease.',
      security: apiSecretAuth, parameters: [pp('nodeId', 'Managed node ID'), pp('name', 'Profile name'), pp('releaseId', 'Adoption release UUID')],
      responses: { 200: success('Retained revision pins, acceptance and phase'), 400: err400, 401: err401, 403: err403,
        503: { description: 'Retained journal unavailable' } } },
  },
  '/ardent/installations/{nodeId}/profiles/{name}/action': {
    post: { tags: ['Magnus Ardent'], summary: 'Run a finite node-scoped Ardent profile action',
      description: 'The Control API dispatches through the node managed-mutation boundary. A task-submit result proves durable admission only; task completion is read from the Ardent task API or its stream. session-open takes {key, reset?, context?} and task-submit takes {prompt, idempotency_key, session_id?}; both answer 409 AGENT_UPGRADE_REQUIRED when a session is involved and the node agent predates the bridge. Ardent 2.2.0 actions need a node agent at studio level 2, or answer 409 AGENT_UPGRADE_REQUIRED: mission-submit takes {session_id?, objective, mission (TeamMission 1.0), context_items? (64 KiB in all), labels?, idempotency_key} in at most 200 KB and needs a session opened with context mission; preview-submit takes {prompt, overrides? {soul?, identity?, skills_enabled?, model?}, session_id?, idempotency_key?} in at most 300 KB; task-pause and task-resume take the task ID as target; development-note takes {kind, title, body, sources?, author? (operator or agent)}. Mission and preview submissions prove admission only and stream on the task stream. For these actions Ardent\'s 400, 404 and 409 (a finished task cannot pause) come back with that status. A linked service identity needs x-acting-subject for preview-submit and development-note, and x-acting-subject naming a linked ADMIN for identity-save ({text, revision}, target soul or identity), skill-set ({enabled, revision}, the skill name as target) and config-save ({text, revision}), or 403 ACTING_ADMIN_REQUIRED. A service config-save may change only execution.backend, the llamacpp model, request_timeout_seconds, context_window_tokens, max_output_tokens and reasoning_effort, providers.codex.model, skills.enabled and artifacts.max_bytes; any other change answers 403 CONFIG_PATH_FORBIDDEN, and a revision that is no longer current 409 CONFLICT. For identity-save, skill-set and config-save Ardent\'s 409 (stale revision) comes back as 409 CONFLICT and its 400 as 400. skill-install (node agent studio level 3, ADMIN or a service acting for a linked ADMIN, no target) takes {source: hiveskills, name (catalog slug), version, channel? (stable or canary), enable?, revision? (the configuration revision, required with enable)}: the Control API fetches that release from MAGNUS_ARDENT_HIVESKILLS_URL, requires it to be the one promoted on the channel and its archive to match the catalog SHA-256 and hold only regular files and directories under a root SKILL.md that Ardent indexes under that name (at most 1 MiB compressed, 4 MiB unpacked, 256 entries), and the node agent checks it again and installs it as the Ardent owner into the profile\'s first skill directory with a .hiveskills.json receipt, then enables it through Ardent when asked. It answers {source, name, version, sha256, files, changed, enabled, revision, enable_error, activation_required}; a failed enable leaves the skill installed with enable_error set. It answers 503 HIVESKILLS_UNCONFIGURED without a registry, 404 when the catalog has no such skill, 409 SKILL_VERSION_UNAVAILABLE when that version is not promoted, 422 SKILL_ARCHIVE_INVALID when the archive fails a check, and 409 SKILL_CONFLICT when the profile has a skill of that name Magnus did not install; it never replaces one. Context-stage, context-adopt and context-rollback require a release UUID and exact bundle, base-runtime, policy and configuration SHA-256 pins in body, with no target. Context actions require a signed managed owner and return verified completion evidence. A timeout or failure after dispatch must be inspected, never automatically retried. A failure the node agent finished (it answers 422, or 424 when Ardent itself answered with a server error) settles the command owner and comes back as 503 DEPENDENCY_UNAVAILABLE with the reason. A request whose outcome the node could not confirm leaves its owner unknown and answers 409 ARDENT_OUTCOME_UNKNOWN; while any owner is held, other actions answer 409 RESOURCE_LEASE_CONFLICT naming it. command-reconcile (ADMIN people only; node-wide, the profile segment only satisfies the route) takes the held command ID as target and {disposition: effects_verified or no_effect_verified, reason (10 to 500 characters)}: after the owner\'s deadline plus one minute it settles the owner from the node agent\'s own result or decision, from the signed ledger trace when the agent holds no receipt, or, only for an outcome the agent itself records as unknown, from the ADMIN\'s decision, which the server signs with COMMAND_RECONCILIATION_SECRET and the node agent records under its execution lock. It answers 409 COMMAND_IN_PROGRESS, RECEIPT_ABSENT_UNPROVEN, RECONCILIATION_UNAVAILABLE, RECONCILIATION_REFUSED or NOT_ARDENT_COMMAND when it settles nothing, and every attempt is audited as ardent.command-reconcile.',
      security: apiSecretAuth, parameters: [pp('nodeId', 'Managed node ID'), pp('name', 'Profile name')],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['action'],
        properties: { action: { type: 'string', enum: ['command-reconcile', 'profile-create', 'session-open', 'config-validate', 'config-save', 'peer-validate', 'peer-save', 'identity-save', 'identity-restore', 'provider-test', 'channel-test', 'peer-test', 'memory-search', 'task-submit', 'task-cancel', 'mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note', 'skill-set', 'service-start', 'service-stop', 'service-restart', 'package-install', 'context-stage', 'context-adopt', 'context-rollback', 'skill-install'] },
          target: { type: 'string' }, body: {} }, additionalProperties: false } } } },
      responses: { 200: success('Ardent action acknowledgement'), 400: err400, 401: err401, 403: err403, 404: err404,
        409: { description: 'Node agent must be upgraded, Ardent refused the action in the task\'s current state, a revision is stale, a skill release is not promoted or its name is held by a local skill, a command owner holds the node, or the outcome is unknown' },
        422: { description: 'The HiveSkills archive failed its digest or content checks (skill-install)' },
        503: { description: 'Node or Ardent action unavailable' } } },
  },
  '/ardent/agents': {
    post: { tags: ['Magnus Ardent'], summary: 'Deploy a new Ardent agent (New Agent)',
      description: 'ADMIN, or a linked Ardent service identity acting for an ADMIN named in x-acting-subject. Validates the request, resolves the API port (the first free one from 9910 when omitted) and starts an operation: profile-create, service-start, identity-soul, identity-identity, hivemem-enroll, config-save, skill-set, service-restart, ready-probe. Each step is audited and keeps a receipt; a failure stops the operation, which can be resumed. The HiveMem credential goes straight to the node and is never returned or stored.',
      security: apiSecretAuth, requestBody: { required: true, content: { 'application/json': { schema: zod(ardentAgentDeployRequestSchema) } } },
      responses: { 202: success('Operation started', { type: 'object', properties: { operationId: { type: 'string', format: 'uuid' } } }), 400: err400, 401: err401, 403: err403,
        409: { description: 'Profile or port in use, another operation running, Ardent not installed, or the node agent must be upgraded' },
        503: { description: 'Node unavailable, or HiveMem enrollment or Emberpath not configured' } } },
  },
  '/ardent/agents/operations/{id}': {
    get: { tags: ['Magnus Ardent'], summary: 'Read an Ardent agent operation and its step receipts', security: apiSecretAuth,
      parameters: [pp('id', 'Operation UUID')], responses: { 200: success('Operation', zod(ardentAgentOperationSchema)), 400: err400, 401: err401, 403: err403, 404: err404 } },
  },
  '/ardent/agents/operations/{id}/stream': {
    get: { tags: ['Magnus Ardent'], summary: 'Stream an Ardent agent operation as its steps change',
      description: 'Server-sent events: operation on connect and after each change, then done once the operation succeeds or fails. Reconnect for an operation that runs past 15 minutes.',
      security: apiSecretAuth, parameters: [pp('id', 'Operation UUID')],
      responses: { 200: { description: 'Operation event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } }, 400: err400, 401: err401, 403: err403, 404: err404 } },
  },
  '/ardent/agents/operations/{id}/resume': {
    post: { tags: ['Magnus Ardent'], summary: 'Resume a failed Ardent agent operation',
      description: 'Reruns the first unfinished step and everything after it; finished steps are never rerun. ADMIN, or a service identity acting for an ADMIN.',
      security: apiSecretAuth, parameters: [pp('id', 'Operation UUID')],
      responses: { 202: success('Operation resumed', { type: 'object', properties: { operationId: { type: 'string', format: 'uuid' } } }), 400: err400, 401: err401, 403: err403, 404: err404,
        409: { description: 'The operation did not fail, or another operation on the profile is running' } } },
  },
  '/ardent/installations/{nodeId}/profiles/{name}/hivemem': {
    post: { tags: ['Magnus Ardent'], summary: 'Enable HiveMem on an existing Ardent profile',
      description: 'Starts an operation that enrolls (or, for an agent HiveMem already knows, rotates) a per-agent HiveMem credential, writes it to the profile, sets memory.provider hivemem, restarts the profile and waits until memory reports ready. The profile must be running. ADMIN, or a service identity acting for an ADMIN.',
      security: apiSecretAuth, parameters: [pp('nodeId', 'Managed node ID'), pp('name', 'Profile name')],
      responses: { 202: success('Operation started', { type: 'object', properties: { operationId: { type: 'string', format: 'uuid' } } }), 400: err400, 401: err401, 403: err403,
        409: { description: 'Another operation running, or the node agent must be upgraded' }, 503: { description: 'HiveMem enrollment not configured' } } },
  },
  '/codex/installations': {
    get: {
      tags: ['Codex Agent'],
      summary: 'List Codex CLI and ChatGPT OAuth posture across managed nodes',
      description: 'Returns the Control API cache refreshed every five minutes from each node-local Codex App Server. Set refreshLatest=true for an explicit synchronous rescan. Token values, account IDs, and email addresses are never returned.',
      security: apiSecretAuth,
      parameters: [{ name: 'refreshLatest', in: 'query', schema: { type: 'boolean', default: false } }],
      responses: { 200: success('Codex installations', { type: 'array', items: { type: 'object' } }), 401: err401 },
    },
  },
  '/codex/installations/{nodeId}': {
    get: {
      tags: ['Codex Agent'],
      summary: 'Read one node Codex installation and OAuth posture',
      security: apiSecretAuth,
      parameters: [
        { name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'refreshLatest', in: 'query', schema: { type: 'boolean', default: false } },
      ],
      responses: { 200: success('Codex installation', { type: 'object' }), 401: err401, 404: err404 },
    },
  },
  '/codex/installations/{nodeId}/update': {
    post: {
      tags: ['Codex Agent'],
      summary: 'Update an owned standalone or npm-managed Codex CLI (ADMIN)',
      security: apiSecretAuth,
      parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: success('Updated Codex installation', { type: 'object' }), 401: err401, 403: err403, 404: err404 },
    },
  },
  '/codex/installations/{nodeId}/logout': {
    post: {
      tags: ['Codex Agent'],
      summary: 'Log out the node-local Codex account (ADMIN)',
      security: apiSecretAuth,
      parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: success('Logged-out Codex installation', { type: 'object' }), 401: err401, 403: err403, 404: err404 },
    },
  },
  '/codex/installations/{nodeId}/device-auth': {
    post: {
      tags: ['Codex Agent'],
      summary: 'Start a ChatGPT OAuth device-code login through Codex App Server (ADMIN)',
      description: 'Returns a verification URL and one-time user code. API-key login is not supported by this route.',
      security: apiSecretAuth,
      parameters: [{ name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: success('Device authorization session', { type: 'object' }), 401: err401, 403: err403, 404: err404 },
    },
  },
  '/codex/installations/{nodeId}/device-auth/{sessionId}': {
    get: {
      tags: ['Codex Agent'],
      summary: 'Read a node-local Codex device authorization session',
      security: apiSecretAuth,
      parameters: [
        { name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: success('Device authorization session', { type: 'object' }), 401: err401, 404: err404 },
    },
  },
  '/codex/installations/{nodeId}/device-auth/{sessionId}/cancel': {
    post: {
      tags: ['Codex Agent'],
      summary: 'Cancel a pending Codex device authorization session (ADMIN)',
      security: apiSecretAuth,
      parameters: [
        { name: 'nodeId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: success('Cancelled device authorization session', { type: 'object' }), 401: err401, 403: err403, 404: err404 },
    },
  },
};

// ─── Assemble ───────────────────────────────────────────────────────

/** Build the complete OpenAPI 3.1 specification. */
export function buildOpenApiSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Magnus Control API',
      version: CONTROL_API_VERSION,
      description:
        'Fleet management control plane for the Magnus platform. ' +
        'Manages nodes, commands, cron jobs, file sync, skills, roles, ' +
        'deployments, and more across a distributed fleet of agents.\n\n' +
        '## Authentication\n\n' +
        'Most endpoints require authentication via one of:\n' +
        '- **API Secret** — `x-api-secret` header (injected by the dashboard proxy)\n' +
        '- **JWT Bearer** — `Authorization: Bearer <token>` (HS256, from `/auth/login`)\n' +
        '- **Node Token** — `x-node-token` header (shared secret for agent heartbeats)\n\n' +
        '## RBAC Roles\n\n' +
        '| Role | Access |\n' +
        '|------|--------|\n' +
        '| `ADMIN` | Full access including destructive operations |\n' +
        '| `OPERATOR` | Create/update resources, execute commands |\n' +
        '| `VIEWER` | Read-only access to all resources |\n\n' +
        '## Idempotency\n\n' +
        'Mutating endpoints that support retries accept an `x-idempotency-key` header. ' +
        'Keys are scoped to the route and authenticated actor, claimed only after validation, ' +
        'preview, and preflight checks, and deduplicated via Redis with a 24-hour TTL.',
      license: { name: 'Proprietary' },
    },
    servers: [
      { url: '/api/v1', description: 'Current server' },
      { url: 'https://localhost:4000/api/v1', description: 'Local development' },
    ],
    tags,
    components: {
      securitySchemes: {
        embermendExecutorBearer: { type: 'http', scheme: 'bearer', description: 'Endpoint-scoped Embermend credential with exact installation, targets and action versions. Never a node or administrator credential.' },
        skillsExecutorBearer:{type:'http',scheme:'bearer',bearerFormat:'opaque',description:'Dedicated endpoint-scoped registry credential; only configured targets and exact native sync operations, never general commands.'},
        cindertraceSignature: { type: 'apiKey', in: 'header', name: 'x-cindertrace-signature', description: 'Dedicated response HMAC bound to method, path, exact body, x-cindertrace-time and x-cindertrace-nonce. Responses are signed against the same request binding.' },
        apiSecret: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-secret',
          description: 'Shared API secret. Injected server-side by the dashboard proxy — never sent from browsers.',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'HS256 JWT obtained from `POST /auth/login`.',
        },
        sharedResourceBearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'opaque',
          description: 'Purpose-scoped shared-resource client token; accepted only by reserve, exact lease/operation recovery, start, unknown and signed-settle routes.',
        },
        resourceDrainKey: { type: 'apiKey', in: 'header', name: 'x-resource-drain-key',
          description: 'Dedicated dashboard drain participant secret; never sent from browsers.' },
        nodeToken: {
          type: 'apiKey',
          in: 'header',
          name: 'x-node-token',
          description: 'Shared secret for agent heartbeat authentication (`NODE_MANAGER_SECRET`).',
        },
        hermesRegistryToken: { type: 'apiKey', in: 'header', name: 'x-hermes-registry-token',
          description: 'Distinct bearer bound to one enrolled node and Hermes installation; hosts in `MAGNUS_REGISTRY_SUBMIT_ONLY_HOSTS` have submission-only scope.' },
      },
      schemas: componentSchemas,
    },
    paths: { ...paths,
      '/api/v1/hiveskills/targets/{target}':{get:{summary:'Verify exact enrolled native target and immutable client without dispatch',tags:['Skills'],security:[{skillsExecutorBearer:[]}],parameters:[{name:'target',in:'path',required:true,schema:{type:'string'}}],responses:{200:{description:'Read-only enrolled target posture; ready false retains operator review'},401:{description:'Dedicated executor credential required'},403:{description:'Target outside exact registry grant'}}}},
      '/api/v1/embermend/capabilities': { get: { summary: 'Read enrolled Embermend target capabilities within an exact product grant', tags: ['Operations'], security: [{embermendExecutorBearer:[]}], responses: {200:{description:'Installation identity, compatible targets and supported action versions'},401:{description:'Endpoint-scoped credential required'}} } },
      '/api/v1/embermend/operations': { post: { summary: 'Dispatch an exact authorized Embermend operation or separately approved quiescent-owner settlement', tags: ['Operations'], security: [{embermendExecutorBearer:[]}], requestBody: {required:true,content:{'application/json':{schema:zSchema.toJSONSchema(embermendOperationSchema)}}}, responses:{202:{description:'Durable original operation queued for managed admission'},200:{description:'Original receipt, request binding and retained outcome; success is not security verification'},403:{description:'Target or action outside product grant'},409:{description:'Incompatible enrollment, changed identity or uncertain execution'}} } },
      '/api/v1/embermend/operations/{id}': { get: { summary: 'Reconcile the original signed Embermend operation without replay', tags: ['Operations'], security: [{embermendExecutorBearer:[]}], parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Original signed completion and ownership state'},404:{description:'No operation reserved for this integration'}} } },
      '/api/v1/hiveskills/jobs/{id}': { post: { summary: 'Execute one exact approved HiveSkills publication through enrolled native admission', tags:['Skills'], requestBody:{required:true,content:{'application/json':{schema:zSchema.toJSONSchema(skillJobRequest)}}}, security: [{skillsExecutorBearer:[]}], parameters:[{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}}], responses:{200:{description:'Bounded durable outcome; admitted operations are never replayed'},409:{description:'Publication conflict, not admitted or uncertain'}} }, get:{summary:'Reconcile only the original signed HiveSkills operation receipt',tags:['Skills'],security:[{skillsExecutorBearer:[]}],parameters:[{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}},{name:'target',in:'query',required:true,schema:{type:'string'}}],responses:{200:{description:'Existing durable outcome'}}} },
      '/api/v1/security-integration/response/execute': { post: { summary: 'Execute an exact Cindertrace-approved response through managed node admission', tags: ['Cindertrace'], security: [{cindertraceSignature:[]}], requestBody: {required:true,content:{'application/json':{schema:zSchema.toJSONSchema(responseRequestSchema)}}}, responses: { 200: { description: 'Signed completion receipt' }, 409: { description: 'Expired, already claimed, blocked, or uncertain execution' } } } },
      '/api/v1/security-integration/response/{id}': { get: { summary: 'Read an existing Cindertrace execution without replay', tags: ['Cindertrace'], security: [{cindertraceSignature:[]}], parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses: { 200: { description: 'Signed existing execution status' } } } },
      '/api/v1/security-integration/response/targets/{id}/health': { get: { summary: 'Read fresh target health for Cindertrace', tags: ['Cindertrace'], security: [{cindertraceSignature:[]}], parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses: { 200: { description: 'Signed minimal health snapshot' } } } },
    },
  };
}
