import { z } from 'zod';

/** Common scope used by all per-installation+profile resources. */
export const orchestraScopeSchema = z.object({
  installationId: z.string().min(1),
  profileId: z.string().min(1).optional().nullable(),
});

// ── Skill assignments ──
export const skillAssignmentCreateSchema = orchestraScopeSchema.extend({
  skillSlug: z.string().min(1),
  pinnedVersion: z.string().optional().nullable(),
  source: z.enum(['magnus-skills', 'upload', 'agentskills.io']).default('magnus-skills'),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const skillAssignmentUpdateSchema = z.object({
  pinnedVersion: z.string().optional().nullable(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ── Toolset policies ──
export const toolsetPolicyCreateSchema = orchestraScopeSchema.extend({
  toolset: z.string().min(1),
  enabled: z.boolean().optional(),
  approvalMode: z.enum(['auto', 'confirm', 'block']).default('auto'),
  perToolHooks: z.array(z.record(z.string(), z.unknown())).optional(),
  allowList: z.array(z.string()).optional(),
  denyList: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const toolsetPolicyUpdateSchema = toolsetPolicyCreateSchema.partial().omit({ installationId: true });

// ── Roles ──
export const hermesRoleCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  personalityMd: z.string().default(''),
  personalityRef: z.string().optional().nullable(),
  toolsets: z.array(z.string()).optional(),
  skills: z.array(z.object({ slug: z.string(), version: z.string().optional() })).optional(),
  provider: z.record(z.string(), z.unknown()).optional(),
  cron: z.array(z.record(z.string(), z.unknown())).optional(),
  messaging: z.array(z.record(z.string(), z.unknown())).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const hermesRoleUpdateSchema = hermesRoleCreateSchema.partial().omit({ name: true });
export const hermesRoleApplySchema = orchestraScopeSchema;

// ── Provider configs ──
export const providerConfigSchema = orchestraScopeSchema.extend({
  chain: z.array(z.string()).default([]),
  sortStrategy: z.enum(['priority', 'cost', 'speed', 'quality']).default('priority'),
  whitelist: z.array(z.string()).optional(),
  blacklist: z.array(z.string()).optional(),
  visionOverride: z.string().optional().nullable(),
  compressionOverride: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ── Credential pools ──
export const credentialPoolCreateSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  rotationPolicy: z.enum(['rate-limit', 'round-robin', 'failure']).default('rate-limit'),
  secretRefs: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const credentialPoolUpdateSchema = credentialPoolCreateSchema.partial().omit({ name: true });
export const credentialPoolAttachSchema = orchestraScopeSchema;

// ── MCP servers ──
export const mcpServerCreateSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http', 'sse']),
  endpoint: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  toolFilter: z.array(z.string()).optional(),
  samplingEnabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const mcpServerUpdateSchema = mcpServerCreateSchema.partial().omit({ name: true });
export const mcpServerAttachSchema = orchestraScopeSchema;

// ── Messaging bindings ──
export const messagingBindingCreateSchema = orchestraScopeSchema.extend({
  platform: z.string().min(1),
  channelIds: z.array(z.string()).optional(),
  voiceEnabled: z.boolean().optional(),
  voiceModel: z.string().optional().nullable(),
  ttsProvider: z.string().optional().nullable(),
  secretRef: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const messagingBindingUpdateSchema = messagingBindingCreateSchema.partial().omit({ installationId: true, platform: true });

// ── Cron jobs (Hermes-scoped) ──
export const hermesCronJobCreateSchema = orchestraScopeSchema.extend({
  name: z.string().min(1),
  prompt: z.string().default(''),
  cronExpr: z.string().default(''),
  naturalLanguage: z.string().optional().nullable(),
  attachedSkills: z.array(z.string()).optional(),
  delivery: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const hermesCronJobUpdateSchema = hermesCronJobCreateSchema.partial().omit({ installationId: true, name: true });

// ── Plugins ──
export const hermesPluginCreateSchema = orchestraScopeSchema.extend({
  pluginSlug: z.string().min(1),
  pluginType: z.enum(['general', 'memory-provider', 'context-engine']).default('general'),
  pinnedVersion: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ── Hooks ──
export const hermesHookCreateSchema = orchestraScopeSchema.extend({
  event: z.string().min(1),
  target: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const hermesHookUpdateSchema = hermesHookCreateSchema.partial().omit({ installationId: true });

export type OrchestraScope = z.infer<typeof orchestraScopeSchema>;
