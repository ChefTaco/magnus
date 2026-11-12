import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  agentActorIdSchema, agentIdentityResponseSchema, agentRefSchema,
  consoleSessionResponseSchema, cronUpdateResponseSchema, fleetReadinessResponseSchema, magnusBrowserContractVersion,
  magnusBrowserResponseSchema, magnusBrowserRoute, magnusBrowserRoutes, nodeListItemSchema, registerNodeResponseSchema, roleSchema,
  UPGRADE_REMEDIES, upgradeFailureClass, upgradeRemedy,
} from '../dist/browser.js';
import * as remedySource from '../dist/upgrade-remedies.js';

test('imports only zod', () => {
  const source = readFileSync(new URL('../src/browser.ts', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((match) => match[1]), ['zod']);
});

test('declares a version and one entry per method and path', () => {
  assert.equal(magnusBrowserContractVersion, 1);
  const keys = magnusBrowserRoutes.map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(keys.filter((key, index) => keys.indexOf(key) !== index), []);
});

test('every route has a response schema or stream events, and valid roles', () => {
  for (const route of magnusBrowserRoutes) {
    assert.ok(route.path.startsWith('/'), route.path);
    assert.notEqual(route.response === null, route.events === undefined, route.path);
    for (const role of route.roles) assert.ok(['ADMIN', 'OPERATOR', 'VIEWER'].includes(role), route.path);
  }
});

test('offers no terminal or machine route', () => {
  const forbidden = /terminal|heartbeat|discovery|logs\/ingest|resource-lease|\/mcp|security-integration|hiveskills|hermes-registry/u;
  assert.deepEqual(magnusBrowserRoutes.filter((route) => forbidden.test(route.path)), []);
});

test('resolves concrete paths, preferring an exact path over a parameter', () => {
  assert.equal(magnusBrowserRoute('/nodes/node-1?x=1').path, '/nodes/{nodeId}');
  assert.equal(magnusBrowserRoute('/nodes/system-updates/summary').path, '/nodes/system-updates/summary');
  assert.equal(magnusBrowserRoute('/commands', 'post').method, 'POST');
  assert.throws(() => magnusBrowserRoute('/terminal/ticket', 'POST'), /no released contract/);
  assert.throws(() => magnusBrowserRoute('/nodes/../heartbeat'), /Invalid/);
  assert.throws(() => magnusBrowserResponseSchema('/logs/stream'), /stream/);
});

test('the terminal capability defaults to off, because older servers omit it', () => {
  const capabilities = { hermes: false, agentVersion: '1.0.0', magnusVersion: '1.0.0', securityConsoleUrl: null };
  const parse = (value) => consoleSessionResponseSchema.parse({ success: true, data: { userId: 'alice', role: 'ADMIN', capabilities: value } }).data.capabilities.terminal;
  assert.equal(parse(capabilities), false);
  assert.equal(parse({ ...capabilities, terminal: true }), true);
});

test('parses a session and rejects an unknown role', () => {
  const session = { success: true, data: { userId: 'alice', role: 'VIEWER', capabilities: { hermes: false, agentVersion: '1.0.0', magnusVersion: '1.0.0', securityConsoleUrl: null } } };
  assert.equal(consoleSessionResponseSchema.parse(session).data.role, 'VIEWER');
  assert.throws(() => consoleSessionResponseSchema.parse({ ...session, data: { ...session.data, role: 'SUPER_ADMIN' } }));
});

test('strips secret-like fields from parsed responses', () => {
  const registered = registerNodeResponseSchema.parse({ success: true, data: { nodeId: 'node-1', controlApiUrl: 'https://magnus.example.com', token: 'node-fake-token' } });
  assert.equal('token' in registered.data, false);

  const now = '2026-01-01T00:00:00.000Z';
  const node = { id: 'node-1', name: 'node-1', hostname: 'node-1.example.com', ipAddress: '192.0.2.10', port: 4100, status: 'ONLINE', os: 'linux', arch: 'x64', tags: '[]', metadata: '{}', roleId: null, lastHeartbeatAt: now, createdAt: now, updatedAt: now };
  const cron = { id: 'cron-1', nodeId: 'node-1', name: 'backup', description: '', schedule: '0 * * * *', command: '/usr/bin/true', args: '[]', workingDirectory: null, environmentKeys: ['KEY'], timeoutSeconds: 60, status: 'ACTIVE', lastRunAt: null, lastRunExitCode: null, nextRunAt: null, createdBy: 'alice', createdAt: now, updatedAt: now };
  const updated = cronUpdateResponseSchema.parse({ success: true, data: { ...cron, node: { ...node, token: 'node-fake-token' } } });
  assert.equal('token' in updated.data.node, false);
  assert.equal('environment' in updated.data, false);
  assert.deepEqual(updated.data.environmentKeys, ['KEY']);

  const role = roleSchema.parse({ envConfigKeys: ['KEY'], id: 'role-1', name: 'web', description: '', libraryFileIds: [], skillNames: [], aptPackages: [], npmPackages: [], dockerEnabled: false, dockerNonRoot: false, dockerImage: null, dockerVolumes: [], firewallEnabled: false, firewallMode: 'allow', firewallAllowRules: [], status: 'active', createdAt: now, updatedAt: now, _count: { nodes: 0 } });
  assert.deepEqual(role.envConfigKeys, ['KEY']);

  const readiness = fleetReadinessResponseSchema.parse({ success: true, data: { generatedAt: now, thresholds: { staleNodeMs: 1 }, nodes: [] } });
  assert.equal('expectedFingerprints' in readiness.data, false);
});

test('carries an exact copy of the upgrade remedies', () => {
  assert.deepEqual(UPGRADE_REMEDIES, remedySource.UPGRADE_REMEDIES);
  assert.deepEqual(upgradeRemedy('NOT_A_CODE'), remedySource.upgradeRemedy('NOT_A_CODE'));
  assert.equal(upgradeFailureClass('SELF_UPGRADE_INTEGRITY'), remedySource.upgradeFailureClass('SELF_UPGRADE_INTEGRITY'));
});

test('a listed node with no snapshot has null health, not an error', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const node = { id: 'node-1', name: 'node-1', hostname: 'node-1.example.com', ipAddress: '192.0.2.10', port: 4100, status: 'PROVISIONING', os: 'linux', arch: 'x64', tags: '[]', metadata: '{}', roleId: null, lastHeartbeatAt: null, createdAt: now, updatedAt: now, agent: null, role: null, upgradeReadiness: null };
  assert.equal(nodeListItemSchema.parse({ ...node, health: null }).health, null);
  assert.throws(() => nodeListItemSchema.parse(node));
});

