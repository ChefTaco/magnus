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

  it('is off unless MAGNUS_HISTORY_RETENTION_DAYS is set to at least 7', () => {
    vi.stubEnv('MAGNUS_HISTORY_RETENTION_DAYS', '');
    expect(retention.historyRetentionDays()).toBeNull();
    vi.stubEnv('MAGNUS_HISTORY_RETENTION_DAYS', '3');
    expect(retention.historyRetentionDays()).toBeNull();
    vi.stubEnv('MAGNUS_HISTORY_RETENTION_DAYS', '180');
    expect(retention.historyRetentionDays()).toBe(180);
  });
});
