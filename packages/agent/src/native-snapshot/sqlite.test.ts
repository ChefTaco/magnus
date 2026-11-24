import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectSqlite } from './sqlite.js';
import { sqliteFile } from './files.js';
import { sha256 } from './files.js';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'magnus-journal-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function database(sql: string, name = 'ardent.sqlite') {
  const path = join(directory, name), db = new DatabaseSync(path); db.exec(sql); db.close(); await chmod(path, 0o600); return path;
}
describe('offline journal startup safety', () => {
  it('recognizes terminal partial tasks and superseded windows without mistaking historical retry receipts for runnable work', async () => {
    const path = await database("CREATE TABLE tasks(state TEXT); INSERT INTO tasks VALUES('partial'); CREATE TABLE job_windows(state TEXT); INSERT INTO job_windows VALUES('superseded'); CREATE TABLE job_attempts(state TEXT); INSERT INTO job_attempts VALUES('retry');");
    expect(await inspectSqlite(path)).toEqual({ active: 0, unknown: 0, unsupported: 0 });
  });
  it.each([['1.0', 'TASK_STATE_SUBMITTED', 'active'], ['2', 'TASK_STATE_WORKING', 'active'], ['6.0', 'TASK_STATE_INPUT_REQUIRED', 'active'], ['8', 'TASK_STATE_AUTH_REQUIRED', 'active'], ['0', 'TASK_STATE_UNSPECIFIED', 'unknown']])('holds A2A status %s/%s instead of skipping a status-only table', async (status, recorded, kind) => {
    const path = await database('CREATE TABLE a2a_tasks(status TEXT,task_json TEXT)'); const db = new DatabaseSync(path);
    db.prepare('INSERT INTO a2a_tasks VALUES(?,?)').run(status, JSON.stringify({ id: 'fixture', contextId: 'fixture', status: { state: recorded } })); db.close();
    expect((await inspectSqlite(path))[kind as 'active' | 'unknown']).toBeGreaterThan(0);
  });
  it('accepts terminal A2A status only when indexed and serialized states agree; malformed/mismatched schemas hold', async () => {
    const path = await database('CREATE TABLE a2a_tasks(status TEXT,task_json TEXT)'); const db = new DatabaseSync(path);
    db.prepare('INSERT INTO a2a_tasks VALUES(?,?)').run('3.0', JSON.stringify({ id: 'fixture', contextId: 'fixture', status: { state: 'TASK_STATE_COMPLETED' } })); db.close();
    expect(await inspectSqlite(path)).toEqual({ active: 0, unknown: 0, unsupported: 0 });
    const changed = new DatabaseSync(path); changed.prepare('UPDATE a2a_tasks SET task_json=?').run(JSON.stringify({ id: 'fixture', contextId: 'fixture', status: { state: 'TASK_STATE_WORKING' } })); changed.close();
    expect(await inspectSqlite(path)).toEqual({ active: 1, unknown: 0, unsupported: 1 });
  });
  it('holds startup settlement flushes even when their table has neither state nor status', async () => {
    const path = await database(`CREATE TABLE a2a_team_child_claims(acknowledged INTEGER,settlement_json TEXT);
      INSERT INTO a2a_team_child_claims VALUES(0,'{"outcome":"completed"}'),(1,'{"outcome":"unknown"}');`);
    expect(await inspectSqlite(path)).toEqual({ active: 1, unknown: 1, unsupported: 0 });
  });
  it('holds pending admission receipts and unknown/private schemas including tables with no state field', async () => {
    const path = await database('CREATE TABLE a2a_request_receipts(task_id TEXT); INSERT INTO a2a_request_receipts VALUES(NULL); CREATE TABLE private_queue(payload TEXT); CREATE TABLE future_status(status TEXT);');
    expect(await inspectSqlite(path)).toEqual({ active: 1, unknown: 0, unsupported: 2 });
  });
  it('does not treat a malformed known status-only schema as safe', async () => {
    const path = await database("CREATE TABLE a2a_tasks(status TEXT); INSERT INTO a2a_tasks VALUES('2');");
    expect((await inspectSqlite(path)).unsupported).toBeGreaterThan(0);
  });
  it('holds unbound inbound updates and the one-way rollback fence without changing either', async () => {
    const path = await database(`CREATE TABLE channel_inbound(platform TEXT,account TEXT,update_id TEXT,task_id TEXT);
      CREATE TABLE channel_deliveries(id TEXT,platform TEXT,account TEXT,update_id TEXT,state TEXT);
      INSERT INTO channel_inbound VALUES('fixture','fixture','1',NULL);
      CREATE TABLE admission_fence(release_id TEXT); INSERT INTO admission_fence VALUES('fixture');`);
    expect(await inspectSqlite(path)).toEqual({ active: 1, unknown: 0, unsupported: 1 });
  });
  it('knows the Ardent 3.2.0 recovery, transfer, ancestry and catch-up tables', async () => {
    const schema = `CREATE TABLE tasks(state TEXT); INSERT INTO tasks VALUES('completed');
      CREATE TABLE execution_state(task_id TEXT,messages_json TEXT); CREATE TABLE task_execution(task_id TEXT,root_ref TEXT);
      CREATE TABLE artifact_renditions(original_sha256 TEXT); CREATE TABLE plugin_hook_failures(plugin TEXT);
      CREATE TABLE channel_catchup_gaps(reason TEXT); CREATE TABLE channel_catchup_runs(state TEXT); INSERT INTO channel_catchup_runs VALUES('catching_up'),('interrupted');
      CREATE TABLE a2a_recovery_publications(state TEXT,final INTEGER); INSERT INTO a2a_recovery_publications VALUES('unknown',0);
      CREATE TABLE tool_invocations(state TEXT); INSERT INTO tool_invocations VALUES('succeeded'),('not_dispatched'),('operator_applied');
      CREATE TABLE task_recovery(status TEXT); INSERT INTO task_recovery VALUES('resumed'),('resolved');
      CREATE TABLE artifact_transfers(state TEXT); INSERT INTO artifact_transfers VALUES('completed'),('failed');
      CREATE TABLE channel_inbound(platform TEXT,account TEXT,update_id TEXT,task_id TEXT,disposition TEXT);
      CREATE TABLE channel_deliveries(id TEXT,platform TEXT,account TEXT,update_id TEXT,state TEXT);
      INSERT INTO channel_inbound VALUES('fixture','fixture','old',NULL,'skipped_stale');`;
    // Settled recovery and transfer history, ledgers and a stale post skipped by catch-up are not work.
    expect(await inspectSqlite(await database(schema))).toEqual({ active: 0, unknown: 0, unsupported: 0 });
    const busy = await database(`${schema}
      INSERT INTO tool_invocations VALUES('dispatched'),('failed_unknown');
      INSERT INTO task_recovery VALUES('reconciling'),('awaiting_decision'),('unsupported');
      INSERT INTO artifact_transfers VALUES('transferring');
      INSERT INTO channel_inbound VALUES('fixture','fixture','new',NULL,'admitted');`, 'busy.sqlite');
    expect(await inspectSqlite(busy)).toEqual({ active: 4, unknown: 3, unsupported: 0 });
    const odd = await database("CREATE TABLE tool_invocations(state TEXT); INSERT INTO tool_invocations VALUES('future_state');", 'odd.sqlite');
    expect((await inspectSqlite(odd)).unsupported).toBe(1);
  });
  it('detects sqlite3 and extensionless SQLite headers for private job databases', async () => {
    const sqlite3 = await database("CREATE TABLE job_windows(state TEXT); INSERT INTO job_windows VALUES('retry');", 'jobs.sqlite3');
    const extensionless = await database("CREATE TABLE private_queue(payload TEXT);", 'private-journal');
    expect(await sqliteFile(sqlite3)).toBe(true); expect((await inspectSqlite(sqlite3)).active).toBe(1);
    expect(await sqliteFile(extensionless)).toBe(true); expect((await inspectSqlite(extensionless)).unsupported).toBe(1);
  });
  it('never creates source WAL/SHM for a closed WAL-mode database', async () => {
    const path = join(directory, 'closed.sqlite'), db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE tasks(state TEXT); INSERT INTO tasks VALUES('completed');"); db.close();
    const names = await readdir(directory), before = await lstat(path);
    expect(await inspectSqlite(path)).toEqual({ active: 0, unknown: 0, unsupported: 0 });
    expect(await readdir(directory)).toEqual(names);
    const after = await lstat(path); expect([after.mtimeMs, after.ctimeMs, after.size]).toEqual([before.mtimeMs, before.ctimeMs, before.size]);
  });
  it('includes committed uncheckpointed WAL work while leaving the live source and SHM byte-for-byte untouched', async () => {
    const path = join(directory, 'live.sqlite'), db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE tasks(state TEXT); INSERT INTO tasks VALUES('queued');");
      const snapshot = async () => Promise.all((await readdir(directory)).sort().map(async name => {
        const file = join(directory, name), info = await lstat(file);
        return { name, bytes: sha256(await readFile(file)), mtime: info.mtimeMs, ctime: info.ctimeMs, mode: info.mode, uid: info.uid, gid: info.gid };
      }));
      const before = await snapshot();
      expect(await inspectSqlite(path)).toEqual({ active: 1, unknown: 0, unsupported: 0 });
      expect(await snapshot()).toEqual(before);
    } finally { db.close(); }
  });
});
