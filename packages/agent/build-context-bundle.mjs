import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const ardent = join(root, 'ardent');
const require = createRequire(join(ardent, 'package.json'));
const engine = resolve(dirname(require.resolve('@hivemagnus/emberfold')), '..');
const zod = dirname(createRequire(join(engine, 'package.json')).resolve('zod/package.json'));
const files = [];
const add = async (source, path) => {
  const bytes = await readFile(source);
  files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') });
};
for (const name of ['context', 'context-checkpoints', 'context-maintenance']) {
  const source = await readFile(join(ardent, 'src', name + '.ts'), 'utf8');
  const result = ts.transpileModule(source, { fileName: name + '.ts', reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true } });
  if (result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error))
    throw new Error('Context adapter transpilation failed: ' + name);
  const bytes = Buffer.from(result.outputText);
  files.push({ path: 'ardent/' + name + '.js', sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') });
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
const manifest = { schema_version: 1, engine_version: JSON.parse(await readFile(join(engine, 'package.json'))).version,
  validator_version: JSON.parse(await readFile(join(zod, 'package.json'))).version, files };
if (manifest.engine_version !== '0.1.0' || manifest.validator_version !== '4.6.7') throw new Error('Context runtime dependency pin differs');
const bytes = JSON.stringify(manifest);
await mkdir(join(import.meta.dirname, 'dist'), { recursive: true });
await writeFile(join(import.meta.dirname, 'dist/ardent-context-bundle.json'), bytes);
console.log(`Context overlay: ${files.length} files, ${Buffer.byteLength(bytes)} bytes`);
