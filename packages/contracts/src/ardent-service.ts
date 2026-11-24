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
  ardentSkillInstallNodeSchema, ardentSkillInstallResultSchema, ardentSkillInstallSchema,
  ardentTaskStreamQuerySchema, ardentTaskTextEventSchema, ardentTeamMissionSchema, ardentDependenciesResponseSchema,
} from './browser.js';
import {
  agentDefinitionExportSchema, agentDefinitionInstallRequestSchema, agentDefinitionPreflightSchema, agentDefinitionValidateRequestSchema,
} from './agent-definition.js';

/** Token permission a client-credentials token (audience magnus) needs, besides a link with role ARDENT_SERVICE. */
export const ARDENT_SERVICE_PERMISSION = 'magnus:ardent';
/** Header naming the Oathweave subject of the person the service acts for. */
export const ARDENT_ACTING_SUBJECT_HEADER = 'x-acting-subject';

const ok = <T extends z.ZodType>(data: T) => z.object({ success: z.literal(true), data });
const uuid = z.string().regex(/^[0-9a-f-]{36}$/u);
const revision = z.string().regex(/^[a-f0-9]{64}$/u);

// ── Execution context v1 (the hive-common contract, C1) ──
/** Reference kinds an execution context may name. */
export const ARDENT_EXECUTION_REF_KINDS = ['request', 'task', 'mission', 'step', 'attempt', 'workflow', 'node', 'artifact', 'run'] as const;
const executionRefPattern = /^hx1:[a-z][a-z0-9-]{1,31}:[A-Za-z0-9._-]{1,96}:([a-z]+):[A-Za-z0-9._:/-]{1,128}$/u;
/** A qualified reference `hx1:<product>:<instance>:<kind>:<id>`, at most 256 characters. */
export const ardentExecutionRefSchema = z.string().max(256).regex(executionRefPattern)
  .refine(value => (ARDENT_EXECUTION_REF_KINDS as readonly string[]).includes(executionRefPattern.exec(value)?.[1] ?? ''), 'Unknown reference kind');
/**
 * Execution context v1, as hive-common's parseExecutionContext reads it: attribution only, never access.
 * Unknown keys are dropped.
 */
export const ardentExecutionContextSchema = z.object({
  v: z.literal(1),
  root: ardentExecutionRefSchema,
  request_id: z.string().regex(/^[A-Za-z0-9._:@/+=-]{1,128}$/u).optional(),
  parent: ardentExecutionRefSchema.optional(),
  self: ardentExecutionRefSchema.optional(),
  inputs: z.array(ardentExecutionRefSchema).max(16).optional(),
  attempt: z.number().int().min(1).max(1_000_000).optional(),
  deadline_ms: z.number().int().min(0).optional(),
});
export type ArdentExecutionContext = z.infer<typeof ardentExecutionContextSchema>;
/** A valid execution context with unknown keys and an empty `inputs` dropped, or undefined. Never throws. */
export function parseArdentExecutionContext(value: unknown): ArdentExecutionContext | undefined {
  const parsed = ardentExecutionContextSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { inputs, ...rest } = parsed.data;
  return inputs?.length ? { ...rest, inputs } : rest;
}
/**
 * The optional top-level `execution` of task-submit, mission-submit and preview-submit. Any value is
 * accepted; one that is not a valid execution context is dropped, never rejected. Magnus passes it on
 * only to a profile that reports capabilities.lineage >= 1.
 */
export const ardentExecutionFieldSchema = z.unknown().transform(value => parseArdentExecutionContext(value)).optional();

