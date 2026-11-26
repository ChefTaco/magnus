import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '@hivemagnus/ardent';
import { inspectSqlite } from './sqlite.js';
import { inspectJournalFile } from './journal.js';
import Database from './journal-sqlite.js';
import { sha256, sqliteFile } from './files.js';

vi.mock('./journal.js', async original => {
  const actual = await original<typeof import('./journal.js')>();
  return { ...actual, inspectJournalFile: vi.fn(actual.inspectJournalFile) };
});
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'magnus-journal-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

/** A journal written by Ardent's own task store, so fixtures carry the real schema. */
async function journal(build: (store: TaskStore) => void = () => {}, name = 'ardent.sqlite') {
  const path = join(directory, name), store = new TaskStore(path);
  try { build(store); } finally { store.close(); }
  await chmod(path, 0o600); return path;
}
const task = (store: TaskStore) => store.accept({ caller: 'fixture', context: 'direct', prompt: 'fixture', backend: 'llamacpp', deadlineMs: Date.now() + 60_000 });

describe('offline journal startup safety', () => {
  it('reports a fresh Ardent journal and settled tasks as idle', async () => {
    expect(await inspectSqlite(await journal())).toEqual({ active: 0, unknown: 0, unsupported: 0 });
    const settled = await journal(store => { store.finishWithAssistant(task(store).id, 'completed', 'done'); store.setState(task(store).id, 'failed'); }, 'settled.sqlite');
    expect(await inspectSqlite(settled)).toEqual({ active: 0, unknown: 0, unsupported: 0 });
  });
  it('counts queued and running tasks as work and an unknown outcome as uncertain', async () => {
    const path = await journal(store => {
      task(store); store.startQueued(task(store).id); store.setState(task(store).id, 'unknown');
      store.finishWithAssistant(task(store).id, 'partial', 'part');
    });
    expect(await inspectSqlite(path)).toEqual({ active: 2, unknown: 1, unsupported: 0 });
  });
  it('holds an admitted chat update with no task and the closed one-way rollback fence', async () => {
    const path = await journal(store => { store.claimInbound('telegram', 'fixture', '1'); store.closeAdmission(randomUUID()); });
    expect(await inspectSqlite(path)).toEqual({ active: 1, unknown: 0, unsupported: 1 });
  });
  it('holds tables and state values Ardent does not classify', async () => {
    const path = await journal(store => {
      const id = task(store).id;
      store.db.exec(`CREATE TABLE private_queue(payload TEXT); UPDATE tasks SET state='future_state' WHERE id='${id}'`);
    });
    expect(await inspectSqlite(path)).toEqual({ active: 0, unknown: 0, unsupported: 2 });
  });
  it('refuses a journal policy version this agent does not read', async () => {
    const path = await journal();
    vi.mocked(inspectJournalFile).mockReturnValueOnce({ policy_version: 2, idle: true, active: 0, unknown: 0, unsupported: 0, tables: [] });
    await expect(inspectSqlite(path)).rejects.toThrow(/Unsupported Ardent journal policy version 2/);
  });
  it('refuses a journal that fails its integrity check', async () => {
    const path = join(directory, 'broken.sqlite'), db = new DatabaseSync(path);
    db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE tasks(id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE events(id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id)); INSERT INTO events VALUES (1,'missing');`); db.close();
    await expect(inspectSqlite(path)).rejects.toThrow(/foreign-key/);
  });
  it('detects sqlite3 and extensionless SQLite headers for private job databases', async () => {
    const sqlite3 = await journal(store => { task(store); }, 'jobs.sqlite3');
    const extensionless = join(directory, 'private-journal'), db = new DatabaseSync(extensionless);
    db.exec('CREATE TABLE private_queue(payload TEXT);'); db.close();
    expect(await sqliteFile(sqlite3)).toBe(true); expect((await inspectSqlite(sqlite3)).active).toBe(1);
    expect(await sqliteFile(extensionless)).toBe(true); expect((await inspectSqlite(extensionless)).unsupported).toBe(1);
  });
  it('never creates source WAL/SHM for a closed WAL-mode database', async () => {
    const path = await journal(store => { store.finishWithAssistant(task(store).id, 'completed', 'done'); });
    const names = await readdir(directory), before = await lstat(path);
    expect(await inspectSqlite(path)).toEqual({ active: 0, unknown: 0, unsupported: 0 });
    expect(await readdir(directory)).toEqual(names);
    const after = await lstat(path); expect([after.mtimeMs, after.ctimeMs, after.size]).toEqual([before.mtimeMs, before.ctimeMs, before.size]);
  });
  it('includes committed uncheckpointed WAL work while leaving the live source and SHM byte-for-byte untouched', async () => {
    const path = join(directory, 'live.sqlite'), store = new TaskStore(path);
    try {
      task(store);
      const snapshot = async () => Promise.all((await readdir(directory)).sort().map(async name => {
        const file = join(directory, name), info = await lstat(file);
        return { name, bytes: sha256(await readFile(file)), mtime: info.mtimeMs, ctime: info.ctimeMs, mode: info.mode, uid: info.uid, gid: info.gid };
      }));
      const before = await snapshot();
      expect(before.map(file => file.name)).toContain('live.sqlite-wal');
      expect(await inspectSqlite(path)).toEqual({ active: 1, unknown: 0, unsupported: 0 });
      expect(await snapshot()).toEqual(before);
    } finally { store.close(); }
  });
});

describe('published journal driver', () => {
  it('opens only existing databases, read-only, and reads them', async () => {
    const path = await journal(store => { task(store); });
    expect(() => new Database(path)).toThrow(/read-only/);
    expect(() => new Database(path, { readonly: true })).toThrow(/read-only/);
    const missing = join(directory, 'missing.sqlite');
    expect(() => new Database(missing, { readonly: true, fileMustExist: true })).toThrow();
    expect(await readdir(directory)).not.toContain('missing.sqlite');
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM tasks WHERE state='queued'").get()).toEqual({ count: 1 });
      expect([...db.prepare('SELECT state FROM tasks').iterate()]).toEqual([{ state: 'queued' }]);
      expect(() => db.prepare("UPDATE tasks SET state='completed'").all()).toThrow(/readonly/);
    } finally { db.close(); }
  });
});
