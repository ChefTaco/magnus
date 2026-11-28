/**
 * Fleet analytics: anomaly events and their correlation, resource predictions and disk forecasts,
 * configuration drift scans, service dependency and network topology maps, agent profiles, and the
 * node comparison and metric time series. Every route here sits behind `authMiddleware`.
 */
import {
  anomalyEventSchema,
  correlatedAnomalyGroupSchema,
  dependencyHealthSchema,
  diskForecastSchema,
} from '@hivemagnus/magnus-contracts/browser';
import {
  type JsonSchema, type Paths, browserOperation, err400, err401, err403, err404, err502, inlineBody, optionalBody, pp, qp,
  success, userAuth, zodOut,
} from '../helpers.js';

const any = 'Any role.';
const write = 'Roles: ADMIN, OPERATOR.';
const nodeId = pp('nodeId', 'Node ID');
const dateTime = { type: 'string', format: 'date-time' };
const clamped = 'Out-of-range or non-numeric values are clamped or replaced by the default, never refused.';

const anomalyFilters = [
  qp('metric', 'Only this metric (cpu, memory, disk, swap, network_rx, network_tx)'),
  qp('severity', 'Only this severity (info, warning, critical)'),
  qp('resolved', 'true: resolved only; false: active only; anything else: both'),
  qp('page', 'Page number from 1 (default 1)', { type: 'integer' }),
  qp('pageSize', 'Items per page (default 50, at most 100)', { type: 'integer' }),
];
const anomalyList = { type: 'object', properties: { anomalies: { type: 'array', items: zodOut(anomalyEventSchema) }, total: { type: 'integer' } } };
/** An anomaly row without the node relation, as the node summary returns it. */
const anomalyRow: JsonSchema = (() => {
  const row = zodOut(anomalyEventSchema) as { properties: Record<string, unknown>; required?: string[] };
  const { node: _node, ...properties } = row.properties;
  return { ...row, properties, required: (row.required ?? []).filter((name) => name !== 'node') };
})();

const prediction = {
  type: 'object',
  properties: {
    metric: { type: 'string' },
    currentValue: { type: 'number' },
    predictedValue: { type: 'number' },
    hoursAhead: { type: 'number' },
    predictedAt: dateTime,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
    breachesThreshold: { type: 'boolean' },
    threshold: { type: 'number' },
    trend: { type: 'string', enum: ['rising', 'falling', 'stable'] },
    trendPerHour: { type: 'number' },
  },
};

const driftFinding = {
  type: 'object',
  description: 'One check as the node agent evaluated it.',
  properties: {
    type: { type: 'string', enum: ['package', 'file', 'service', 'sysctl', 'user'] },
    name: { type: 'string' },
    expected: { type: 'string' },
    actual: { type: 'string' },
    status: { type: 'string', enum: ['match', 'drifted', 'missing', 'error'] },
  },
};
const driftScan = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    nodeId: { type: 'string' },
    status: { type: 'string', enum: ['clean', 'drifted', 'error'] },
    findings: { type: 'array', items: driftFinding, description: 'For an `error` scan, one `{ error }` item.' },
    scannedAt: dateTime,
  },
};

const profile = {
  type: 'object',
  description: 'The agent\'s profile sections (heap, cpu, process; only the requested one when `type` is set), with the node\'s id and name.',
  properties: { nodeId: { type: 'string' }, nodeName: { type: 'string' } },
  additionalProperties: true,
};

const comparedNode = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    hostname: { type: 'string' },
    ipAddress: { type: 'string' },
    status: { type: 'string' },
    agentVersion: { type: 'string', description: '`unknown` when no agent has reported' },
    os: { type: 'string', nullable: true },
    arch: { type: 'string', nullable: true },
    tags: { type: 'array', items: { type: 'string' } },
    health: {
      type: 'object', nullable: true, description: 'Newest snapshot, null when the node has none',
      properties: { cpuUsagePercent: { type: 'number' }, memoryPercent: { type: 'number' }, disks: { type: 'string', description: 'JSON-encoded disk array' }, timestamp: dateTime },
    },
    skills: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, version: { type: 'string' }, status: { type: 'string' } } } },
    roles: { type: 'array', items: { type: 'object', properties: { roleName: { type: 'string' }, action: { type: 'string' }, status: { type: 'string' } } } },
  },
};

