/**
 * `magnus-agent historical-settlements`: the operator's view of the historical-mutation settlements
 * this agent stores (`$AGENT_INSTALL_DIR/.magnus/mutation-barrier/historical-<record id>.json`), and
 * the two ways to stop depending on a shared key for them (docs/NODE_CREDENTIALS.md, "Retiring the
 * shared key"):
 *
 *   list                            how each settlement verifies, and whether the agent honours it
 *   reseal [--apply]                MAC the ones that verify only with a shared key again with the
 *                                   node-local keys; afterwards COMMAND_RECONCILIATION_SECRET (and
 *                                   COMMAND_RECONCILIATION_PREVIOUS_SECRET) can be removed
 *   prune --unverifiable [--with-records] [--apply]
 *                                   move the ones no key of this agent verifies out of the barrier
 *
 * Both writing commands are dry runs without `--apply`, need root with it, take the barrier's lock
 * (the agent may keep running) and keep every file they replace or remove in a new root-only
 * directory under `$AGENT_INSTALL_DIR/.magnus/historical-settlement-archive/`. Nothing is deleted.
 */
import { constants } from 'node:fs';
import { chownSync, lstatSync } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { HistoricalKeys } from './executors/historical-mutation.js';
import type { HistoricalSettlementEntry, MutationBarrier, SettlementArchivePlan } from './executors/mutation-barrier.js';

export const HISTORICAL_SETTLEMENTS_USAGE = 'usage: magnus-agent historical-settlements list [--json] [--check]'
  + ' | reseal [--apply] [--json] | prune --unverifiable [--with-records] [--apply] [--json]';

const FLAGS: Record<string, readonly string[]> = {
  list: ['--json', '--check'],
  reseal: ['--apply', '--json'],
  prune: ['--unverifiable', '--with-records', '--apply', '--json'],
};

export interface HistoricalSettlementsContext {
  installDir: string;
  /** The effective user id; `--apply` needs 0. */
  uid: number | undefined;
  barrier: MutationBarrier;
  /** The node-local keys; `create` makes them when missing (only `reseal --apply` does). */
  localKeys: (create: boolean) => HistoricalKeys | null;
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => Date;
}

export function parseHistoricalSettlementsArgs(args: readonly string[]): { action: 'list' | 'reseal' | 'prune'; flags: Set<string> } | { error: string } {
  const [action, ...rest] = args;
  const allowed = action ? FLAGS[action] : undefined;
  if (!allowed) return { error: HISTORICAL_SETTLEMENTS_USAGE };
  const flags = new Set(rest);
  if (flags.size !== rest.length || rest.some(flag => !allowed.includes(flag))) return { error: HISTORICAL_SETTLEMENTS_USAGE };
  if (action === 'prune' && !flags.has('--unverifiable')) return { error: `${HISTORICAL_SETTLEMENTS_USAGE} (prune only acts on --unverifiable settlements)` };
  return { action: action as 'list' | 'reseal' | 'prune', flags };
}

