/**
 * Fleet reads and writes: command history, the live event stream, shared-secret status, the external
 * security console's integration routes, and node tags, Wazuh, Linux users and system updates.
 */
import { securityInventorySkippedSchema, securityInventoryTargetSchema } from '@hivemagnus/magnus-contracts';
import { bulkNodeTagsSchema } from '../../schemas/nodes.js';
import {
  type JsonSchema, type Paths, browserOperation, err400, err401, err403, err404, err410, errorResponse,
  pp, requestBody, success, userAuth, zodOut,
} from '../helpers.js';

const sharedCredentialName = pp('name', 'Shared credential: `API_SECRET` or `NODE_MANAGER_SECRET`; any other name answers 400 `UNKNOWN_CREDENTIAL`');
const rotationStatus: JsonSchema = { type: 'object', description: 'Fingerprints only; secret values are never returned.', properties: {
  name: { type: 'string' },
  configured: { type: 'boolean', description: 'False when the server has no value for the credential: `NODE_MANAGER_SECRET` in node-key enforce mode, where nothing sends or accepts it' },
  activeFingerprint: { type: 'string', nullable: true, description: 'Null when `configured` is false' },
  previousFingerprint: { type: 'string', nullable: true, description: 'The previous value, while it is still accepted' },
  rotatedAt: { type: 'string', format: 'date-time', nullable: true },
  expiresAt: { type: 'string', format: 'date-time', nullable: true, description: 'When the previous value stops being accepted' },
  gracePeriodMs: { type: 'integer', nullable: true },
} };
const adminCredentialNote = 'ADMIN only (local or Oathweave session, or the API secret).';

const wazuhPosture: JsonSchema = { type: 'object', nullable: true, description: 'Null when the latest snapshot has no valid Wazuh report.', properties: {
  installed: { type: 'boolean' },
  serviceStatus: { type: 'string', enum: ['active', 'inactive', 'failed', 'not_installed', 'unknown'] },
  enabled: { type: 'string', enum: ['enabled', 'disabled', 'static', 'unknown'] },
  version: { type: 'string', nullable: true },
  managerAddresses: { type: 'array', items: { type: 'string' } },
} };