test('publishes the console pages that had no contract', () => {
  for (const [method, path] of [
    ['GET', '/anomalies'], ['GET', '/anomalies/summary'], ['GET', '/anomalies/event/{id}/correlation'], ['GET', '/remediation/rules'],
    ['POST', '/remediation/trigger'], ['GET', '/notifications'], ['PUT', '/notifications/preferences'], ['GET', '/ops/retention'],
    ['GET', '/assistant/conversations'], ['GET', '/webhooks'], ['POST', '/webhooks/{id}/test'], ['GET', '/topology'], ['POST', '/topology/scan'],
  ]) assert.ok(magnusBrowserRoutes.some((route) => route.method === method && route.path === path), `${method} ${path}`);
});

test('webhook responses cannot carry a stored credential', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const endpoint = { id: 'hook-1', name: 'pager', url: 'https://hooks.example.com', urlConfigured: true, type: 'generic', secretConfigured: true, headersConfigured: true, events: '[]', active: true, retries: 3, timeoutMs: 10000, createdBy: 'alice', createdAt: now, updatedAt: now };
  const parsed = magnusBrowserResponseSchema('/webhooks/hook-1').parse({ success: true, data: { endpoint: { ...endpoint, secret: 'fake-secret', headers: 'fake-headers' } } });
  assert.equal('secret' in parsed.data.endpoint, false);
  assert.equal('headers' in parsed.data.endpoint, false);
});

test('agent identity: references, actor IDs and the response shape', () => {
  for (const ref of ['node-1~lead', 'cmabc123.x~default']) assert.equal(agentRefSchema.safeParse(ref).success, true, ref);
  for (const ref of ['node-1', 'node-1~', '~lead', 'a~b~c', 'node 1~lead', `${'a'.repeat(129)}~lead`]) assert.equal(agentRefSchema.safeParse(ref).success, false, ref);
  assert.equal(agentActorIdSchema.safeParse('ardent-lead-0a1b2c3d').success, true);
  for (const id of ['a', 'Ardent', 'a'.repeat(33), 'x/y']) assert.equal(agentActorIdSchema.safeParse(id).success, false, id);
  assert.equal(magnusBrowserRoute('/agents/identity?actorId=ardent-lead-0a1b2c3d').path, '/agents/identity');
  assert.equal(magnusBrowserRoute('/agents/node-1~lead/identity').path, '/agents/{agentRef}/identity');
  const data = { agentRef: 'node-1~default', nodeId: 'node-1', profile: 'default', runtime: 'hermes', actorId: null, workspaceId: null,
    oathweaveSubject: null, emberpathClientKeyId: null };
  assert.deepEqual(agentIdentityResponseSchema.parse({ success: true, data: { ...data, token: 'fixture-token' } }).data, data);
  assert.throws(() => agentIdentityResponseSchema.parse({ success: true, data: { ...data, runtime: 'other' } }));
});

test('hive event feed: the route, the query and the event shape', async () => {
  const { hiveEventFeedQuerySchema, hiveEventFeedResponseSchema } = await import('../dist/browser.js');
  assert.equal(magnusBrowserRoute('/hive/events?limit=10').path, '/hive/events');
  assert.deepEqual(hiveEventFeedQuerySchema.parse({ limit: '200' }), { limit: 200 });
  for (const limit of ['0', '201', 'x']) assert.equal(hiveEventFeedQuerySchema.safeParse({ limit }).success, false, limit);
  const event = { id: 'magnus:notification:cmabc123', product: 'magnus', type: 'node.offline', severity: 'critical',
    title: 'node-1 went offline', summary: 'No heartbeat.', occurredAt: '2026-11-12T10:00:00.000Z',
    subject: { nodeId: 'cmnode123' }, link: { product: 'magnus', path: '/fleet/nodes/cmnode123' }, sourceRef: 'cmabc123' };
  assert.deepEqual(hiveEventFeedResponseSchema.parse({ data: [event], nextCursor: null }).data, [event]);
  assert.throws(() => hiveEventFeedResponseSchema.parse({ data: [{ ...event, severity: 'error' }], nextCursor: null }));
  assert.throws(() => hiveEventFeedResponseSchema.parse({ data: [{ ...event, link: { product: 'magnus', path: 'https://example.com' } }], nextCursor: null }));
});