// ── Recovery and artifact transfer v2 (Ardent 3.2.0, node agents reporting studio >= 4) ──
export const ARDENT_RECOVERY_ACTIONS = ['mark_applied', 'mark_not_applied', 'retry_with_new_deadline', 'abandon'] as const;
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) ?? '').length;
/** POST tasks/{id}/recovery: resolve a task held awaiting_decision (result at most 64 KiB). */
export const ardentTaskRecoveryDecisionSchema = z.object({
  action: z.enum(ARDENT_RECOVERY_ACTIONS),
  call_id: z.string().min(1).max(256).optional(),
  result: z.unknown().optional().refine(value => value === undefined || jsonBytes(value) <= 64 * 1024, 'Exceeds 65536 bytes'),
  note: z.string().min(1).max(2000).optional(),
  deadline_seconds: z.number().int().min(1).max(86_400).optional(),
}).strict();
/** C3: a task's execution recovery. Readers accept fields Ardent may add. */
export const ardentTaskRecoverySchema = z.object({
  status: z.enum(['ready', 'reconciling', 'resumed', 'awaiting_decision', 'unsupported', 'resolved']),
  reason: z.object({ code: z.string(), message: z.string() }),
  attempt: z.number().int().min(1),
  checkpoint: z.object({
    step: z.number().int(), completed_calls: z.number().int().min(0),
    pending_calls: z.array(z.object({ call_id: z.string(), tool: z.string(), effect: z.string(), dispatched_at: z.string().nullable(), reconcilable: z.boolean() })),
  }).optional(),
  actions: z.array(z.enum(ARDENT_RECOVERY_ACTIONS)),
  continuation_task_id: z.string().optional(),
  decided: z.object({ action: z.enum(ARDENT_RECOVERY_ACTIONS), by: z.string(), at: z.string(), note: z.string().optional() }).optional(),
}).passthrough();
/** POST artifacts/imports: pull one artifact a configured A2A peer exported. */
export const ardentArtifactImportSchema = z.object({
  peer_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  a2a_task_id: z.string().min(1).max(256),
  artifact_id: z.string().regex(/^[a-f0-9]{32}$/u),
  task_id: uuid.optional(),
}).strict();
/** GET artifacts/imports/{id} and each entry of GET artifacts/imports. */
export const ardentArtifactImportStateSchema = z.object({
  import_id: z.string().regex(/^[a-f0-9]{32}$/u), peer_id: z.string(), a2a_task_id: z.string(), artifact_id: z.string(),
  state: z.enum(['queued', 'transferring', 'verifying', 'completed', 'failed']), received_bytes: z.number().int().min(0),
  size: z.number().int().min(0).nullable(), sha256: z.string().nullable(), mime: z.string().nullable(), name: z.string().nullable(),
  protocol: z.enum(['v1', 'v2']).nullable(), attempts: z.number().int().min(0), local_task_id: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).optional(), created_ms: z.number().int(), updated_ms: z.number().int(),
}).passthrough();
/** GET artifacts/{sha256}/renditions: the original first. */
export const ardentArtifactRenditionsSchema = z.object({
  renditions: z.array(z.object({ sha256: z.string(), role: z.string(), mime: z.string(), size: z.number().int().min(0), purpose: z.string().optional(),
    width: z.number().int().optional(), height: z.number().int().optional(), has_alpha: z.boolean().optional() }).passthrough()),
}).passthrough();
/**
 * Request attribution Magnus passes on to a profile: the request ID, the W3C trace and the execution
 * context header (base64url JSON, at most 2 KiB). A value of the wrong shape is dropped, never rejected.
 */
