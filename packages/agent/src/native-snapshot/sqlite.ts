/** Read-only Ardent journal policy. New/private schemas are retained but cannot authorize startup. */
import { DatabaseSync } from 'node:sqlite';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { fileHash, plainPath, statOptional } from './files.js';

const currentStates: Record<string, { column: 'state' | 'status'; terminal: string[] }> = {
  tasks: { column: 'state', terminal: ['completed', 'partial', 'failed', 'cancelled'] },
  channel_deliveries: { column: 'state', terminal: ['sent', 'failed'] },
  job_windows: { column: 'state', terminal: ['completed', 'failed', 'superseded'] },
  // Attempts are immutable receipts: a historical retry is not runnable work; the window owns retry admission.
  job_attempts: { column: 'state', terminal: ['completed', 'failed', 'superseded', 'retry'] },
  a2a_push_deliveries: { column: 'state', terminal: ['sent', 'failed'] },
  a2a_outbound_calls: { column: 'state', terminal: ['failed'] },
  a2a_team_artifacts: { column: 'status', terminal: ['available', 'revoked'] },
  a2a_team_artifact_transfers: { column: 'status', terminal: ['complete'] },
};
const passiveTables = new Set([
  'sessions', 'session_messages', 'channel_cursors', 'channel_preferences', 'events',
  'context_checkpoints', 'context_checkpoint_heads', 'context_compaction_attempts', 'emberfold_checkpoint_metadata',
  'task_admission', 'job_scan', 'artifact_manifests', 'artifact_sweeps', 'development_records',
  'a2a_operation_map', 'a2a_operation_links', 'a2a_team_missions', 'a2a_team_control_requests', 'a2a_team_controls',
  'a2a_team_admission', 'a2a_push_configs', 'a2a_inbound_push',
]);
const specialTables = new Set(['a2a_tasks', 'a2a_team_child_claims', 'a2a_request_receipts', 'channel_inbound', 'admission_fence']);
const pending = new Set(['queued', 'running', 'input_required', 'retry', 'admitting', 'active', 'sending', 'started', 'pending', 'bound']);
const a2aStates = ['UNSPECIFIED', 'SUBMITTED', 'WORKING', 'COMPLETED', 'FAILED', 'CANCELED', 'INPUT_REQUIRED', 'REJECTED', 'AUTH_REQUIRED'];
function a2aState(value: unknown): number | null {
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.0+)?$/.test(value))) {
    const number = Number(value); return Number.isInteger(number) && number >= 0 && number < a2aStates.length ? number : null;
  }
  if (typeof value !== 'string') return null;
  const key = value.replace(/^TASK_STATE_/, '').replace(/-/g, '_').toUpperCase();
  const index = a2aStates.indexOf(key); return index < 0 ? null : index;
}
/** No TaskStore, runtime, plugin, queue handler or captured module is imported or initialized. */
function inspectPrivateSqlite(path: string): { active: number; unknown: number; unsupported: number } {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    const check = db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0]!)[0] !== 'ok') throw new Error('Native database integrity check failed');
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Native database foreign-key integrity check failed');
    let active = 0, unknown = 0, unsupported = 0;
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length === 0) unsupported++;
    const names = new Set(tables.map(t => String(t['name'])));
    const count = (sql: string) => Number(db.prepare(sql).get()!['count']);
    for (const table of tables) {
      const id = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).parse(table['name']);
      const columns = new Set(db.prepare(`PRAGMA table_info("${id}")`).all().map(c => String(c['name'])));
      if (typeof table['sql'] !== 'string' || /CREATE\s+VIRTUAL\s+TABLE/i.test(table['sql'])) { unsupported++; continue; }
      if (!currentStates[id] && !passiveTables.has(id) && !specialTables.has(id)) { unsupported++; continue; }
      const requireColumns = (...required: string[]) => {
        if (required.some(column => !columns.has(column))) { unsupported++; return false; }
        return true;
      };
      const policy = currentStates[id];
      if (policy) {
        if (!requireColumns(policy.column)) continue;
        if ((policy.column !== 'state' && columns.has('state')) || (policy.column !== 'status' && columns.has('status'))) unsupported++;
        for (const row of db.prepare(`SELECT "${policy.column}" AS value,count(*) AS count FROM "${id}" GROUP BY "${policy.column}"`).all()) {
          const state = String(row['value']), amount = Number(row['count']);
          if (state === 'unknown') unknown += amount;
          else if (pending.has(state) && !policy.terminal.includes(state)) active += amount;
          else if (!policy.terminal.includes(state)) unsupported += amount || 1;
        }
        continue;
      }
      if (id === 'a2a_tasks') {
        if (!requireColumns('status', 'task_json')) continue;
        if (columns.has('state')) unsupported++;
        for (const row of db.prepare('SELECT status,task_json FROM a2a_tasks').iterate()) {
          let json: unknown;
          try { json = JSON.parse(String(row['task_json'])); } catch { unsupported++; continue; }
          const parsed = z.object({ id: z.string().min(1), contextId: z.string(), status: z.object({ state: z.union([z.string(), z.number()]) }) }).safeParse(json);
          const indexed = a2aState(row['status']), recorded = parsed.success ? a2aState(parsed.data.status.state) : null;
          if (indexed === null || recorded === null || indexed !== recorded) unsupported++;
          for (const state of new Set([indexed, recorded])) {
            if (state === 0) unknown++;
            else if (state !== null && [1, 2, 6, 8].includes(state)) active++;
          }
        }
        continue;
      }
      if (columns.has('state') || columns.has('status')) { unsupported++; continue; }
      if (id === 'admission_fence') {
        // This is the existing one-way rollback fence; never clear it for a temporary snapshot.
        unsupported += count('SELECT count(*) AS count FROM admission_fence');
      } else if (id === 'a2a_team_child_claims') {
        if (!requireColumns('acknowledged', 'settlement_json')) continue;
        // Gateway startup flushes retained settlements, even though this table has no state column.
        active += count('SELECT count(*) AS count FROM a2a_team_child_claims WHERE acknowledged IS NULL OR acknowledged!=1 OR settlement_json IS NULL');
        for (const row of db.prepare('SELECT settlement_json FROM a2a_team_child_claims WHERE settlement_json IS NOT NULL').iterate()) {
          let value: unknown;
          try { value = JSON.parse(String(row['settlement_json'])); } catch { unsupported++; continue; }
          const outcome = z.object({ outcome: z.enum(['completed', 'partial', 'failed', 'blocked', 'input_required', 'cancelled', 'unknown']) }).safeParse(value);
          if (!outcome.success) unsupported++;
          else if (outcome.data.outcome === 'unknown') unknown++;
          else if (outcome.data.outcome === 'input_required') active++;
        }
      } else if (id === 'a2a_request_receipts') {
        if (requireColumns('task_id')) active += count("SELECT count(*) AS count FROM a2a_request_receipts WHERE task_id IS NULL OR task_id=''");
      } else if (id === 'channel_inbound') {
        if (!requireColumns('task_id', 'platform', 'account', 'update_id')) continue;
        if (!names.has('channel_deliveries')) { unsupported++; continue; }
        active += count(`SELECT count(*) AS count FROM channel_inbound AS inbound
          LEFT JOIN channel_deliveries AS delivery ON delivery.platform=inbound.platform
            AND delivery.account=inbound.account AND delivery.update_id=inbound.update_id
          WHERE inbound.task_id IS NULL AND (delivery.id IS NULL OR delivery.state IN ('queued','unknown'))`);
      }
    }
    return { active, unknown, unsupported };
  } finally { db.close(); }
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
