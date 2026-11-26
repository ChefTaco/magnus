import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { journalImports } from './journal-imports.mjs';

// Ardent's journal policy and inspector come from the pinned, published @hivemagnus/ardent (a
// devDependency; source: https://github.com/ChefTaco/Ardent). tsc emits src/native-snapshot/journal.ts
// as a re-export of '@hivemagnus/ardent/journal'; replace it with Ardent's own module so the
// published agent ships the policy without the Ardent runtime, reading SQLite through journal-sqlite.js.
const ardentEntry = createRequire(join(import.meta.dirname, 'package.json')).resolve('@hivemagnus/ardent');
const ardent = resolve(dirname(ardentEntry), '..');
const ardentManifest = JSON.parse(await readFile(join(ardent, 'package.json'), 'utf8'));
const pinned = JSON.parse(await readFile(join(import.meta.dirname, 'package.json'), 'utf8')).devDependencies['@hivemagnus/ardent'];
if (ardentManifest.name !== '@hivemagnus/ardent' || ardentManifest.version !== pinned)
  throw new Error(`Installed Ardent ${ardentManifest.version} differs from the pinned ${pinned}`);

const dist = join(import.meta.dirname, 'dist');
const target = join(dist, 'native-snapshot/journal.js');
const marker = `// Ardent journal module from @hivemagnus/ardent@${ardentManifest.version} (Apache-2.0), dist/journal.js.\n`;
const reexport = "export { inspectJournalFile, JOURNAL_POLICY_VERSION } from '@hivemagnus/ardent/journal';";
const emitted = await readFile(target, 'utf8');
if (!emitted.startsWith(marker) && !emitted.split('\n').some(line => line === reexport))
  throw new Error(`${target} is neither the compiled re-export nor a copy of Ardent ${ardentManifest.version}'s journal module`);

// The inspector must stay dependency-light: refuse any import beyond this reviewed set.
const source = await readFile(join(ardent, 'dist/journal.js'), 'utf8');
const imports = journalImports(source);
const reviewed = ['./sqlite.js', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:os', 'node:path', 'node:stream/promises', 'zod'];
if (JSON.stringify(imports) !== JSON.stringify(reviewed) || /\bimport\s*\(|\brequire\s*\(/.test(source))
  throw new Error(`Ardent journal module imports changed: ${imports.join(', ')}`);
const driver = "import Database from './sqlite.js';";
if (source.split(driver).length - 1 !== 1) throw new Error('Ardent journal SQLite import differs');
await writeFile(target, marker + source.replace(driver, "import Database from './journal-sqlite.js';"));
await writeFile(join(dist, 'native-snapshot/journal.d.ts'), await readFile(join(ardent, 'dist/journal.d.ts')));
for (const map of ['journal.js.map', 'journal.d.ts.map']) await rm(join(dist, 'native-snapshot', map), { force: true });

// No compiled file may load the Ardent package itself; it is not a runtime dependency.
const walk = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path) : Promise.resolve(entry.name.endsWith('.js') ? [path] : []);
}))).flat();
for (const file of await walk(dist)) {
  if (/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]@hivemagnus\/ardent(?:\/[^'"]*)?['"]/.test(await readFile(file, 'utf8'))) throw new Error(`${file} imports @hivemagnus/ardent at runtime`);
}

// Smoke-test the shipped module with the agent's own driver.
const scratch = await mkdtemp(join(tmpdir(), 'magnus-journal-build-'));
try {
  const path = join(scratch, 'ardent.sqlite'), db = new DatabaseSync(path);
  db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY, state TEXT NOT NULL); INSERT INTO tasks VALUES ('a','queued'),('b','completed'),('c','unknown'); CREATE TABLE private_queue(payload TEXT);");
  db.close();
  const { inspectJournalFile } = await import(pathToFileURL(target).href);
  const status = inspectJournalFile(path);
  if (status.policy_version !== 1 || status.active !== 1 || status.unknown !== 1 || status.unsupported !== 1)
    throw new Error(`Ardent journal module smoke test failed: ${JSON.stringify(status)}`);
} finally { await rm(scratch, { recursive: true, force: true }); }
console.log(`Journal policy: @hivemagnus/ardent@${ardentManifest.version} dist/journal.js`);
