/** Read-only Ardent journal check. New/private schemas are retained but cannot authorize startup. */
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileHash, plainPath, statOptional } from './files.js';
import { inspectJournalFile } from './journal.js';

/** Ardent's policy format this agent reads; a different version may count work differently. */
const SUPPORTED_POLICY_VERSION = 1;

/** Ardent classifies every table and state; no TaskStore, runtime, plugin, queue handler or captured module runs. */
function inspectPrivateSqlite(path: string): { active: number; unknown: number; unsupported: number } {
  const status = inspectJournalFile(path);
  if (status.policy_version !== SUPPORTED_POLICY_VERSION) throw new Error(`Unsupported Ardent journal policy version ${String(status.policy_version)}`);
  return { active: status.active, unknown: status.unknown, unsupported: status.unsupported };
}

/** SQLite readOnly can still create/modify source WAL/SHM. Inspect a byte-verified private copy,
 * retaining the WAL so committed, uncheckpointed work is never mistaken for an idle database. */
export async function inspectSqlite(path: string): Promise<{ active: number; unknown: number; unsupported: number }> {
  await plainPath(path);
  const scratch = await mkdtemp(join(tmpdir(), 'magnus-native-sqlite-'));
  await chmod(scratch, 0o700);
  try {
    const destination = join(scratch, 'journal.sqlite');
    const sources: Array<{ path: string; copied: string; sha256: string }> = [];
    for (const suffix of ['', '-wal']) {
      const source = path + suffix;
      await plainPath(source, true);
      if (!await statOptional(source)) {
        if (suffix === '') throw new Error('Native database disappeared before private inspection');
        continue;
      }
      const digest = await fileHash(source), copied = destination + suffix;
      await copyFile(source, copied); await chmod(copied, 0o600);
      if (await fileHash(copied) !== digest) throw new Error('Native database changed while copying its private inspection snapshot');
      sources.push({ path: source, copied, sha256: digest });
    }
    const result = inspectPrivateSqlite(destination);
    for (const source of sources) if (await fileHash(source.path) !== source.sha256) throw new Error('Native database changed during private inspection');
    const hadWal = sources.some(source => source.path === path + '-wal');
    if ((await statOptional(path + '-wal') !== null) !== hadWal) throw new Error('Native database WAL membership changed during private inspection');
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
