import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

// The context adapter comes from the pinned, published @hivemagnus/ardent (a devDependency;
// source: https://github.com/ChefTaco/Ardent), together with the Emberfold engine it depends on.
const ardentEntry = createRequire(join(import.meta.dirname, 'package.json')).resolve('@hivemagnus/ardent');
const ardent = resolve(dirname(ardentEntry), '..');
const ardentManifest = JSON.parse(await readFile(join(ardent, 'package.json'), 'utf8'));
const pinned = JSON.parse(await readFile(join(import.meta.dirname, 'package.json'), 'utf8')).devDependencies['@hivemagnus/ardent'];
if (ardentManifest.name !== '@hivemagnus/ardent' || ardentManifest.version !== pinned)
  throw new Error(`Installed Ardent ${ardentManifest.version} differs from the pinned ${pinned}`);
const require = createRequire(join(ardent, 'package.json'));
const engine = resolve(dirname(require.resolve('@hivemagnus/emberfold')), '..');
const zod = dirname(createRequire(join(engine, 'package.json')).resolve('zod/package.json'));
const files = [];
const add = async (source, path, transform) => {
  const original = await readFile(source);
  const bytes = transform ? Buffer.from(transform(original.toString('utf8'))) : original;
  files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') });
};
for (const name of ['context', 'context-checkpoints', 'context-maintenance']) await add(join(ardent, 'dist', name + '.js'), 'ardent/' + name + '.js');
// Ardent 3's storage boundary needs its own patched driver when overlaid on
// an older runtime. Bundle only the reviewed Linux/glibc runtime files, keeping
// staging offline and including every dependency in the candidate tree digest.
const hasStorageBoundary = await access(join(ardent, 'dist/sqlite.js')).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
if (hasStorageBoundary) {
  await add(join(ardent, 'dist/sqlite.js'), 'ardent/sqlite.js', source => {
    const from = "from '@photostructure/sqlite'";
    if (source.split(from).length - 1 !== 1) throw new Error('Context SQLite import differs');
    return source.replace(from, "from './context-sqlite/dist/index.mjs'");
  });
  const sqlite = dirname(require.resolve('@photostructure/sqlite/package.json'));
  const sqliteManifest = JSON.parse(await readFile(join(sqlite, 'package.json'), 'utf8'));
  if (sqliteManifest.name !== '@photostructure/sqlite' || sqliteManifest.version !== '3.3.1') throw new Error('Context SQLite driver pin differs');
  for (const name of ['package.json', 'LICENSE']) await add(join(sqlite, name), 'sqlite/' + name);
  for (const name of await readdir(join(sqlite, 'dist'))) {
    if (/^(?:index\.(?:mjs|cjs)|chunk-[A-Z0-9]+\.mjs)$/.test(name)) await add(join(sqlite, 'dist', name), 'sqlite/dist/' + name);
  }
  for (const arch of ['x64', 'arm64']) await add(join(sqlite, 'prebuilds/linux-' + arch, '@photostructure+sqlite.glibc.node'),
    'sqlite/prebuilds/linux-' + arch + '/@photostructure+sqlite.glibc.node');
  const sqliteRequire = createRequire(join(sqlite, 'package.json'));
  const loader = dirname(sqliteRequire.resolve('node-gyp-build/package.json'));
  const loaderManifest = JSON.parse(await readFile(join(loader, 'package.json'), 'utf8'));
  if (loaderManifest.name !== 'node-gyp-build' || loaderManifest.version !== '4.8.4') throw new Error('Context SQLite loader pin differs');
  for (const name of ['package.json', 'LICENSE', 'index.js', 'node-gyp-build.js', 'optional.js']) await add(join(loader, name), 'sqlite-loader/' + name);
}

const walk = async (directory, prefix, filter) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Context runtime payload must not contain symlinks');
    if (entry.isDirectory()) await walk(join(directory, entry.name), relative + '/', filter);
    else if (entry.isFile() && filter(relative)) await add(join(directory, entry.name), relative);
  }
};
for (const name of ['package.json', 'LICENSE', 'NOTICE', 'README.md']) await add(join(engine, name), 'emberfold/' + name);
await walk(join(engine, 'dist'), 'emberfold/dist/', path => /\.(js|d\.ts)$/.test(path));
for (const name of ['package.json', 'index.js', 'LICENSE']) await add(join(zod, name), 'zod/' + name);
await walk(join(zod, 'v4'), 'zod/v4/', path => path.endsWith('.js'));
files.sort((first, second) => first.path.localeCompare(second.path, 'en'));
const manifest = { schema_version: hasStorageBoundary ? 2 : 1, engine_version: JSON.parse(await readFile(join(engine, 'package.json'))).version,
  validator_version: JSON.parse(await readFile(join(zod, 'package.json'))).version, files };
if (manifest.engine_version !== '0.1.0' || manifest.validator_version !== '4.6.7') throw new Error('Context runtime dependency pin differs');
if (files.reduce((total, file) => total + Buffer.from(file.content, 'base64').length, 0) > 12 * 1024 * 1024) throw new Error('Context payload exceeds the reviewed size bound');
const bytes = JSON.stringify(manifest);
await mkdir(join(import.meta.dirname, 'dist'), { recursive: true });
await writeFile(join(import.meta.dirname, 'dist/ardent-context-bundle.json'), bytes);
console.log(`Context overlay: ${files.length} files, ${Buffer.byteLength(bytes)} bytes`);
