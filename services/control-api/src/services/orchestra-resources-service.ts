import { getDb } from '../db/index.js';
import { HttpError } from '../middleware/error-handler.js';

function asJson<T>(value: T): string {
  return JSON.stringify(value ?? null);
}

function safeParse(value: string | null | undefined, fallback: unknown): unknown {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function ensureInstallation(installationId: string): Promise<void> {
  const db = getDb();
  const found = await db.hermesInstallation.findUnique({ where: { id: installationId } });
  if (!found) throw new HttpError(404, 'NOT_FOUND', `Hermes installation ${installationId} not found`);
}

// ── Skill assignments ──────────────────────────────────────────────────────
export async function listSkillAssignments(filter: { installationId?: string; profileId?: string }) {
  const db = getDb();
  return db.hermesSkillAssignment.findMany({
    where: {
      ...(filter.installationId ? { installationId: filter.installationId } : {}),
      ...(filter.profileId ? { profileId: filter.profileId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createSkillAssignment(input: {
  installationId: string;
  profileId?: string | null;
  skillSlug: string;
  pinnedVersion?: string | null;
  source?: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
  actorId: string;
}) {
  await ensureInstallation(input.installationId);
  const db = getDb();
  return db.hermesSkillAssignment.create({
    data: {
      installationId: input.installationId,
      profileId: input.profileId ?? "",
      skillSlug: input.skillSlug,
      pinnedVersion: input.pinnedVersion ?? null,
      source: input.source ?? 'magnus-skills',
      enabled: input.enabled ?? true,
      metadata: asJson(input.metadata ?? {}),
      createdBy: input.actorId,
    },
  });
}

export async function updateSkillAssignment(id: string, patch: { pinnedVersion?: string | null; enabled?: boolean; metadata?: Record<string, unknown> }) {
  const db = getDb();
  return db.hermesSkillAssignment.update({
    where: { id },
    data: {
      ...(patch.pinnedVersion !== undefined ? { pinnedVersion: patch.pinnedVersion } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.metadata !== undefined ? { metadata: asJson(patch.metadata) } : {}),
    },
  });
}

export async function deleteSkillAssignment(id: string) {
  const db = getDb();
  await db.hermesSkillAssignment.delete({ where: { id } });
}

// ── Toolset policies ────────────────────────────────────────────────────────
export async function listToolsetPolicies(filter: { installationId?: string; profileId?: string }) {
  const db = getDb();
  return db.hermesToolsetPolicy.findMany({
    where: {
      ...(filter.installationId ? { installationId: filter.installationId } : {}),
      ...(filter.profileId ? { profileId: filter.profileId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function upsertToolsetPolicy(input: {
  installationId: string;
  profileId?: string | null;
  toolset: string;
  enabled?: boolean;
  approvalMode?: string;
  perToolHooks?: unknown[];
  allowList?: string[];
  denyList?: string[];
  metadata?: Record<string, unknown>;
  actorId: string;
}) {
  await ensureInstallation(input.installationId);
  const db = getDb();
  return db.hermesToolsetPolicy.upsert({
    where: {
      installationId_profileId_toolset: {
        installationId: input.installationId,
        profileId: input.profileId ?? "",
        toolset: input.toolset,
      },
    },
    create: {
      installationId: input.installationId,
      profileId: input.profileId ?? "",
      toolset: input.toolset,
      enabled: input.enabled ?? true,
      approvalMode: input.approvalMode ?? 'auto',
      perToolHooks: asJson(input.perToolHooks ?? []),
      allowList: asJson(input.allowList ?? []),
      denyList: asJson(input.denyList ?? []),
      metadata: asJson(input.metadata ?? {}),
      createdBy: input.actorId,
    },
    update: {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.approvalMode !== undefined ? { approvalMode: input.approvalMode } : {}),
      ...(input.perToolHooks !== undefined ? { perToolHooks: asJson(input.perToolHooks) } : {}),
      ...(input.allowList !== undefined ? { allowList: asJson(input.allowList) } : {}),
      ...(input.denyList !== undefined ? { denyList: asJson(input.denyList) } : {}),
      ...(input.metadata !== undefined ? { metadata: asJson(input.metadata) } : {}),
    },
  });
}

export async function deleteToolsetPolicy(id: string) {
  const db = getDb();
  await db.hermesToolsetPolicy.delete({ where: { id } });
}

export async function updateToolsetPolicyById(id: string, patch: {
  enabled?: boolean;
  approvalMode?: string;
  perToolHooks?: unknown[];
  allowList?: string[];
  denyList?: string[];
  metadata?: Record<string, unknown>;
}) {
  const db = getDb();
  return db.hermesToolsetPolicy.update({
    where: { id },
    data: {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.approvalMode !== undefined ? { approvalMode: patch.approvalMode } : {}),
      ...(patch.perToolHooks !== undefined ? { perToolHooks: asJson(patch.perToolHooks) } : {}),
      ...(patch.allowList !== undefined ? { allowList: asJson(patch.allowList) } : {}),
      ...(patch.denyList !== undefined ? { denyList: asJson(patch.denyList) } : {}),
      ...(patch.metadata !== undefined ? { metadata: asJson(patch.metadata) } : {}),
    },
  });
}

// ── Roles ───────────────────────────────────────────────────────────────────
export async function listHermesRoles() {
  const db = getDb();
  const rows = await db.hermesRole.findMany({
    include: { applications: true },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    ...r,
    toolsets: safeParse(r.toolsetsJson, []),
    skills: safeParse(r.skillsJson, []),
    provider: safeParse(r.providerJson, {}),
    cron: safeParse(r.cronJson, []),
    messaging: safeParse(r.messagingJson, []),
  }));
}

export async function getHermesRole(id: string) {
  const db = getDb();
  const r = await db.hermesRole.findUnique({ where: { id }, include: { applications: true } });
  if (!r) return null;
  return {
    ...r,
    toolsets: safeParse(r.toolsetsJson, []),
    skills: safeParse(r.skillsJson, []),
    provider: safeParse(r.providerJson, {}),
    cron: safeParse(r.cronJson, []),
    messaging: safeParse(r.messagingJson, []),
  };
}

export async function createHermesRole(input: {
  name: string;
  description?: string;
  personalityMd?: string;
  personalityRef?: string | null;
  toolsets?: unknown[];
  skills?: unknown[];
  provider?: Record<string, unknown>;
  cron?: unknown[];
  messaging?: unknown[];
  metadata?: Record<string, unknown>;
  actorId: string;
}) {
  const db = getDb();
  return db.hermesRole.create({
    data: {
      name: input.name,
      description: input.description ?? '',
      personalityMd: input.personalityMd ?? '',
      personalityRef: input.personalityRef ?? null,
      toolsetsJson: asJson(input.toolsets ?? []),
      skillsJson: asJson(input.skills ?? []),
      providerJson: asJson(input.provider ?? {}),
      cronJson: asJson(input.cron ?? []),
      messagingJson: asJson(input.messaging ?? []),
      metadata: asJson(input.metadata ?? {}),
      createdBy: input.actorId,
    },
  });
}

export async function updateHermesRole(id: string, patch: {
  description?: string;
  personalityMd?: string;
  personalityRef?: string | null;
  toolsets?: unknown[];
  skills?: unknown[];
  provider?: Record<string, unknown>;
  cron?: unknown[];
  messaging?: unknown[];
  metadata?: Record<string, unknown>;
}) {
  const db = getDb();
  return db.hermesRole.update({
    where: { id },
    data: {
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.personalityMd !== undefined ? { personalityMd: patch.personalityMd } : {}),
      ...(patch.personalityRef !== undefined ? { personalityRef: patch.personalityRef } : {}),
      ...(patch.toolsets !== undefined ? { toolsetsJson: asJson(patch.toolsets) } : {}),
      ...(patch.skills !== undefined ? { skillsJson: asJson(patch.skills) } : {}),
      ...(patch.provider !== undefined ? { providerJson: asJson(patch.provider) } : {}),
      ...(patch.cron !== undefined ? { cronJson: asJson(patch.cron) } : {}),
      ...(patch.messaging !== undefined ? { messagingJson: asJson(patch.messaging) } : {}),
      ...(patch.metadata !== undefined ? { metadata: asJson(patch.metadata) } : {}),
    },
  });
}

export async function deleteHermesRole(id: string) {
  const db = getDb();
  await db.hermesRole.delete({ where: { id } });
}

export async function applyHermesRole(roleId: string, scope: { installationId: string; profileId?: string | null; actorId: string }) {
  await ensureInstallation(scope.installationId);
  const db = getDb();
  const role = await db.hermesRole.findUnique({ where: { id: roleId } });
  if (!role) throw new HttpError(404, 'NOT_FOUND', `Hermes role ${roleId} not found`);
  return db.hermesRoleApplication.upsert({
    where: {
      roleId_installationId_profileId: {
        roleId,
        installationId: scope.installationId,
        profileId: scope.profileId ?? "",
      },
    },
    create: {
      roleId,
      installationId: scope.installationId,
      profileId: scope.profileId ?? "",
      createdBy: scope.actorId,
    },
    update: { status: 'pending', error: null },
  });
}

// ── Provider configs ────────────────────────────────────────────────────────
export async function getProviderConfig(installationId: string, profileId: string | null) {
  const db = getDb();
  return db.hermesProviderConfig.findFirst({ where: { installationId, profileId: profileId ?? '' } });
}

export async function upsertProviderConfig(input: {
  installationId: string;
  profileId?: string | null;
  chain?: string[];
  sortStrategy?: string;
  whitelist?: string[];
  blacklist?: string[];
  visionOverride?: string | null;
  compressionOverride?: string | null;
  metadata?: Record<string, unknown>;
  actorId: string;
}) {
  await ensureInstallation(input.installationId);
  const db = getDb();
  return db.hermesProviderConfig.upsert({
    where: {
      installationId_profileId: { installationId: input.installationId, profileId: input.profileId ?? "" },
    },
    create: {
      installationId: input.installationId,
      profileId: input.profileId ?? "",
      chainJson: asJson(input.chain ?? []),
      sortStrategy: input.sortStrategy ?? 'priority',
      whitelistJson: asJson(input.whitelist ?? []),
      blacklistJson: asJson(input.blacklist ?? []),
      visionOverride: input.visionOverride ?? null,
      compressionOverride: input.compressionOverride ?? null,
      metadata: asJson(input.metadata ?? {}),
      createdBy: input.actorId,
    },
    update: {
      ...(input.chain !== undefined ? { chainJson: asJson(input.chain) } : {}),
      ...(input.sortStrategy !== undefined ? { sortStrategy: input.sortStrategy } : {}),
      ...(input.whitelist !== undefined ? { whitelistJson: asJson(input.whitelist) } : {}),
      ...(input.blacklist !== undefined ? { blacklistJson: asJson(input.blacklist) } : {}),
      ...(input.visionOverride !== undefined ? { visionOverride: input.visionOverride } : {}),
      ...(input.compressionOverride !== undefined ? { compressionOverride: input.compressionOverride } : {}),
      ...(input.metadata !== undefined ? { metadata: asJson(input.metadata) } : {}),
    },
  });
}

// ── Credential pools ────────────────────────────────────────────────────────
export async function listCredentialPools() {
  const db = getDb();
  return db.hermesCredentialPool.findMany({
    include: { attachments: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createCredentialPool(input: { name: string; provider: string; rotationPolicy?: string; secretRefs?: string[]; metadata?: Record<string, unknown>; actorId: string }) {
  const db = getDb();
  return db.hermesCredentialPool.create({
    data: {
      name: input.name,
      provider: input.provider,
      rotationPolicy: input.rotationPolicy ?? 'rate-limit',
      secretRefsJson: asJson(input.secretRefs ?? []),
      metadata: asJson(input.metadata ?? {}),
      createdBy: input.actorId,
    },
  });
}

export async function updateCredentialPool(id: string, patch: { provider?: string; rotationPolicy?: string; secretRefs?: string[]; metadata?: Record<string, unknown> }) {
  const db = getDb();
  return db.hermesCredentialPool.update({
    where: { id },
    data: {
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.rotationPolicy !== undefined ? { rotationPolicy: patch.rotationPolicy } : {}),
      ...(patch.secretRefs !== undefined ? { secretRefsJson: asJson(patch.secretRefs) } : {}),
      ...(patch.metadata !== undefined ? { metadata: asJson(patch.metadata) } : {}),
    },
  });
}

export async function deleteCredentialPool(id: string) {
  const db = getDb();
  await db.hermesCredentialPool.delete({ where: { id } });
}

export async function attachCredentialPool(poolId: string, scope: { installationId: string; profileId?: string | null; actorId: string }) {
  await ensureInstallation(scope.installationId);
  const db = getDb();
  return db.hermesCredentialPoolAttachment.upsert({
    where: {
      poolId_installationId_profileId: { poolId, installationId: scope.installationId, profileId: scope.profileId ?? "" },
    },
    create: { poolId, installationId: scope.installationId, profileId: scope.profileId ?? "", createdBy: scope.actorId },
    update: { status: 'pending' },
  });
}

export async function detachCredentialPool(attachmentId: string) {
  const db = getDb();
  await db.hermesCredentialPoolAttachment.delete({ where: { id: attachmentId } });
}

// ── MCP servers ─────────────────────────────────────────────────────────────
export async function listMcpServers() {
  const db = getDb();
  return db.hermesMcpServer.findMany({ include: { attachments: true }, orderBy: { createdAt: 'desc' } });
}

export async function createMcpServer(input: { name: string; transport: string; endpoint?: string; args?: string[]; env?: Record<string, string>; toolFilter?: string[]; samplingEnabled?: boolean; metadata?: Record<string, unknown>; actorId: string }) {
  const db = getDb();
  return db.hermesMcpServer.create({
    data: {
      name: input.name,
      transport: input.transport,
      endpoint: input.endpoint ?? '',
      argsJson: asJson(input.args ?? []),
      envJson: asJson(input.env ?? {}),
      toolFilterJson: asJson(input.toolFilter ?? []),
      samplingEnabled: input.samplingEnabled ?? false,
      metadata: asJson(input.metadata ?? {}),
      createdBy: input.actorId,
    },
  });
}

export async function updateMcpServer(id: string, patch: { transport?: string; endpoint?: string; args?: string[]; env?: Record<string, string>; toolFilter?: string[]; samplingEnabled?: boolean; metadata?: Record<string, unknown> }) {
  const db = getDb();
  return db.hermesMcpServer.update({
    where: { id },
    data: {
      ...(patch.transport !== undefined ? { transport: patch.transport } : {}),
      ...(patch.endpoint !== undefined ? { endpoint: patch.endpoint } : {}),
      ...(patch.args !== undefined ? { argsJson: asJson(patch.args) } : {}),
      ...(patch.env !== undefined ? { envJson: asJson(patch.env) } : {}),
      ...(patch.toolFilter !== undefined ? { toolFilterJson: asJson(patch.toolFilter) } : {}),
      ...(patch.samplingEnabled !== undefined ? { samplingEnabled: patch.samplingEnabled } : {}),
      ...(patch.metadata !== undefined ? { metadata: asJson(patch.metadata) } : {}),
    },
  });
}

export async function deleteMcpServer(id: string) {
  const db = getDb();
  await db.hermesMcpServer.delete({ where: { id } });
}

export async function attachMcpServer(serverId: string, scope: { installationId: string; profileId?: string | null; actorId: string }) {
  await ensureInstallation(scope.installationId);
  const db = getDb();
  return db.hermesMcpServerAttachment.upsert({
    where: { serverId_installationId_profileId: { serverId, installationId: scope.installationId, profileId: scope.profileId ?? "" } },
    create: { serverId, installationId: scope.installationId, profileId: scope.profileId ?? "", createdBy: scope.actorId },
    update: { status: 'pending' },
  });
}

export async function detachMcpServer(attachmentId: string) {
  const db = getDb();
  await db.hermesMcpServerAttachment.delete({ where: { id: attachmentId } });
}

// ── Messaging bindings ──────────────────────────────────────────────────────
export async function listMessagingBindings(filter: { installationId?: string; profileId?: string }) {
  const db = getDb();
  return db.hermesMessagingBinding.findMany({
    where: {
      ...(filter.installationId ? { installationId: filter.installationId } : {}),
      ...(filter.profileId ? { profileId: filter.profileId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createMessagingBinding(input: {
  installationId: string;
  profileId?: string | null;
  platform: string;
  channelIds?: string[];
  voiceEnabled?: boolean;
  voiceModel?: string | null;
  ttsProvider?: string | null;
  secretRef?: string | null;
  metadata?: Record<string, unknown>;
  actorId: string;
}) {
  await ensureInstallation(input.installationId);
  const db = getDb();
  return db.hermesMessagingBinding.create({
    data: {
      installationId: input.installationId,
      profileId: input.profileId ?? "",
      platform: input.platform,
      channelIdsJson: asJson(input.channelIds ?? []),
      voiceEnabled: input.voiceEnabled ?? false,
      voiceModel: input.voiceModel ?? null,
      ttsProvider: input.ttsProvider ?? null,
      secretRef: input.secretRef ?? null,
      metadata: asJson(input.metadata ?? {}),
      createdBy: input.actorId,
    },
  });
}

export async function updateMessagingBinding(id: string, patch: { channelIds?: string[]; voiceEnabled?: boolean; voiceModel?: string | null; ttsProvider?: string | null; secretRef?: string | null; metadata?: Record<string, unknown> }) {
  const db = getDb();
  return db.hermesMessagingBinding.update({
    where: { id },
    data: {
      ...(patch.channelIds !== undefined ? { channelIdsJson: asJson(patch.channelIds) } : {}),
      ...(patch.voiceEnabled !== undefined ? { voiceEnabled: patch.voiceEnabled } : {}),
      ...(patch.voiceModel !== undefined ? { voiceModel: patch.voiceModel } : {}),
      ...(patch.ttsProvider !== undefined ? { ttsProvider: patch.ttsProvider } : {}),
      ...(patch.secretRef !== undefined ? { secretRef: patch.secretRef } : {}),
      ...(patch.metadata !== undefined ? { metadata: asJson(patch.metadata) } : {}),
    },
  });
}

export async function deleteMessagingBinding(id: string) {
  const db = getDb();
  await db.hermesMessagingBinding.delete({ where: { id } });
}

// ── Hermes cron jobs ────────────────────────────────────────────────────────
export async function listHermesCronJobs(filter: { installationId?: string; profileId?: string }) {
  const db = getDb();
  return db.hermesCronJob.findMany({
    where: {
      ...(filter.installationId ? { installationId: filter.installationId } : {}),
      ...(filter.profileId ? { profileId: filter.profileId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createHermesCronJob(input: {
  installationId: string;
  profileId?: string | null;
  name: string;
  prompt?: string;
  cronExpr?: string;
  naturalLanguage?: string | null;
  attachedSkills?: string[];
  delivery?: Record<string, unknown>;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
  actorId: string;
}) {
  await ensureInstallation(input.installationId);
  const db = getDb();
  return db.hermesCronJob.create({
    data: {
      installationId: input.installationId,
      profileId: input.profileId ?? "",
      name: input.name,
      prompt: input.prompt ?? '',
      cronExpr: input.cronExpr ?? '',
      naturalLanguage: input.naturalLanguage ?? null,
      attachedSkillsJson: asJson(input.attachedSkills ?? []),
      deliveryJson: asJson(input.delivery ?? {}),
      enabled: input.enabled ?? true,
      metadata: asJson(input.metadata ?? {}),
      createdBy: input.actorId,
    },
  });
}

export async function updateHermesCronJob(id: string, patch: { prompt?: string; cronExpr?: string; naturalLanguage?: string | null; attachedSkills?: string[]; delivery?: Record<string, unknown>; enabled?: boolean; metadata?: Record<string, unknown> }) {
  const db = getDb();
  return db.hermesCronJob.update({
    where: { id },
    data: {
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.cronExpr !== undefined ? { cronExpr: patch.cronExpr } : {}),
      ...(patch.naturalLanguage !== undefined ? { naturalLanguage: patch.naturalLanguage } : {}),
      ...(patch.attachedSkills !== undefined ? { attachedSkillsJson: asJson(patch.attachedSkills) } : {}),
      ...(patch.delivery !== undefined ? { deliveryJson: asJson(patch.delivery) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.metadata !== undefined ? { metadata: asJson(patch.metadata) } : {}),
    },
  });
}

export async function deleteHermesCronJob(id: string) {
  const db = getDb();
  await db.hermesCronJob.delete({ where: { id } });
}

// ── Plugins ─────────────────────────────────────────────────────────────────
export async function listHermesPlugins(filter: { installationId?: string; profileId?: string }) {
  const db = getDb();
  return db.hermesPluginInstall.findMany({
    where: {
      ...(filter.installationId ? { installationId: filter.installationId } : {}),
      ...(filter.profileId ? { profileId: filter.profileId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function installHermesPlugin(input: { installationId: string; profileId?: string | null; pluginSlug: string; pluginType?: string; pinnedVersion?: string | null; metadata?: Record<string, unknown>; actorId: string }) {
  await ensureInstallation(input.installationId);
  const db = getDb();
  return db.hermesPluginInstall.upsert({
    where: { installationId_profileId_pluginSlug: { installationId: input.installationId, profileId: input.profileId ?? "", pluginSlug: input.pluginSlug } },
    create: {
      installationId: input.installationId,
      profileId: input.profileId ?? "",
      pluginSlug: input.pluginSlug,
      pluginType: input.pluginType ?? 'general',
      pinnedVersion: input.pinnedVersion ?? null,
      metadata: asJson(input.metadata ?? {}),
      createdBy: input.actorId,
    },
    update: { status: 'pending', pinnedVersion: input.pinnedVersion ?? null },
  });
}

export async function removeHermesPlugin(id: string) {
  const db = getDb();
  await db.hermesPluginInstall.delete({ where: { id } });
}

// ── Hooks ───────────────────────────────────────────────────────────────────
export async function listHermesHooks(filter: { installationId?: string; profileId?: string }) {
  const db = getDb();
  return db.hermesHook.findMany({
    where: {
      ...(filter.installationId ? { installationId: filter.installationId } : {}),
      ...(filter.profileId ? { profileId: filter.profileId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createHermesHook(input: { installationId: string; profileId?: string | null; event: string; target: string; config?: Record<string, unknown>; enabled?: boolean; metadata?: Record<string, unknown>; actorId: string }) {
  await ensureInstallation(input.installationId);
  const db = getDb();
  return db.hermesHook.create({
    data: {
      installationId: input.installationId,
      profileId: input.profileId ?? "",
      event: input.event,
      target: input.target,
      configJson: asJson(input.config ?? {}),
      enabled: input.enabled ?? true,
      metadata: asJson(input.metadata ?? {}),
      createdBy: input.actorId,
    },
  });
}

export async function updateHermesHook(id: string, patch: { event?: string; target?: string; config?: Record<string, unknown>; enabled?: boolean; metadata?: Record<string, unknown> }) {
  const db = getDb();
  return db.hermesHook.update({
    where: { id },
    data: {
      ...(patch.event !== undefined ? { event: patch.event } : {}),
      ...(patch.target !== undefined ? { target: patch.target } : {}),
      ...(patch.config !== undefined ? { configJson: asJson(patch.config) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.metadata !== undefined ? { metadata: asJson(patch.metadata) } : {}),
    },
  });
}

export async function deleteHermesHook(id: string) {
  const db = getDb();
  await db.hermesHook.delete({ where: { id } });
}
