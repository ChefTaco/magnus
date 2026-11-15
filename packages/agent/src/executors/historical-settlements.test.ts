/**
 * Retiring the shared reconciliation key from an agent (docs/NODE_CREDENTIALS.md, "Retiring the
 * shared key"): settlements stored by 3.0.1 with COMMAND_RECONCILIATION_SECRET keep verifying from
 * COMMAND_RECONCILIATION_PREVIOUS_SECRET, `reseal` moves them to the node-local keys, and `prune`
 * archives the ones no key verifies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MutationBarrier } from './mutation-barrier.js';
import { signHistoricalAssertion, verifyHistoricalReceipt, type HistoricalKeys, type HostBoot, type ReviewedHistoricalRecords } from './historical-mutation.js';
import { parseHistoricalSettlementsArgs, runHistoricalSettlements } from '../historical-settlements-cli.js';

/** What 3.0.1 signed with: the shared result and reconciliation keys. */
const shared = { result: 'shared-result-signing-fixture-'.repeat(2), reconciliation: 'shared-reconciliation-fixture-'.repeat(2) };
/** The node-local keys of 3.0.2. */
const local = { result: 'a'.repeat(64), reconciliation: 'b'.repeat(64) };
/** 3.0.2 with both shared keys moved to their verify-only previous slots. */
const retired: HistoricalKeys = { ...local, previousResult: [shared.result], previousReconciliation: [shared.reconciliation] };
/** 3.0.2 with the reconciliation key removed outright (the result key kept as previous). */
const removed: HistoricalKeys = { ...local, previousResult: [shared.result] };
const identity = { nodeId: 'fixture', nodeFqdn: 'fixture.lab', epoch: 1, barrierId: randomUUID() };

