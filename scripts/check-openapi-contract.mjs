#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';

const specPath = resolve('services/control-api/dist/openapi/spec.js');
if (!existsSync(specPath)) {
  console.error('OpenAPI contract check requires a built Control API. Run npm run control-api:build first.');
  process.exit(1);
}

const { buildOpenApiSpec } = await import(`file://${specPath}`);
const spec = buildOpenApiSpec();
const failures = [];

if (spec.openapi !== '3.1.0') failures.push('spec.openapi must be 3.1.0');
if (!spec.info?.title || !spec.info?.description) failures.push('spec.info needs title and description');

const declaredTags = new Set((spec.tags ?? []).map((tag) => tag.name));
const schemes = new Set(Object.keys(spec.components?.securitySchemes ?? {}));
for (const [path, methods] of Object.entries(spec.paths ?? {})) {
  for (const [method, operation] of Object.entries(methods)) {
    for (const tag of operation.tags ?? []) if (!declaredTags.has(tag)) failures.push(`${method.toUpperCase()} ${path} uses undeclared tag ${tag}`);
    for (const requirement of operation.security ?? []) {
      for (const name of Object.keys(requirement)) if (!schemes.has(name)) failures.push(`${method.toUpperCase()} ${path} uses unknown security scheme ${name}`);
    }
    if (!operation.summary) failures.push(`${method.toUpperCase()} ${path} missing summary`);
    if (!Array.isArray(operation.tags) || operation.tags.length === 0) failures.push(`${method.toUpperCase()} ${path} missing tags`);
    if (!operation.responses || Object.keys(operation.responses).length === 0) failures.push(`${method.toUpperCase()} ${path} missing responses`);
  }
}

// The document must also be valid OpenAPI 3.1 with every $ref resolvable, so generated clients work.
try {
  await SwaggerParser.validate(structuredClone(spec));
} catch (error) {
  failures.push(`spec is not valid OpenAPI: ${error instanceof Error ? error.message : String(error)}`);
}

// A typed client must be generable from the document (the repository ships none; consumers generate their own).
if (failures.length === 0) {
  const directory = mkdtempSync(join(tmpdir(), 'magnus-openapi-'));
  try {
    writeFileSync(join(directory, 'magnus.json'), JSON.stringify(spec));
    execFileSync(resolve('node_modules/.bin/openapi-typescript'), [join(directory, 'magnus.json'), '-o', join(directory, 'magnus.ts')], { stdio: 'pipe', timeout: 60_000 });
  } catch (error) {
    failures.push(`openapi-typescript cannot generate types: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`OpenAPI contract check failed (${failures.length}):`);
  for (const failure of failures.slice(0, 50)) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`OpenAPI contract check passed (${Object.keys(spec.paths ?? {}).length} paths).`);

