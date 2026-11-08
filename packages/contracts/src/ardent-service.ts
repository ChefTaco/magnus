/**
 * The Ardent bridge as a linked Oathweave service identity sees it, for
 * products such as an Ardent project workspace that reach Ardent agents only
 * through Magnus. Paths are relative to /api/v1. Responses use the Magnus
 * envelope `{ success, data }`; streams are server-sent events.
 */
import { z } from 'zod';
import {
  ARDENT_STUDIO_CAPABILITY, ARDENT_STUDIO_EVENT_KINDS, ardentAgentDeployRequestSchema, ardentAgentOperationAcceptedResponseSchema,
  ardentAgentOperationResponseSchema, ardentAgentOperationSchema, ardentArtifactManifestSchema, ardentArtifactRecordSchema,
  ardentContextItemSchema, ardentDevelopmentNoteSchema, ardentDevelopmentPageSchema, ardentDevelopmentQuerySchema,
  ardentDevelopmentRecordSchema, ardentMissionSubmitSchema, ardentPreviewOverridesSchema, ardentPreviewSubmitSchema,
  ardentSessionContextSchema, ardentSessionOpenSchema, ardentStudioEventKindSchema, ardentTaskAdmissionSchema,
  ardentTaskArtifactsSchema, ardentTaskDoneEventSchema, ardentTaskJournalEventSchema, ardentTaskPauseStateSchema,
  ardentTaskStreamQuerySchema, ardentTaskTextEventSchema, ardentTeamMissionSchema,
} from './browser.js';

/** Token permission a client-credentials token (audience magnus) needs, besides a link with role ARDENT_SERVICE. */
export const ARDENT_SERVICE_PERMISSION = 'magnus:ardent';
/** Header naming the Oathweave subject of the person the service acts for. */
export const ARDENT_ACTING_SUBJECT_HEADER = 'x-acting-subject';

const ok = <T extends z.ZodType>(data: T) => z.object({ success: z.literal(true), data });
const uuid = z.string().regex(/^[0-9a-f-]{36}$/u);
const revision = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * Actions a service runs only for a named person: x-acting-subject must name a person linked on the
 * service's issuer (any role). They answer 403 ACTING_SUBJECT_REQUIRED without it.
 */
export const ARDENT_SERVICE_SUBJECT_ACTIONS = ['preview-submit', 'development-note'] as const;
/**
 * Agent changes a service runs only for a linked ADMIN named in x-acting-subject, the check New Agent uses.
 * Without one they answer 403 ACTING_ADMIN_REQUIRED, and an unlinked subject 403 ACTING_SUBJECT_UNLINKED.
 */
export const ARDENT_SERVICE_ADMIN_ACTIONS = ['identity-save', 'skill-set', 'config-save'] as const;
/**
 * The only configuration values a service's config-save may change: the backend and model settings,
 * the enabled skills and the artifact size limit. A change anywhere else, including provider URLs,
 * credentials and their environment names, the Codex command, memory, channels, peers, plugins and
 * the API and A2A listeners, answers 403 CONFIG_PATH_FORBIDDEN. An array is one value.
 */
export const ARDENT_SERVICE_CONFIG_PATHS = [
  'execution.backend',
  'providers.llamacpp.model', 'providers.llamacpp.request_timeout_seconds', 'providers.llamacpp.context_window_tokens',
  'providers.llamacpp.max_output_tokens', 'providers.llamacpp.reasoning_effort',
  'providers.codex.model',
  'skills.enabled',
  'artifacts.max_bytes',
] as const;

