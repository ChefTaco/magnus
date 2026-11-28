import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logAuditEvent, verifyAuditIntegrity } from './audit-service.js';
import { auditCutoffDay, auditRetentionDays, pruneAuditLogs } from './audit-retention.js';

afterEach(() => vi.unstubAllEnvs());

describe('audit retention', () => {
  it('is off unless MAGNUS_AUDIT_RETENTION_DAYS is set to at least 90', () => {
    vi.stubEnv('MAGNUS_AUDIT_RETENTION_DAYS', '');
    expect(auditRetentionDays()).toBeNull();
    vi.stubEnv('MAGNUS_AUDIT_RETENTION_DAYS', '30');
    expect(auditRetentionDays()).toBeNull();
    vi.stubEnv('MAGNUS_AUDIT_RETENTION_DAYS', '90.5');
    expect(auditRetentionDays()).toBeNull();
    vi.stubEnv('MAGNUS_AUDIT_RETENTION_DAYS', '400');
    expect(auditRetentionDays()).toBe(400);
  });

  it('computes the first kept UTC day', () => {
    expect(auditCutoffDay(90, new Date('2026-11-28T23:59:00Z'))).toBe('2026-08-30');
  });

  it('deletes whole days older than the window, keeps later chains valid and audits the deletion', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'magnus-audit-retention-'));
    vi.stubEnv('AUDIT_LOG_DIR', dir);
    vi.stubEnv('AUDIT_HMAC_SECRET', 'd'.repeat(64));
    const now = new Date();
    const day = (offset: number) => new Date(now.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    for (const offset of [400, 200, 91, 89]) await writeFile(path.join(dir, `${day(offset)}.jsonl`), '');
    await writeFile(path.join(dir, 'notes.txt'), 'not an audit day');
    await logAuditEvent({ action: 'log.retention', actorId: 'test', actorType: 'system', targetType: 'fixture', targetId: 'before' });

    const removed = await pruneAuditLogs(90, now);
    expect(removed).toEqual([day(400), day(200), day(91)]);
    const left = (await readdir(dir)).sort();
    expect(left).toEqual([`${day(89)}.jsonl`, `${day(0)}.jsonl`, 'notes.txt'].sort());

    const today = (await readFile(path.join(dir, `${day(0)}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { action: string; details: Record<string, unknown> });
    expect(today.at(-1)).toMatchObject({ action: 'audit.retention', details: { retentionDays: 90, removedDays: 3, oldestRemoved: day(400), newestRemoved: day(91) } });
    expect(await verifyAuditIntegrity(day(0))).toMatchObject({ valid: true, totalEntries: 2 });
    // Nothing left to remove: no second audit event.
    expect(await pruneAuditLogs(90, now)).toEqual([]);
    expect((await readFile(path.join(dir, `${day(0)}.jsonl`), 'utf8')).trim().split('\n')).toHaveLength(2);
  });
});