export const ARDENT_TRACE_HEADER_PATTERNS: Readonly<Record<'x-request-id' | 'traceparent' | 'x-hive-execution', RegExp>> = {
  'x-request-id': /^[A-Za-z0-9._:@/+=-]{1,128}$/u,
  traceparent: /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u,
  'x-hive-execution': /^[A-Za-z0-9_-]{1,2048}$/u,
};
/** The well-formed attribution headers among those `read` returns. */
export function ardentTraceHeaders(read: (name: string) => string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, pattern] of Object.entries(ARDENT_TRACE_HEADER_PATTERNS)) {
    const value = read(name)?.trim();
    if (value && pattern.test(value)) headers[name] = value;
  }
  return headers;
}
/** Range a v2 content read may carry: one byte range. */
export const ARDENT_RANGE_PATTERN = /^bytes=(?:\d{1,15}-\d{0,15}|-\d{1,15})$/u;
/** If-Range a v2 content read may carry: the artifact's ETag or an HTTP date. */
export const ARDENT_IF_RANGE_PATTERN = /^(?:"[a-f0-9]{64}"|[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT)$/u;
/** Response headers of a v2 content read that Magnus passes on, each with the shape it must have. */
export const ARDENT_CONTENT_HEADER_PATTERNS: Readonly<Record<string, RegExp>> = {
  'content-range': /^bytes (?:\d{1,15}-\d{1,15}|\*)\/\d{1,15}$/u,
  'accept-ranges': /^bytes$/u,
  etag: /^"[a-f0-9]{64}"$/u,
  'repr-digest': /^sha-256=:[A-Za-z0-9+/]{43}=:$/u,
  'x-content-sha256': /^[a-f0-9]{64}$/u,
  'content-disposition': /^attachment(?:;[\x20-\x7e]{0,500})?$/u,
};
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]{1,64}=(?:[A-Za-z0-9!#$&^_.+-]{1,128}|"[\x20\x21\x23-\x5b\x5d-\x7e]{0,128}"))*$/u;
/** A media type with optional parameters as given, or application/octet-stream for anything else. */
export function ardentMediaType(value: string | null | undefined): string {
  return value && value.length <= 255 && MEDIA_TYPE.test(value) ? value : 'application/octet-stream';
}
/**
 * The 409 code a profile answers through Magnus for a route or action it lacks (ARDENT_RUNTIME_GATES).
 * error.details carries { capability, required_version, installed_version }.
 */
export const ARDENT_UNSUPPORTED_CAPABILITY = 'unsupported_capability';
export const ardentUnsupportedCapabilityDetailsSchema = z.object({
  capability: z.string(), required_version: z.string(), installed_version: z.string().nullable(),
});

/**
 * Actions a service runs only for a named person: x-acting-subject must name a person linked on the
 * service's issuer (any role). They answer 403 ACTING_SUBJECT_REQUIRED without it.
 */
export const ARDENT_SERVICE_SUBJECT_ACTIONS = ['preview-submit', 'development-note'] as const;
/**
 * Agent changes a service runs only for a linked ADMIN named in x-acting-subject, the check New Agent uses.
 * Without one they answer 403 ACTING_ADMIN_REQUIRED, and an unlinked subject 403 ACTING_SUBJECT_UNLINKED.
 */
export const ARDENT_SERVICE_ADMIN_ACTIONS = ['identity-save', 'skill-set', 'config-save', 'skill-install'] as const;
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
  execution: ardentExecutionFieldSchema,
}).strict();
export const ardentServiceTaskAdmissionSchema = z.object({ task_id: uuid, state: z.string() });
export const ardentServiceTaskCancelRequestSchema = z.object({ action: z.literal('task-cancel'), target: uuid }).strict();
// The actions below need a node agent reporting studio >= 2 (ARDENT_STUDIO_CAPABILITY.missions) and Ardent 2.2.0.
export const ardentServiceMissionSubmitRequestSchema = z.object({ action: z.literal('mission-submit'), body: ardentMissionSubmitSchema, execution: ardentExecutionFieldSchema }).strict();
export const ardentServiceTaskPauseRequestSchema = z.object({ action: z.literal('task-pause'), target: uuid }).strict();
export const ardentServiceTaskResumeRequestSchema = z.object({ action: z.literal('task-resume'), target: uuid }).strict();
export const ardentServicePreviewSubmitRequestSchema = z.object({ action: z.literal('preview-submit'), body: ardentPreviewSubmitSchema, execution: ardentExecutionFieldSchema }).strict();
export const ardentServiceDevelopmentNoteRequestSchema = z.object({ action: z.literal('development-note'), body: ardentDevelopmentNoteSchema }).strict();
// The actions below need a node agent reporting studio >= 4 and a profile reporting the capability (ARDENT_RUNTIME_GATES).
/** Resolve a task held awaiting_decision (capabilities.recovery >= 1). */
export const ardentServiceTaskRecoveryRequestSchema = z.object({ action: z.literal('task-recovery'), target: uuid, body: ardentTaskRecoveryDecisionSchema }).strict();
/** Pull an artifact from an A2A peer (capabilities.artifact_transfer >= 2). */
export const ardentServiceArtifactImportRequestSchema = z.object({ action: z.literal('artifact-import'), body: ardentArtifactImportSchema }).strict();
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
/**
 * Install a HiveSkills catalog release onto the profile (studio >= 3). Magnus fetches the archive from its
 * configured registry, checks it against the catalog digest and installs it; with `enable` it also enables it.
 */
