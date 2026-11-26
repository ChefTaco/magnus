import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

// The published agent ships Ardent's journal module rewired onto journal-sqlite.js (see
// build-journal-module.mjs). Exercise that built file, so iterate() runs through the agent's driver.
const built = pathToFileURL(resolve('dist/native-snapshot/journal.js')).href;
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'magnus-journal-dist-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('built journal module', () => {
  it('iterates A2A task and team child claim rows through the agent SQLite driver', async () => {
    const path = join(directory, 'ardent.sqlite'), db = new DatabaseSync(path);
    db.exec('CREATE TABLE a2a_tasks(id TEXT PRIMARY KEY, status TEXT NOT NULL, task_json TEXT NOT NULL);'
      + 'CREATE TABLE a2a_team_child_claims(id TEXT PRIMARY KEY, acknowledged INTEGER, settlement_json TEXT);');
    const task = (id: string, state: number) => JSON.stringify({ id, contextId: 'fixture', status: { state } });
    const insertTask = db.prepare('INSERT INTO a2a_tasks VALUES (?,?,?)');
    insertTask.run('working', '1', task('working', 1));
    insertTask.run('unspecified', '0', task('unspecified', 0));
    insertTask.run('done', '3', task('done', 3));
    const insertClaim = db.prepare('INSERT INTO a2a_team_child_claims VALUES (?,?,?)');
    insertClaim.run('pending', null, null);
    insertClaim.run('lost', 1, JSON.stringify({ outcome: 'unknown' }));
    insertClaim.run('waiting', 1, JSON.stringify({ outcome: 'input_required' }));
    insertClaim.run('settled', 1, JSON.stringify({ outcome: 'completed' }));
    db.close();
    const { inspectJournalFile } = await import(built) as typeof import('./journal.js');
    const status = inspectJournalFile(path);
    expect(status).toMatchObject({ idle: false, active: 3, unknown: 2, unsupported: 0 });
    expect(status.tables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'a2a_tasks', active: 1, unknown: 1 }),
      expect.objectContaining({ name: 'a2a_team_child_claims', active: 2, unknown: 1 }),
    ]));
  });
});
