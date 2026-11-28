/**
 * Agent, scheduler and gateway machine routes, the retired heartbeat stream, local maintenance
 * receipts and the Hermes Agent inventory reads.
 */
import { hermesInstallationSchema, hermesProfileSchema } from '@hivemagnus/magnus-contracts/browser';
import { schedulerSettleSchema, schedulerTriggerSchema } from '../../services/managed-cron.js';
import { admissionFenceRequest } from '../../services/admission-fence.js';
import { nodeSessionReceiptSchema } from '../../schemas/node-session-receipt.js';
import {
  type Paths, browserOperation, err400, err401, err403, err404, errorResponse, inlineBody, nodeAuthSecurity, pp,
  requestBody, success, userAuth, zodOut,
} from '../helpers.js';

const sha256 = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const nodeAuthNote = 'Node credential: a node signature, or the shared node secret only under an explicit `NODE_AUTH_MODE=compat` or `warn`. '
  + 'The node the body names must be the caller (403 otherwise). Responses are `Cache-Control: no-store`.';
const nodeErrors = { 400: err400, 401: err401, 403: err403 };
const fqdnNonceBody = inlineBody({ type: 'object', additionalProperties: false, required: ['nodeFqdn', 'nonce'],
  properties: { nodeFqdn: { type: 'string', minLength: 1, maxLength: 253 }, nonce: { type: 'string', format: 'uuid' } } });
const enrollmentStatusFields = {
  version: { type: 'integer', enum: [1] }, nodeId: { type: 'string' }, nodeFqdn: { type: 'string' },
  state: { type: 'string', description: '`legacy` until enrollment starts, then `draining` or `enrolled`' },
  epoch: { type: 'integer' }, barrierId: { type: 'string', format: 'uuid', nullable: true }, nonce: { type: 'string', format: 'uuid' },
};
const challenge = { type: 'object', nullable: true, properties: { challengeId: { type: 'string', format: 'uuid' }, expiresAt: { type: 'integer', description: 'Epoch milliseconds' } } };
const participantWork = { type: 'object', properties: {
  workId: { type: 'string', format: 'uuid' }, nodeId: { type: 'string' }, nodeFqdn: { type: 'string', nullable: true },
  participant: { type: 'string', enum: ['api', 'dashboard'] }, ownerId: { type: 'string', format: 'uuid' }, kind: { type: 'string' },
  state: { type: 'string', enum: ['reserved', 'running', 'unknown', 'released'] }, epoch: { type: 'integer' },
  barrierId: { type: 'string', nullable: true }, requestSha256: { ...sha256, nullable: true }, operationSha256: { ...sha256, nullable: true },
  fence: { type: 'string', nullable: true, description: 'Decimal fence generation' }, deadline: { type: 'integer', nullable: true, description: 'Epoch milliseconds' },
} };
const fenceCoverage = { type: 'string', enum: ['control-api-node-reservations'], description: 'The fence pauses only this API\'s new node and shared reservations, not independent writers.' };
const adminWorkNote = 'Requires a user session (or the API secret) with the ADMIN role.';
const hermesJob = { type: 'object', properties: {
  id: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' }, installationId: { type: 'string', nullable: true },
  profileId: { type: 'string', nullable: true }, targetHost: { type: 'string', nullable: true }, createdBy: { type: 'string' },
  steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, status: { type: 'string', enum: ['queued', 'running', 'done', 'error'] },
    message: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' } } } },
  result: { type: 'object', nullable: true, additionalProperties: true }, error: { type: 'string', nullable: true },
  metadata: { type: 'object', additionalProperties: true }, startedAt: { type: 'string', format: 'date-time' },
  completedAt: { type: 'string', format: 'date-time', nullable: true },
} };
const hermesRedaction = 'Profiles carry `apiServerKeyConfigured`; `apiServerKeyFingerprint` is returned to ADMIN only. Also served at the deprecated alias `/orchestra`.';
const hermesRateLimit = '`/hermes/*` and `/orchestra/*` share a budget of 20 requests a minute per subject (429 beyond it).';
const fleetGatewayAuth = [{ fleetGatewayToken: [] }];
const gatewayNodeId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' };
const retiredHeartbeatStream = errorResponse('`HEARTBEAT_STREAM_RETIRED`: Redis stream heartbeat ingestion is retired; agents `POST /heartbeat`');