let root: string; let clock: number; let boot: HostBoot;
let reviewed: Record<string, ReviewedHistoricalRecords[string]>;
let ids: string[];
const barrierWith = (keys: HistoricalKeys, bootReader = async () => boot) => new MutationBarrier(root, identity.nodeFqdn, keys, bootReader, reviewed);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'historical-settlements-'));
  clock = 1_790_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  boot = { id: randomUUID(), startedAt: clock - 100_000 };
  reviewed = {};
  // A 3.0.1 agent with the shared keys: two unknown records, a drain, then a settlement after a reboot.
  const old = barrierWith(shared);
  for (const route of ['/commands/execute', '/codex/update']) await old.finish(await old.begin('POST', route), 'unknown');
  await old.drain(identity);
  const before = await old.historicalObservation();
  for (const row of before.records) reviewed[row.id] = { nodeFqdn: identity.nodeFqdn, recordSha256: row.recordSha256 };
  ids = before.records.map(row => row.id).sort();
  clock += 10_000; boot = { id: randomUUID(), startedAt: clock }; clock += 5000;
  await old.settleHistorical(signHistoricalAssertion({ version: 1, before, boot, records: before.records,
    disposition: 'post_boot_quiescence_outcome_unknown', approvalRef: 'operator:fixture', decisionId: randomUUID(),
    expiresAt: clock + 300_000 }, shared.reconciliation));
  expect(await old.snapshot(identity)).toMatchObject({ unknownCount: 0 });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('stored historical settlements across the shared-key retirement', () => {
  it('keep verifying with the shared key in its previous slot, and are refused, blocking the drain evidence, without it', async () => {
    expect(await barrierWith(retired).snapshot(identity)).toMatchObject({ activeCount: 0, unknownCount: 0 });
    expect((await barrierWith(retired).unknownInventory()).unsettledCounts).toEqual({ active: 0, unknown: 0 });
    expect((await barrierWith(retired).historicalSettlements(local)).map(entry => [entry.state, entry.record, entry.agentRefusal]))
      .toEqual([['shared-key', 'retained', null], ['shared-key', 'retained', null]]);
    // No key verifies them: every read of the barrier that consults settlements fails, nothing else does.
    const without = barrierWith(removed);
    await expect(without.snapshot(identity)).rejects.toThrow('Historical signature differs');
    await expect(without.unknownInventory()).rejects.toThrow('Historical signature differs');
    await expect(without.historicalObservation()).rejects.toThrow('Historical signature differs');
    const entries = await without.historicalSettlements(local);
    expect(entries.map(entry => entry.recordId)).toEqual(ids);
    expect(entries.every(entry => entry.state === 'unverifiable' && entry.agentRefusal === 'Historical signature differs'
      && entry.recordMatches === true && entry.recordAcceptedBeforeBoot === true)).toBe(true);
  });

  it('reseal re-MACs them with the node-local keys, keeps the originals and changes nothing they settle', async () => {
    const originals = new Map<string, Buffer>();
    for (const id of ids) originals.set(id, await readFile(join(root, `historical-${id}.json`)));
    const before = await barrierWith(retired).unknownInventory();
    const archived = new Map<string, Buffer>();
    expect(await barrierWith(retired).resealHistoricalSettlements(local, async (name, bytes) => { archived.set(name, bytes); })).toEqual(ids);
    for (const id of ids) {
      expect(archived.get(`historical-${id}.json`)).toEqual(originals.get(id));
      const sealed = JSON.parse(await readFile(join(root, `historical-${id}.json`), 'utf8'));
      expect(verifyHistoricalReceipt(sealed, local)).toMatchObject({ originalOutcome: 'unknown', replayPermitted: false });
      expect(() => verifyHistoricalReceipt(sealed, shared)).toThrow('signature');
      expect((await stat(join(root, `historical-${id}.json`))).mode & 0o777).toBe(0o600);
    }
    // The shared key can go now: the node-local keys alone read every settlement.
    const after = barrierWith(local);
    expect(await after.snapshot(identity)).toMatchObject({ unknownCount: 0 });
    expect((await after.unknownInventory()).rows.map(row => [row.id, row.state, row.acceptedAt, row.routeSha256]))
      .toEqual(before.rows.map(row => [row.id, row.state, row.acceptedAt, row.routeSha256]));
    expect((await after.historicalSettlements(local)).map(entry => entry.state)).toEqual(['node-local', 'node-local']);
    // Nothing left to do on a second run.
    expect(await after.resealHistoricalSettlements(local, async () => { throw new Error('nothing to keep'); })).toEqual([]);
  });

  it('prune archives unverifiable settlements; their records count as unknown again unless --with-records retires them too', async () => {
    const without = barrierWith(removed);
    expect(await without.archiveUnverifiableSettlements({ localKeys: local, withRecords: false, archive: null }))
      .toEqual(ids.map(recordId => ({ recordId, state: 'unverifiable', record: 'retained-unsettled' })));
    expect(await without.archiveUnverifiableSettlements({ localKeys: local, withRecords: true, archive: null }))
      .toEqual(ids.map(recordId => ({ recordId, state: 'unverifiable', record: 'would-archive' })));
    // A dry run changes nothing.
    await expect(without.snapshot(identity)).rejects.toThrow('Historical signature differs');

    const kept = new Map<string, Buffer>();
    const [first, second] = ids as [string, string];
    const firstBytes = await readFile(join(root, `request-${first}.json`));
    // Settlement only: the record is unsettled again and the drain evidence reads it as unknown.
    await rm(join(root, `historical-${second}.json`));
    expect(await without.archiveUnverifiableSettlements({ localKeys: local, withRecords: true,
      archive: async (name, bytes) => { kept.set(name, bytes); } })).toEqual([{ recordId: first, state: 'unverifiable', record: 'archived' }]);
    expect([...kept.keys()].sort()).toEqual([`historical-${first}.json`, `request-${first}.json`]);
    expect(kept.get(`request-${first}.json`)).toEqual(firstBytes);
    expect((await readdir(root)).filter(name => name.includes(first))).toEqual([]);
    expect(await without.snapshot(identity)).toMatchObject({ activeCount: 0, unknownCount: 1 });
    expect((await without.unknownInventory()).rows.map(row => row.id)).toEqual([second]);
  });

  it('prune keeps a record accepted after the current boot or whose bytes changed, and reports settlements nothing reads', async () => {
    const [first, second] = ids as [string, string];
    await writeFile(join(root, `request-${second}.json`), (await readFile(join(root, `request-${second}.json`))).toString() + '\n', { mode: 0o600 });
    const orphan = randomUUID();
    await writeFile(join(root, `historical-${orphan}.json`), '{}', { mode: 0o600 });
    // A boot older than the records: they may still be running.
    const early = barrierWith(removed, async () => ({ id: randomUUID(), startedAt: 1 }));
    const plans = await early.archiveUnverifiableSettlements({ localKeys: local, withRecords: true, archive: null });
    expect(plans).toEqual(expect.arrayContaining([
      { recordId: first, state: 'unverifiable', record: 'kept-not-before-boot' },
      { recordId: orphan, state: 'malformed', record: 'not-retained' }]));
    expect(plans.find(plan => plan.recordId === second)?.record).toBe('kept-bytes-differ');
  });
});

