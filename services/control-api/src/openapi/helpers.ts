/**
 * Building blocks for the OpenAPI document: JSON Schema from Zod, response envelopes, parameters,
 * error responses and security requirements. `spec.ts` and the per-domain modules in `paths/` use
 * them, so every entry has the same shape.
 */
import { createHash } from 'node:crypto';
import { z, type ZodSchema } from 'zod';
import { magnusBrowserRoutes, type MagnusBrowserRoute } from '@hivemagnus/magnus-contracts/browser';

export type JsonSchema = Record<string, unknown>;
/** One path item: operations by lower-case method. */
export type PathItem = Record<string, unknown>;
export type Paths = Record<string, PathItem>;

const hoisted: Record<string, JsonSchema> = {};

/** Definitions that Zod could not inline (recursive schemas), for `components.schemas`. */
export const hoistedSchemas = (): Record<string, JsonSchema> => ({ ...hoisted });

/**
 * Convert a Zod schema to OpenAPI-compatible JSON Schema (strips $schema). Request side by default.
 * A recursive schema keeps its cycle as `definitions` (or `$defs`), whose local pointers would resolve against the
 * whole document; those definitions move to `components.schemas` under a content-derived name.
 */
export function zod(schema: ZodSchema, io: 'input' | 'output' = 'input'): JsonSchema {
  const js = z.toJSONSchema(schema, { target: 'openapi-3.0', io, reused: 'inline', unrepresentable: 'any' }) as JsonSchema;
  delete js['$schema'];
  const defsKey = '$defs' in js ? '$defs' : 'definitions' in js ? 'definitions' : null;
  if (!defsKey) return js;
  const defs = js[defsKey] as Record<string, JsonSchema>;
  delete js[defsKey];
  const local = `#/${defsKey}/`;
  const prefix = `Recursive_${createHash('sha256').update(JSON.stringify(defs)).digest('hex').slice(0, 12)}`;
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key,
      key === '$ref' && typeof inner === 'string' && inner.startsWith(local) ? `#/components/schemas/${prefix}_${inner.slice(local.length)}` : rewrite(inner)]));
  };
  for (const [name, definition] of Object.entries(defs)) hoisted[`${prefix}_${name}`] = rewrite(definition) as JsonSchema;
  return rewrite(js) as JsonSchema;
}

/** JSON Schema of what a route sends back. */
export const zodOut = (schema: ZodSchema): JsonSchema => zod(schema, 'output');

/** Shorthand for a $ref pointer. */
export const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** JSON request body referencing a component schema. */
export function jsonBody(schemaName: string, description?: string) {
  return {
    required: true,
    ...(description && { description }),
    content: { 'application/json': { schema: ref(schemaName) } },
  };
}

/** JSON request body from a Zod schema. */
export const requestBody = (schema: ZodSchema, description?: string) => ({
  required: true, ...(description && { description }), content: { 'application/json': { schema: zod(schema) } },
});

/** Inline JSON request body, for routes whose schema has no component of its own. */
export function inlineBody(schema: JsonSchema, description?: string) {
  return { required: true, ...(description && { description }), content: { 'application/json': { schema } } };
}

/** Optional JSON request body: the route also accepts no body or an empty one. */
export function optionalBody(schema: JsonSchema, description?: string) {
  return { required: false, ...(description && { description }), content: { 'application/json': { schema } } };
}

/** Standard success response with optional data schema. */
export function success(description: string, dataSchema?: JsonSchema | { $ref: string }) {
  const props: Record<string, unknown> = { success: { type: 'boolean', enum: [true] } };
  if (dataSchema) props['data'] = dataSchema;
  return {
    description,
    content: {
      'application/json': {
        schema: { type: 'object', properties: props },
      },
    },
  };
}

/** Response whose whole JSON body is the given schema (no `success`/`data` envelope, or one a Zod schema already describes). */
export function body(description: string, schema: JsonSchema | { $ref: string }) {
  return { description, content: { 'application/json': { schema } } };
}

/** Paginated success response. */
export function paginated(description: string, itemSchema?: JsonSchema | { $ref: string }) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean', enum: [true] },
            data: { type: 'array', items: itemSchema ?? { type: 'object' } },
            meta: ref('PaginationMeta'),
          },
        },
      },
    },
  };
}

/** Server-sent event stream. */
export function eventStream(description: string) {
  return { description, content: { 'text/event-stream': { schema: { type: 'string' } } } };
}

const apiError = (description: string) => ({ description, content: { 'application/json': { schema: ref('ApiError') } } });