export const paths: Paths = {
  // ──────────────── Managed cron occurrences (node scheduler) ────────────────
  '/cron/managed-occurrences/admit': {
    post: { tags: ['Cron'], summary: 'Node scheduler: admit one occurrence of an active managed cron job', security: nodeAuthSecurity,
      description: `${nodeAuthNote} Consumes existing managed authority and never creates a cron definition. The occurrence identity is claimed once; `
        + 'a second admit of the same `occurrenceId` answers 409 (inspect it with `/status` instead of replaying). A failure after the claim leaves the occurrence `unknown`.',
      requestBody: requestBody(schedulerTriggerSchema),
      responses: { 200: success('Durable admission and the command to run', { type: 'object', properties: {
        occurrenceId: sha256, specSha256: sha256, commandId: { type: 'string' }, coordination: { type: 'object' },
        claim: { type: 'object', properties: { leaseId: { type: 'string' }, nodeId: { type: 'string' }, nodeFqdn: { type: 'string' } } }, requestSha256: sha256 } }),
        ...nodeErrors, 404: err404, 409: errorResponse('`SCHEDULER_AUTHORITY_CONFLICT`, `ADMISSION_FENCED` or another conflict: the job, its revision, timing or resource admission differs') } },
  },
  '/cron/managed-occurrences/settle': {
    post: { tags: ['Cron'], summary: 'Node scheduler: settle an occurrence with its signed command result', security: nodeAuthSecurity,
      description: `${nodeAuthNote} Requires the original supervisor completion signed by the node (or, for a node without a key, the result HMAC) and a released resource lease bound to that result.`,
      requestBody: requestBody(schedulerSettleSchema),
      responses: { 200: success('Settled occurrence', { type: 'object', properties: { occurrenceId: sha256, state: { type: 'string', enum: ['completed'] } } }),
        ...nodeErrors, 404: errorResponse('Occurrence not found for this node'), 409: errorResponse('`SCHEDULER_AUTHORITY_CONFLICT`: the completion or its resource settlement is not proven') } },
  },
  '/cron/managed-occurrences/status': {
    post: { tags: ['Cron'], summary: 'Node scheduler: read an occurrence without replaying it', security: nodeAuthSecurity, description: nodeAuthNote,
      requestBody: inlineBody({ type: 'object', additionalProperties: false, required: ['nodeFqdn', 'occurrenceId'],
        properties: { nodeFqdn: { type: 'string', minLength: 1, maxLength: 253 }, occurrenceId: sha256 } }),
      responses: { 200: success('Occurrence state', { type: 'object', properties: {
        occurrenceId: sha256, state: { type: 'string', description: 'admitting, running, unknown or completed' }, commandId: { type: 'string' },
        revision: { type: 'integer' }, specSha256: sha256, deadline: { type: 'integer', description: 'Epoch milliseconds' },
        commandStatus: { type: 'string', description: 'Status of the command, or `unknown` when it is absent' } } }),
        ...nodeErrors, 404: errorResponse('Occurrence not found for this node') } },
  },

  // ──────────────── Resource admission fence and enrollment ────────────────
  '/resource-leases/admission/{nodeId}': {
    get: { tags: ['Commands'], summary: 'Inspect the release admission fence of a node', security: userAuth,
      description: 'Roles: ADMIN, OPERATOR. Uncached.', parameters: [pp('nodeId', 'Node ID')],
      responses: { 200: success('Admission fence state', { type: 'object', properties: {
        nodeId: { type: 'string' }, nodeFqdn: { type: 'string' }, closed: { type: 'boolean' }, releaseId: { type: 'string', format: 'uuid', nullable: true },
        closedAt: { type: 'string', format: 'date-time', nullable: true }, coverage: fenceCoverage, independentWritersCovered: { type: 'boolean', enum: [false] } } }),
        401: err401, 403: err403, 404: errorResponse('`RESOURCE_TARGET_INVALID`: the managed node is absent') } },
  },
  '/resource-leases/admission/{nodeId}/close': {
    post: { tags: ['Commands'], summary: 'Close a node\'s admission fence for a release', security: userAuth,
      description: `${adminWorkNote} Pauses this API's new reservations for the node and, while any fence is closed, its new shared-resource work. `
        + 'Closing again with the same release is idempotent. Audited as `resource.admission.close`.',
      parameters: [pp('nodeId', 'Node ID')], requestBody: requestBody(admissionFenceRequest),
      responses: { 200: success('Closed fence', { type: 'object', properties: { nodeId: { type: 'string' }, nodeFqdn: { type: 'string' },
        releaseId: { type: 'string', format: 'uuid' }, closedAt: { type: 'string', format: 'date-time' }, coverage: fenceCoverage } }),
        400: err400, 401: err401, 403: err403,
        409: errorResponse('`RESOURCE_TARGET_INVALID` (the FQDN is not the node\'s inventory host name) or `RELEASE_FENCE_CONFLICT` (another release owns the fence)') } },
  },
  '/resource-leases/admission/{nodeId}/release': {
    post: { tags: ['Commands'], summary: 'Reopen a node\'s admission fence after a release', security: userAuth,
      description: `${adminWorkNote} Needs the exact node, FQDN and release that closed the fence, and no active or unknown command, participant, managed cron or shared work. `
        + 'Enrollment history stays. Audited as `resource.admission.release`.',
      parameters: [pp('nodeId', 'Node ID')], requestBody: requestBody(admissionFenceRequest),
      responses: { 200: success('Reopened fence', { type: 'object', properties: { nodeId: { type: 'string' }, nodeFqdn: { type: 'string' },
        releaseId: { type: 'string', format: 'uuid' }, closed: { type: 'boolean', enum: [false] }, coverage: fenceCoverage } }),
        400: err400, 401: err401, 403: err403,
        409: errorResponse('`RELEASE_FENCE_CONFLICT` (not the exact fence and release) or `ADMISSION_WORK_UNSETTLED` (work is still active or unknown)') } },
  },
  '/resource-leases/enrollment/scheduler-status': {
    post: { tags: ['Commands'], summary: 'Node credential: enrollment status for the node scheduler participant', security: nodeAuthSecurity,
      description: `${nodeAuthNote} Durable enrollment coordination only; never execution approval. The scheduler challenge is present only while the node drains and its acknowledgement is current.`,
      requestBody: fqdnNonceBody,
      responses: { 200: success('Authoritative durable status', { type: 'object', properties: { ...enrollmentStatusFields, schedulerChallenge: challenge } }),
        ...nodeErrors, 404: err404, 409: errorResponse('`RESOURCE_TARGET_INVALID`: the FQDN does not name exactly one inventory node') } },
  },
  '/resource-leases/enrollment/work/{workId}/node-receipt': {
    post: { tags: ['Commands'], summary: 'Node credential: settle started participant work from a node session receipt', security: nodeAuthSecurity,
      description: `${nodeAuthNote} The receipt of an independently supervised, bounded node process group releases only the exact durable owner it binds. `
        + 'It is verified with the node\'s key (or, for a node without one, the result HMAC). This route observes; it never dispatches or retries. '
        + 'Sending the same receipt again returns the settled work.',
      parameters: [pp('workId', 'Participant work UUID; must equal `workId` in the receipt')], requestBody: requestBody(nodeSessionReceiptSchema),
      responses: { 200: success('Released participant work', participantWork),
        400: errorResponse('Validation error, or `INVALID_WORK_ID` when the path and receipt work IDs differ'), 401: err401,
        403: errorResponse('The node does not own the receipt, or `RESOURCE_EVIDENCE_INVALID`: the receipt signature is invalid'),
        404: errorResponse('`RESOURCE_WORK_NOT_FOUND`'),
        409: errorResponse('`RESOURCE_EVIDENCE_INVALID` (the receipt does not bind the exact authority or completion owner) or `RESOURCE_WORK_CONFLICT`') } },
  },

  // ──────────────── Fleet gateway (machine) ────────────────
  '/fleet-gateway/target': {
    post: { tags: ['Terminal'], summary: 'Fleet gateway: inventory facts for one node', security: fleetGatewayAuth,
      description: 'Called by the fleet gateway with its own credential (`x-fleet-gateway-token`). Nothing here dials the node; the gateway applies its own host-key approval. '
        + 'With `managedTerminalProtocol: 1` the answer also says whether the node is enrolled for managed terminals. Uncached.',
      requestBody: inlineBody({ type: 'object', additionalProperties: false, required: ['nodeId'],
        properties: { nodeId: gatewayNodeId, managedTerminalProtocol: { type: 'integer', enum: [1] } } }),
      responses: { 200: success('Node target', { type: 'object', properties: { nodeId: { type: 'string' }, hostname: { type: 'string' }, ipAddress: { type: 'string' },
        status: { type: 'string' }, managedTerminal: { type: 'boolean', description: 'Only with managedTerminalProtocol 1: resource enrollment is `enrolled`' } } }),
        400: err400, 401: errorResponse('Fleet gateway credential required'), 404: errorResponse('`NODE_NOT_FOUND`') } },
  },
  '/fleet-gateway/audit': {
    post: { tags: ['Terminal'], summary: 'Fleet gateway: record terminal session metadata in the audit log', security: fleetGatewayAuth,
      description: 'Called by the fleet gateway with its own credential (`x-fleet-gateway-token`). The schema has no field for terminal input or output. Uncached.',
      requestBody: inlineBody({ type: 'object', additionalProperties: false,
        required: ['action', 'subject', 'actorId', 'nodeId', 'sessionId', 'outcome', 'at', 'durationMs', 'ipAddress', 'fingerprint'],
        properties: {
          action: { type: 'string', enum: ['terminal.session.open', 'terminal.session.close', 'terminal.session.refuse', 'terminal.host-key.approve', 'terminal.host-key.remove'] },
          subject: { type: 'string', minLength: 1, maxLength: 256 }, actorId: { type: 'string', minLength: 1, maxLength: 256 },
          nodeId: { ...gatewayNodeId, nullable: true }, sessionId: { type: 'string', pattern: '^ts_[A-Za-z0-9_-]{43}$', nullable: true },
          outcome: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$' }, at: { type: 'string', format: 'date-time' },
          durationMs: { type: 'integer', minimum: 0, nullable: true }, ipAddress: { type: 'string', description: 'IPv4 or IPv6', nullable: true },
          fingerprint: { type: 'string', pattern: '^SHA256:[A-Za-z0-9+/]{43}$', nullable: true },
        } }),
      responses: { 200: success('Recorded', { type: 'object', properties: { recorded: { type: 'boolean', enum: [true] } } }),
        400: err400, 401: errorResponse('Fleet gateway credential required') } },
  },

  // ──────────────── Heartbeat stream (retired) ────────────────
  '/heartbeat/stream': {
    post: { tags: ['Heartbeat'], summary: 'Retired Redis stream heartbeat ingestion', deprecated: true, security: [],
      description: 'Always answers 410, without checking credentials. Agents send `POST /heartbeat`.',
      responses: { 410: retiredHeartbeatStream } },
  },
  '/heartbeat/stream/stats': {
    get: { tags: ['Heartbeat'], summary: 'Residual state of the retired heartbeat stream', security: userAuth,
      description: 'Any role. Read-only Redis figures for the retired stream transport. `enabled` is false when Redis could not be read; the other fields then keep their defaults.',
      responses: { 200: success('Heartbeat stream stats', { type: 'object', properties: {
        enabled: { type: 'boolean' }, streamKey: { type: 'string', description: 'Physical Redis key, including any key prefix' },
        length: { type: 'integer' }, consumerGroup: { type: 'string' }, pending: { type: 'integer' }, lastDeliveredId: { type: 'string', nullable: true },
        consumers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, pending: { type: 'integer' }, idleMs: { type: 'integer' } } } } } }),
        401: err401 } },
  },

  // ──────────────── Self-update receipts ────────────────
  '/self-update/work/{workId}': {
    get: { tags: ['Self-Update'], summary: 'Read the durable receipt of a self-update check, apply or restart', security: userAuth,
      description: 'Roles: ADMIN, OPERATOR. The work ID is returned in `X-Magnus-Work-Id` (and `X-Magnus-Restart-Work-Id`) by the self-update routes. Uncached.',
      parameters: [pp('workId', 'Durable work UUID')],
      responses: { 200: success('API maintenance receipt', { type: 'object', properties: {
        workId: { type: 'string', format: 'uuid' }, nodeId: { type: 'string' }, kind: { type: 'string', enum: ['self-update-check', 'self-update-apply', 'self-update-restart'] },
        state: { type: 'string' }, epoch: { type: 'integer' }, barrierId: { type: 'string', nullable: true },
        startedAt: { type: 'string', format: 'date-time', nullable: true }, settledAt: { type: 'string', format: 'date-time', nullable: true },
        settlement: { type: 'string', nullable: true } } }),
        400: errorResponse('`INVALID_WORK_ID`: not a UUID'), 401: err401, 403: err403, 404: errorResponse('`LOCAL_WORK_NOT_FOUND`') } },
  },

  // ──────────────── Hermes Agent inventory reads ────────────────
  '/hermes/installations': {
    get: browserOperation('GET', '/hermes/installations', { tags: ['Hermes Agent'], summary: 'List Hermes Agent installations with their profiles',
      description: `Read from the Control database; no SSH. Detected aliases of one host are collapsed into one row. ${hermesRedaction} ${hermesRateLimit}`,
      errors: { 429: errorResponse('Rate limited') } }),
  },
  '/hermes/installations/{id}': {
    get: { tags: ['Hermes Agent'], summary: 'Get one Hermes Agent installation with its profiles', security: userAuth,
      description: `Any role. ${hermesRedaction} ${hermesRateLimit}`, parameters: [pp('id', 'Installation ID')],
      responses: { 200: success('Installation', zodOut(hermesInstallationSchema)), 401: err401, 404: err404, 429: errorResponse('Rate limited') } },
  },
  '/hermes/installations/{id}/profiles': {
    get: { tags: ['Hermes Agent'], summary: 'List the profiles of one Hermes Agent installation', security: userAuth,
      description: `Any role. Each profile carries a short \`installation\` summary. ${hermesRedaction} ${hermesRateLimit}`, parameters: [pp('id', 'Installation ID')],
      responses: { 200: success('Profiles', { type: 'array', items: zodOut(hermesProfileSchema) }), 401: err401, 404: err404, 429: errorResponse('Rate limited') } },
  },
  '/hermes/profiles': {
    get: { tags: ['Hermes Agent'], summary: 'List every Hermes Agent profile', security: userAuth,
      description: `Any role. Each profile carries a short \`installation\` summary. ${hermesRedaction} ${hermesRateLimit}`,
      responses: { 200: success('Profiles', { type: 'array', items: zodOut(hermesProfileSchema) }), 401: err401, 429: errorResponse('Rate limited') } },
  },
  '/hermes/jobs/{id}': {
    get: { tags: ['Hermes Agent'], summary: 'Get one Hermes operation job', security: userAuth,
      description: `Any role. Also served at the deprecated alias \`/orchestra\`. ${hermesRateLimit}`, parameters: [pp('id', 'Job ID')],
      responses: { 200: success('Operation job', hermesJob), 401: err401, 404: errorResponse('Hermes operation job not found'), 429: errorResponse('Rate limited') } },
  },
};