describe('magnus-agent historical-settlements', () => {
  let installDir: string; let lines: string[]; let errors: string[];
  beforeEach(async () => { installDir = await mkdtemp(join(tmpdir(), 'historical-settlements-cli-')); lines = []; errors = []; });
  afterEach(async () => { await rm(installDir, { recursive: true, force: true }); });
  const context = (keys: HistoricalKeys, uid: number | undefined = 0) => ({ installDir, uid, barrier: barrierWith(keys),
    localKeys: () => local, out: (line: string) => lines.push(line), err: (line: string) => errors.push(line), now: () => new Date(clock) });

  it('parses only the documented forms', () => {
    expect(parseHistoricalSettlementsArgs(['list'])).toMatchObject({ action: 'list' });
    expect(parseHistoricalSettlementsArgs(['prune', '--unverifiable', '--with-records', '--apply'])).toMatchObject({ action: 'prune' });
    for (const args of [[], ['remove'], ['prune'], ['prune', '--apply'], ['list', '--apply'], ['reseal', '--apply', '--apply'], ['reseal', '--force']])
      expect(parseHistoricalSettlementsArgs(args)).toHaveProperty('error');
  });

  it('lists, and with --check fails while a settlement needs a shared key or verifies with none', async () => {
    expect(await runHistoricalSettlements(['list', '--check'], context(retired))).toBe(1);
    expect(lines.join('\n')).toContain('2 to re-seal');
    lines = [];
    expect(await runHistoricalSettlements(['list', '--json'], context(removed))).toBe(0);
    expect(JSON.parse(lines[0]!).summary).toMatchObject({ total: 2, unverifiable: 2, refused: 2 });
  });

  it('refuses --apply unless run as root, and changes nothing in a dry run', async () => {
    const files = async () => (await readdir(root)).sort();
    const listing = await files();
    expect(await runHistoricalSettlements(['reseal', '--apply'], context(retired, 1000))).toBe(1);
    expect(errors.join('\n')).toContain('run it as root');
    expect(await runHistoricalSettlements(['reseal'], context(retired))).toBe(0);
    expect(await runHistoricalSettlements(['prune', '--unverifiable', '--with-records'], context(removed))).toBe(0);
    expect(lines.join('\n')).toContain('Would archive 2');
    expect(await files()).toEqual(listing);
    await expect(readdir(join(installDir, '.magnus'))).rejects.toThrow();
  });

  it('applies reseal and prune into a new owner-only archive with a manifest', async () => {
    expect(await runHistoricalSettlements(['reseal', '--apply', '--json'], context(retired))).toBe(0);
    const reseal = JSON.parse(lines.pop()!) as { resealed: string[]; archive: string };
    expect(reseal.resealed).toEqual(ids);
    expect((await stat(reseal.archive)).mode & 0o777).toBe(0o700);
    expect((await readdir(reseal.archive)).sort()).toEqual([...ids.map(id => `historical-${id}.json`), 'manifest.json'].sort());
    expect(await runHistoricalSettlements(['list', '--check'], context(local))).toBe(0);

    // A settlement no key verifies, next to the re-sealed ones.
    const orphan = randomUUID();
    await writeFile(join(root, `historical-${orphan}.json`), '{"version":1}', { mode: 0o600 });
    expect(await runHistoricalSettlements(['prune', '--unverifiable', '--apply', '--json'], context(local))).toBe(0);
    const prune = JSON.parse(lines.pop()!) as { plans: unknown[]; archive: string };
    expect(prune.plans).toEqual([{ recordId: orphan, state: 'malformed', record: 'not-retained' }]);
    expect(prune.archive).not.toBe(reseal.archive);
    expect(JSON.parse(await readFile(join(prune.archive, 'manifest.json'), 'utf8'))).toMatchObject({ action: 'prune-unverifiable', plans: prune.plans });
    expect(await readFile(join(prune.archive, `historical-${orphan}.json`), 'utf8')).toBe('{"version":1}');
    expect((await readdir(root)).some(name => name.includes(orphan))).toBe(false);
  });

  it('says so when this agent has no mutation barrier', async () => {
    const empty = { ...context(local), barrier: new MutationBarrier(join(installDir, 'missing'), identity.nodeFqdn, local) };
    expect(await runHistoricalSettlements(['list'], empty)).toBe(0);
    expect(lines.join('\n')).toContain('No mutation barrier');
  });
});
