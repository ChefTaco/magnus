import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApprovalPayload } from '../security/approval-assertion.js';
import { approvalSignerPublicKeyB64, signApprovalAssertion } from '../security/approval-assertion-test-fixture.js';
import { commandResultSigningPayload } from '../security/command-result-signature.js';

const fixture = vi.hoisted(() => ({
  processor: undefined as undefined | ((job: { data: { commandId: string } }) => Promise<void>),
  enqueue: vi.fn(), execute: vi.fn(),
}));
// Exercise the production worker callback and PostgreSQL transitions; only the
// Redis transport and node network boundary are replaced. No Redis is required.
vi.mock('bullmq', () => ({
  Queue: class { add = fixture.enqueue; async getJob() { return undefined; } async close() {} },
  Worker: class {
    constructor(_name: string, processor: typeof fixture.processor) { fixture.processor = processor; }
    on() { return this; }
    async close() {}
  },
}));
vi.mock('../sdk/index.js', () => ({ NodeApiClient: class { executeCommand = fixture.execute; } }));
vi.mock('./command-lifecycle.js', () => ({ reconcileCommands: vi.fn() }));
vi.mock('./notification-service.js', () => ({ createNotification: vi.fn() }));
vi.mock('./security-export.js', () => ({ securityFusionRemote: () => true, securityFusionLocal: () => false }));
vi.mock('../utils/env.js', async original => ({ ...await original<object>(),
  getNodeManagerSecret: () => 'dispatch-fixture-node-auth-key-at-least-32-characters' }));

const prefix = `td-${randomUUID()}`;
const resultSecret = 'dispatch-fixture-node-result-key-at-least-32-characters';
const actor = 'b'.repeat(64);