export const paths: Paths = {
  // ──────────────── Commands ────────────────
  '/commands': {
    get: browserOperation('GET', '/commands', {
      tags: ['Commands'], summary: 'List recent commands',
      description: 'Newest first, created within the last `hours`. `environment` is never returned. Out-of-range `hours` and `pageSize` are clamped (1-720, 1-100); defaults 24 and 25.',
    }),
  },
  '/commands/{commandId}/stream': {
    get: {
      tags: ['Commands'], summary: 'Retired command output stream (ADMIN, OPERATOR)',
      description: 'Always answers 410 `COMMAND_STREAM_RETIRED` for a known command: follow status on `GET /events/stream` and read the signature-verified output from `GET /commands/{commandId}/result`.',
      security: userAuth, parameters: [pp('commandId', 'Command ID')],
      responses: { 401: err401, 403: err403, 404: err404, 410: err410 },
    },
  },

  // ──────────────── Live events ────────────────
  '/events/stream': {
    get: browserOperation('GET', '/events/stream', {
      tags: ['Events'], summary: 'Live fleet events (server-sent events)',
      description: 'The first event is `connected`; then every event-bus message as an event named after its channel. A comment line `: keepalive` follows every 30 seconds. `channels` is a comma-separated list of channel prefixes; without it every channel is sent.',
      queryDescriptions: { channels: 'Comma-separated channel prefixes to receive' },
    }),
  },

  // ──────────────── Shared credentials (ADMIN) ────────────────
  '/credentials/rotate': {
    post: {
      tags: ['Credentials'], summary: 'Retired: online credential rotation',
      description: `${adminCredentialNote} Always answers 410; use the reviewed coordinated fleet rollout.`, security: userAuth,
      responses: { 401: err401, 403: err403, 410: { ...err410, description: '`CREDENTIAL_ROTATION_RETIRED`: online credential rotation is retired' } },
    },
  },
  '/credentials/rotations': {
    get: {
      tags: ['Credentials'], summary: 'List recorded shared-credential rotations',
      description: `${adminCredentialNote} A stored record of a credential the server has no value for (\`NODE_MANAGER_SECRET\` in node-key enforce mode) is listed as \`configured: false\` with null fingerprints, as its status route reports it.`, security: userAuth,
      responses: { 200: success('Rotation status per recorded credential', { type: 'array', items: rotationStatus }), 401: err401, 403: err403 },
    },
  },
  '/credentials/{name}/status': {
    get: {
      tags: ['Credentials'], summary: 'Rotation status of one shared credential',
      description: `${adminCredentialNote} In node-key enforce mode without a shared node secret, \`NODE_MANAGER_SECRET\` answers \`configured: false\` with null fingerprints.`, security: userAuth,
      parameters: [sharedCredentialName],
      responses: { 200: success('Rotation status', rotationStatus), 400: { ...err400, description: '`UNKNOWN_CREDENTIAL`' }, 401: err401, 403: err403 },
    },
  },
  '/credentials/{name}/rollout': {
    post: {
      tags: ['Credentials'], summary: 'Retired: online fleet secret rollout',
      description: `${adminCredentialNote} Always answers 410; use the inventory-pinned deploy-agent workflow.`, security: userAuth,
      parameters: [pp('name', 'Credential name (ignored)')],
      responses: { 401: err401, 403: err403, 410: { ...err410, description: '`CREDENTIAL_ROLLOUT_RETIRED`: online fleet secret rollout is retired' } },
    },
  },
  '/credentials/{name}/retire-previous': {
    post: {
      tags: ['Credentials'], summary: 'Stop accepting the previous value of a shared credential',
      description: `${adminCredentialNote} Ends the grace period at once. Audited as \`credentials.rotate\` with both fingerprints. `
        + 'For `NODE_MANAGER_SECRET` in node-key enforce mode without a shared node secret, a previous value left from an earlier rotation is removed and the answer has `configured: false`.',
      security: userAuth,
      parameters: [sharedCredentialName],
      responses: {
        200: success('Status after retirement', { ...rotationStatus, properties: { ...(rotationStatus['properties'] as JsonSchema),
          retiredPreviousFingerprint: { type: 'string', nullable: true, description: 'Null when there was no previous value' } } }),
        400: { ...err400, description: '`UNKNOWN_CREDENTIAL`' }, 401: err401, 403: err403,
      },
    },
  },

  // ──────────────── External security console ────────────────
  '/security-integration/inventory': {
    get: {
      tags: ['Cindertrace'], summary: 'Node inventory for the external security console',
      description: 'Bearer token whose SHA-256 is `SECURITY_INVENTORY_TOKEN_SHA256`; no user session. Every node with an agent, without sentinel nodes. `metadata` carries only the security isolation keys, JSON-encoded. '
        + 'A node that is not a valid target is listed in `skipped` instead of failing the export: `agent_tls_required` when its agent URL is not HTTPS (the server has no agent TLS), `invalid_target` otherwise (for example a blank name).',
      security: [{ securityInventoryBearer: [] }],
      responses: {
        200: { description: 'Inventory targets', content: { 'application/json': { schema: {
          type: 'object', required: ['success', 'data', 'skipped'],
          properties: {
            success: { type: 'boolean', enum: [true] },
            data: { type: 'array', items: zodOut(securityInventoryTargetSchema) },
            skipped: { type: 'array', items: zodOut(securityInventorySkippedSchema) },
          },
        } } } },
        401: { ...err401, description: '`UNAUTHORIZED`: missing or wrong token' },
      },
    },
  },
  '/security-integration/summary': {
    get: {
      tags: ['Cindertrace'], summary: 'Security summary from the external security console',
      description: 'Any role (the `security-fusion:read` permission). Passes through the body of the console\'s `/api/v1/security-fusion/summary`, which needs `SECURITY_FUSION_API_URL` (HTTPS) and `SECURITY_SUMMARY_TOKEN`.',
      security: userAuth,
      responses: {
        200: { description: 'The console\'s summary, unchanged', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        401: err401, 403: err403,
        503: errorResponse('`SECURITY_UNAVAILABLE`: not configured, unreachable, or answered an error'),
      },
    },
  },
  '/security-integration/backups': {
    post: {
      tags: ['Cindertrace'], summary: 'Receive an encrypted backup from the external security console',
      description: 'Bearer token whose SHA-256 is `SECURITY_BACKUP_TOKEN_SHA256`; no user session. The raw body (32 bytes to 512 MiB) is stored as `x-backup-name` in `SECURITY_BACKUP_DIRECTORY` (default `$MAGNUS_HOME/security-backups`) once its SHA-256 matches `x-backup-sha256`. One upload at a time.',
      security: [{ securityBackupBearer: [] }],
      parameters: [
        { name: 'x-backup-name', in: 'header', required: true, schema: { type: 'string', pattern: '^security-\\d{8}T\\d{6}Z\\.aes$' } },
        { name: 'x-backup-sha256', in: 'header', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      ],
      requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
      responses: {
        201: success('Stored backup', { type: 'object', properties: { name: { type: 'string' }, bytes: { type: 'integer' }, sha256: { type: 'string' } } }),
        400: { ...err400, description: '`VALIDATION_ERROR`: invalid `x-backup-name` or `x-backup-sha256`' },
        401: { ...err401, description: '`UNAUTHORIZED`: missing or wrong token' },
        409: errorResponse('`BACKUP_UPLOAD_ACTIVE`: another upload is in progress'),
        503: errorResponse('`BACKUP_TRANSFER_FAILED`: empty, too large, digest mismatch or unsafe directory'),
      },
    },
  },

  // ──────────────── Nodes ────────────────
  '/nodes/tags': {
    get: {
      tags: ['Nodes'], summary: 'Tags in use, with node counts', description: 'Any role. Sorted by name; sentinel nodes are left out.', security: userAuth,
      responses: { 200: success('Tags', { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } } } }), 401: err401 },
    },
  },
  '/nodes/tags/bulk': {
    post: {
      tags: ['Nodes'], summary: 'Add or remove tags on many nodes (ADMIN, OPERATOR)',
      description: 'Tags are trimmed, lower-cased and de-duplicated; empty ones are dropped. Unknown node IDs are skipped. Audited as `node.tags.bulk`.',
      security: userAuth, requestBody: requestBody(bulkNodeTagsSchema),
      responses: {
        200: success('Result', { type: 'object', properties: { updated: { type: 'integer', description: 'Nodes found and updated' },
          action: { type: 'string', enum: ['add', 'remove'] }, tags: { type: 'array', items: { type: 'string' }, description: 'The normalized tags applied' } } }),
        400: err400, 401: err401, 403: err403,
      },
    },
  },
  '/nodes/wazuh/summary': {
    get: {
      tags: ['Nodes'], summary: 'Fleet Wazuh agent posture from each node\'s latest health snapshot', description: 'Any role. Sentinel nodes are left out.', security: userAuth,
      responses: {
        200: success('Wazuh posture', { type: 'object', properties: {
          total: { type: 'integer' }, reporting: { type: 'integer' }, installed: { type: 'integer' }, active: { type: 'integer' }, failed: { type: 'integer' },
          nodes: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, name: { type: 'string' }, hostname: { type: 'string' }, nodeStatus: { type: 'string' },
            lastHeartbeatAt: { type: 'string', format: 'date-time', nullable: true }, observedAt: { type: 'string', format: 'date-time', nullable: true },
            wazuh: wazuhPosture } } },
        } }),
        401: err401,
      },
    },
  },
  '/nodes/{nodeId}/wazuh': {
    get: {
      tags: ['Nodes'], summary: 'Wazuh agent posture of one node', description: 'Any role. From the node\'s latest health snapshot.', security: userAuth,
      parameters: [pp('nodeId', 'Node ID')],
      responses: {
        200: success('Wazuh posture', { type: 'object', properties: { nodeId: { type: 'string' }, observedAt: { type: 'string', format: 'date-time' }, wazuh: wazuhPosture } }),
        401: err401, 404: errorResponse('No health snapshot for this node (also for an unknown node)'),
      },
    },
  },
  '/nodes/scan-users': {
    get: {
      tags: ['Nodes'], summary: 'Linux accounts across online nodes (ADMIN, OPERATOR)',
      description: 'Asks every ONLINE node\'s agent for its user list (10-second timeout each). Unreachable nodes are skipped silently.',
      security: userAuth,
      responses: {
        200: success('Node IDs per account name', { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } }),
        401: err401, 403: err403,
      },
    },
  },
  '/nodes/system-updates/summary': {
    get: browserOperation('GET', '/nodes/system-updates/summary', {
      tags: ['Nodes'], summary: 'Fleet automatic-update and reboot posture',
      description: 'From each node\'s latest health snapshot; sentinel nodes are left out.',
    }),
  },
  '/nodes/{nodeId}/system-updates/enable': {
    post: browserOperation('POST', '/nodes/{nodeId}/system-updates/enable', {
      tags: ['Nodes'], summary: 'Turn on automatic system updates on a node',
      description: 'The agent applies the update policy (20-minute timeout). Audited as `node.system_updates.enable` or `node.system_updates.enable_failed`.',
      params: { nodeId: 'Node ID' },
      errors: { 404: err404, 409: errorResponse('`INVALID_STATE`: the node is not ONLINE'), 502: errorResponse('`NODE_UPDATE_POLICY_FAILED`: the agent refused or failed') },
    }),
  },
};
