import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

vi.mock('../queue/workers.js', () => ({ enqueueCommand: vi.fn(async () => undefined) }));

const API_SECRET = 'fixture-console-contract-api-secret-at-least-32';

/**
 * Parses real control API responses, produced from real database rows, with the
 * published browser contract. Fixtures alone would only prove the schema agrees
 * with itself: this catches a nullable column, a serialized date or an envelope
 * that the contract got wrong.
 */
describe.skipIf(!process.env['TEST_DATABASE_URL'])('browser contract against real responses', () => {
  const prefix = `contract-${randomUUID()}`;
  const nodeId = prefix;
  const commandId = `${prefix}-command`;
  const cronId = `${prefix}-cron`;
  const runId = `${prefix}-run`;
  let home: string;
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let app: typeof import('../server.js')['app'];
  let contract: typeof import('@hivemagnus/magnus-contracts/browser');

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    process.env['DATABASE_URL'] = url;
    home = mkdtempSync(join(tmpdir(), 'magnus-contract-'));
    vi.stubEnv('MAGNUS_HOME', home);
    vi.stubEnv('API_SECRET', API_SECRET);
    vi.stubEnv('AUDIT_HMAC_SECRET', 'fixture-console-contract-audit-at-least-32');
    vi.stubEnv('CREDENTIAL_ROTATION_KEY', 'fixture-console-contract-rotation-at-least-32');
    vi.stubEnv('NODE_MANAGER_SECRET', 'fixture-console-contract-node-manager-at-least-32');
    vi.stubEnv('MAGNUS_HERMES_ENABLED', 'true');
    db = (await import('../db/index.js')).getDb();
    app = (await import('../server.js')).app;
    contract = await import('@hivemagnus/magnus-contracts/browser');

    const now = new Date();
    await db.node.create({ data: {
      id: nodeId, name: prefix, hostname: `${prefix}.example.com`, ipAddress: '192.0.2.10', os: 'linux', arch: 'x64',
      token: `node-${randomUUID()}`, status: 'ONLINE', lastHeartbeatAt: now, tags: '["fixture"]', metadata: '{"fixture":true}',
    } });
    await db.agent.create({ data: { nodeId, version: '1.2.3', status: 'RUNNING', capabilities: '[]' } });
    await db.healthSnapshot.create({ data: {
      nodeId, cpuUsagePercent: 12.5, cpuCores: 4, cpuLoadAverage: '[0.1,0.2,0.3]', memoryTotalBytes: 8_000_000_000n,
      memoryUsedBytes: 4_000_000_000n, memoryPercent: 50, swapTotalBytes: 0n, swapUsedBytes: 0n,
      disks: JSON.stringify([{ mountPoint: '/', totalBytes: 100, usedBytes: 50, freeBytes: 50, usagePercent: 50, filesystem: '/dev/sda1' }]),
      network: '[]', services: '[]',
    } });
    await db.gpuSnapshot.create({ data: { nodeId, sampledAt: now, status: 'ok', sampleIntervalSeconds: 60, devices: JSON.stringify([
      { index: 0, vendor: 'nvidia', name: 'Fixture GPU', uuid: null, utilizationPercent: 10, fanPercent: null, temperatureCelsius: 40 },
    ]) } });
    await db.remoteCommand.create({ data: { id: commandId, nodeId, command: '/usr/bin/true', args: '[]', environment: '{}', idempotencyKey: commandId, createdBy: 'alice', status: 'COMPLETED', completedAt: now } });
    await db.commandResult.create({ data: { commandId, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5 } });
    await db.cronJob.create({ data: { id: cronId, nodeId, name: prefix, schedule: '0 * * * *', command: '/usr/bin/true', args: '[]', environment: '{}', createdBy: 'alice' } });
    await db.cronJobExecution.create({ data: { cronJobId: cronId, nodeId, exitCode: 0, stdout: '', stderr: '', durationMs: 1, completedAt: now } });
    await db.logEntry.create({ data: { nodeId, source: 'agent', level: 'info', message: 'fixture message', metadata: '{}' } });
    await db.executionRun.create({ data: {
      id: runId, type: 'rollout', status: 'completed', rolloutStrategy: 'rolling', totalNodes: 1, completedNodes: 1, failedNodes: 0,
      createdBy: 'alice', metadata: JSON.stringify({ command: '/usr/bin/true', args: [] }),
      targets: { create: [{ nodeId, status: 'completed', evidence: '{}' }] },
    } });
    const installation = await db.hermesInstallation.create({ data: { hostname: `${prefix}.example.com`, nodeId, metadata: '{}', rawStatus: '{}', dashboardHost: '127.0.0.1' } });
    await db.hermesProfile.create({ data: { installationId: installation.id, name: 'default', profileHome: '/opt/hermes', capabilities: '{}', envStatus: '{}', metadata: '{}' } });
    await db.role.create({ data: { id: prefix, name: prefix, description: 'Fixture role', envConfig: '{"FIXTURE_VALUE":"visible-to-any-role"}' } });
    await (await import('../services/audit-service.js')).logAuditEvent({ action: 'cron.update', actorId: 'alice', targetType: 'cron', targetId: cronId, details: { fixture: true } });
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.executionRun.deleteMany({ where: { id: runId } });
      await db.hermesInstallation.deleteMany({ where: { nodeId } });
      await db.role.deleteMany({ where: { id: prefix } });
      await db.maintenanceWindow.deleteMany({ where: { reason: { startsWith: prefix } } });
      await db.libraryFile.deleteMany({ where: { name: { startsWith: prefix } } });
      await db.node.delete({ where: { id: nodeId } });
      await (await import('../db/index.js')).disconnectDb();
    }
    if (home) rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function call(method: string, path: string, body?: unknown) {
    const response = await app.request(`/api/v1${path}`, {
      method,
      headers: { 'x-api-secret': API_SECRET, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() as unknown };
  }

  function expectParses(label: string, schema: z.ZodType | null, json: unknown) {
    if (!schema) throw new Error(`${label} has no response schema`);
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new Error(`${label} does not match its contract: ${JSON.stringify(parsed.error.issues.slice(0, 5))}\n${JSON.stringify(json).slice(0, 800)}`);
    return parsed.data;
  }

  // Reads that touch a live agent or a model provider cannot run here.
  const GET_PATHS: Record<string, string> = {
    '/console/session': '/console/session',
    '/stats/overview': '/stats/overview',
    '/nodes/tailscale/summary': '/nodes/tailscale/summary',
    '/assistant/insights/pins': '/assistant/insights/pins',
    '/ops/dependency-health': '/ops/dependency-health',
    '/orchestra/installations': '/orchestra/installations',
    '/orchestra/profiles': '/orchestra/profiles',
    '/ops/readiness': '/ops/readiness',
    '/nodes': '/nodes?pageSize=100',
    '/nodes/system-updates/summary': '/nodes/system-updates/summary',
    '/health': '/health',
    '/self-update/version': '/self-update/version',
    '/self-update/status': '/self-update/status',
    '/agents/upgrade/eligibility': '/agents/upgrade/eligibility',
    '/nodes/{nodeId}': `/nodes/${nodeId}`,
    '/nodes/{nodeId}/gpu': `/nodes/${nodeId}/gpu`,
    '/nodes/{nodeId}/health': `/nodes/${nodeId}/health`,
    '/nodes/{nodeId}/health/history': `/nodes/${nodeId}/health/history`,
    '/nodes/{nodeId}/health/timeseries': `/nodes/${nodeId}/health/timeseries`,
    '/health/{nodeId}/forecast': `/health/${nodeId}/forecast`,
    '/hermes/installations': '/hermes/installations',
    '/roles': '/roles',
    '/roles/applications/list': '/roles/applications/list',
    '/commands': '/commands',
    '/commands/{commandId}': `/commands/${commandId}`,
    '/commands/{commandId}/result': `/commands/${commandId}/result`,
    '/cron': '/cron',
    '/cron/{cronId}': `/cron/${cronId}`,
    '/library/files': '/library/files',
    '/audit/days': '/audit/days',
    '/audit': '/audit',
    '/ops/incident-summary': `/ops/incident-summary?nodeId=${nodeId}`,
    '/ops/timeline': '/ops/timeline',
    '/ops/lessons': '/ops/lessons?query=fixture',
    '/rollouts': '/rollouts',
    '/rollouts/{id}': `/rollouts/${runId}`,
    '/ops/applications': '/ops/applications',
    '/ops/maintenance': '/ops/maintenance',
    '/ops/capacity-advice': '/ops/capacity-advice',
    '/dependencies': '/dependencies',
    '/skills': '/skills',
  };
  const NOT_RUN_HERE = new Set([
    '/assistant/insights', // model provider
    '/events/stream', '/logs/stream', // streams
    '/agents/upgrade/runs/{id}', // needs a run
    '/files/read', '/ops/storage-evidence/{nodeId}', // live agent
    '/library/files/{fileId}', '/ops/incidents/{id}/evidence', // covered below
  ]);

  it('covers every GET route in the contract', () => {
    const reads = contract.magnusBrowserRoutes.filter((route) => route.method === 'GET').map((route) => route.path);
    expect(reads.filter((path) => !GET_PATHS[path] && !NOT_RUN_HERE.has(path))).toEqual([]);
  });

  it('parses every read', async () => {
    const failures: string[] = [];
    for (const [routePath, concrete] of Object.entries(GET_PATHS)) {
      const route = contract.magnusBrowserRoutes.find((value) => value.method === 'GET' && value.path === routePath)!;
      const { status, json } = await call('GET', concrete);
      if (status !== 200) { failures.push(`GET ${concrete} answered ${status}: ${JSON.stringify(json).slice(0, 300)}`); continue; }
      try { expectParses(`GET ${routePath}`, route.response, json); } catch (error) { failures.push((error as Error).message); }
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it('never carries the node token through a cron update', async () => {
    const { status, json } = await call('PATCH', `/cron/${cronId}`, { description: 'updated' });
    expect(status).toBe(200);
    expect(JSON.stringify(json)).not.toMatch(/"token"/);
    expectParses('PATCH /cron/{cronId}', contract.cronUpdateResponseSchema, json);
  });

  it('parses writes that need no live agent', async () => {
    const library = await call('POST', '/library/files', contract.createLibraryFileRequestSchema.parse({ name: `${prefix}-file`, fileName: `${prefix}.md`, content: 'fixture' }));
    expect(library.status).toBe(201);
    const file = expectParses('POST /library/files', contract.libraryFileResponseSchema, library.json) as { data: { id: string } };
    expectParses('GET /library/files/{fileId}', contract.libraryFileResponseSchema, (await call('GET', `/library/files/${file.data.id}`)).json);
    expectParses('PATCH /library/files/{fileId}', contract.libraryFileResponseSchema, (await call('PATCH', `/library/files/${file.data.id}`, { content: 'updated' })).json);

    const startsAt = new Date(Date.now() + 60_000).toISOString();
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    const maintenance = await call('POST', '/ops/maintenance', contract.createMaintenanceRequestSchema.parse({ reason: `${prefix} window`, nodeIds: [nodeId], startsAt, endsAt }));
    expect(maintenance.status).toBe(201);
    const window = expectParses('POST /ops/maintenance', contract.maintenanceWindowResponseSchema, maintenance.json) as { data: { id: string } };
    expectParses('POST /ops/maintenance/{id}/cancel', contract.maintenanceWindowResponseSchema, (await call('POST', `/ops/maintenance/${window.data.id}/cancel`)).json);

    const preview = await call('POST', '/commands', contract.dispatchCommandRequestSchema.parse({ idempotencyKey: `${prefix}-preview`, nodeIds: [nodeId], command: '/usr/bin/true', dryRun: true }));
    expect(preview.status).toBe(200);
    expectParses('POST /commands dry run', contract.commandDispatchResponseSchema, preview.json);

    const registered = await call('POST', '/nodes/register', contract.registerNodeRequestSchema.parse({ name: `${prefix}-new`, hostname: `${prefix}-new.example.com`, ipAddress: '192.0.2.11' }));
    expect(registered.status).toBe(201);
    const created = expectParses('POST /nodes/register', contract.registerNodeResponseSchema, registered.json) as { data: Record<string, unknown> & { nodeId: string } };
    expect(created.data).not.toHaveProperty('token');
    expectParses('PATCH /nodes/{nodeId}', contract.updateNodeResponseSchema, (await call('PATCH', `/nodes/${created.data.nodeId}`, { tags: ['fixture'] })).json);
    expectParses('DELETE /nodes/{nodeId}', contract.deleteNodeResponseSchema, (await call('DELETE', `/nodes/${created.data.nodeId}`)).json);

    const cron = await call('POST', '/cron', contract.createCronRequestSchema.parse({ nodeId, name: `${prefix}-created`, schedule: '0 * * * *', command: '/usr/bin/true' }));
    expect(cron.status).toBe(201);
    const job = expectParses('POST /cron', contract.cronCreateResponseSchema, cron.json) as { data: { id: string } };
    expectParses('DELETE /cron/{cronId}', contract.cronDeleteResponseSchema, (await call('DELETE', `/cron/${job.data.id}`)).json);

    const logs = await call('POST', '/logs/query', contract.logQueryRequestSchema.parse({ nodeId }));
    expect(logs.status).toBe(200);
    expectParses('POST /logs/query', contract.logQueryResponseSchema, logs.json);

    expectParses('POST /commands/{commandId}/cancel refused', contract.apiErrorSchema, (await call('POST', `/commands/${commandId}/cancel`, {})).json);
  }, 60_000);
});