describe.skipIf(!process.env['TEST_DATABASE_URL'])('Telegram approval through durable rollout and command dispatch', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let approvals: typeof import('./team-approvals.js');
  let remediation: typeof import('./remediation-service.js');
  let rollout: typeof import('./rollout-service.js');
  let queue: typeof import('../queue/workers.js');
  let temporary: string;
  let configFile: string;

  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable magnus_ideas database required');
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('APPROVAL_SIGNER_PUBLIC_KEY_B64', approvalSignerPublicKeyB64);
    vi.stubEnv('APPROVAL_TELEGRAM_ACTOR_SHA256', actor);
    vi.stubEnv('RESULT_SIGNING_SECRET', resultSecret);
    vi.stubEnv('NODE_MANAGER_SECRET', 'dispatch-fixture-node-auth-key-at-least-32-characters');
    temporary = await mkdtemp(join(tmpdir(), 'team-approval-dispatch-'));
    configFile = join(temporary, 'applications.json');
    await writeFile(configFile, JSON.stringify({ schemaVersion: 1, applications: [] }), { mode: 0o600 });
    vi.stubEnv('MAGNUS_APPLICATION_PROBES_FILE', configFile);
    db = (await import('../db/index.js')).getDb();
    approvals = await import('./team-approvals.js');
    remediation = await import('./remediation-service.js');
    rollout = await import('./rollout-service.js');
    queue = await import('../queue/workers.js');
    await db.node.create({ data: { id: prefix, name: prefix, hostname: `${prefix}.invalid`,
      ipAddress: '127.0.0.1', os: 'fixture', arch: 'fixture', token: randomUUID(),
      status: 'ONLINE', lastHeartbeatAt: new Date() } });
    await db.remediationRule.create({ data: { id: prefix, name: prefix, agentDefinitionId: 'diagnostics.v1' } });
    queue.startCommandWorker();
  });

  afterEach(async () => {
    vi.restoreAllMocks(); fixture.execute.mockReset(); fixture.enqueue.mockClear();
    vi.stubEnv('APPROVAL_SIGNER_PUBLIC_KEY_B64', approvalSignerPublicKeyB64);
    if (!db) return;
    await db.teamApprovalDecision.deleteMany({ where: { proposalId: { startsWith: `remediation:${prefix}-` } } });
    await db.executionRun.deleteMany({ where: { id: { startsWith: `remediation_${prefix}-` } } });
    await db.remoteCommand.deleteMany({ where: { nodeId: prefix } });
    await db.remediationExecution.deleteMany({ where: { ruleId: prefix } });
    await db.applicationObservation.deleteMany({ where: { nodeId: prefix } });
    await db.node.update({ where: { id: prefix }, data: { lastHeartbeatAt: new Date() } });
    await writeFile(configFile, JSON.stringify({ schemaVersion: 1, applications: [] }));
  });

  afterAll(async () => {
    await queue?.closeCommandQueue();
    if (db) {
      await db.commandResourceFence.deleteMany({ where: { resourceKey: `node:${prefix}` } });
      await db.remediationRule.deleteMany({ where: { id: prefix } });
      await db.node.deleteMany({ where: { id: prefix } });
      await (await import('../db/index.js')).disconnectDb();
    }
    if (temporary) await rm(temporary, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function propose(restart = false) {
    const id = `${prefix}-${randomUUID()}`;
    const applicationId = `${prefix}.app`;
    if (restart) {
      await writeFile(configFile, JSON.stringify({ schemaVersion: 1, applications: [{
        id: applicationId, projectId: 'fixture', serviceId: 'fixture', nodeId: prefix,
        baseUrl: 'https://fixture.invalid/', healthPath: '/health', restartService: 'fixture-app.service',
      }] }));
      await db.applicationObservation.create({ data: { id: applicationId, projectId: 'fixture', serviceId: 'fixture', nodeId: prefix, status: 'pass', observedAt: new Date() } });
    }
    const input = JSON.stringify({ runbookVersion: restart ? 'restart-service.v1' : 'diagnostics.v1', nodeId: prefix,
      ...(restart ? { applicationId } : {}), command: restart ? '/usr/bin/systemctl' : '/usr/bin/uptime',
      args: restart ? ['restart', 'fixture-app.service'] : [], timeoutSeconds: 60,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    await db.remediationExecution.create({ data: { id, ruleId: prefix, nodeId: prefix,
      anomalyEventId: 'fixture-anomaly', status: 'pending_approval', input } });
    const view = await approvals.getTeamApprovalPlan(`remediation:${id}`);
    const payload: ApprovalPayload = { version: 2, proposal_id: view.plan_id, proposal_revision: view.revision,
      plan_sha256: view.plan_sha256, decision: 'approve', decision_id: randomUUID(), decided_at: Date.now(),
      expires_at: view.expires_at, actor_binding_sha256: actor, execution_id: randomUUID() };
    const assertion = signApprovalAssertion(payload);
    return { id, input, view, assertion, rolloutId: `remediation_${id}` };
  }

  async function approved(restart = false) {
    const proposal = await propose(restart);
    await approvals.recordTeamApproval(proposal.assertion);
    return proposal;
  }

  function admission(proposal: Awaited<ReturnType<typeof propose>>) {
    const plan = JSON.parse(proposal.input);
    return { type: 'command' as const, strategy: 'one_at_a_time' as const, nodeIds: [prefix],
      rolloutId: proposal.rolloutId, createdBy: `telegram:${actor}`,
      metadata: { command: plan.command, args: plan.args, timeoutSeconds: plan.timeoutSeconds,
        executionDeadline: proposal.view.expires_at, ...(plan.applicationId ? { applicationId: plan.applicationId } : {}) } };
  }

  async function queued(restart = false) {
    const proposal = await approved(restart);
    await remediation.reconcileRemediation();
    await rollout.executeRollout(proposal.rolloutId);
    const command = await db.remoteCommand.findFirstOrThrow({ where: { correlationId: proposal.rolloutId } });
    expect(command.status).toBe('QUEUED');
    expect(fixture.enqueue).toHaveBeenCalled();
    return { proposal, command };
  }

  it('never restores legacy approval when the Telegram bridge configuration is absent', async () => {
    const proposal = await propose();
    vi.stubEnv('APPROVAL_SIGNER_PUBLIC_KEY_B64', '');
    await expect(remediation.approveRemediation(proposal.id, 'system')).rejects.toMatchObject({ code: 'TELEGRAM_APPROVAL_REQUIRED' });
    expect((await db.remediationExecution.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('pending_approval');
    expect(await db.executionRun.count({ where: { id: proposal.rolloutId } })).toBe(0);
  });

  it.each(['actor', 'metadata'] as const)('does not adopt a deterministic rollout collision with changed %s', async change => {
    const proposal = await approved();
    const opts = admission(proposal);
    if (change === 'actor') opts.createdBy = 'other-operator';
    else opts.metadata.command = '/usr/bin/false';
    const unrelated = await rollout.createRollout(opts);
    await remediation.reconcileRemediation();
    expect((await db.remediationExecution.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('failed');
    const preserved = await db.executionRun.findUniqueOrThrow({ where: { id: proposal.rolloutId } });
    expect(preserved.metadata).toBe(unrelated.metadata);
    expect(preserved.createdBy).toBe(opts.createdBy);
    expect(await db.remoteCommand.count({ where: { correlationId: proposal.rolloutId } })).toBe(0);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('adopts an exact committed rollout after expiry without renewing permission or altering the plan', async () => {
    const proposal = await approved();
    const committed = await rollout.createRollout(admission(proposal));
    // Crash point: rollout committed, remediation row still approving.
    vi.spyOn(Date, 'now').mockReturnValue(proposal.view.expires_at + 1_000);
    await remediation.reconcileRemediation();
    const restored = await db.remediationExecution.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(restored.status).toBe('running');
    expect(restored.input).toBe(proposal.input);
    const run = await db.executionRun.findUniqueOrThrow({ where: { id: proposal.rolloutId } });
    expect(run.metadata).toBe(committed.metadata);
    expect(JSON.parse(run.metadata).executionDeadline).toBe(proposal.view.expires_at);
    expect(await db.teamApprovalDecision.count({ where: { proposalId: proposal.view.plan_id } })).toBe(1);
    await db.node.update({ where: { id: prefix }, data: { lastHeartbeatAt: new Date(Date.now()) } });
    await rollout.executeRollout(proposal.rolloutId);
    expect(await db.remoteCommand.count({ where: { correlationId: proposal.rolloutId } })).toBe(0);
    const target = await db.rolloutTarget.findFirstOrThrow({ where: { rolloutId: proposal.rolloutId } });
    expect(target.error).toContain('deadline expired');
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it.each(['missing-fence', 'later-fence', 'other-node', 'missing-deadline'] as const)('rejects queued approval with %s before node execution', async change => {
    const { command } = await queued();
    const coordination = JSON.parse(command.coordinationJson!);
    const patch = change === 'missing-fence' ? { coordinationJson: null }
      : change === 'later-fence' ? { coordinationJson: JSON.stringify({ ...coordination, expiresAt: coordination.expiresAt + 60_000 }) }
      : change === 'other-node' ? { coordinationJson: JSON.stringify({ ...coordination, resourceKey: 'node:other' }) }
      : { executionDeadline: null };
    await db.remoteCommand.update({ where: { id: command.id }, data: patch });
    await expect(fixture.processor!({ data: { commandId: command.id } })).rejects.toThrow(
      change === 'missing-deadline' ? /current Telegram permission/ : /deadline\/fence binding/);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect((await db.remoteCommand.findUniqueOrThrow({ where: { id: command.id } })).status).toBe('FAILED');
  });

  it('checks current restart allowlist after queue admission and before calling the node', async () => {
    const { command } = await queued(true);
    await expect(remediation.validateRemediationCommandForDispatch(command)).resolves.toBeUndefined();
    await writeFile(configFile, JSON.stringify({ schemaVersion: 1, applications: [] }));
    await expect(fixture.processor!({ data: { commandId: command.id } })).rejects.toThrow(/allowlisted restart service/);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect((await db.remoteCommand.findUniqueOrThrow({ where: { id: command.id } })).status).toBe('FAILED');
  });

  it('dispatches the exact still-approved command once and persists its signed result', async () => {
    const { command } = await queued();
    fixture.execute.mockImplementation(async (payload: { commandId: string }) => {
      const value = { commandId: payload.commandId, exitCode: 0, stdout: 'fixture success', stderr: '', durationMs: 1, truncated: false };
      return { success: true, data: { ...value, signature: createHmac('sha256', resultSecret).update(commandResultSigningPayload(value)).digest('hex') } };
    });
    await fixture.processor!({ data: { commandId: command.id } });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.execute).toHaveBeenCalledWith(expect.objectContaining({ commandId: command.id, command: '/usr/bin/uptime', args: [],
      coordination: expect.objectContaining({ resourceKey: `node:${prefix}`, expiresAt: command.executionDeadline!.getTime() }) }));
    expect((await db.remoteCommand.findUniqueOrThrow({ where: { id: command.id } })).status).toBe('COMPLETED');
    await fixture.processor!({ data: { commandId: command.id } });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });
});
