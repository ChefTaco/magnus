import { Hono } from 'hono';
import { errorHandler } from '../middleware/error-handler.js';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandRequestDigest, type CommandRequest } from '../security/command-request.js';
import { commandResultSigningPayload } from '../security/command-result-signature.js';
import { COMMAND_COMPLETION_REGISTRY_SHA256 } from '../security/command-completion-registry.js';
import { httpIdentity, httpReceiptBody } from '../security/managed-http.js';
import { approvalSignerPublicKeyB64, signApprovalAssertion } from '../security/approval-assertion-test-fixture.js';

const secret = 'resource-lease-result-fixture-at-least-32-characters';
const actor = 'c'.repeat(64);
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  NODE_MANAGER_SECRET: 'resource-lease-node-auth-fixture-at-least-32-characters',
  RESULT_SIGNING_SECRET: 'resource-lease-result-fixture-at-least-32-characters', RESULT_SIGNING_PREVIOUS_SECRET: '',
  getNodeManagerSecret: () => 'resource-lease-node-auth-fixture-at-least-32-characters' }));
vi.mock('../queue/workers.js', () => ({ enqueueCommand: vi.fn() }));
const prefix = `rl-${randomUUID()}`;

describe.skipIf(!process.env['TEST_DATABASE_URL'])('durable finite-command resource ownership with PostgreSQL', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let lease: typeof import('./command-resource-leases.js');
  let sdk: typeof import('../sdk/node-api-client.js');
  let temporary: string;
  let config: string;
  const nodeId = prefix;
  const baseUrl = 'http://127.0.0.1:39091';
  const context = { nodeId, actorId: 'fixture-operator', baseUrl };
  const request = (): CommandRequest => ({ commandId: `cmd-${randomUUID()}`, command: '/usr/bin/true', args: [], timeoutSeconds: 5 });
  const registeredRequest = (): CommandRequest => ({ commandId: `cmd-${randomUUID()}`, command: '/usr/bin/uptime',
    args: [], environment: {}, timeoutSeconds: 60 });
  const client = () => new sdk.NodeApiClient({ baseUrl, nodeToken: 'resource-lease-node-auth-fixture-at-least-32-characters',
    resourceNodeId: nodeId, resourceActorId: 'fixture-operator' });
  function signed(input: CommandRequest, registeredEvidence = false) {
    const result = { commandId: input.commandId, exitCode: 0, stdout: 'fixture', stderr: '', durationMs: 1, truncated: false,
      coordination: { ...input.coordination!, requestSha256: commandRequestDigest(input) },
      ...(registeredEvidence ? { completion: { registryVersion: 1 as const, registrySha256: COMMAND_COMPLETION_REGISTRY_SHA256,
        descriptorId: 'diagnostics-uptime-v1' } } : {}) };
    return { ...result, signature: createHmac('sha256', secret).update(commandResultSigningPayload(result)).digest('hex') };
  }
  function json(value: unknown) { return new Response(JSON.stringify({ success: true, data: value }), { headers: { 'content-type': 'application/json' } }); }

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    vi.stubEnv('DATABASE_URL', url); vi.stubEnv('TLS_CERT_PATH', ''); vi.stubEnv('TLS_KEY_PATH', '');
    vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'true');
    vi.stubEnv('APPROVAL_SIGNER_PUBLIC_KEY_B64', approvalSignerPublicKeyB64); vi.stubEnv('APPROVAL_TELEGRAM_ACTOR_SHA256', actor);
    temporary = await mkdtemp(join(tmpdir(), 'magnus-resource-lease-'));
    vi.stubEnv('CREDENTIAL_ROTATION_KEY', 'resource-lease-rotation-fixture-at-least-32-characters');
    vi.stubEnv('CREDENTIAL_ROTATION_STATE_PATH', join(temporary, 'rotation.json'));
    config = join(temporary, 'applications.json');
    await writeFile(config, JSON.stringify({ schemaVersion: 1, applications: [{ id: `${prefix}.app`, projectId: 'fixture', serviceId: 'fixture',
      nodeId, baseUrl: 'https://fixture.invalid/', healthPath: '/health', restartService: 'fixture-app.service' }] }), { mode: 0o600 });
    vi.stubEnv('MAGNUS_APPLICATION_PROBES_FILE', config);
    db = (await import('../db/index.js')).getDb(); lease = await import('./command-resource-leases.js'); sdk = await import('../sdk/node-api-client.js');
    await db.node.create({ data: { id: nodeId, name: prefix, hostname: `${prefix}.invalid`, ipAddress: '127.0.0.1', port: 39091,
      os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date() } });
    await db.remediationRule.create({ data: { id: prefix, name: prefix, agentDefinitionId: 'restart-service.v1' } });
  });
  // Command-layer fixtures explicitly model an already completed enrollment.
  // The separate enrollment integration suite verifies that public completion fails closed.
  beforeEach(async () => {
    await db.resourceEnrollment.upsert({ where: { nodeId }, create: { nodeId, nodeFqdn: `${prefix}.invalid`,
      state: 'enrolled', epoch: 1, barrierId: randomUUID(), enrolledAt: new Date() }, update: { state: 'enrolled' } });
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'true');
    if (!db) return;
    await db.commandResourceLease.deleteMany({ where: { nodeId } });
    await db.remoteCommand.deleteMany({ where: { nodeId } });
    await db.teamApprovalDecision.deleteMany({ where: { proposalId: { startsWith: `remediation:${prefix}-` } } });
    await db.remediationExecution.deleteMany({ where: { ruleId: prefix } });
    await db.node.update({ where: { id: nodeId }, data: { lastHeartbeatAt: new Date() } });
  });
  afterAll(async () => {
    if (db) {
      await db.commandResourceFence.deleteMany({ where: { resourceKey: `node:${nodeId}` } });
      await db.resourceEnrollment.deleteMany({ where: { nodeId } });
      await db.remediationRule.deleteMany({ where: { id: prefix } }); await db.node.deleteMany({ where: { id: nodeId } });
      await (await import('../db/index.js')).disconnectDb();
    }
    if (temporary) await rm(temporary, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function approvedRestart() {
    const id = `${prefix}-${randomUUID()}`;
    const plan = { runbookVersion: 'restart-service.v1', nodeId, applicationId: `${prefix}.app`, command: '/usr/bin/systemctl',
      args: ['restart', 'fixture-app.service'], timeoutSeconds: 5, expiresAt: new Date(Date.now() + 30_000).toISOString() };
    await db.remediationExecution.create({ data: { id, nodeId, ruleId: prefix, anomalyEventId: 'fixture', status: 'pending_approval', input: JSON.stringify(plan) } });
    const approvals = await import('./team-approvals.js');
    const view = await approvals.getTeamApprovalPlan(`remediation:${id}`);
    const payload = { version: 2 as const, proposal_id: view.plan_id, proposal_revision: view.revision, plan_sha256: view.plan_sha256,
      decision: 'approve' as const, decision_id: randomUUID(), decided_at: Date.now(), expires_at: view.expires_at,
      actor_binding_sha256: actor, execution_id: randomUUID() };
    await approvals.recordTeamApproval(signApprovalAssertion(payload));
    const fence = await db.commandResourceFence.upsert({ where: { resourceKey: `node:${nodeId}` }, create: { resourceKey: `node:${nodeId}`, generation: 1n }, update: { generation: { increment: 1n } } });
    const req: CommandRequest = { commandId: `cmd-${randomUUID()}`, command: plan.command, args: plan.args, timeoutSeconds: plan.timeoutSeconds,
      coordination: { version: 1, resourceKey: `node:${nodeId}`, fence: fence.generation.toString(), expiresAt: view.expires_at } };
    await db.remoteCommand.create({ data: { id: req.commandId, nodeId, command: req.command, args: JSON.stringify(req.args), timeoutSeconds: req.timeoutSeconds,
      status: 'RUNNING', startedAt: new Date(), idempotencyKey: randomUUID(), correlationId: `remediation_${id}`, createdBy: `telegram:${actor}`,
      executionDeadline: new Date(view.expires_at), coordinationJson: JSON.stringify(req.coordination) } });
    return { req, id, expires: view.expires_at };
  }

  it('serializes concurrent generic callers without duplicate ownership or dispatch', async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => lease.admitResourceCommand(context, request())));
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(o => o.status === 'rejected' && o.reason instanceof lease.ResourceLeaseConflict)).toHaveLength(7);
    expect(await db.commandResourceLease.count({ where: { nodeId } })).toBe(1);
    expect(await db.remoteCommand.count({ where: { nodeId } })).toBe(1);
    const row = await db.commandResourceLease.findFirstOrThrow({ where: { nodeId } });
    expect(row.resourceKey).toBe(`node:${nodeId}:all`); expect(row.serviceUnit).toBeNull();
    expect(row).toMatchObject({ completionClass: 'unverified', completionRegistryVersion: null,
      completionRegistrySha256: null, completionDescriptorId: null, completionOccurrenceId: null, completionSpecSha256: null });
  });

  it('arbitrates independent API processes through PostgreSQL rather than an in-memory lock', async () => {
    const childPath = join(temporary, 'claim.mts');
    const moduleUrl = fileURLToPath(new URL('./command-resource-leases.ts', import.meta.url));
    const dbUrl = fileURLToPath(new URL('../db/index.ts', import.meta.url));
    await writeFile(childPath, `import { admitResourceCommand } from ${JSON.stringify(moduleUrl)};
import { disconnectDb } from ${JSON.stringify(dbUrl)};
try { const row = await admitResourceCommand(JSON.parse(process.argv[2]), JSON.parse(process.argv[3])); console.log(JSON.stringify({owned:Boolean(row)})); } catch (error) { console.log(JSON.stringify({owned:false, code:error.code})); } finally { await disconnectDb(); }
`);
    type Verdict = { owned: boolean; code?: string };
    const children: Array<{ child: ChildProcess; done: Promise<Verdict> }> = [];
    const stop = (child: ChildProcess) => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        // Each fixture owns a separate process group, including loader helpers.
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    };
    const run = () => {
      const child = spawn(process.execPath, ['--import', 'tsx', childPath, JSON.stringify(context), JSON.stringify(request())], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env['TEST_DATABASE_URL']!, MAGNUS_RESOURCE_LEASES_ENABLED: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      });
      const done = new Promise<Verdict>((resolve, reject) => {
        let output = ''; let bytes = 0; let failure: string | undefined;
        const deadline = setTimeout(() => { failure = 'Isolated lease claimant exceeded its 15-second deadline'; stop(child); }, 15_000);
        deadline.unref();
        child.stdout!.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 8_192) { failure = 'Isolated lease claimant exceeded output bound'; stop(child); return; }
          output += chunk.toString();
        });
        // Drain diagnostics without exposing environment/connection strings or
        // letting an unread stderr pipe stall a child before its verdict.
        child.stderr!.resume();
        child.on('error', () => { failure = 'Isolated lease claimant could not start'; });
        child.on('close', (code, signal) => {
          clearTimeout(deadline);
          if (failure) return reject(new Error(failure));
          if (code !== 0) return reject(new Error(`Isolated lease claimant exited ${code ?? signal}`));
          try {
            const verdict = JSON.parse(output.trim()) as Verdict;
            if (typeof verdict.owned !== 'boolean' || (verdict.code !== undefined && typeof verdict.code !== 'string'))
              throw new Error('Malformed verdict');
            resolve(verdict);
          } catch { reject(new Error('Invalid isolated claimant verdict')); }
        });
      });
      children.push({ child, done });
      return done;
    };
    try {
      const outcomes = await Promise.all(Array.from({ length: 4 }, run));
      expect(outcomes.filter(item => item.owned)).toHaveLength(1);
      expect(outcomes.filter(item => item.code === 'RESOURCE_LEASE_CONFLICT')).toHaveLength(3);
      expect(await db.commandResourceLease.count({ where: { nodeId } })).toBe(1);
    } finally {
      // A failed claimant must not keep mutating fixtures during afterEach.
      for (const { child } of children) stop(child);
      await Promise.allSettled(children.map(({ done }) => done));
    }
    // Four cold Node/tsx/Prisma starts share hosted-runner CPU. The enclosing
    // test must outlive its existing 15s child limit and reap them before DB cleanup.
  }, 30_000);

  it('uses exact approved system-unit scope and conflicts with equivalent generic wrappers', async () => {
    const { req } = await approvedRestart();
    const admitted = await lease.admitResourceCommand(context, req);
    expect(admitted?.payload.coordination).toEqual(req.coordination);
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: req.commandId } })).resourceKey)
      .toBe(`node:${nodeId}:system-service:fixture-app.service`);
    for (const generic of [request(), { ...request(), command: 'systemctl', args: ['restart', 'fixture-app'] },
      { ...request(), command: 'bash', args: ['-c', 'systemctl restart fixture-app.service'] },
      { ...request(), command: '/usr/local/sbin/example-containment', args: ['restart-service', 'fixture-app.service'] }]) {
      await expect(lease.admitResourceCommand(context, generic)).rejects.toBeInstanceOf(lease.ResourceLeaseConflict);
    }
    expect(await db.commandResourceLease.count({ where: { nodeId } })).toBe(1);
  });

  it('rejects expired Telegram approval without changing the immutable plan or acquiring ownership', async () => {
    const { req, expires, id } = await approvedRestart();
    const before = (await db.remediationExecution.findUniqueOrThrow({ where: { id } })).input;
    vi.spyOn(Date, 'now').mockReturnValue(expires + 1);
    await expect(lease.admitResourceCommand(context, req)).rejects.toThrow('Telegram permission');
    expect(await db.commandResourceLease.count({ where: { nodeId } })).toBe(0);
    expect((await db.remediationExecution.findUniqueOrThrow({ where: { id } })).input).toBe(before);
  });

  it('releases only a pre-POST failure and preserves its durable evidence', async () => {
    const fetch = vi.fn(async () => json({ features: { commandFencing: 0 } })); vi.stubGlobal('fetch', fetch);
    const req = request(); await expect(client().executeCommand(req)).rejects.toThrow('does not support command fencing');
    expect(fetch).toHaveBeenCalledTimes(1);
    const row = await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: req.commandId } });
    expect(row.state).toBe('released'); expect(row.settlement).toBe('not-dispatched'); expect(row.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await lease.admitResourceCommand(context, request()))?.leaseId).toBeTruthy();
  });

  it('keeps a lost-reply lease across expiry and restart; a verified receipt settles without executing again', async () => {
    let wire: CommandRequest | undefined;
    const fetch = vi.fn(async (req: Request) => {
      if (req.url.endsWith('/ping')) return json({ features: { commandFencing: 1, managedMutations: 1,
        commandCompletionRegistry: { version: 1, sha256: COMMAND_COMPLETION_REGISTRY_SHA256, enabled: 1 } } });
      wire = await req.json() as CommandRequest; throw new Error('lost reply after node acceptance');
    }); vi.stubGlobal('fetch', fetch);
    const req = registeredRequest(); await expect(client().executeCommand(req)).rejects.toThrow('lost reply');
    expect(fetch).toHaveBeenCalledTimes(2);
    const owned = await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: req.commandId } });
    expect(owned.state).toBe('unknown');
    await (await import('../db/index.js')).disconnectDb(); db = (await import('../db/index.js')).getDb();
    vi.spyOn(Date, 'now').mockReturnValue(owned.deadline.getTime() + 1000);
    await expect(lease.admitResourceCommand(context, request())).rejects.toBeInstanceOf(lease.ResourceLeaseConflict);
    vi.restoreAllMocks();
    const result = signed(wire!, true);
    const receiptFetch = vi.fn(async () => json({ commandId: req.commandId, requestSha256: commandRequestDigest(wire!), state: 'completed', result }));
    vi.stubGlobal('fetch', receiptFetch);
    expect((await client().getCommandReceipt(req.commandId, { nodeFqdn: `${prefix}.invalid`, requestSha256: owned.requestSha256 })).state).toBe('completed');
    expect(receiptFetch).toHaveBeenCalledTimes(1);
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: req.commandId } })).state).toBe('released');
    expect((await lease.admitResourceCommand(context, request()))?.leaseId).toBeTruthy();
  });

  it('does not release forged, wrong-request or generic terminal-state evidence', async () => {
    const admission = (await lease.admitResourceCommand(context, registeredRequest()))!;
    await lease.markResourceDispatched(admission); await lease.failResourceCommand(admission);
    const good = signed(admission.payload, true);
    await expect(lease.settleResourceResult(admission.commandId, { ...good, stdout: 'forged' })).rejects.toThrow('does not settle');
    await expect(lease.settleResourceResult(admission.commandId,
      signed({ ...admission.payload, args: ['different'] }, true))).rejects.toThrow('does not settle');
    await db.remoteCommand.update({ where: { id: admission.commandId }, data: { status: 'CANCELLED' } });
    await expect(lease.admitResourceCommand(context, request())).rejects.toBeInstanceOf(lease.ResourceLeaseConflict);
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: admission.commandId } })).state).toBe('unknown');
  });

  it('retains unregistered commands even when their exact signed process result is terminal', async () => {
    const admission = (await lease.admitResourceCommand(context, request()))!;
    await lease.markResourceDispatched(admission); await lease.failResourceCommand(admission);
    await expect(lease.settleResourceResult(admission.commandId, signed(admission.payload)))
      .rejects.toThrow('registered whole-effect evidence');
    expect(await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: admission.commandId } }))
      .toMatchObject({ state: 'unknown', completionClass: 'unverified', settlement: null });
  });

  it('does not promote scheduler-shaped command metadata without an exact occurrence and spec', async () => {
    const occurrenceId = createHash('sha256').update(randomUUID()).digest('hex');
    const commandId = `cron-${occurrenceId}`; const deadline = Date.now() + 60_000;
    const fence = await db.commandResourceFence.upsert({ where: { resourceKey: `node:${nodeId}` },
      create: { resourceKey: `node:${nodeId}`, generation: 1n }, update: { generation: { increment: 1n } } });
    const payload: CommandRequest = { commandId, command: '/usr/bin/true', args: [], timeoutSeconds: 60,
      coordination: { version: 1, resourceKey: `node:${nodeId}`, fence: fence.generation.toString(), expiresAt: deadline } };
    await db.remoteCommand.create({ data: { id: commandId, nodeId, command: payload.command, args: '[]', environment: '{}',
      timeoutSeconds: payload.timeoutSeconds, status: 'RUNNING', startedAt: new Date(), createdBy: 'fixture',
      idempotencyKey: `managed-cron:${occurrenceId}`, correlationId: 'managed-cron:missing-definition',
      executionDeadline: new Date(deadline), coordinationJson: JSON.stringify(payload.coordination) } });
    const admission = (await lease.admitResourceCommand(context, payload))!; await lease.markResourceDispatched(admission);
    expect(await db.commandResourceLease.findUniqueOrThrow({ where: { commandId } }))
      .toMatchObject({ completionClass: 'unverified', completionOccurrenceId: null, completionSpecSha256: null, state: 'running' });
    await expect(lease.settleResourceResult(commandId, signed(admission.payload)))
      .rejects.toThrow('registered whole-effect evidence');
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { commandId } })).state).toBe('running');
  });

  it('retains crashed worker ownership rather than treating command timeout as a release', async () => {
    const admission = (await lease.admitResourceCommand(context, request()))!;
    await lease.markResourceDispatched(admission);
    await db.remoteCommand.update({ where: { id: admission.commandId }, data: { startedAt: new Date(Date.now() - 60_000) } });
    await (await import('./command-lifecycle.js')).reconcileCommands();
    expect((await db.remoteCommand.findUniqueOrThrow({ where: { id: admission.commandId } })).status).toBe('FAILED');
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: admission.commandId } })).state).toBe('unknown');
    await expect(lease.admitResourceCommand(context, request())).rejects.toBeInstanceOf(lease.ResourceLeaseConflict);
  });

  it('fences off a crashed pre-POST reservation without manufacturing an unknown node execution', async () => {
    const admission = (await lease.admitResourceCommand(context, request()))!;
    await db.remoteCommand.update({ where: { id: admission.commandId }, data: { startedAt: new Date(Date.now() - 60_000) } });
    await (await import('./command-lifecycle.js')).reconcileCommands();
    const row = await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: admission.commandId } });
    expect(row.state).toBe('released'); expect(row.settlement).toBe('not-dispatched');
    await expect(lease.markResourceDispatched(admission)).rejects.toThrow('expired or changed');
    expect((await lease.admitResourceCommand(context, request()))?.leaseId).toBeTruthy();
  });

  it('settles the normal signed result with a durable direct-command receipt', async () => {
    const fetch = vi.fn(async (req: Request) => {
      if (req.url.endsWith('/ping')) return json({ features: { commandFencing: 1, managedMutations: 1,
        commandCompletionRegistry: { version: 1, sha256: COMMAND_COMPLETION_REGISTRY_SHA256, enabled: 1 } } });
      return json(signed(await req.json() as CommandRequest, true));
    }); vi.stubGlobal('fetch', fetch);
    const req = registeredRequest(); const result = await client().executeCommand(req);
    expect(result.data.exitCode).toBe(0);
    const row = await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: req.commandId } });
    expect(row.state).toBe('released'); expect(row.settlement).toBe('signed-command-result');
    expect((await db.remoteCommand.findUniqueOrThrow({ where: { id: req.commandId } })).status).toBe('COMPLETED');
    expect((await db.commandResult.findUniqueOrThrow({ where: { commandId: req.commandId } })).stdout).toBe('fixture');
    expect(row).toMatchObject({ completionClass: 'node-supervised-command', completionRegistryVersion: 1,
      completionRegistrySha256: COMMAND_COMPLETION_REGISTRY_SHA256, completionDescriptorId: 'diagnostics-uptime-v1' });
    await expect(db.commandResourceLease.update({ where: { id: row.id },
      data: { completionDescriptorId: 'changed-after-admission' } })).rejects.toThrow('command resource authority is immutable');
    await expect(client().executeCommand(req)).rejects.toThrow('already has a durable resource owner');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the first terminal result immutable under concurrent differing signed receipts', async () => {
    const admission = (await lease.admitResourceCommand(context, registeredRequest()))!;
    await lease.markResourceDispatched(admission);
    const first = signed(admission.payload, true);
    const secondBody = { ...first, exitCode: 7, stdout: 'different-signed-receipt' };
    const second = { ...secondBody, signature: createHmac('sha256', secret)
      .update(commandResultSigningPayload(secondBody)).digest('hex') };
    await Promise.all([lease.settleResourceResult(admission.commandId, first), lease.settleResourceResult(admission.commandId, second)]);
    const owned = await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: admission.commandId } });
    const result = await db.commandResult.findUniqueOrThrow({ where: { commandId: admission.commandId } });
    expect(owned.state).toBe('released'); expect([0, 7]).toContain(result.exitCode);
    await lease.settleResourceResult(admission.commandId, result.exitCode === 0 ? second : first);
    await lease.failResourceCommand(admission);
    expect(await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: admission.commandId } })).toEqual(owned);
    expect(await db.commandResult.findUniqueOrThrow({ where: { commandId: admission.commandId } })).toEqual(result);
  });

  it('requires the exact signed reconciliation acknowledged by the node to settle unknown', async () => {
    const key = 'resource-lease-reconciliation-fixture-at-least-32-characters';
    vi.stubEnv('COMMAND_RECONCILIATION_SECRET', key);
    const admission = (await lease.admitResourceCommand(context, request()))!;
    await lease.markResourceDispatched(admission); await lease.failResourceCommand(admission);
    const assertion = { nodeFqdn: `${prefix}.invalid`, commandId: admission.commandId,
      requestSha256: commandRequestDigest(admission.payload), coordination: admission.payload.coordination,
      disposition: 'no_effect_verified' as const, evidenceSha256: 'a'.repeat(64),
      approvalRef: 'operator:fixture-evidence-review', decisionId: randomUUID(), expiresAt: Date.now() + 60_000 };
    const signedAssertion = { ...assertion, signature: createHmac('sha256', key).update(sdk.commandReconciliationSigningPayload(assertion)).digest('hex') };
    const expected = { nodeFqdn: assertion.nodeFqdn, requestSha256: assertion.requestSha256 };
    const fetch = vi.fn(async (req: Request) => req.url.endsWith('/ping') ? json({ features: { commandReconciliation: 1 } })
      : json({ commandId: admission.commandId, requestSha256: assertion.requestSha256, coordination: assertion.coordination,
        state: 'reconciled', reconciliation: signedAssertion })); vi.stubGlobal('fetch', fetch);
    await expect(client().reconcileCommandReceipt({ ...signedAssertion, evidenceSha256: 'b'.repeat(64) }, expected)).rejects.toThrow('signature');
    expect(fetch).not.toHaveBeenCalled();
    await client().reconcileCommandReceipt(signedAssertion, expected);
    expect(fetch).toHaveBeenCalledTimes(2);
    const row = await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: admission.commandId } });
    expect(row.state).toBe('released'); expect(row.settlement).toBe('signed-reconciliation:no_effect_verified');
    expect(row.evidenceSha256).toBe('a'.repeat(64));
    expect((await db.remoteCommand.findUniqueOrThrow({ where: { id: admission.commandId } })).status).toBe('FAILED');
  });

  it('keeps fresh unenrolled nodes in legacy mode while rejecting fabricated canonical identities', async () => {
    await db.resourceEnrollment.delete({ where: { nodeId } });
    vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'false');
    expect(await lease.admitResourceCommand(context, request())).toBeNull();
    expect(await db.commandResourceLease.count({ where: { nodeId } })).toBe(0);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const fabricated = new sdk.NodeApiClient({ baseUrl, nodeToken: 'fixture', resourceNodeId: 'missing-fixture-node' });
    await expect(fabricated.executeCommand(request())).rejects.toThrow('Canonical command target');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cannot disable an enrolled node or redirect its canonical endpoint to bypass ownership', async () => {
    await lease.admitResourceCommand(context, request()); vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'false');
    await expect(lease.admitResourceCommand(context, request())).rejects.toBeInstanceOf(lease.ResourceLeaseConflict);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const unidentified = new sdk.NodeApiClient({ baseUrl, nodeToken: 'fixture-node-token' });
    await expect(unidentified.executeCommand(request())).rejects.toThrow('canonical resource node identity');
    fetch.mockClear();
    await expect(client().executeCommand(request())).rejects.toBeInstanceOf(lease.ResourceLeaseConflict);
    expect(fetch).not.toHaveBeenCalled();
    await expect(lease.admitResourceCommand({ ...context, baseUrl: 'http://other.invalid' }, request())).rejects.toThrow('Canonical command target');
  });
  it('serializes native writes with commands and settles the signed response without storing private bodies', async () => {
    let nativeId = ''; const content = 'private-native-body-not-in-receipts';
    const fetch = vi.fn(async (req: Request) => {
      if (req.url.endsWith('/ping')) return json({ features: { managedMutations: 1 } });
      expect(req.url).toContain('/commands/managed-http');
      const value = await req.json(); nativeId = value.commandId;
      const input = { ...httpIdentity(value.commandId, value.method, value.path, value.body, value.timeoutSeconds), coordination: value.coordination };
      await expect(lease.admitResourceCommand(context, request())).rejects.toBeInstanceOf(lease.ResourceLeaseConflict);
      const response = { status: 200, body: JSON.stringify({ success: true, data: { written: true, checksum: 'fixture' } }) };
      const receipt = { ...signed(input), stdout: httpReceiptBody(value.method, value.path, response.status, response.body) };
      receipt.signature = createHmac('sha256', secret).update(commandResultSigningPayload(receipt)).digest('hex');
      return json({ response, receipt });
    }); vi.stubGlobal('fetch', fetch);
    expect((await client().writeFile({ filePath: '/tmp/fixture', content })).data.written).toBe(true);
    const row = await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: nativeId } });
    expect(row.state).toBe('released');
    const command = await db.remoteCommand.findUniqueOrThrow({ where: { id: nativeId } });
    expect(command.command).toBe('@magnus/native-http/v1'); expect(JSON.stringify(command)).not.toContain(content);
    expect((await lease.admitResourceCommand(context, request()))?.leaseId).toBeTruthy();
  });

  it('returns exact verified signed managed HTTP evidence for scheduler acknowledgements', async () => {
    let signedReceipt: ReturnType<typeof signed> | undefined;
    const spec = { nodeFqdn: `${prefix}.invalid`, name: 'receipt-fixture', revision: 1, schedule: '* * * * *',
      timezone: 'UTC' as const, environment: {}, command: '/usr/bin/true', args: [], timeoutSeconds: 60,
      expiresAt: Date.now() + 60_000 };
    const identity = { nodeFqdn: spec.nodeFqdn, name: spec.name,
      jobId: createHash('sha256').update(JSON.stringify([spec.nodeFqdn, spec.name])).digest('hex'), revision: 1,
      specSha256: createHash('sha256').update(JSON.stringify(spec)).digest('hex'), staged: true as const, enabled: false as const };
    const fetch = vi.fn(async (req: Request) => {
      if (req.url.endsWith('/ping')) return json({ features: { managedMutations: 1 } });
      const value = await req.json();
      const input = { ...httpIdentity(value.commandId, value.method, value.path, value.body, value.timeoutSeconds), coordination: value.coordination };
      const response = { status: 200, body: JSON.stringify({ success: true, data: identity }) };
      signedReceipt = { ...signed(input), stdout: httpReceiptBody(value.method, value.path, response.status, response.body) };
      signedReceipt.signature = createHmac('sha256', secret).update(commandResultSigningPayload(signedReceipt)).digest('hex');
      return json({ response, receipt: signedReceipt });
    }); vi.stubGlobal('fetch', fetch);
    const result = await client().syncManagedCronJob(spec);
    expect(result.response).toMatchObject({ success: true, data: identity });
    expect(result.evidence).toMatchObject({ commandId: signedReceipt!.commandId,
      commandSha256: signedReceipt!.coordination!.requestSha256,
      receiptSha256: createHash('sha256').update(JSON.stringify({
        payload: commandResultSigningPayload(signedReceipt!), signature: signedReceipt!.signature,
      })).digest('hex') });
    expect(result.evidence.acknowledgedAt).toBeInstanceOf(Date);
  });

  it('retains native ownership when a signed response body is changed in transit', async () => {
    const fetch = vi.fn(async (req: Request) => {
      if (req.url.endsWith('/ping')) return json({ features: { managedMutations: 1 } });
      const value = await req.json();
      const input = { ...httpIdentity(value.commandId, value.method, value.path, value.body, value.timeoutSeconds), coordination: value.coordination };
      const receipt = { ...signed(input), stdout: httpReceiptBody(value.method, value.path, 200, '{}') };
      receipt.signature = createHmac('sha256', secret).update(commandResultSigningPayload(receipt)).digest('hex');
      return json({ response: { status: 200, body: '{"tampered":true}' }, receipt });
    }); vi.stubGlobal('fetch', fetch);
    await expect(client().writeFile({ filePath: '/tmp/fixture', content: 'fixture' })).rejects.toThrow('differs from signed receipt');
    expect((await db.commandResourceLease.findFirstOrThrow({ where: { nodeId } })).state).toBe('unknown');
    await expect(lease.admitResourceCommand(context, request())).rejects.toBeInstanceOf(lease.ResourceLeaseConflict);
  });

  it('refuses older agents before dispatch and releases the known unused reservation', async () => {
    const fetch = vi.fn(async () => json({ features: { commandFencing: 1 } })); vi.stubGlobal('fetch', fetch);
    const req = request(); await expect(client().executeCommand(req)).rejects.toThrow('sticky managed mutation');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { commandId: req.commandId } })).settlement).toBe('not-dispatched');
  });

  it('confirms only an authenticated exact running lease without creating an owner', async () => {
    const router = (await import('../routes/resource-leases.js')).resourceLeasesRouter;
    const app = new Hono().onError(errorHandler).route('/resource-leases', router);
    const admission = (await lease.admitResourceCommand(context, request()))!;
    const body = { leaseId: admission.leaseId, nodeId, nodeFqdn: `${prefix}.invalid`, commandId: admission.commandId,
      requestSha256: commandRequestDigest(admission.payload), coordination: admission.payload.coordination };
    const send = (value: unknown, token = 'resource-lease-node-auth-fixture-at-least-32-characters') => app.request('/resource-leases/claim', {
      method: 'POST', headers: { 'x-node-token': token, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    expect((await send(body, '')).status).toBe(401);
    expect((await send(body, 'wrong-key')).status).toBe(401);
    expect((await send(body)).status).toBe(409); // reservation is not dispatched
    await lease.markResourceDispatched(admission);
    expect((await send(body)).status).toBe(200);
    expect((await send({ ...body, nodeFqdn: 'other.invalid' })).status).toBe(409);
    expect((await send({ ...body, requestSha256: 'a'.repeat(64) })).status).toBe(409);
    expect((await send({ ...body, coordination: { ...body.coordination, fence: '999' } })).status).toBe(409);
    vi.spyOn(Date, 'now').mockReturnValue(body.coordination!.expiresAt + 1);
    expect((await send(body)).status).toBe(409); vi.restoreAllMocks();
    expect(await db.commandResourceLease.count({ where: { nodeId } })).toBe(1);
  });

  it('authorizes only exact retained skill-publication evidence recovery without reviving ownership', async () => {
    const router = (await import('../routes/resource-leases.js')).resourceLeasesRouter;
    const app = new Hono().onError(errorHandler).route('/resource-leases', router);
    const identity = httpIdentity(`skill-${randomUUID()}`, 'POST', '/skills/install', '{"fixture":true}', 5);
    const admission = (await lease.admitResourceCommand({ ...context, actorId: 'skill-installation:fixture' }, identity))!;
    await lease.markResourceDispatched(admission);
    await lease.failResourceCommand(admission);
    const body = { leaseId: admission.leaseId, nodeId, nodeFqdn: `${prefix}.invalid`, commandId: admission.commandId,
      requestSha256: commandRequestDigest(admission.payload), coordination: admission.payload.coordination };
    const send = (value: unknown, token = 'resource-lease-node-auth-fixture-at-least-32-characters') =>
      app.request('/resource-leases/recovery-claim', { method: 'POST', headers: {
        'x-node-token': token, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    expect((await send(body, '')).status).toBe(401);
    expect((await send({ ...body, requestSha256: '0'.repeat(64) })).status).toBe(409);
    const accepted = await send(body); expect(accepted.status).toBe(200);
    expect((await accepted.json()).data).toEqual({ admitted: true, ...body });
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { id: admission.leaseId } })).state).toBe('unknown');

    await db.commandResourceLease.delete({ where: { id: admission.leaseId } });
    await db.remoteCommand.delete({ where: { id: admission.commandId } });
    const unrelated = (await lease.admitResourceCommand(context, request()))!;
    await lease.markResourceDispatched(unrelated);
    const unrelatedBody = { leaseId: unrelated.leaseId, nodeId, nodeFqdn: `${prefix}.invalid`, commandId: unrelated.commandId,
      requestSha256: commandRequestDigest(unrelated.payload), coordination: unrelated.payload.coordination };
    expect((await send(unrelatedBody)).status).toBe(409);
  });

  it('denies legacy execution from completed enrollment through failed preflight and flag rollback', async () => {
    const router = (await import('../routes/resource-leases.js')).resourceLeasesRouter;
    const app = new Hono().onError(errorHandler).route('/resource-leases', router);
    const check = (hostname = `${prefix}.invalid`, token = 'resource-lease-node-auth-fixture-at-least-32-characters') => {
      const nonce = randomUUID();
      return app.request('/resource-leases/legacy-admission', { method: 'POST', headers: {
        'x-node-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ nodeFqdn: hostname, nonce }) });
    };
    expect((await check(`${prefix}.invalid`, '')).status).toBe(401);
    expect((await check('unknown.invalid')).status).toBe(409);
    await db.node.create({ data: { id: `${prefix}-duplicate`, name: `${prefix}-duplicate`, hostname: `${prefix}.invalid`,
      ipAddress: '127.0.0.2', port: 39091, os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE' } });
    try { expect((await check()).status).toBe(409); }
    finally { await db.node.delete({ where: { id: `${prefix}-duplicate` } }); }

    const disabledLegacy = await check(); expect(disabledLegacy.headers.get('cache-control')).toBe('no-store');
    expect((await disabledLegacy.json()).data).toMatchObject({ gateEnabled: true, enrolled: true, allowedLegacy: false });
    vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'false');
    expect((await (await check()).json()).data.allowedLegacy).toBe(false);
    vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'true');
    const admission = (await lease.admitResourceCommand(context, request()))!;
    expect((await (await check()).json()).data).toMatchObject({ enrolled: true, allowedLegacy: false });
    await lease.failResourceCommand(admission); // capability/preflight denial before any node POST
    vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'false');
    expect((await (await check()).json()).data).toMatchObject({ gateEnabled: false, enrolled: true, allowedLegacy: false });
    expect((await db.commandResourceLease.findUniqueOrThrow({ where: { id: admission.leaseId } })).settlement).toBe('not-dispatched');
  });

});