// POST /ardent/installations/{nodeId}/profiles/{name}/action — the actions a service may run
export const ardentServiceSessionOpenRequestSchema = z.object({ action: z.literal('session-open'), body: ardentSessionOpenSchema }).strict();
export const ardentServiceSessionSchema = z.object({
  id: uuid, caller: z.string(), context: z.string(), key: z.string(), created_ms: z.number(), updated_ms: z.number(),
});
export const ardentServiceTaskSubmitRequestSchema = z.object({
  action: z.literal('task-submit'),
  body: z.object({ prompt: z.string().trim().min(1).max(16_000), idempotency_key: uuid, session_id: uuid.optional() }).strict(),
}).strict();
export const ardentServiceTaskAdmissionSchema = z.object({ task_id: uuid, state: z.string() });
export const ardentServiceTaskCancelRequestSchema = z.object({ action: z.literal('task-cancel'), target: uuid }).strict();
// The actions below need a node agent reporting studio >= 2 (ARDENT_STUDIO_CAPABILITY.missions) and Ardent 2.2.0.
export const ardentServiceMissionSubmitRequestSchema = z.object({ action: z.literal('mission-submit'), body: ardentMissionSubmitSchema }).strict();
export const ardentServiceTaskPauseRequestSchema = z.object({ action: z.literal('task-pause'), target: uuid }).strict();
export const ardentServiceTaskResumeRequestSchema = z.object({ action: z.literal('task-resume'), target: uuid }).strict();
export const ardentServicePreviewSubmitRequestSchema = z.object({ action: z.literal('preview-submit'), body: ardentPreviewSubmitSchema }).strict();
export const ardentServiceDevelopmentNoteRequestSchema = z.object({ action: z.literal('development-note'), body: ardentDevelopmentNoteSchema }).strict();
// Agent changes (ARDENT_SERVICE_ADMIN_ACTIONS). Each carries the revision it was based on; a stale one answers 409 CONFLICT.
/** Ardent's identity edit: the new SOUL.md or IDENTITY.md text and the revision it replaces. */
export const ardentIdentityEditSchema = z.object({ text: z.string().min(1).max(128 * 1024), revision }).strict();
/** Ardent's skill toggle: `revision` is the configuration revision (GET …/config). */
export const ardentSkillEditSchema = z.object({ enabled: z.boolean(), revision }).strict();
/** Ardent's configuration edit: the whole config.yaml text and the configuration revision it replaces. */
export const ardentConfigEditSchema = z.object({ text: z.string().min(1).max(200_000), revision }).strict();
export const ardentServiceIdentitySaveRequestSchema = z.object({
  action: z.literal('identity-save'), target: z.enum(['soul', 'identity']), body: ardentIdentityEditSchema,
}).strict();
export const ardentServiceSkillSetRequestSchema = z.object({
  action: z.literal('skill-set'), target: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u), body: ardentSkillEditSchema,
}).strict();
/** Only ARDENT_SERVICE_CONFIG_PATHS may differ between the current configuration and `text`. */
export const ardentServiceConfigSaveRequestSchema = z.object({ action: z.literal('config-save'), body: ardentConfigEditSchema }).strict();
export const ardentServiceActionRequestSchema = z.union([
  ardentServiceSessionOpenRequestSchema, ardentServiceTaskSubmitRequestSchema, ardentServiceTaskCancelRequestSchema,
  ardentServiceMissionSubmitRequestSchema, ardentServiceTaskPauseRequestSchema, ardentServiceTaskResumeRequestSchema,
  ardentServicePreviewSubmitRequestSchema, ardentServiceDevelopmentNoteRequestSchema,
  ardentServiceIdentitySaveRequestSchema, ardentServiceSkillSetRequestSchema, ardentServiceConfigSaveRequestSchema,
]);
/** GET …/identity/soul and …/identity/identity, and the identity-save answer. */
export const ardentIdentityFileSchema = z.object({ kind: z.enum(['soul', 'identity']), name: z.string(), text: z.string(), revision });
/** GET …/config: the raw config.yaml and its revision. Secrets appear only as environment variable names or ${NAME} references. */
export const ardentConfigFileSchema = z.object({ revision, text: z.string() });
/** The skill-set and config-save answer: the new configuration revision. The change applies once the profile restarts. */
export const ardentConfigSavedSchema = z.object({ revision, activation_required: z.boolean() });

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
    note: 'Each installation carries capabilities.studio: 1 for sessions and streams, 2 for missions, pause, previews and development. Below what a feature needs, offer an agent upgrade.' },
  { method: 'GET', path: '/ardent/installations/{nodeId}', response: ok(z.record(z.string(), z.unknown())), actingAdmin: false },
  { method: 'GET', path: '/ardent/installations/{nodeId}/profiles/{name}/{resource}', response: ok(z.unknown()), actingAdmin: false,
    note: 'resource is one of status, profile, skills, memory/status, sessions, sessions/{id}/messages, tasks, tasks/{id}, tasks/{id}/events, identity/soul, identity/identity (ardentIdentityFileSchema), and config (ardentConfigFileSchema, which needs x-acting-subject naming a linked ADMIN, as a person reading it needs ADMIN); with studio >= 2 also tasks/{id}/artifacts (ardentTaskArtifactsSchema), artifacts/{sha256}/manifest (ardentArtifactRecordSchema) and development (ardentDevelopmentPageSchema, query ardentDevelopmentQuerySchema). sessions takes context=direct|mission|preview (studio >= 2). data is the Ardent response.' },
  { method: 'POST', path: '/ardent/installations/{nodeId}/profiles/{name}/action', request: ardentServiceActionRequestSchema, response: ok(z.unknown()), actingAdmin: false,
    note: 'session-open answers an Ardent session, task-submit, mission-submit and preview-submit a task admission (ardentTaskAdmissionSchema), task-cancel the cancelled task, task-pause and task-resume ardentTaskPauseStateSchema, development-note the stored ardentDevelopmentRecordSchema. preview-submit and development-note need x-acting-subject (ARDENT_SERVICE_SUBJECT_ACTIONS). identity-save answers ardentIdentityFileSchema, skill-set and config-save ardentConfigSavedSchema; they need x-acting-subject naming a linked ADMIN (ARDENT_SERVICE_ADMIN_ACTIONS), answer 409 CONFLICT when the revision is stale, and config-save answers 403 CONFIG_PATH_FORBIDDEN when anything outside ARDENT_SERVICE_CONFIG_PATHS changes. mission-submit, task-pause, task-resume, preview-submit, development-note and a session-open with context answer 409 AGENT_UPGRADE_REQUIRED below studio 2. Ardent\'s own 400, 404 and 409 (a finished task cannot pause) come back with that status. Any other action answers 403.' },
  { method: 'GET', path: '/ardent/installations/{nodeId}/profiles/{name}/tasks/{taskId}/stream', query: ardentTaskStreamQuerySchema, response: null, actingAdmin: false,
    events: { 'task.text': ardentTaskTextEventSchema, 'task.delta': ardentTaskTextEventSchema, 'task.event': ardentTaskJournalEventSchema, 'task.done': ardentTaskDoneEventSchema },
    note: 'Missions and previews stream here like any task. task.event kinds include ARDENT_STUDIO_EVENT_KINDS (mission, team_handoff, paused, ...) on Ardent 2.2.0; accept unknown kinds.' },
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
export type ArdentMissionSubmit = z.infer<typeof ardentMissionSubmitSchema>;
export type ArdentTeamMission = z.infer<typeof ardentTeamMissionSchema>;
export type ArdentPreviewSubmit = z.infer<typeof ardentPreviewSubmitSchema>;
export type ArdentDevelopmentNote = z.infer<typeof ardentDevelopmentNoteSchema>;
export type ArdentDevelopmentRecord = z.infer<typeof ardentDevelopmentRecordSchema>;
export type ArdentArtifactRecord = z.infer<typeof ardentArtifactRecordSchema>;
export type ArdentTaskPauseState = z.infer<typeof ardentTaskPauseStateSchema>;
export type ArdentIdentityFile = z.infer<typeof ardentIdentityFileSchema>;
export type ArdentConfigFile = z.infer<typeof ardentConfigFileSchema>;
export type ArdentConfigSaved = z.infer<typeof ardentConfigSavedSchema>;
export type ArdentServiceConfigPath = typeof ARDENT_SERVICE_CONFIG_PATHS[number];
export type ArdentServiceSession = z.infer<typeof ardentServiceSessionSchema>;
export type ArdentServiceTaskAdmission = z.infer<typeof ardentServiceTaskAdmissionSchema>;
export type ArdentServiceProfile = z.infer<typeof ardentServiceProfileSchema>;
export type ArdentAgentDeployRequest = z.infer<typeof ardentAgentDeployRequestSchema>;
export type ArdentAgentOperation = z.infer<typeof ardentAgentOperationSchema>;
export {
  ARDENT_STUDIO_CAPABILITY, ARDENT_STUDIO_EVENT_KINDS, ardentAgentDeployRequestSchema, ardentAgentOperationAcceptedResponseSchema,
  ardentAgentOperationResponseSchema, ardentAgentOperationSchema, ardentArtifactManifestSchema, ardentArtifactRecordSchema,
  ardentContextItemSchema, ardentDevelopmentNoteSchema, ardentDevelopmentPageSchema, ardentDevelopmentQuerySchema,
  ardentDevelopmentRecordSchema, ardentMissionSubmitSchema, ardentPreviewOverridesSchema, ardentPreviewSubmitSchema,
  ardentSessionContextSchema, ardentSessionOpenSchema, ardentStudioEventKindSchema, ardentTaskAdmissionSchema,
  ardentTaskArtifactsSchema, ardentTaskDoneEventSchema, ardentTaskJournalEventSchema, ardentTaskPauseStateSchema,
  ardentTaskStreamQuerySchema, ardentTaskTextEventSchema, ardentTeamMissionSchema,
};