/** Shorthand error responses. */
export const err400 = apiError('Validation error');
export const err401 = apiError('Unauthorized — missing or invalid credentials');
export const err403 = apiError('Forbidden — insufficient role/permissions');
export const err404 = apiError('Resource not found');
export const err409 = apiError('Conflict — duplicate or conflicting resource');
export const err410 = apiError('Gone — the operation is retired');
export const err429 = apiError('Too many requests');
export const err502 = apiError('The node agent or upstream service failed');
export const err503 = apiError('The feature is not configured or a dependency is unavailable');
/** An error response with its own description. */
export const errorResponse = apiError;

/** Standard query-string parameter. */
export function qp(name: string, description: string, opts?: { type?: string; required?: boolean; format?: string; enum?: string[] }) {
  return {
    name,
    in: 'query' as const,
    description,
    required: opts?.required ?? false,
    schema: {
      type: opts?.type ?? 'string',
      ...(opts?.format && { format: opts.format }),
      ...(opts?.enum && { enum: opts.enum }),
    },
  };
}

/** Standard path parameter. */
export function pp(name: string, description: string) {
  return { name, in: 'path' as const, required: true, schema: { type: 'string' }, description };
}

/** Query parameters from a Zod object schema, one per property. */
export function queryParams(schema: ZodSchema, descriptions: Record<string, string> = {}) {
  const js = zod(schema);
  const properties = (js['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = new Set((js['required'] ?? []) as string[]);
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name, in: 'query' as const, required: required.has(name), schema: propertySchema,
    ...(descriptions[name] ? { description: descriptions[name] } : {}),
  }));
}

/** System callers: the shared API secret (an ADMIN). */
export const apiSecretAuth = [{ apiSecret: [] }];
/** A person's console session (local JWT or Oathweave token), or the shared API secret. */
export const userAuth = [{ bearerAuth: [] }, { apiSecret: [] }];
/** Agent routes: a node signature, or the shared node secret while NODE_AUTH_MODE is not enforce. */
export const nodeAuthSecurity = [{ nodeSignature: [] }, { nodeToken: [] }];
export const sharedResourceAuth = [{ sharedResourceBearer: [] }, { apiSecret: [] }, { bearerAuth: [] }];
export const nodeTokenAuth = [{ nodeToken: [] }];

/** "Roles: ADMIN, OPERATOR." for a description. */
export function rolesNote(roles: readonly string[]): string {
  return roles.length === 0 ? 'No authentication.' : roles.length === 3 ? 'Any role.' : `Roles: ${roles.join(', ')}.`;
}

/**
 * Request, query, response, roles and notes of a route the browser contract publishes
 * (`@hivemagnus/magnus-contracts/browser`), so its entry is generated from the same Zod schemas
 * HiveXUI parses with. `operation` adds tags, summary, path parameter descriptions and error responses.
 */
export function browserOperation(method: MagnusBrowserRoute['method'], path: string, operation: {
  tags: string[]; summary: string; description?: string; params?: Record<string, string>; errors?: Record<string, unknown>;
  queryDescriptions?: Record<string, string>;
}) {
  const route = magnusBrowserRoutes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`${method} ${path} is not in the browser contract`);
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => pp(match[1]!, operation.params?.[match[1]!] ?? match[1]!));
  const description = [operation.description, route.note, rolesNote(route.roles)].filter(Boolean).join('\n\n');
  const status = String(route.successStatus ?? 200);
  const ok = route.response
    ? { description: operation.summary, content: { 'application/json': { schema: zodOut(route.response) } } }
    : eventStream(`${operation.summary}. Events: ${Object.keys(route.events ?? {}).join(', ') || 'see description'}.`);
  return {
    tags: operation.tags,
    summary: operation.summary,
    description,
    security: route.roles.length === 0 ? [] : userAuth,
    ...(pathParams.length || route.query ? { parameters: [...pathParams, ...(route.query ? queryParams(route.query, operation.queryDescriptions) : [])] } : {}),
    ...(route.request ? { requestBody: requestBody(route.request) } : {}),
    responses: {
      [status]: ok,
      ...(route.roles.length ? { 401: err401 } : {}),
      ...(route.roles.length && route.roles.length < 3 ? { 403: err403 } : {}),
      ...operation.errors,
    },
  };
}

/** Merge path objects; the same method on the same path twice is a mistake, so it throws. */
export function mergePaths(...sources: Paths[]): Paths {
  const merged: Paths = {};
  for (const source of sources) {
    for (const [path, item] of Object.entries(source)) {
      const target = merged[path] ?? (merged[path] = {});
      for (const [method, operation] of Object.entries(item)) {
        if (method in target) throw new Error(`OpenAPI: ${method.toUpperCase()} ${path} is documented twice`);
        target[method] = operation;
      }
    }
  }
  return merged;
}