/** A new root-only directory that keeps every file a run replaces or removes. */
async function archiveDirectory(installDir: string, now: Date): Promise<{ directory: string; keep: (name: string, bytes: Buffer) => Promise<void> }> {
  const base = join(installDir, '.magnus', 'historical-settlement-archive');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const info = await lstat(base);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== (process.getuid?.() ?? 0) || info.mode & 0o077)
    throw new Error(`${base} must be a directory owned by this user and readable by it only (mode 0700)`);
  const directory = join(base, `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { mode: 0o700 });
  return { directory, keep: async (name, bytes) => {
    const handle = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } };
}

async function writeManifest(directory: string, value: unknown): Promise<void> {
  const handle = await open(join(directory, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  const parent = await open(directory, constants.O_RDONLY);
  try { await parent.sync(); } finally { await parent.close(); }
}

function describe(entry: HistoricalSettlementEntry): string {
  const record = entry.record === 'retained'
    ? entry.agentRefusal ? `record retained, REFUSED by the agent: ${entry.agentRefusal}` : 'record retained, honoured'
    : entry.record === 'completed' ? 'record completed, not read' : 'no record, not read';
  return `  ${entry.recordId}  ${entry.state.padEnd(12)}  ${record}${entry.problem && entry.state !== 'node-local' && !entry.agentRefusal?.includes(entry.problem) ? ` (${entry.problem})` : ''}`;
}

function summary(entries: readonly HistoricalSettlementEntry[]) {
  const count = (state: HistoricalSettlementEntry['state']) => entries.filter(entry => entry.state === state).length;
  return { total: entries.length, nodeLocal: count('node-local'), sharedKey: count('shared-key'),
    unverifiable: count('unverifiable'), malformed: count('malformed'),
    refused: entries.filter(entry => entry.agentRefusal !== null).length };
}

export async function runHistoricalSettlements(args: readonly string[], context: HistoricalSettlementsContext): Promise<number> {
  const out = context.out ?? (line => console.log(line));
  const err = context.err ?? (line => console.error(line));
  const parsed = parseHistoricalSettlementsArgs(args);
  if ('error' in parsed) { err(`magnus-agent: ${parsed.error}`); return 1; }
  const { action, flags } = parsed;
  const json = flags.has('--json'); const apply = flags.has('--apply');
  if (apply && context.uid !== 0) { err('magnus-agent: --apply changes the mutation barrier: run it as root'); return 1; }
  try { await lstat(context.barrier.root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (json) out(JSON.stringify({ action, root: context.barrier.root, entries: [], summary: summary([]) }));
    else out(`No mutation barrier at ${context.barrier.root}: this agent stores no historical settlements.`);
    return 0;
  }

  if (action === 'list') {
    const entries = await context.barrier.historicalSettlements(context.localKeys(false));
    const totals = summary(entries);
    if (json) out(JSON.stringify({ action, root: context.barrier.root, entries, summary: totals }, null, 2));
    else {
      out(`Historical settlements in ${context.barrier.root}:`);
      for (const entry of entries) out(describe(entry));
      out(`${totals.total} settlement(s): ${totals.nodeLocal} node-local, ${totals.sharedKey} to re-seal, `
        + `${totals.unverifiable + totals.malformed} unverifiable; ${totals.refused} refused by the agent.`);
      if (totals.sharedKey) out('Re-seal them with the node-local keys: magnus-agent historical-settlements reseal --apply');
      if (totals.unverifiable + totals.malformed) out('Archive the unverifiable ones: magnus-agent historical-settlements prune --unverifiable [--with-records] --apply');
    }
    // --check: fail while any settlement still needs a shared key, verifies with none, or is refused.
    return flags.has('--check') && (totals.sharedKey || totals.unverifiable || totals.malformed || totals.refused) ? 1 : 0;
  }

  const now = (context.now ?? (() => new Date()))();
  if (action === 'reseal') {
    let resealed: string[]; let archive: Awaited<ReturnType<typeof archiveDirectory>> | null = null;
    if (!apply) resealed = (await context.barrier.historicalSettlements(context.localKeys(false)))
      .filter(entry => entry.state === 'shared-key').map(entry => entry.recordId);
    else {
      const keys = context.localKeys(true);
      if (!keys) { err('magnus-agent: the node-local keys are not available (see the agent log); nothing was re-sealed'); return 1; }
      archive = await archiveDirectory(context.installDir, now);
      resealed = await context.barrier.resealHistoricalSettlements(keys, archive.keep);
    }
    if (archive) await writeManifest(archive.directory, { version: 1, action: 'reseal', at: now.toISOString(), resealed });
    if (json) out(JSON.stringify({ action, apply, resealed, archive: archive?.directory ?? null }));
    else if (!resealed.length) out('Every readable settlement already verifies with the node-local keys; nothing to re-seal.');
    else {
      out(`${apply ? 'Re-sealed' : 'Would re-seal'} ${resealed.length} settlement(s) with the node-local keys:`);
      for (const id of resealed) out(`  ${id}`);
      out(apply ? `The originals are kept in ${archive!.directory}.` : 'Run again with --apply to write them (as root).');
    }
    return 0;
  }

  const archive = apply ? await archiveDirectory(context.installDir, now) : null;
  const plans = await context.barrier.archiveUnverifiableSettlements({ localKeys: context.localKeys(false),
    withRecords: flags.has('--with-records'), archive: archive?.keep ?? null });
  if (archive) await writeManifest(archive.directory, { version: 1, action: 'prune-unverifiable', at: now.toISOString(), plans });
  if (json) out(JSON.stringify({ action, apply, plans, archive: archive?.directory ?? null }));
  else if (!plans.length) out('No unverifiable settlements; nothing to archive.');
  else {
    const what: Record<SettlementArchivePlan['record'], string> = {
      'archived': 'its record archived with it',
      'would-archive': 'its record would be archived with it',
      'retained-unsettled': 'its record stays and counts as unknown again until settled anew (or use --with-records)',
      'not-retained': 'no retained record: the agent never reads it',
      'kept-bytes-differ': 'its record stays: its bytes are not the ones the settlement names',
      'kept-not-before-boot': 'its record stays: it was accepted after the current kernel boot',
    };
    out(`${apply ? 'Archived' : 'Would archive'} ${plans.length} unverifiable settlement(s):`);
    for (const plan of plans) out(`  ${plan.recordId}  ${plan.state.padEnd(12)}  ${what[plan.record]}`);
    out(apply ? `Kept in ${archive!.directory}.` : 'Run again with --apply to move them (as root).');
  }
  return 0;
}

/** Make a node-local key file created by root readable by the agent's own account again. */
export function keepIdentityOwner(installDir: string, files: readonly string[]): void {
  if (process.getuid?.() !== 0) return;
  const directory = resolve(installDir, 'identity');
  let owner;
  try { owner = lstatSync(directory); } catch { return; }
  for (const name of files) {
    const file = join(directory, name);
    try { const info = lstatSync(file); if (info.isFile() && info.uid !== owner.uid) chownSync(file, owner.uid, owner.gid); }
    catch { /* not created */ }
  }
}
