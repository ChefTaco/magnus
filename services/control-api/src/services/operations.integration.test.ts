import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalPayload } from '../security/approval-assertion.js';
import { approvalSignerPublicKeyB64, signApprovalAssertion } from '../security/approval-assertion-test-fixture.js';
vi.mock('../queue/workers.js', () => ({ enqueueCommand: vi.fn() }));
const enabled = Boolean(process.env['TEST_DATABASE_URL']);
describe.skipIf(!enabled)('operations on disposable PostgreSQL', () => {
  let db: ReturnType<(typeof import('../db/index.js'))['getDb']>;
  let rollout: typeof import('./rollout-service.js');
  const prefix = `ideas-${randomUUID()}`;
  const approvalActor = createHash('sha256').update(prefix).digest('hex');
  const nodes = [0, 1].map((i) => `${prefix}-${i}`);
  const extraNodes = [2, 3, 4].map((i) => `${prefix}-${i}`);
  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas'))
      throw new Error('Use a disposable magnus_ideas database');
    vi.stubEnv('DATABASE_URL', url);
    vi.stubEnv('APPROVAL_SIGNER_PUBLIC_KEY_B64', approvalSignerPublicKeyB64);
    vi.stubEnv('APPROVAL_TELEGRAM_ACTOR_SHA256', approvalActor);
    db = (await import('../db/index.js')).getDb();
    rollout = await import('./rollout-service.js');
    for (const id of [...nodes, ...extraNodes])
      await db.node.create({
        data: {
          id,
          name: id,
          hostname: `${id}.invalid`,
          ipAddress: '127.0.0.1',
          os: 'test',
          arch: 'test',
          token: randomUUID(),
          status: 'ONLINE',
          lastHeartbeatAt: new Date(),
        },
      });
  });
  afterAll(async () => {
    if (!db) { vi.unstubAllEnvs(); return; }
    const remediationExecutions = await db.remediationExecution.findMany({
      where: { rule: { createdBy: prefix } }, select: { id: true },
    });
    await db.teamApprovalDecision.deleteMany({ where: {
      proposalId: { in: remediationExecutions.map(({ id }) => `remediation:${id}`) },
    } });
    await db.securityFusionCaseActivity.deleteMany({ where: { caseId: prefix } });
    await db.securityFusionCommandOutbox.deleteMany({ where: { actorId: prefix } });
    await db.securityFusionAction.deleteMany({ where: { requestedBy: prefix } });
    await db.webhookEndpoint.deleteMany({ where: { createdBy: prefix } });
    await db.notification.deleteMany({ where: { sourceRef: { startsWith: prefix } } });
    await db.applicationObservation.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.incidentLesson.deleteMany({ where: { reviewedBy: prefix } });
    await db.remediationRule.deleteMany({ where: { createdBy: prefix } });
    await db.executionRun.deleteMany({ where: { OR: [
      { createdBy: prefix }, { id: { in: remediationExecutions.map(({ id }) => `remediation_${id}`) } },
    ] } });
    await db.commandResourceFence.deleteMany({ where: {
      resourceKey: { in: [...nodes, ...extraNodes].map(id => `node:${id}`) },
    } });
    await db.node.deleteMany({ where: { id: { in: [...nodes, ...extraNodes] } } });
    await db.maintenanceWindow.deleteMany({ where: { actorId: prefix } });
    await db.$disconnect();
    vi.unstubAllEnvs();
  });
  it('persists claims, rejects changed retries, pauses waves, and requires fresh recovery evidence', async () => {
    const input = {
      type: 'command' as const,
      strategy: 'one_at_a_time' as const,
      nodeIds: nodes,
      metadata: { command: '/usr/bin/uptime' },
      createdBy: prefix,
      rolloutId: `test-${randomUUID()}`,
    };
    const [first, duplicate] = await Promise.all([
      rollout.createRollout(input),
      rollout.createRollout(input),
    ]);
    expect(first.id).toBe(duplicate.id);
    await expect(
      rollout.createRollout({ ...input, metadata: { command: 'different' } }),
    ).rejects.toThrow('different request');
    await Promise.all([rollout.executeRollout(first.id), rollout.executeRollout(first.id)]);
    let commands = await db.remoteCommand.findMany({ where: { correlationId: first.id } });
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    await db.commandResult.create({
      data: { commandId: command.id, exitCode: 0, stdout: '', stderr: '', durationMs: 1 },
    });
    await db.remoteCommand.update({
      where: { id: command.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await rollout.executeRollout(first.id);
    expect(
      (await rollout.getRolloutStatus(first.id)).targets.find((t) => t.commandId === command.id)
        ?.status,
    ).toBe('verifying');
    await rollout.setRolloutControl(first.id, 'pause');
    await db.node.update({
      where: { id: command.nodeId },
      data: { lastHeartbeatAt: new Date(Date.now() + 100) },
    });
    await rollout.executeRollout(first.id);
    commands = await db.remoteCommand.findMany({ where: { correlationId: first.id } });
    expect(commands).toHaveLength(1);
    expect((await rollout.getRolloutStatus(first.id)).completedNodes).toBe(1);
    await rollout.setRolloutControl(first.id, 'resume');
    await rollout.executeRollout(first.id);
    expect(await db.remoteCommand.count({ where: { correlationId: first.id } })).toBe(2);
    await rollout.setRolloutControl(first.id, 'abort');
    await rollout.executeRollout(first.id);
    expect((await rollout.getRolloutStatus(first.id)).status).toBe('cancelled');
    expect(
      await db.remoteCommand.count({ where: { correlationId: first.id, status: 'QUEUED' } }),
    ).toBe(0);
  });
  it('fails interrupted commands without dispatching the rest of the fleet', async () => {
    const run = await rollout.createRollout({
      type: 'command',
      strategy: 'one_at_a_time',
      nodeIds: nodes,
      metadata: { command: '/usr/bin/uptime', timeoutSeconds: 1 },
      createdBy: prefix,
    });
    await rollout.executeRollout(run.id);
    const target = (await rollout.getRolloutStatus(run.id)).targets.find((t) => t.commandId)!;
    await db.rolloutTarget.update({
      where: { id: target.id },
      data: { startedAt: new Date(Date.now() - 300000) },
    });
    await db.remoteCommand.update({
      where: { id: target.commandId! },
      data: { status: 'RUNNING' },
    });
    await rollout.executeRollout(run.id);
    const result = await rollout.getRolloutStatus(run.id);
    expect(result.status).toBe('failed');
    expect(result.targets.map((t) => t.status).sort()).toEqual(['cancelled', 'failed']);
    expect(await db.remoteCommand.count({ where: { correlationId: run.id } })).toBe(1);
  });
  it('matches only scoped active maintenance and expires without an in-memory timer', async () => {
    const { matchingMaintenance } = await import('./maintenance-service.js');
    const window = await db.maintenanceWindow.create({
      data: {
        actorId: prefix,
        reason: 'test maintenance',
        nodeIds: JSON.stringify([nodes[0]]),
        serviceIds: '["factory"]',
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 60000),
      },
    });
    expect((await matchingMaintenance(nodes[0], 'factory'))?.id).toBe(window.id);
    expect(await matchingMaintenance(nodes[0], 'unrelated')).toBeNull();
    expect(await matchingMaintenance(nodes[1], 'factory')).toBeNull();
    await db.maintenanceWindow.update({
      where: { id: window.id },
      data: { endsAt: new Date(Date.now() - 1) },
    });
    expect(await matchingMaintenance(nodes[0], 'factory')).toBeNull();
  });
  it('recovers an approved runbook admission and retrieves only current reviewed lessons', async () => {
    const service = await import('./remediation-service.js');
    const lessons = await import('./incident-lessons.js');
    const anomaly = await db.anomalyEvent.create({
      data: { nodeId: nodes[0]!, metric: 'memory', value: 95, zScore: 3, mean: 50, stdDev: 15 },
    });
    const rule = await service.createRule({
      name: prefix,
      agentDefinitionId: 'diagnostics.v1',
      createdBy: prefix,
    });
    const proposal = await service.triggerManualRemediation({
      anomalyEventId: anomaly.id,
      ruleId: rule.id,
      triggeredBy: prefix,
    });
    expect(proposal.status).toBe('pending_approval');
    const approvals = await import('./team-approvals.js');
    const approvalPlan = await approvals.getTeamApprovalPlan(`remediation:${proposal.executionId}`);
    const permission: ApprovalPayload = {
      version: 2, proposal_id: approvalPlan.plan_id, proposal_revision: approvalPlan.revision,
      plan_sha256: approvalPlan.plan_sha256, decision: 'approve', decision_id: randomUUID(),
      decided_at: Date.now(), expires_at: approvalPlan.expires_at,
      actor_binding_sha256: approvalActor, execution_id: randomUUID(),
    };
    const assertion = signApprovalAssertion(permission);
    expect(await approvals.recordTeamApproval(assertion))
      .toMatchObject({ accepted: true, replay: false, decision_id: permission.decision_id });
    await service.reconcileRemediation();
    const runId = `remediation_${proposal.executionId}`;
    expect((await rollout.getRolloutStatus(runId)).createdBy).toBe(`telegram:${approvalActor}`);
    // Simulate process loss after admission but before recording the rollout ID.
    // Preserve the exact signed plan, including its original expiration.
    const admitted = await db.remediationExecution.findUniqueOrThrow({ where: { id: proposal.executionId } });
    const approvalOutput = JSON.parse(admitted.output!);
    delete approvalOutput.rolloutId;
    await db.remediationExecution.update({
      where: { id: proposal.executionId },
      data: {
        status: 'approving',
        output: JSON.stringify(approvalOutput),
      },
    });
    await service.reconcileRemediation();
    expect((await db.remediationExecution.findUniqueOrThrow({ where: { id: proposal.executionId } })).input)
      .toBe(admitted.input);
    expect(await db.teamApprovalDecision.count({ where: { proposalId: approvalPlan.plan_id } })).toBe(1);
    await rollout.executeRollout(runId);
    expect(await db.executionRun.count({ where: { id: runId } })).toBe(1);
    const target = (await rollout.getRolloutStatus(runId)).targets[0]!;
    await db.commandResult.create({
      data: {
        commandId: target.commandId!,
        exitCode: 0,
        stdout: 'private output excluded',
        stderr: '',
        durationMs: 1,
      },
    });
    await db.remoteCommand.update({
      where: { id: target.commandId! },
      data: { status: 'COMPLETED', completedAt: new Date(Date.now() - 1000) },
    });
    await db.node.update({ where: { id: nodes[0] }, data: { lastHeartbeatAt: new Date() } });
    await rollout.executeRollout(runId);
    await service.reconcileRemediation();
    expect(
      (await db.remediationExecution.findUniqueOrThrow({ where: { id: proposal.executionId } }))
        .status,
    ).toBe('completed');
    const lesson = await lessons.publishLesson(
      {
        incidentId: anomaly.id,
        symptom: 'Synthetic worker pressure',
        cause: 'Confirmed synthetic resource pressure',
        runbookVersion: 'diagnostics.v1',
        evidenceIds: [proposal.executionId],
        reviewed: true,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      prefix,
    );
    expect((await lessons.lessonSuggestions('worker pressure')).lessons.map((l) => l.id)).toContain(
      lesson.id,
    );
    await lessons.supersedeLesson(lesson.id);
    expect(
      (await lessons.lessonSuggestions('worker pressure')).lessons.map((l) => l.id),
    ).not.toContain(lesson.id);
    const packet = await (
      await import('./incident-evidence.js')
    ).exportIncidentEvidence(anomaly.id);
    expect(packet.json).not.toContain('private output excluded');
  });
  it('claims a Mattermost delivery once across duplicate or restarted workers', async () => {
    const endpoint=await db.webhookEndpoint.create({data:{name:prefix,url:'https://unused.invalid/hooks/test',type:'mattermost',headers:'{}',createdBy:prefix}});
    const delivery=await db.webhookDelivery.create({data:{endpointId:endpoint.id,event:'test',payload:'{}'}});
    const { claimMattermostAttempt }=await import('./webhook-service.js');
    const claims=await Promise.all([claimMattermostAttempt(delivery.id),claimMattermostAttempt(delivery.id)]);
    expect(claims.sort()).toEqual([false,true]);expect(await claimMattermostAttempt(delivery.id)).toBe(false);
  });

  it('atomically arbitrates cancellation against worker claims and recovers overdue commands without replay', async () => {
    const { cancelQueuedCommand, reconcileCommands } = await import('./command-lifecycle.js');
    const { enqueueCommand } = await import('../queue/workers.js');
    const make = (extra = {}) => db.remoteCommand.create({ data: { nodeId: nodes[0]!, command: '/usr/bin/uptime',
      idempotencyKey: randomUUID(), createdBy: prefix, status: 'QUEUED', timeoutSeconds: 1, ...extra } });
    for (let i = 0; i < 6; i++) {
      const cmd = await make();
      const [cancel, claim] = await Promise.allSettled([
        cancelQueuedCommand(cmd.id),
        db.remoteCommand.updateMany({ where: { id: cmd.id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } }),
      ]);
      expect(claim.status).toBe('fulfilled');
      if (claim.status === 'fulfilled') expect(cancel.status === 'fulfilled' ? claim.value.count === 0 : claim.value.count === 1).toBe(true);
    }
    const old = await make({ status: 'RUNNING', startedAt: new Date(Date.now() - 32_000) });
    const long = await make({ status: 'RUNNING', timeoutSeconds: 3600, startedAt: new Date(Date.now() - 600_000) });
    const queued = await make();
    vi.mocked(enqueueCommand).mockClear();
    await reconcileCommands();
    expect(await db.remoteCommand.findUnique({ where: { id: old.id } })).toMatchObject({ status: 'FAILED' });
    expect(await db.commandResult.findUnique({ where: { commandId: old.id } })).toMatchObject({ stderr: expect.stringContaining('outcome unknown') });
    expect(await db.remoteCommand.findUnique({ where: { id: long.id } })).toMatchObject({ status: 'RUNNING' });
    expect(enqueueCommand).toHaveBeenCalledWith(queued.id);
    expect(enqueueCommand).not.toHaveBeenCalledWith(old.id);
    expect(enqueueCommand).not.toHaveBeenCalledWith(long.id);
  });

  it('persists notification and delivery atomically with concurrent deduplication while Redis is absent', async () => {
    const ep = await db.webhookEndpoint.create({ data: { name: prefix, url: 'https://unused.invalid', type: 'mattermost', headers: '{}', events: '["application.failed"]', createdBy: prefix } });
    const { createNotification } = await import('./notification-service.js');
    const input = { type: 'application.failed' as const, severity: 'warning' as const, title: 'Synthetic test', message: 'Synthetic failure', nodeId: nodes[0], sourceRef: prefix };
    const ids = await Promise.all([createNotification(input), createNotification(input)]);
    expect(ids.filter(Boolean)).toHaveLength(1);
    const deliveries = await db.webhookDelivery.findMany({ where: { endpointId: ep.id } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(JSON.parse(deliveries[0]!.payload).notificationId).toBe(ids.find(Boolean));
    // A malformed endpoint aborts the same transaction: there is no saved but unsendable notification.
    await db.webhookEndpoint.update({ where: { id: ep.id }, data: { events: 'invalid json' } });
    await expect(createNotification({ ...input, sourceRef: prefix + '-rollback' })).rejects.toThrow();
    expect(await db.notification.count({ where: { sourceRef: prefix + '-rollback' } })).toBe(0);
    await db.webhookEndpoint.delete({ where: { id: ep.id } });
  });

  it('rolls back a probe transition fault and emits the original failure once after restart', async () => {
    const { applicationConfigSchema } = await import('./operations-config.js');
    const { persistApplicationProbeResult } = await import('./application-probes.js');
    const config = applicationConfigSchema.parse({ id: `${prefix}-app`, projectId: 'test/app', serviceId: 'app',
      nodeId: nodes[0], baseUrl: 'https://app.invalid', healthPath: '/health', kind: 'http' });
    const result = (status: 'pass' | 'fail') => ({ status, observedAt: new Date().toISOString(),
      checks: [{ name: 'health', status, detail: status }], releaseRevision: null });
    const ep = await db.webhookEndpoint.create({ data: { name: `${prefix}-probe`, url: 'https://unused.invalid',
      type: 'mattermost', headers: '{}', events: '["application.failed","application.recovered"]', createdBy: prefix } });
    await persistApplicationProbeResult(config, result('pass'));
    await expect(persistApplicationProbeResult(config, result('fail'), async () => { throw Error('injected crash'); }))
      .rejects.toThrow('injected crash');
    expect(await db.applicationObservation.findUnique({ where: { id: config.id } })).toMatchObject({ status: 'pass' });
    expect(await db.notification.count({ where: { sourceRef: config.id, type: 'application.failed' } })).toBe(0);
    await persistApplicationProbeResult(config, result('fail'));
    await persistApplicationProbeResult(config, result('fail'));
    expect(await db.notification.count({ where: { sourceRef: config.id, type: 'application.failed' } })).toBe(1);
    expect(await db.webhookDelivery.count({ where: { endpointId: ep.id } })).toBe(1);
    await expect(persistApplicationProbeResult(config, result('pass'), async () => { throw Error('recovery crash'); }))
      .rejects.toThrow('recovery crash');
    expect(await db.applicationObservation.findUnique({ where: { id: config.id } })).toMatchObject({ status: 'fail' });
    await persistApplicationProbeResult(config, result('pass'));
    await persistApplicationProbeResult(config, result('pass'));
    expect(await db.notification.count({ where: { sourceRef: config.id, type: 'application.recovered' } })).toBe(1);
    expect(await db.webhookDelivery.count({ where: { endpointId: ep.id } })).toBe(2);
    await db.webhookEndpoint.delete({ where: { id: ep.id } });
  });

  it('resumes Security Fusion verification using fresh specific-service evidence and expires unhealthy outcomes', async () => {
    const { reconcileRestartVerification } = await import('./security-fusion-verification.js');
    const make = async () => {
      const cmd = await db.remoteCommand.create({ data: { nodeId: nodes[0]!, command: '/usr/bin/uptime', idempotencyKey: randomUUID(), createdBy: prefix,
        status: 'COMPLETED', completedAt: new Date(Date.now() - 1000), result: { create: { exitCode: 0, stdout: '', stderr: '', durationMs: 1 } } } });
      const action = await db.securityFusionAction.create({ data: { caseId: prefix, nodeId: nodes[0]!, kind: 'service_restart', serviceName: 'review.service',
        rationale: 'Synthetic verification test', rollbackPlan: 'none', previewJson: '{}', previewSha256: 'test', status: 'verifying', requestedBy: prefix } });
      await db.securityFusionCommandOutbox.create({ data: { actionId: action.id, operation: 'execute', actorId: prefix, status: 'dispatched', remoteCommandId: cmd.id } });
      return { cmd, action };
    };
    const first = await make();
    await reconcileRestartVerification();
    expect(await db.securityFusionAction.findUnique({ where: { id: first.action.id } })).toMatchObject({ status: 'verifying' });
    await db.healthSnapshot.create({ data: { cpuUsagePercent: 0, cpuCores: 1, cpuLoadAverage: '[]', memoryTotalBytes: 1n, memoryUsedBytes: 0n, memoryPercent: 0, swapTotalBytes: 0n, swapUsedBytes: 0n, disks: '[]', network: '[]', nodeId: nodes[0]!, timestamp: new Date(), services: '[{"name":"review","status":"active"}]' } });
    await reconcileRestartVerification();
    expect(await db.securityFusionAction.findUnique({ where: { id: first.action.id } })).toMatchObject({ status: 'succeeded' });
    const second = await make();
    await db.healthSnapshot.create({ data: { cpuUsagePercent: 0, cpuCores: 1, cpuLoadAverage: '[]', memoryTotalBytes: 1n, memoryUsedBytes: 0n, memoryPercent: 0, swapTotalBytes: 0n, swapUsedBytes: 0n, disks: '[]', network: '[]', nodeId: nodes[0]!, timestamp: new Date(Date.now() + 10), services: '[{"name":"review","status":"failed"}]' } });
    await reconcileRestartVerification(new Date(Date.now() + 20));
    expect(await db.securityFusionAction.findUnique({ where: { id: second.action.id } })).toMatchObject({ status: 'verifying' });
    await reconcileRestartVerification(new Date(Date.now() + 181_000));
    expect(await db.securityFusionAction.findUnique({ where: { id: second.action.id } })).toMatchObject({ status: 'failed' });
  });

  it('advances through a wave larger than its budget without replaying completed targets', async () => {
    const run = await rollout.createRollout({ type: 'command', strategy: 'all_at_once', maxUnavailable: 1,
      nodeIds: nodes, metadata: { command: '/usr/bin/uptime' }, createdBy: prefix });
    await rollout.executeRollout(run.id);
    for (let completed = 0; completed < nodes.length; completed++) {
      const state = await rollout.getRolloutStatus(run.id);
      const active = state.targets.filter(t => ['queued', 'verifying'].includes(t.status));
      expect(active).toHaveLength(1);
      expect(await db.remoteCommand.count({ where: { correlationId: run.id } })).toBe(completed + 1);
      const target = active[0]!;
      await db.remoteCommand.update({ where: { id: target.commandId! }, data: { status: 'COMPLETED',
        completedAt: new Date(Date.now() - 1000), result: { create: { exitCode: 0, stdout: '', stderr: '', durationMs: 1 } } } });
      await db.node.update({ where: { id: target.nodeId }, data: { lastHeartbeatAt: new Date() } });
      await rollout.executeRollout(run.id);
    }
    expect((await rollout.getRolloutStatus(run.id)).status).toBe('completed');
    expect(await db.remoteCommand.count({ where: { correlationId: run.id } })).toBe(nodes.length);
  });

  it('limits admitted disruption and refuses a later wave after target health is lost', async () => {
    const run = await rollout.createRollout({ type: 'command', strategy: 'all_at_once', maxUnavailable: 1,
      nodeIds: nodes, metadata: { command: '/usr/bin/uptime' }, createdBy: prefix });
    await rollout.executeRollout(run.id);
    expect(await db.remoteCommand.count({ where: { correlationId: run.id } })).toBe(1);
    const target = (await rollout.getRolloutStatus(run.id)).targets.find(t => t.commandId)!;
    await db.remoteCommand.update({ where: { id: target.commandId! }, data: { status: 'COMPLETED', completedAt: new Date(Date.now() - 1000), result: { create: { exitCode: 0, stdout: '', stderr: '', durationMs: 1 } } } });
    await db.node.update({ where: { id: target.nodeId }, data: { lastHeartbeatAt: new Date() } });
    const other = nodes.find(id => id !== target.nodeId)!;
    await db.node.update({ where: { id: other }, data: { lastHeartbeatAt: new Date(Date.now() - 130_000) } });
    await rollout.executeRollout(run.id);
    await rollout.executeRollout(run.id);
    expect((await rollout.getRolloutStatus(run.id)).status).toBe('failed');
    expect(await db.remoteCommand.count({ where: { correlationId: run.id } })).toBe(1);
    await db.node.update({ where: { id: other }, data: { lastHeartbeatAt: new Date() } });
  });

  for (const budget of [2, 3]) it(`holds a ${budget}-target disruption budget when one admitted target fails`, async () => {
    const selected = [...nodes, ...extraNodes].slice(0, budget + 2);
    const run = await rollout.createRollout({ type: 'command', strategy: 'all_at_once', maxUnavailable: budget,
      nodeIds: selected, metadata: { command: '/usr/bin/uptime' }, createdBy: prefix });
    await Promise.all([rollout.executeRollout(run.id), rollout.executeRollout(run.id)]);
    const admitted = (await rollout.getRolloutStatus(run.id)).targets.filter(t => t.commandId);
    expect(admitted).toHaveLength(budget);
    expect(await db.remoteCommand.count({ where: { correlationId: run.id } })).toBe(budget);
    for (const [index, target] of admitted.entries()) {
      await db.remoteCommand.update({ where: { id: target.commandId! }, data: { status: index === 0 ? 'FAILED' : 'COMPLETED',
        completedAt: new Date(Date.now() - 1000), result: { create: { exitCode: index === 0 ? 1 : 0, stdout: '', stderr: '', durationMs: 1 } } } });
      await db.node.update({ where: { id: target.nodeId }, data: { lastHeartbeatAt: new Date() } });
    }
    await Promise.all([rollout.executeRollout(run.id), rollout.executeRollout(run.id)]);
    expect(await db.remoteCommand.count({ where: { correlationId: run.id } })).toBe(budget);
    expect((await rollout.getRolloutStatus(run.id)).targets.filter(t => t.status === 'completed')).toHaveLength(budget - 1);
    expect((await rollout.getRolloutStatus(run.id)).status).toBe('failed');
  });

});
