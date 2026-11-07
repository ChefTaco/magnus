#!/usr/bin/env node
// Checks the generated Ardent management API types in @hivemagnus/magnus-contracts against the
// OpenAPI document of the pinned, published @hivemagnus/ardent package (devDependency of the root
// and the agent). Ardent itself validates and pins the document in its own repository:
// https://github.com/ChefTaco/Ardent
//   node scripts/check-ardent-openapi.mjs           check src/ardent-openapi.ts
//   node scripts/check-ardent-openapi.mjs --write   regenerate it after upgrading Ardent
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import SwaggerParser from '@apidevtools/swagger-parser';

const root = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const generatedTypes = join(root, 'packages/contracts/src/ardent-openapi.ts');
const generator = join(root, 'node_modules/.bin/openapi-typescript');
// openapi-typescript 7 runs on the archived @redocly/openapi-core 1.x, which only calls minimatch
// to match resolve.http.headers from a Redocly config. The repo pins minimatch 11 everywhere
// (GHSA-g3hv-75wg-m249), so there must be no Redocly config next to the generator.
for (const name of ['redocly.yaml', '.redocly.yaml', 'redocly.yml', '.redocly.yml']) {
  if (existsSync(join(root, name))) throw new Error(`${join(root, name)}: a Redocly config is not supported by the pinned openapi-typescript toolchain`);
}
// The package exports only its entry point; the document builder lives next to it in dist/.
const entry = createRequire(join(root, 'package.json')).resolve('@hivemagnus/ardent');
const manifest = JSON.parse(await readFile(join(dirname(entry), '..', 'package.json'), 'utf8'));
const pinned = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).devDependencies['@hivemagnus/ardent'];
if (manifest.name !== '@hivemagnus/ardent' || manifest.version !== pinned) throw new Error(`Installed Ardent ${manifest.version} differs from the pinned ${pinned}; run npm ci`);
const { ardentOpenApi } = await import(pathToFileURL(join(dirname(entry), 'api.js')).href);
const document = ardentOpenApi();
// Validation also resolves the document in place, exactly as Ardent's own check does before it
// pins openapi/ardent.json, so the generated types match that pinned document.
await SwaggerParser.validate(document);
const directory = await mkdtemp(join(tmpdir(), 'magnus-ardent-openapi-'));
try {
  const source = join(directory, 'ardent.json');
  await writeFile(source, JSON.stringify(document, null, 2) + '\n');
  const expected = join(directory, 'ardent-openapi.ts');
  await exec(generator, [source, '-o', expected], { timeout: 30_000 });
  const operations = Object.values(document.paths).flatMap(methods => Object.keys(methods)).length;
  if (process.argv.includes('--write')) {
    await writeFile(generatedTypes, await readFile(expected));
    console.log(`Wrote ${generatedTypes} from @hivemagnus/ardent@${manifest.version} (${operations} operations)`);
  } else {
    if (await readFile(generatedTypes, 'utf8') !== await readFile(expected, 'utf8'))
      throw new Error(`Ardent typed client drift against @hivemagnus/ardent@${manifest.version}: run npm run ardent:openapi:write and review ${generatedTypes}`);
    console.log(`Ardent client types match @hivemagnus/ardent@${manifest.version} (${operations} operations)`);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
