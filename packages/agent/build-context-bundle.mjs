import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
const add = async (source, path) => {
  const bytes = await readFile(source);
  files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') });
};
for (const name of ['context', 'context-checkpoints', 'context-maintenance']) await add(join(ardent, 'dist', name + '.js'), 'ardent/' + name + '.js');
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
const manifest = { schema_version: 1, engine_version: JSON.parse(await readFile(join(engine, 'package.json'))).version,
  validator_version: JSON.parse(await readFile(join(zod, 'package.json'))).version, files };
if (manifest.engine_version !== '0.1.0' || manifest.validator_version !== '4.6.7') throw new Error('Context runtime dependency pin differs');
const bytes = JSON.stringify(manifest);
await mkdir(join(import.meta.dirname, 'dist'), { recursive: true });
await writeFile(join(import.meta.dirname, 'dist/ardent-context-bundle.json'), bytes);
console.log(`Context overlay: ${files.length} files, ${Buffer.byteLength(bytes)} bytes`);
