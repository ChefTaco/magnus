/**
 * The Ardent bridge as a linked Oathweave service identity sees it, for
 * products such as an Ardent project workspace that reach Ardent agents only
 * through Magnus. Paths are relative to /api/v1. Responses use the Magnus
 * envelope `{ success, data }`; streams are server-sent events.
 */
import { z } from 'zod';
import {
  ardentAgentDeployRequestSchema, ardentAgentOperationAcceptedResponseSchema, ardentAgentOperationResponseSchema,
  ardentAgentOperationSchema, ardentTaskDoneEventSchema, ardentTaskJournalEventSchema, ardentTaskStreamQuerySchema,
  ardentTaskTextEventSchema,
} from './browser.js';

/** Token permission a client-credentials token (audience magnus) needs, besides a link with role ARDENT_SERVICE. */
export const ARDENT_SERVICE_PERMISSION = 'magnus:ardent';
/** Header naming the Oathweave subject of the person the service acts for. */
export const ARDENT_ACTING_SUBJECT_HEADER = 'x-acting-subject';

const ok = <T extends z.ZodType>(data: T) => z.object({ success: z.literal(true), data });
const uuid = z.string().regex(/^[0-9a-f-]{36}$/u);

// POST /ardent/installations/{nodeId}/profiles/{name}/action — the three actions a service may run
export const ardentServiceSessionOpenRequestSchema = z.object({
  action: z.literal('session-open'), body: z.object({ key: z.string().trim().min(1).max(256), reset: z.boolean().optional() }).strict(),
}).strict();
export const ardentServiceSessionSchema = z.object({
  id: uuid, caller: z.string(), context: z.string(), key: z.string(), created_ms: z.number(), updated_ms: z.number(),
});
export const ardentServiceTaskSubmitRequestSchema = z.object({
  action: z.literal('task-submit'),
  body: z.object({ prompt: z.string().trim().min(1).max(16_000), idempotency_key: uuid, session_id: uuid.optional() }).strict(),
}).strict();
export const ardentServiceTaskAdmissionSchema = z.object({ task_id: uuid, state: z.string() });
export const ardentServiceTaskCancelRequestSchema = z.object({ action: z.literal('task-cancel'), target: uuid }).strict();
export const ardentServiceActionRequestSchema = z.union([
  ardentServiceSessionOpenRequestSchema, ardentServiceTaskSubmitRequestSchema, ardentServiceTaskCancelRequestSchema,
]);

// GET /ardent/profiles
export const ardentServiceProfileSchema = z.object({
  id: z.string(), name: z.string(), backend: z.enum(['llamacpp', 'codex']).nullable(), apiPort: z.number().int().nullable(),
  running: z.boolean(), a2aEnabled: z.boolean(), channels: z.record(z.string(), z.boolean()), error: z.string().nullable(),
  nodeId: z.string(), nodeName: z.string(), hostname: z.string(), installationVersion: z.string().nullable(), reachable: z.boolean(),
});

export interface ArdentServiceRoute {
  method: 'GET' | 'POST';
  /** Relative to /api/v1, with `{name}` for each path parameter. */
  path: string;
  query?: z.ZodType;
  request?: z.ZodType;
  /** Null for a byte stream or an event stream. */
  response: z.ZodType | null;
  events?: Readonly<Record<string, z.ZodType>>;
  successStatus?: 202;
  /** The request must name, in x-acting-subject, a person whose Magnus link role is ADMIN. */
  actingAdmin: boolean;
  note?: string;
}

/** Every route a linked Ardent service identity may call. All others answer 403. */
export const ardentServiceRoutes: readonly ArdentServiceRoute[] = [
  { method: 'GET', path: '/ardent/profiles', response: ok(z.array(ardentServiceProfileSchema)), actingAdmin: false },
  { method: 'GET', path: '/ardent/installations', response: ok(z.array(z.record(z.string(), z.unknown()))), actingAdmin: false,
    note: 'Each installation carries capabilities.studio = 1 when its node agent has the bridge; otherwise offer an agent upgrade.' },
  { method: 'GET', path: '/ardent/installations/{nodeId}', response: ok(z.record(z.string(), z.unknown())), actingAdmin: false },
  { method: 'GET', path: '/ardent/installations/{nodeId}/profiles/{name}/{resource}', response: ok(z.unknown()), actingAdmin: false,
    note: 'resource is one of status, profile, skills, memory/status, sessions, sessions/{id}/messages, tasks, tasks/{id}, tasks/{id}/events, identity/soul, identity/identity. data is the Ardent response.' },
  { method: 'POST', path: '/ardent/installations/{nodeId}/profiles/{name}/action', request: ardentServiceActionRequestSchema, response: ok(z.unknown()), actingAdmin: false,
    note: 'session-open answers an Ardent session, task-submit a task admission, task-cancel the cancelled task. Any other action answers 403.' },
  { method: 'GET', path: '/ardent/installations/{nodeId}/profiles/{name}/tasks/{taskId}/stream', query: ardentTaskStreamQuerySchema, response: null, actingAdmin: false,
    events: { 'task.text': ardentTaskTextEventSchema, 'task.delta': ardentTaskTextEventSchema, 'task.event': ardentTaskJournalEventSchema, 'task.done': ardentTaskDoneEventSchema } },
  { method: 'GET', path: '/ardent/installations/{nodeId}/profiles/{name}/artifacts/{artifactId}', response: null, actingAdmin: false,
    note: 'application/octet-stream, streamed; up to the node agent cap (64 MiB by default).' },
  { method: 'POST', path: '/ardent/agents', request: ardentAgentDeployRequestSchema, response: ardentAgentOperationAcceptedResponseSchema, successStatus: 202, actingAdmin: true },
  { method: 'GET', path: '/ardent/agents/operations/{id}', response: ardentAgentOperationResponseSchema, actingAdmin: false },
  { method: 'GET', path: '/ardent/agents/operations/{id}/stream', response: null, actingAdmin: false,
    events: { operation: ardentAgentOperationSchema, done: ardentAgentOperationSchema } },
  { method: 'POST', path: '/ardent/agents/operations/{id}/resume', response: ardentAgentOperationAcceptedResponseSchema, successStatus: 202, actingAdmin: true },
  { method: 'POST', path: '/ardent/installations/{nodeId}/profiles/{name}/hivemem', response: ardentAgentOperationAcceptedResponseSchema, successStatus: 202, actingAdmin: true },
];

export type ArdentServiceActionRequest = z.infer<typeof ardentServiceActionRequestSchema>;
export type ArdentServiceSession = z.infer<typeof ardentServiceSessionSchema>;
export type ArdentServiceTaskAdmission = z.infer<typeof ardentServiceTaskAdmissionSchema>;
export type ArdentServiceProfile = z.infer<typeof ardentServiceProfileSchema>;
export type ArdentAgentDeployRequest = z.infer<typeof ardentAgentDeployRequestSchema>;
export type ArdentAgentOperation = z.infer<typeof ardentAgentOperationSchema>;
export {
  ardentAgentDeployRequestSchema, ardentAgentOperationAcceptedResponseSchema, ardentAgentOperationResponseSchema,
  ardentAgentOperationSchema, ardentTaskDoneEventSchema, ardentTaskJournalEventSchema, ardentTaskStreamQuerySchema,
  ardentTaskTextEventSchema,
};
