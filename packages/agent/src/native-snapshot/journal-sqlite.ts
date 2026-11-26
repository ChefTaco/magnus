/**
 * The SQLite driver for Ardent's journal inspector in the published agent (see journal.ts). It
 * implements only what that inspector uses: a read-only, must-exist open, prepared statements and
 * close. Extensions stay disabled.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

type Values = SQLInputValue[];
export default class Database {
  readonly #database: DatabaseSync;
  constructor(path: string, options: { readonly?: boolean; fileMustExist?: boolean } = {}) {
    if (options.readonly !== true || options.fileMustExist !== true) throw new Error('Journal inspection opens existing databases read-only');
    const location = pathToFileURL(path);
    location.searchParams.set('mode', 'ro');
    this.#database = new DatabaseSync(location, { readOnly: true, allowExtension: false });
  }
  prepare(sql: string): { all(...values: Values): unknown[]; get(...values: Values): unknown; iterate(...values: Values): Iterable<unknown> } {
    const statement = this.#database.prepare(sql);
    return { all: (...values) => statement.all(...values), get: (...values) => statement.get(...values), iterate: (...values) => statement.iterate(...values) };
  }
  close(): void { if (this.#database.isOpen) this.#database.close(); }
}