export const paths: Paths = {
  // ──────────────── Anomalies ────────────────
  '/anomalies': {
    get: browserOperation('GET', '/anomalies', {
      tags: ['Anomalies'], summary: 'Fleet-wide anomaly feed, newest first',
      description: `Filters combine. ${clamped}`,
      queryDescriptions: { nodeId: 'Only this node', metric: 'Only this metric', severity: 'Only this severity', resolved: 'true: resolved only; false: active only', page: 'Page number from 1', pageSize: 'Items per page (default 50, at most 100)' },
    }),
  },
  '/anomalies/summary': {
    get: browserOperation('GET', '/anomalies/summary', {
      tags: ['Anomalies'], summary: 'Active anomalies grouped by node and by severity',
    }),
  },
  '/anomalies/correlations': {
    get: {
      tags: ['Anomalies'], summary: 'Group anomalies that happened close together across the fleet',
      description: `Reads the oldest 200 matching anomalies, splits them where the gap between two exceeds the window, and adds the commands run on the affected nodes around each group. ${clamped} ${any}`,
      security: userAuth,
      parameters: [
        qp('windowMinutes', 'Largest gap inside one group, in minutes (1-120, default 5)', { type: 'integer' }),
        qp('includeResolved', '`true` also groups resolved anomalies', { enum: ['true', 'false'] }),
      ],
      responses: { 200: success('Anomaly groups, oldest first', { type: 'array', items: zodOut(correlatedAnomalyGroupSchema) }), 401: err401 },
    },
  },
  '/anomalies/timeline': {
    get: {
      tags: ['Anomalies'], summary: 'Anomalies and CPU/memory samples in one time range',
      description: `At most 200 anomalies and 200 health samples, oldest first. ${clamped} ${any}`,
      security: userAuth,
      parameters: [qp('hours', 'Range in hours back from now (1-720, default 24)', { type: 'integer' }), qp('nodeId', 'Only this node')],
      responses: {
        200: success('Timeline', {
          type: 'object',
          properties: {
            timeRange: { type: 'object', properties: { start: dateTime, end: dateTime } },
            anomalyCount: { type: 'integer' },
            anomalies: { type: 'array', items: { type: 'object', properties: {
              id: { type: 'string' }, nodeId: { type: 'string' }, metric: { type: 'string' }, value: { type: 'number' },
              severity: { type: 'string' }, zScore: { type: 'number' }, resolved: { type: 'boolean' }, createdAt: dateTime } } },
            healthContext: { type: 'array', items: { type: 'object', properties: {
              nodeId: { type: 'string' }, timestamp: dateTime, cpu: { type: 'number' }, memory: { type: 'number' } } } },
          },
        }),
        401: err401,
      },
    },
  },
  '/anomalies/event/{id}/correlation': {
    get: browserOperation('GET', '/anomalies/event/{id}/correlation', {
      tags: ['Anomalies'], summary: 'The group an anomaly belongs to, with a rule-based analysis', params: { id: 'Anomaly event ID' },
      errors: { 404: err404 },
    }),
  },
  '/anomalies/{nodeId}': {
    get: {
      tags: ['Anomalies'], summary: 'Anomalies of one node, newest first',
      description: `An unknown node answers an empty list. ${clamped} ${any}`,
      security: userAuth,
      parameters: [nodeId, ...anomalyFilters],
      responses: { 200: success('Anomalies', anomalyList), 401: err401 },
    },
  },
  '/anomalies/{nodeId}/summary': {
    get: {
      tags: ['Anomalies'], summary: 'Anomaly counts and the ten newest anomalies of one node',
      description: `\`byMetric\` counts active anomalies. An unknown node answers zeros. ${any}`,
      security: userAuth,
      parameters: [nodeId],
      responses: {
        200: success('Node anomaly summary', { type: 'object', properties: {
          total: { type: 'integer' }, active: { type: 'integer' },
          byMetric: { type: 'object', additionalProperties: { type: 'integer' } },
          recent: { type: 'array', items: anomalyRow },
        } }),
        401: err401,
      },
    },
  },
  '/anomalies/{id}/resolve': {
    post: {
      tags: ['Anomalies'], summary: 'Mark one anomaly resolved', description: `Takes no body. Audited as \`anomaly.resolve\`. ${write}`,
      security: userAuth,
      parameters: [pp('id', 'Anomaly event ID')],
      responses: { 200: { description: 'Resolved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', enum: [true] } } } } } }, 401: err401, 403: err403, 404: err404 },
    },
  },
  '/anomalies/resolve-node': {
    post: {
      tags: ['Anomalies'], summary: 'Resolve every active anomaly of a node, or of one metric on it',
      description: `Audited as \`anomaly.resolve_node\` with the node, the metric and the number resolved. ${write}`,
      security: userAuth,
      requestBody: inlineBody({ type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string', minLength: 1, maxLength: 128 }, metric: { type: 'string', minLength: 1, maxLength: 100, description: 'Only this metric' } } }),
      responses: { 200: success('Number of anomalies resolved', { type: 'object', properties: { resolved: { type: 'integer' } } }), 400: { ...err400, description: 'Not JSON, or `nodeId` missing or not a string' }, 401: err401, 403: err403 },
    },
  },
  '/anomalies/purge': {
    post: {
      tags: ['Anomalies'], summary: 'Delete resolved anomalies older than a retention period',
      description: 'Deletes anomalies resolved more than `retentionDays` ago. An empty or missing body keeps the default of 30 days; a body that is not valid JSON answers 400 and deletes nothing. Audited as `anomaly.purge` with `retentionDays` and the number deleted. ADMIN only.',
      security: userAuth,
      requestBody: optionalBody({ type: 'object', properties: { retentionDays: { type: 'integer', minimum: 1, maximum: 3650, default: 30, description: 'Whole days; 0 or less would delete every resolved anomaly and answers 400' } } }),
      responses: { 200: success('Number of anomalies deleted', { type: 'object', properties: { deleted: { type: 'integer' }, retentionDays: { type: 'integer' } } }), 400: { ...err400, description: 'Not valid JSON, or `retentionDays` is not a whole number from 1 to 3650' }, 401: err401, 403: err403 },
    },
  },

  // ──────────────── Predictions and forecasts ────────────────
  '/predictions': {
    get: {
      tags: ['Predictions'], summary: 'Resource predictions for every online node, with the nodes at risk',
      description: `Evaluates each online node's recent health with double exponential smoothing. ${any}`,
      security: userAuth,
      responses: {
        200: success('Fleet predictions', { type: 'object', properties: {
          atRisk: { type: 'array', items: { type: 'object', properties: { nodeId: { type: 'string' }, nodeName: { type: 'string' }, predictions: { type: 'array', items: prediction } } } },
          summary: { type: 'object', properties: { totalNodes: { type: 'integer' }, nodesAtRisk: { type: 'integer' }, byMetric: { type: 'object', additionalProperties: { type: 'integer' } } } },
        } }),
        401: err401,
      },
    },
  },
  '/predictions/{nodeId}': {
    get: {
      tags: ['Predictions'], summary: 'Resource predictions for one node',
      description: `An unknown node answers an empty list. ${any}`,
      security: userAuth,
      parameters: [nodeId],
      responses: { 200: success('Node predictions', { type: 'object', properties: { nodeId: { type: 'string' }, predictions: { type: 'array', items: prediction } } }), 401: err401 },
    },
  },
  '/health/{nodeId}/forecast': {
    get: browserOperation('GET', '/health/{nodeId}/forecast', {
      tags: ['Predictions'], summary: 'Disk-full forecast per mount of one node', params: { nodeId: 'Node ID' },
      description: '`days` is the lookback (default 30, at most 365); a missing, non-numeric or non-positive value is 30.',
      queryDescriptions: { days: 'Lookback in days (default 30, at most 365)' },
      errors: { 404: err404 },
    }),
  },
  '/health/forecast/at-risk': {
    get: {
      tags: ['Predictions'], summary: 'Nodes with a disk forecast to fill up within a threshold',
      description: `Forecasts every node's disks and keeps the mounts expected to fill within \`days\`; the most urgent node comes first. A missing, non-numeric or non-positive \`days\` is 30, and it is at most 3650. ${any}`,
      security: userAuth,
      parameters: [qp('days', 'Threshold in days (default 30, at most 3650)', { type: 'number' })],
      responses: {
        200: success('Nodes at risk', { type: 'object', properties: {
          daysThreshold: { type: 'number' }, count: { type: 'integer' },
          nodes: { type: 'array', items: { type: 'object', properties: { nodeId: { type: 'string' }, hostname: { type: 'string', nullable: true }, forecasts: { type: 'array', items: zodOut(diskForecastSchema) } } } },
        } }),
        401: err401,
      },
    },
  },
  '/health/dependencies': {
    get: {
      tags: ['Health'], summary: 'Health of the server\'s own dependencies (database, Redis, integrations)',
      description: `The same report as \`GET /ops/dependency-health\`. ${any}`,
      security: userAuth,
      responses: { 200: success('Dependency health', zodOut(dependencyHealthSchema)), 401: err401 },
    },
  },

  // ──────────────── Drift ────────────────
  '/drift/scan': {
    post: {
      tags: ['Drift'], summary: 'Check a node against expected packages, files, services, sysctls and users',
      description: 'The node agent evaluates the checks and the result is stored. When the agent cannot be reached or answers an error, '
        + 'the route still answers 200: `data` is then `{ scan, error }`, where `scan` is the stored `error` scan with `findings` as a JSON-encoded string. '
        + 'Both outcomes are audited as `drift.scan` (`details.status` is the scan status, or `error`). '
        + write,
      security: userAuth,
      requestBody: inlineBody({
        type: 'object', required: ['nodeId', 'checks'], additionalProperties: true,
        properties: {
          nodeId: { type: 'string', minLength: 1, maxLength: 128 },
          checks: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['type', 'name', 'expected'], properties: {
            type: { type: 'string', enum: ['package', 'file', 'service', 'sysctl', 'user'] },
            name: { type: 'string', minLength: 1, maxLength: 512 },
            expected: { type: 'string', maxLength: 4096, description: 'Expected version, content digest, state or value; `absent` for a user that must not exist' },
          } } },
        },
      }),
      responses: {
        200: success('Stored scan, or the stored error scan and the error', { oneOf: [driftScan, { type: 'object', properties: { scan: { type: 'object' }, error: { type: 'string' } } }] }),
        400: err400, 401: err401, 403: err403, 404: err404,
      },
    },
  },
  '/drift/{nodeId}': {
    get: {
      tags: ['Drift'], summary: 'The 20 newest drift scans of a node',
      description: `An unknown node answers an empty list. ${any}`,
      security: userAuth,
      parameters: [nodeId],
      responses: { 200: success('Drift scans, newest first', { type: 'array', items: driftScan }), 401: err401 },
    },
  },
  '/drift/{nodeId}/latest': {
    get: {
      tags: ['Drift'], summary: 'The newest drift scan of a node', description: any,
      security: userAuth,
      parameters: [nodeId],
      responses: { 200: success('Drift scan', driftScan), 401: err401, 404: err404 },
    },
  },

  // ──────────────── Dependencies and topology ────────────────
  '/dependencies': {
    get: browserOperation('GET', '/dependencies', {
      tags: ['Topology'], summary: 'Service dependency graph between nodes',
      description: 'Cached for ten minutes; a cache miss collects connections from every node. A Hermes plugin read credential gets the redacted form, without addresses, processes or ports.',
    }),
  },
  '/dependencies/scan': {
    post: {
      tags: ['Topology'], summary: 'Collect the dependency graph again and replace the cache',
      description: `Takes no body. Answers the full graph. ${write}`,
      security: userAuth,
      responses: { 200: (browserOperation('GET', '/dependencies', { tags: ['Topology'], summary: 'Fresh dependency graph' }).responses as Record<string, unknown>)['200'], 401: err401, 403: err403 },
    },
  },
  '/topology': {
    get: browserOperation('GET', '/topology', { tags: ['Topology'], summary: 'Network topology of the fleet: nodes, subnets and reachability' }),
  },
  '/topology/scan': {
    post: {
      ...browserOperation('POST', '/topology/scan', { tags: ['Topology'], summary: 'Probe the fleet again and replace the cached topology', errors: { 400: err400 } }),
      requestBody: optionalBody({
        type: 'object', additionalProperties: true,
        properties: { probeTimeoutMs: { type: 'integer', minimum: 1, maximum: 15000, default: 3000, description: 'Timeout of each probe' } },
      }, 'Optional; an empty body keeps the 3000 ms default. A body that is not valid JSON answers 400.'),
    },
  },

  // ──────────────── Profiling ────────────────
  '/profiling': {
    get: {
      tags: ['Profiling'], summary: 'Collect agent runtime profiles from every node that is not offline or decommissioned',
      description: `Each node answers within ten seconds or is reported with an \`error\`. ${write}`,
      security: userAuth,
      responses: {
        200: success('One profile or error per node', { type: 'array', items: { anyOf: [profile, { type: 'object', properties: { nodeId: { type: 'string' }, nodeName: { type: 'string' }, error: { type: 'string' } } }] } }),
        401: err401, 403: err403,
      },
    },
  },
  '/profiling/{nodeId}': {
    get: {
      tags: ['Profiling'], summary: 'Collect the agent runtime profile of one node',
      description: `Read-only on the node; the request is audited as \`node.profile\`. ${write}`,
      security: userAuth,
      parameters: [nodeId, qp('type', 'Only this profile section; all of them when absent', { enum: ['heap', 'cpu', 'process'] })],
      responses: { 200: success('Profile', profile), 400: err400, 401: err401, 403: err403, 404: err404, 502: err502 },
    },
  },

  // ──────────────── Node comparison and time series ────────────────
  '/nodes/compare': {
    get: {
      tags: ['Nodes'], summary: 'Compare two to five nodes side by side',
      description: '`diffFields` names what differs: `status`, `agentVersion`, `os`, `arch`, `health.cpuUsagePercent` or `health.memoryPercent` '
        + '(a spread over 10 points, only when every node has a snapshot) and `skills`. Unknown IDs are left out; fewer than two known nodes answers 404. '
        + any,
      security: userAuth,
      parameters: [qp('ids', 'Comma-separated node IDs (2-5)', { required: true })],
      responses: {
        200: success('Comparison', { type: 'object', properties: { nodes: { type: 'array', items: comparedNode }, diffFields: { type: 'array', items: { type: 'string' } } } }),
        400: err400, 401: err401, 404: err404,
      },
    },
  },
  '/nodes/{nodeId}/health/timeseries': {
    get: browserOperation('GET', '/nodes/{nodeId}/health/timeseries', {
      tags: ['Nodes'], summary: 'One metric of a node over a period', params: { nodeId: 'Node ID' },
      description: 'Defaults: `cpu` over `1h`. Periods over 24 hours are averaged into five-minute buckets. Disk is the `usagePercent` of the first disk entry (the root mount). A node without samples (or an unknown node) answers empty arrays and zeros.',
      queryDescriptions: { metric: 'cpu (default), memory, swap or disk', period: '1h (default), 6h, 24h, 7d or 30d' },
      errors: { 400: err400 },
    }),
  },
};
