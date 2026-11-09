import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { managedTerminalOperation, managedTerminalReceiptPayload } from '@hivemagnus/magnus-contracts';

describe.skipIf(!process.env['TEST_DATABASE_URL'])('managed terminal ownership (PostgreSQL)', () => {
  const nodeId = 'terminal-' + randomUUID(); const host = nodeId + '.example.com';
  const key = 'synthetic-terminal-result-key-at-least-thirty-two';
  let db: ReturnType<typeof import('../db/index.js')['getDb']>;
  let work: typeof import('./resource-participant-work.js'); let terminal: typeof import('./managed-terminal.js');
  beforeAll(async () => {
    const url = process.env['TEST_DATABASE_URL']!;
    if (!new URL(url).pathname.startsWith('/magnus_ideas')) throw new Error('Disposable fixture database required');
    vi.stubEnv('DATABASE_URL', url); vi.stubEnv('RESULT_SIGNING_SECRET', key); vi.stubEnv('MAGNUS_RESOURCE_LEASES_ENABLED', 'true');
    db = (await import('../db/index.js')).getDb(); work = await import('./resource-participant-work.js'); terminal = await import('./managed-terminal.js');
    await db.node.create({ data: { id: nodeId, name: nodeId, hostname: host, ipAddress: '192.0.2.10', os: 'fixture', arch: 'amd64',
      token: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date() } });
    await db.resourceEnrollment.create({ data: { nodeId, nodeFqdn: host, state: 'enrolled', epoch: 1, barrierId: randomUUID() } });
  });
  afterAll(async () => {
    if (db) { await db.resourceParticipantWork.deleteMany({ where: { nodeId } }); await db.resourceEnrollment.deleteMany({ where: { nodeId } });
      await db.node.delete({ where: { id: nodeId } }); await (await import('../db/index.js')).disconnectDb(); }
    vi.unstubAllEnvs();
  });
  it('retains the raw SSH refusal and allows only the exact managed terminal with a single consumed claim', async () => {
    const value = { host, workId: randomUUID(), ownerId: randomUUID(), kind: 'terminal-http' as const,
      operationSha256: 'a'.repeat(64), deadline: Date.now() + 60000 };
    await expect(work.dashboardParticipantWork.reserve(value)).rejects.toMatchObject({ code: 'RESOURCE_SSH_UNAVAILABLE' });
    value.operationSha256 = createHash('sha256').update(managedTerminalOperation(value)).digest('hex');
    const reserved = await work.dashboardParticipantWork.reserve(value);
    const started = await work.dashboardParticipantWork.start(reserved.workId, reserved);
    const row = await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: started.workId } });
    const authority = terminal.terminalAuthority(row);
    const claims = await Promise.allSettled(Array.from({ length: 8 }, () => terminal.claimManagedTerminal(authority, randomUUID())));
    expect(claims.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    await expect(db.resourceParticipantWork.update({ where: { workId: value.workId }, data: { managedTerminalClaimedAt: null } })).rejects.toBeTruthy();
    await expect(terminal.claimManagedTerminal({ ...authority, nodeFqdn: 'other.example.com' }, randomUUID())).rejects.toBeTruthy();
    await work.dashboardParticipantWork.finish(value.workId, { ownerId: value.ownerId, disposition: 'remote-ended', evidenceSha256: 'f'.repeat(64) });
    expect((await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: value.workId } })).state).toBe('unknown');
    const unit = 'magnus-terminal-' + 'a'.repeat(64) + '.service';
    const unsigned = { ...authority, version: 1 as const, boundary: 'restricted-terminal-process-v1' as const,
      bootId: randomUUID(), unit, invocationId: 'a'.repeat(32), cgroup: '/system.slice/' + unit,
      startedAt: Date.now(), terminalAt: Date.now(), groupEmpty: true as const };
    const receipt = { ...unsigned, signature: createHmac('sha256', key).update(managedTerminalReceiptPayload(unsigned)).digest('hex') };
    await expect(terminal.settleManagedTerminal({ ...receipt, fence: '2' })).rejects.toBeTruthy();
    await expect(terminal.settleManagedTerminal({ ...receipt, groupEmpty: false })).rejects.toBeTruthy();
    expect(await terminal.settleManagedTerminal(receipt)).toEqual({ workId: value.workId, state: 'released' });
    expect(await terminal.settleManagedTerminal(receipt)).toEqual({ workId: value.workId, state: 'released' });
    await work.dashboardParticipantWork.finish(value.workId, { ownerId: value.ownerId, disposition: 'unknown', evidenceSha256: 'e'.repeat(64) });
    expect((await db.resourceParticipantWork.findUniqueOrThrow({ where: { workId: value.workId } })).state).toBe('released');
  });
});