export const ardentServiceSkillInstallRequestSchema = z.object({ action: z.literal('skill-install'), body: ardentSkillInstallSchema }).strict();
/** Only ARDENT_SERVICE_CONFIG_PATHS may differ between the current configuration and `text`. */
export const ardentServiceConfigSaveRequestSchema = z.object({ action: z.literal('config-save'), body: ardentConfigEditSchema }).strict();
export const ardentServiceActionRequestSchema = z.union([
  ardentServiceSessionOpenRequestSchema, ardentServiceTaskSubmitRequestSchema, ardentServiceTaskCancelRequestSchema,
  ardentServiceMissionSubmitRequestSchema, ardentServiceTaskPauseRequestSchema, ardentServiceTaskResumeRequestSchema,
  ardentServicePreviewSubmitRequestSchema, ardentServiceDevelopmentNoteRequestSchema,
  ardentServiceIdentitySaveRequestSchema, ardentServiceSkillSetRequestSchema, ardentServiceConfigSaveRequestSchema,
  ardentServiceSkillInstallRequestSchema, ardentServiceTaskRecoveryRequestSchema, ardentServiceArtifactImportRequestSchema,
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
    note: 'Each installation carries capabilities.studio: 1 for sessions and streams, 2 for missions, pause, previews and development, 3 for skill-install, 4 for the Ardent 3.2.0 runtime contracts; below what a feature needs, offer an agent upgrade. From studio 4 each profile also carries its Ardent version and capabilities { recovery, lineage, artifact_transfer } (ardentProfileCapabilities): recovery and lineage 1 on Ardent 3.2.0 or later, artifact_transfer 2 for transfer v2. A profile below what a route needs answers 409 unsupported_capability; offer an Ardent upgrade.' },
  { method: 'GET', path: '/ardent/installations/{nodeId}', response: ok(z.record(z.string(), z.unknown())), actingAdmin: false },
  { method: 'GET', path: '/ardent/installations/{nodeId}/profiles/{name}/{resource}', response: ok(z.unknown()), actingAdmin: false,
    note: 'resource is one of status, profile, skills, memory/status, sessions, sessions/{id}/messages, tasks, tasks/{id}, tasks/{id}/events, identity/soul, identity/identity (ardentIdentityFileSchema), and config (ardentConfigFileSchema, which needs x-acting-subject naming a linked ADMIN, as a person reading it needs ADMIN); with studio >= 2 also tasks/{id}/artifacts (ardentTaskArtifactsSchema), artifacts/{sha256}/manifest (ardentArtifactRecordSchema) and development (ardentDevelopmentPageSchema, query ardentDevelopmentQuerySchema). sessions takes context=direct|mission|preview (studio >= 2). With studio >= 4 also tasks/{id}/recovery (ardentTaskRecoverySchema; 404 when the task was never interrupted) with capabilities.recovery >= 1, tasks/{id}/lineage with capabilities.lineage >= 1, and artifacts/{sha256}/renditions (ardentArtifactRenditionsSchema), artifacts/{sha256}/manifest/v2, artifacts/imports (query limit) and artifacts/imports/{id} (ardentArtifactImportStateSchema) with capabilities.artifact_transfer >= 2. A profile without the capability answers 409 unsupported_capability with error.details ardentUnsupportedCapabilityDetailsSchema, an agent below studio 4 409 AGENT_UPGRADE_REQUIRED. data is the Ardent response.' },
  { method: 'POST', path: '/ardent/installations/{nodeId}/profiles/{name}/action', request: ardentServiceActionRequestSchema, response: ok(z.unknown()), actingAdmin: false,
    note: 'session-open answers an Ardent session, task-submit, mission-submit and preview-submit a task admission (ardentTaskAdmissionSchema), task-cancel the cancelled task, task-pause and task-resume ardentTaskPauseStateSchema, development-note the stored ardentDevelopmentRecordSchema. preview-submit and development-note need x-acting-subject (ARDENT_SERVICE_SUBJECT_ACTIONS). identity-save answers ardentIdentityFileSchema, skill-set and config-save ardentConfigSavedSchema; they need x-acting-subject naming a linked ADMIN (ARDENT_SERVICE_ADMIN_ACTIONS), answer 409 CONFLICT when the revision is stale, and config-save answers 403 CONFIG_PATH_FORBIDDEN when anything outside ARDENT_SERVICE_CONFIG_PATHS changes. skill-install answers ardentSkillInstallResultSchema and also needs a linked ADMIN; it answers 503 HIVESKILLS_UNCONFIGURED when Magnus has no HiveSkills registry, 404 NOT_FOUND when the catalog has no such skill, 409 SKILL_VERSION_UNAVAILABLE when that version is not the one promoted on the channel, 422 SKILL_ARCHIVE_INVALID when the archive fails its digest or checks, 409 SKILL_CONFLICT when the profile has a local skill of that name Magnus did not install, and 409 AGENT_UPGRADE_REQUIRED below studio 3. task-recovery (target the task, body ardentTaskRecoveryDecisionSchema) answers ardentTaskRecoverySchema and artifact-import (body ardentArtifactImportSchema) an { import_id } admission; they need studio 4 and the profile capability (recovery >= 1, artifact_transfer >= 2) and otherwise answer 409 AGENT_UPGRADE_REQUIRED or 409 unsupported_capability. task-submit, mission-submit and preview-submit take an optional top-level execution (ardentExecutionFieldSchema, an execution context v1): Magnus passes it to a profile with capabilities.lineage >= 1, drops it otherwise or when it is invalid, and never rejects the request for it; x-request-id, traceparent and x-hive-execution reach the profile too. mission-submit, task-pause, task-resume, preview-submit, development-note and a session-open with context answer 409 AGENT_UPGRADE_REQUIRED below studio 2. Ardent\'s own 400, 404 and 409 (a finished task cannot pause) come back with that status. Any other action answers 403.' },
  { method: 'GET', path: '/ardent/installations/{nodeId}/profiles/{name}/tasks/{taskId}/stream', query: ardentTaskStreamQuerySchema, response: null, actingAdmin: false,
    events: { 'task.text': ardentTaskTextEventSchema, 'task.delta': ardentTaskTextEventSchema, 'task.event': ardentTaskJournalEventSchema, 'task.done': ardentTaskDoneEventSchema },
    note: 'Missions and previews stream here like any task. task.event kinds include ARDENT_STUDIO_EVENT_KINDS (mission, team_handoff, paused, ...) on Ardent 2.2.0; accept unknown kinds.' },
  { method: 'GET', path: '/ardent/installations/{nodeId}/profiles/{name}/artifacts/{artifactId}', response: null, actingAdmin: false,
    note: 'application/octet-stream, streamed; up to the node agent cap (64 MiB by default).' },
  { method: 'GET', path: '/ardent/installations/{nodeId}/profiles/{name}/artifacts/{sha256}/content', response: null, actingAdmin: false,
    note: 'Artifact transfer v2 (studio >= 4, capabilities.artifact_transfer >= 2), streamed: the artifact media type and Content-Disposition with its name, Accept-Ranges, ETag "<sha256>", Repr-Digest and X-Content-SHA256. Range and If-Range pass through: 206 with Content-Range for one range, 416 with Content-Range bytes */<size> when unsatisfiable. Up to the node agent cap (64 MiB by default) for the whole artifact; 409 unsupported_capability on an older profile.' },
  { method: 'POST', path: '/ardent/agents', request: ardentAgentDeployRequestSchema, response: ardentAgentOperationAcceptedResponseSchema, successStatus: 202, actingAdmin: true },
  { method: 'GET', path: '/ardent/agents/operations/{id}', response: ardentAgentOperationResponseSchema, actingAdmin: false },
  { method: 'GET', path: '/ardent/agents/operations/{id}/stream', response: null, actingAdmin: false,
    events: { operation: ardentAgentOperationSchema, done: ardentAgentOperationSchema } },
  { method: 'POST', path: '/ardent/agents/operations/{id}/resume', response: ardentAgentOperationAcceptedResponseSchema, successStatus: 202, actingAdmin: true },
  { method: 'POST', path: '/ardent/installations/{nodeId}/profiles/{name}/hivemem', response: ardentAgentOperationAcceptedResponseSchema, successStatus: 202, actingAdmin: true },
  { method: 'GET', path: '/ardent/dependencies', response: ardentDependenciesResponseSchema, actingAdmin: false,
    note: 'HiveMem, HiveSkills and Emberpath as Magnus resolved them (explicit setting, then the Hive Registry). Read only; refresh=true resolves again now.' },
  { method: 'GET', path: '/ardent/installations/{nodeId}/profiles/{name}/definition', response: ok(agentDefinitionExportSchema), actingAdmin: true,
    note: 'Exports the profile as a hive-agent-definition/1. 409 AGENT_UPGRADE_REQUIRED when the node agent cannot report skill receipts or retained extensions; 422 DEFINITION_CONTAINS_CREDENTIAL when a carried text looks like a credential.' },
  { method: 'POST', path: '/ardent/agent-definitions/validate', request: agentDefinitionValidateRequestSchema, response: ok(agentDefinitionPreflightSchema), actingAdmin: true,
    note: 'The preflight for installing the definition on nodeId. 422 DEFINITION_INVALID or DEFINITION_CONTAINS_CREDENTIAL for a definition that is malformed, fails a digest or carries a credential-like value.' },
  { method: 'POST', path: '/ardent/agent-definitions/install', request: agentDefinitionInstallRequestSchema, response: ardentAgentOperationAcceptedResponseSchema, successStatus: 202, actingAdmin: true,
    note: 'Starts a definition operation (kind definition) once the preflight passes; 409 PREFLIGHT_FAILED carries the report in error.details and nothing is created.' },
];

export type ArdentServiceActionRequest = z.infer<typeof ardentServiceActionRequestSchema>;
export type ArdentTaskRecoveryDecision = z.infer<typeof ardentTaskRecoveryDecisionSchema>;
export type ArdentTaskRecovery = z.infer<typeof ardentTaskRecoverySchema>;
export type ArdentArtifactImport = z.infer<typeof ardentArtifactImportSchema>;
export type ArdentArtifactImportState = z.infer<typeof ardentArtifactImportStateSchema>;
export type ArdentUnsupportedCapabilityDetails = z.infer<typeof ardentUnsupportedCapabilityDetailsSchema>;
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
export type ArdentSkillInstall = z.infer<typeof ardentSkillInstallSchema>;
export type ArdentSkillInstallNode = z.infer<typeof ardentSkillInstallNodeSchema>;
export type ArdentSkillInstallResult = z.infer<typeof ardentSkillInstallResultSchema>;
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
  ardentSkillInstallNodeSchema, ardentSkillInstallResultSchema, ardentSkillInstallSchema,
  ardentTaskStreamQuerySchema, ardentTaskTextEventSchema, ardentTeamMissionSchema,
};
