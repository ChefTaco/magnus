import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createResourceParticipant } from '../../runtime-resource-participant.mjs';

const env = { RESOURCE_ENROLLMENT_DASHBOARD_SECRET: 'fixture-dashboard-secret-separate-32bytes', API_SECRET: 'other-secret' };
function ledger() {
  const rows = new Map<string, any>();
  const descriptor = { version: 1, participant: 'dashboard', nodeId: 'node-fixture', nodeFqdn: 'fixture.lab', epoch: 2,
    barrierId: randomUUID(), challengeId: randomUUID(), expiresAt: Date.now() + 60_000 };
  let draining = false;
  const request = vi.fn(async (path: string, body: any) => {
    if (path === '/work/reserve') {
      if (draining) throw Error('draining');
      const row = { ...body, participant: 'dashboard', nodeId: descriptor.nodeId, nodeFqdn: descriptor.nodeFqdn, state: 'reserved', epoch: 1,
        barrierId: null, requestSha256: 'b'.repeat(64), fence: String(rows.size + 1) };
      rows.set(body.workId, row); return { ...row };
    }
    if (path === '/status') return { version: 1, nodeId: descriptor.nodeId, nodeFqdn: descriptor.nodeFqdn,
      nonce: body.nonce, state: draining ? 'draining' : 'legacy', epoch: descriptor.epoch, barrierId: descriptor.barrierId,
      challenge: { challengeId: descriptor.challengeId, expiresAt: descriptor.expiresAt },
      activeCount: [...rows.values()].filter(r => ['reserved','running'].includes(r.state)).length,
      unknownCount: [...rows.values()].filter(r => r.state === 'unknown').length, evidenceSha256: 'a'.repeat(64) };
    const row = rows.get(path.split('/')[2]!);
    if (!row || row.ownerId !== body.ownerId) throw Error('owner mismatch');
    if (path.endsWith('/start')) {
      if (draining || row.state !== 'reserved') throw Error('start denied');
      if (body.operationSha256 !== row.operationSha256 || body.fence !== row.fence || body.deadline !== row.deadline || body.requestSha256 !== row.requestSha256)
        throw Error('authority mismatch');
      row.state = 'running'; return { ...row };
    }
    row.state = row.state === 'reserved' && body.disposition === 'not-started' ? 'released' : 'unknown';
    return { ...row };
  });
  return { rows, descriptor, request, drain: () => { draining = true; } };
}

describe('durable dashboard SSH participant', () => {
  it('reserves and admits before returning a handle and never treats shell exit as released effects', async () => {
    const db = ledger(); const participant = createResourceParticipant({ env, request: db.request });
    const work = await participant.begin('fixture.lab', 'terminal-http');
    expect(db.request.mock.calls.map(c => c[0])).toEqual(['/work/reserve', `/work/${work.workId}/start`]);
    await work.finish('remote-ended');
    expect(db.rows.get(work.workId).state).toBe('unknown');
  });
  it('a retired WebSocket terminal kind cannot be reserved', async () => {
    const db = ledger();
    await expect(createResourceParticipant({ env, request: db.request }).begin('fixture.lab', 'terminal-ws' as 'terminal-http')).rejects.toThrow('Invalid managed SSH');
    expect(db.request).not.toHaveBeenCalled();
  });
  it('drain between reservation and dispatch denies execution', async () => {
    const db = ledger();
    const request = async (path: string, body: any) => { const value = await db.request(path, body); if (path.endsWith('/reserve')) db.drain(); return value; };
    await expect(createResourceParticipant({ env, request }).begin('fixture.lab', 'hermes-http')).rejects.toThrow('start denied');
    expect([...db.rows.values()][0].state).toBe('reserved');
  });
  it('lost start acknowledgment does not reconnect or retry an execution grant', async () => {
    const db = ledger();
    const request = vi.fn(async (path: string, body: any) => { const value = await db.request(path, body); if (path.endsWith('/start')) throw Error('lost ack'); return value; });
    await expect(createResourceParticipant({ env, request }).begin('fixture.lab', 'terminal-http')).rejects.toThrow('lost ack');
    expect(request).toHaveBeenCalledTimes(2);
    expect([...db.rows.values()][0].state).toBe('running');
  });
  it('one immutable settlement survives competing closes and lost settlement acknowledgment', async () => {
    const db = ledger();
    const request = vi.fn(async (path: string, body: any) => { const value = await db.request(path, body); if (path.endsWith('/finish')) throw Error('lost ack'); return value; });
    const work = await createResourceParticipant({ env, request }).begin('fixture.lab', 'terminal-http');
    await expect(work.finish('unknown')).rejects.toThrow('lost ack');
    await expect(work.finish('remote-ended')).rejects.toThrow('lost ack');
    expect(request.mock.calls.filter(c => c[0].endsWith('/finish'))).toHaveLength(1);
    expect(db.rows.get(work.workId).state).toBe('unknown');
  });
  it('rejects reused secrets', async () => {
    const db = ledger();
    await expect(createResourceParticipant({ env: { ...env, API_SECRET: env.RESOURCE_ENROLLMENT_DASHBOARD_SECRET }, request: db.request }).begin('fixture.lab', 'terminal-http')).rejects.toThrow('dedicated');
  });
  it('rejects incomplete successful start receipt and unavailable authority', async () => {
    const db = ledger();
    const request = async (path: string, body: any) => { const result = await db.request(path, body); return path.endsWith('/start') ? {} : result; };
    await expect(createResourceParticipant({ env, request }).begin('fixture.lab', 'hermes-http')).rejects.toThrow('not acknowledged');
    await expect(createResourceParticipant({ env, request: async () => { throw Error('authority down'); } }).begin('fixture.lab', 'terminal-http')).rejects.toThrow('authority down');
  });
});
