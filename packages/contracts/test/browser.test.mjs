import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  consoleSessionResponseSchema, cronUpdateResponseSchema, fleetReadinessResponseSchema, magnusBrowserContractVersion,
  magnusBrowserResponseSchema, magnusBrowserRoute, magnusBrowserRoutes, registerNodeResponseSchema, roleSchema,
} from '../dist/browser.js';

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
  const cron = { id: 'cron-1', nodeId: 'node-1', name: 'backup', description: '', schedule: '0 * * * *', command: '/usr/bin/true', args: '[]', workingDirectory: null, environment: '{"KEY":"value"}', timeoutSeconds: 60, status: 'ACTIVE', lastRunAt: null, lastRunExitCode: null, nextRunAt: null, createdBy: 'alice', createdAt: now, updatedAt: now };
  const updated = cronUpdateResponseSchema.parse({ success: true, data: { ...cron, node: { ...node, token: 'node-fake-token' } } });
  assert.equal('token' in updated.data.node, false);
  assert.equal('environment' in updated.data, false);

  const role = roleSchema.parse({ id: 'role-1', name: 'web', description: '', libraryFileIds: [], skillNames: [], aptPackages: [], npmPackages: [], dockerEnabled: false, dockerNonRoot: false, dockerImage: null, dockerVolumes: [], firewallEnabled: false, firewallMode: 'allow', firewallAllowRules: [], status: 'active', createdAt: now, updatedAt: now, _count: { nodes: 0 }, envConfig: { KEY: 'value' } });
  assert.equal('envConfig' in role, false);

  const readiness = fleetReadinessResponseSchema.parse({ success: true, data: { generatedAt: now, thresholds: { staleNodeMs: 1 }, expectedFingerprints: { apiSecret: 'fake', nodeManagerSecret: 'fake' }, nodes: [] } });
  assert.equal('expectedFingerprints' in readiness.data, false);
});
