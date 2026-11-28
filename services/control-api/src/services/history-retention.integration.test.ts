import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const id = 'retention-' + randomUUID();
const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

describe.skipIf(!process.env['TEST_DATABASE_URL'])('history retention (PostgreSQL)', () => {
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let retention: typeof import('./history-retention.js');
  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!; if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable fixture required');
    vi.stubEnv('DATABASE_URL', url); vi.stubEnv('TLS_CERT_PATH', 'fixture'); vi.stubEnv('TLS_KEY_PATH', 'fixture');
    db = (await import('../db/index.js')).getDb(); retention = await import('./history-retention.js');
    await db.node.create({ data: { id, name: id, hostname: `${id}.invalid`, ipAddress: '192.0.2.40', port: 4100, os: 'fixture', arch: 'fixture', token: randomUUID(), status: 'ONLINE' } });
  });
  afterAll(async () => {
    if (db) {
      await db.commandResourceLease.deleteMany({ where: { nodeId: id } }).catch(() => undefined);
      await db.node.delete({ where: { id } });
      await (await import('../db/index.js')).disconnectDb();
    }
    vi.unstubAllEnvs();
  });

  const command = (key: string, status: 'COMPLETED' | 'RUNNING' | 'QUEUED', createdAt = old) => db.remoteCommand.create({
    data: { nodeId: id, command: 'uptime', status, idempotencyKey: `${id}-${key}`, createdBy: 'system', createdAt },
  });

  it('deletes old finished history and keeps everything unresolved, in flight or recent', async () => {
    const finished = await command('finished', 'COMPLETED');
    await db.commandResult.create({ data: { commandId: finished.id, exitCode: 0, stdout: '', stderr: '', durationMs: 1 } });
    const running = await command('running', 'RUNNING');
    const recent = await command('recent', 'COMPLETED', new Date());

    const rule = await db.alertRule.create({ data: { name: `${id}-rule`, metric: 'cpu', operator: 'gt', threshold: 90, createdBy: 'system' } });
    await db.alertViolation.create({ data: { ruleId: rule.id, nodeId: id, metric: 'cpu', value: 95, threshold: 90, severity: 'warning',
      status: 'resolved', resolvedAt: old, createdAt: old } });
    await db.alertViolation.create({ data: { ruleId: rule.id, nodeId: id, metric: 'cpu', value: 95, threshold: 90, severity: 'warning',
      status: 'active', createdAt: old } });

    const conversation = await db.aiConversation.create({ data: { title: `${id}-old`, type: 'chat', createdBy: 'system' } });
    await db.$executeRaw`UPDATE "ai_conversations" SET "updatedAt" = ${old} WHERE "id" = ${conversation.id}`;

    const waiting = await db.aiConversation.create({ data: { title: `${id}-waiting`, type: 'chat', createdBy: 'system' } });
    await db.aiMessage.create({ data: { conversationId: waiting.id, role: 'assistant', content: 'needs approval',
      pendingApproval: JSON.stringify({ toolName: 'execCommand', toolArgs: {}, conversationId: waiting.id }) } });
    await db.$executeRaw`UPDATE "ai_conversations" SET "updatedAt" = ${old} WHERE "id" = ${waiting.id}`;

    const counts = await retention.pruneHistory(90);
    expect(counts.commands).toBeGreaterThanOrEqual(1);

    expect(await db.remoteCommand.findUnique({ where: { id: finished.id } })).toBeNull();
    expect(await db.commandResult.findUnique({ where: { commandId: finished.id } })).toBeNull();
    expect(await db.remoteCommand.findUnique({ where: { id: running.id } })).not.toBeNull();
    expect(await db.remoteCommand.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await db.alertViolation.count({ where: { ruleId: rule.id, status: 'resolved' } })).toBe(0);
    expect(await db.alertViolation.count({ where: { ruleId: rule.id, status: 'active' } })).toBe(1);
    expect(await db.aiConversation.findUnique({ where: { id: conversation.id } })).toBeNull();
    // An old conversation still awaiting a tool approval is kept.
    expect(await db.aiConversation.findUnique({ where: { id: waiting.id } })).not.toBeNull();
    await db.aiConversation.delete({ where: { id: waiting.id } });

    await db.alertRule.delete({ where: { id: rule.id } });
  });

  it('keeps an old finished command that an unsettled resource lease still names', async () => {
    const leased = await command('leased', 'COMPLETED');
    await db.commandResourceLease.create({ data: { id: randomUUID(), nodeId: id, resourceKey: `node:${id}`, commandId: leased.id,
      ownerActor: 'system', requestSha256: 'a'.repeat(64), coordinationJson: '{}', state: 'unknown', deadline: new Date(Date.now() + 60_000) } });
    await retention.pruneHistory(90);
    expect(await db.remoteCommand.count({ where: { id: leased.id } })).toBe(1);
  });

  it('prunes finished pushes, rollouts, remediations and jobs, and keeps the newest drift scan, Ardent operation and receipt', async () => {
    const recent = new Date();
    const older = new Date(old.getTime() - 86_400_000);
    const push = (status: string, createdAt: Date) => db.filePatchTask.create({ data: { nodeId: id, filePath: '/etc/fixture', content: 'x', status, createdBy: 'system', createdAt } });
    const pushOld = await push('completed', old); const pushPending = await push('pending', old); const pushRecent = await push('failed', recent);

    const run = (key: string, status: string, completedAt: Date | null) => db.executionRun.create({ data: { id: `${id}-${key}`, type: 'command', status, createdBy: 'system', createdAt: old, completedAt,
      targets: { create: [{ nodeId: id, status: 'completed' }] } } });
    await run('done', 'completed', old); await run('running', 'running', null); await run('recent', 'failed', recent);

    const rule = await db.remediationRule.create({ data: { name: `${id}-remediation`, agentDefinitionId: 'restart-service.v1' } });
    const remediation = (status: string, triggeredAt: Date, completedAt: Date | null) => db.remediationExecution.create({ data: { ruleId: rule.id, anomalyEventId: 'fixture', nodeId: id, status, triggeredAt, completedAt } });
    const remediationOld = await remediation('completed', old, old);
    const remediationApproving = await remediation('approving', old, null);
    const remediationInFlight = await remediation('failed', old, old);
    await db.remoteCommand.create({ data: { nodeId: id, command: 'uptime', status: 'RUNNING', idempotencyKey: `${id}-remediation`, createdBy: 'system', createdAt: recent, correlationId: `remediation_${remediationInFlight.id}` } });
    // The approving remediation's admitted rollout is kept even though it is old and finished.
    await db.executionRun.create({ data: { id: `remediation_${remediationApproving.id}`, type: 'remediation', status: 'completed', createdBy: 'system', createdAt: old, completedAt: old } });

    await db.driftScan.create({ data: { nodeId: id, status: 'clean', findings: '[]', scannedAt: older } });
    const newestScan = await db.driftScan.create({ data: { nodeId: id, status: 'drifted', findings: '[]', scannedAt: old } });

    const operation = (key: string, kind: string, status: string, at: Date) => db.ardentAgentOperation.create({ data: { id: `${id}-${key}`, kind, nodeId: id, profile: 'p1', status,
      requestJson: '{}', createdBy: 'system', createdAt: at, completedAt: at } });
    await operation('enroll-old', 'hivemem', 'succeeded', older);
    await operation('enroll-newest-success', 'hivemem', 'succeeded', old);
    await operation('enroll-failed', 'hivemem', 'failed', new Date(old.getTime() + 1000));
    await operation('deploy-old', 'deploy', 'failed', older);
    await operation('deploy-new', 'deploy', 'failed', old);

    const receipt = (slug: string, createdAt: Date) => db.hermesRegistryReceipt.create({ data: { nodeId: id, installationId: `${id}-install`, kind: 'skill', slug, revision: 1, sha256: 'b'.repeat(64), status: 'applied', createdAt } });
    const receiptOld = await receipt('one', older); const receiptNewest = await receipt('one', old); const receiptOther = await receipt('two', older);

    const deploy = await db.deployJob.create({ data: { type: 'deploy', status: 'completed', targets: '[]', createdBy: 'system', startedAt: old, completedAt: old } });
    const deployRunning = await db.deployJob.create({ data: { type: 'deploy', status: 'running', targets: '[]', createdBy: 'system', startedAt: old } });

    const counts = await retention.pruneHistory(90);
    for (const key of ['filePatches', 'driftScans', 'hermesRegistryReceipts', 'deployJobs', 'rollouts', 'remediations'] as const) expect(counts[key]).toBeGreaterThanOrEqual(1);
    expect(counts.ardentOperations).toBeGreaterThanOrEqual(2);
    expect(await db.filePatchTask.findMany({ where: { nodeId: id }, select: { id: true } })).toEqual(expect.arrayContaining([{ id: pushPending.id }, { id: pushRecent.id }]));
    expect(await db.filePatchTask.count({ where: { id: pushOld.id } })).toBe(0);

    const runs = (await db.executionRun.findMany({ where: { OR: [{ id: { startsWith: id } }, { id: `remediation_${remediationApproving.id}` }] }, select: { id: true } })).map(row => row.id).sort();
    expect(runs).toEqual([`${id}-recent`, `${id}-running`, `remediation_${remediationApproving.id}`].sort());
    expect(await db.rolloutTarget.count({ where: { rolloutId: `${id}-done` } })).toBe(0);

    const remediations = (await db.remediationExecution.findMany({ where: { ruleId: rule.id }, select: { id: true } })).map(row => row.id).sort();
    expect(remediations).toEqual([remediationApproving.id, remediationInFlight.id].sort());
    expect(remediations).not.toContain(remediationOld.id);

    expect((await db.driftScan.findMany({ where: { nodeId: id }, select: { id: true } }))).toEqual([{ id: newestScan.id }]);
    expect((await db.ardentAgentOperation.findMany({ where: { nodeId: id }, select: { id: true } })).map(row => row.id).sort())
      .toEqual([`${id}-deploy-new`, `${id}-enroll-failed`, `${id}-enroll-newest-success`].sort());
    expect((await db.hermesRegistryReceipt.findMany({ where: { nodeId: id }, select: { id: true } })).map(row => row.id).sort()).toEqual([receiptNewest.id, receiptOther.id].sort());
    expect(await db.hermesRegistryReceipt.count({ where: { id: receiptOld.id } })).toBe(0);
    expect(await db.deployJob.count({ where: { id: deploy.id } })).toBe(0);
    expect(await db.deployJob.count({ where: { id: deployRunning.id } })).toBe(1);

    await db.remoteCommand.deleteMany({ where: { correlationId: `remediation_${remediationInFlight.id}` } });
    await db.remediationExecution.deleteMany({ where: { ruleId: rule.id } });
    await db.remediationRule.delete({ where: { id: rule.id } });
    await db.executionRun.deleteMany({ where: { OR: [{ id: { startsWith: id } }, { id: `remediation_${remediationApproving.id}` }] } });
    await db.ardentAgentOperation.deleteMany({ where: { nodeId: id } });
    await db.hermesRegistryReceipt.deleteMany({ where: { nodeId: id } });
    await db.deployJob.delete({ where: { id: deployRunning.id } });
  });

  it('is off unless MAGNUS_HISTORY_RETENTION_DAYS is set to at least 7', () => {
    vi.stubEnv('MAGNUS_HISTORY_RETENTION_DAYS', '');
    expect(retention.historyRetentionDays()).toBeNull();
    vi.stubEnv('MAGNUS_HISTORY_RETENTION_DAYS', '3');
    expect(retention.historyRetentionDays()).toBeNull();
    vi.stubEnv('MAGNUS_HISTORY_RETENTION_DAYS', '180');
    expect(retention.historyRetentionDays()).toBe(180);
  });
});
