#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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

for (const [path, methods] of Object.entries(spec.paths ?? {})) {
  for (const [method, operation] of Object.entries(methods)) {
    if (!operation.summary) failures.push(`${method.toUpperCase()} ${path} missing summary`);
    if (!Array.isArray(operation.tags) || operation.tags.length === 0) failures.push(`${method.toUpperCase()} ${path} missing tags`);
    if (!operation.responses || Object.keys(operation.responses).length === 0) failures.push(`${method.toUpperCase()} ${path} missing responses`);
  }
}

if (failures.length > 0) {
  console.error(`OpenAPI contract check failed (${failures.length}):`);
  for (const failure of failures.slice(0, 50)) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`OpenAPI contract check passed (${Object.keys(spec.paths ?? {}).length} paths).`);

