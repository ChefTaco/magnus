import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MutationBarrier } from './mutation-barrier.js';
import { signHistoricalAssertion, verifyHistoricalReceipt, type HistoricalObservation, type HostBoot, type ReviewedHistoricalRecords } from './historical-mutation.js';

const keys = { result: 'owner-result-key-'.repeat(4), reconciliation: 'independent-controller-key-'.repeat(4) };
const identity = { nodeId: 'fixture', nodeFqdn: 'fixture.lab', epoch: 1, barrierId: randomUUID() };
let root: string, clock: number, boot: HostBoot, barrier: MutationBarrier, before: HistoricalObservation;
let reviewed: Record<string, ReviewedHistoricalRecords[string]>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'historical-mutation-'));
  clock = 1_790_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  boot = { id: randomUUID(), startedAt: clock - 100_000 };
  reviewed = {};
  barrier = new MutationBarrier(root, identity.nodeFqdn, keys, async () => boot, reviewed);
  for (const route of ['/commands/execute', '/codex/update']) {
    const token = await barrier.begin('POST', route);
    await barrier.finish(token, 'unknown');
  }
  await barrier.drain(identity);
  before = await barrier.historicalObservation();
  for (const row of before.records) reviewed[row.id] = { nodeFqdn: identity.nodeFqdn, recordSha256: row.recordSha256 };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
function afterBoot() { clock += 10_000; boot = { id: randomUUID(), startedAt: clock }; clock += 5000; }
function decision(overrides: Record<string, unknown> = {}, key = keys.reconciliation) {
  return signHistoricalAssertion({ version: 1, before, boot, records: before.records,
    disposition: 'post_boot_quiescence_outcome_unknown', approvalRef: 'operator:fixture',
    decisionId: randomUUID(), expiresAt: clock + 300_000, ...overrides }, key);
}

describe('historical mutation process quiescence', () => {
  it('refuses service restart as whole-host quiescence without touching originals', async () => {
    await expect(barrier.settleHistorical(decision())).rejects.toThrow('whole-host boot');
    expect((await readdir(root)).filter(n => n.startsWith('historical-'))).toEqual([]);
    expect(await barrier.snapshot(identity)).toMatchObject({ unknownCount: 2 });
  });
  it('preserves unknown bytes, separately releases only the signed process claims, and forbids replay', async () => {
    const files = await Promise.all(before.records.map(r => readFile(join(root, 'request-' + r.id + '.json'))));
    afterBoot();
    const signed = decision();
    const receipt = await barrier.settleHistorical(signed);
    expect(verifyHistoricalReceipt(receipt, keys)).toMatchObject({ originalOutcome: 'unknown', replayPermitted: false });
    expect(await barrier.settleHistorical(signed)).toEqual(receipt);
    const restarted = new MutationBarrier(root, identity.nodeFqdn, keys, async () => boot, reviewed);
    expect(await restarted.snapshot(identity)).toMatchObject({ activeCount: 0, unknownCount: 0 });
    expect((await restarted.unknownInventory()).rows).toHaveLength(2);
    expect((await restarted.unknownInventory()).rows.every(r => r.state === 'unknown' && r.historicalSettlement?.replayPermitted === false)).toBe(true);
    for (const [i, r] of before.records.entries()) expect(await readFile(join(root, 'request-' + r.id + '.json'))).toEqual(files[i]);
    await expect(restarted.begin('POST', '/codex/update')).rejects.toThrow('draining');
    clock += 1_000_000;
    expect(await restarted.snapshot(identity)).toMatchObject({ unknownCount: 0 });
  });
  it('rejects the owner result key as reconciliation authority and rejects tampering', async () => {
    afterBoot();
    await expect(barrier.settleHistorical(decision({}, keys.result))).rejects.toThrow('signature');
    const value = decision(); value.before.records[0]!.recordSha256 = 'a'.repeat(64);
    await expect(barrier.settleHistorical(value)).rejects.toThrow('signature');
    expect(await barrier.snapshot(identity)).toMatchObject({ unknownCount: 2 });
  });
  it('binds the actual kernel boot, deadline, and exact pre-maintenance observation', async () => {
    afterBoot();
    await expect(barrier.settleHistorical(decision({ boot: { ...boot, id: randomUUID() } }))).rejects.toThrow('kernel boot');
    await expect(barrier.settleHistorical(decision({ expiresAt: clock - 1 }))).rejects.toThrow('expired');
    await expect(barrier.settleHistorical(decision({ expiresAt: clock + 300_001 }))).rejects.toThrow('expired');
    await expect(barrier.settleHistorical(decision({ records: [{ ...before.records[0]!, acceptedAt: clock }] }))).rejects.toThrow('whole-host boot');
    await expect(barrier.settleHistorical(decision({ records: [before.records[0]!, before.records[0]!] }))).rejects.toThrow('whole-host boot');
  });
  it('rejects changed source bytes, even when they still parse to the same row', async () => {
    afterBoot();
    const path = join(root, 'request-' + before.records[0]!.id + '.json');
    const bytes = await readFile(path);
    await writeFile(path, bytes.toString() + '\n');
    await expect(barrier.settleHistorical(decision())).rejects.toThrow('Historical source differs');
  });
  it('refuses a changed drain or a different host and fails closed on altered stored receipts', async () => {
    afterBoot();
    const signed = decision();
    const originalReceipt = await barrier.settleHistorical(signed);
    const path = join(root, 'historical-' + before.records[0]!.id + '.json');
    const saved = JSON.parse(await readFile(path, 'utf8')); saved.replayPermitted = true;
    await writeFile(path, JSON.stringify(saved));
    await expect(barrier.snapshot(identity)).rejects.toThrow();
    await writeFile(path, JSON.stringify(originalReceipt));
    await barrier.drain({ ...identity, epoch: 2 });
    await expect(barrier.settleHistorical(signed)).rejects.toThrow('drain differs');
    await expect(new MutationBarrier(root, 'other.lab', keys).unknownInventory()).rejects.toThrow('another node');
  });
  it('rejects conflicting retirement decisions and operations outside the historical route scope', async () => {
    afterBoot(); await barrier.settleHistorical(decision());
    await expect(barrier.settleHistorical(decision())).rejects.toThrow('conflicts');
    const otherRoot = await mkdtemp(join(tmpdir(), 'unsupported-mutation-'));
    try {
      const otherReviewed: Record<string, ReviewedHistoricalRecords[string]> = {};
      const other = new MutationBarrier(otherRoot, identity.nodeFqdn, keys, async () => boot, otherReviewed);
      const token = await other.begin('POST', '/files/write'); await other.finish(token, 'unknown'); await other.drain(identity);
      const observation = await other.historicalObservation(); afterBoot();
      for (const row of observation.records) otherReviewed[row.id] = { nodeFqdn: identity.nodeFqdn, recordSha256: row.recordSha256 };
      await expect(other.settleHistorical(decision({ before: observation, records: observation.records }))).rejects.toThrow('outside the reviewed routes');
    } finally { await rm(otherRoot, { recursive: true, force: true }); }
  });
  it('refuses unreviewed records even with both valid signatures and a later host boot', async () => {
    afterBoot();
    const productionScope = new MutationBarrier(root, identity.nodeFqdn, keys, async () => boot);
    await expect(productionScope.settleHistorical(decision())).rejects.toThrow('exact reviewed records');
    expect(await productionScope.snapshot(identity)).toMatchObject({ unknownCount: 2 });
  });
});
