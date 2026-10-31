/**
 * API documentation routes — serves OpenAPI spec + Swagger UI.
 *
 * - `GET /api/docs`             — interactive Swagger UI
 * - `GET /api/docs/openapi.json` — raw OpenAPI 3.1 JSON spec
 */

import { Hono } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import type { AppVariables } from '../types/index.js';
import { buildOpenApiSpec } from '../openapi/spec.js';

export const docsRouter = new Hono<AppVariables>();

// Cache the spec object — rebuilt only on process restart
let cachedSpec: ReturnType<typeof buildOpenApiSpec> | null = null;

function getSpec() {
  if (!cachedSpec) cachedSpec = buildOpenApiSpec();
  return cachedSpec;
}

// ── Raw OpenAPI JSON ──
docsRouter.get('/openapi.json', (c) => {
  return c.json(getSpec());
});

// ── Swagger UI ──
docsRouter.get(
  '/',
  swaggerUI({ url: '/api/docs/openapi.json' }),
);
