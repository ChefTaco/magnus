import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb } from '../db/index.js';
import { getSkillsDir as getPackageSkillsDir } from '@hivemagnus/magnus-skills';
import { HttpError } from '../middleware/error-handler.js';

export interface OrchestraOverview {
  installations: { total: number; running: number; degraded: number; error: number };
  profiles: { total: number };
  jobs: { queued: number; running: number; completed: number; failed: number };
  resources: {
    skillAssignments: number;
    toolsetPolicies: number;
    roles: number;
    providerConfigs: number;
    credentialPools: number;
    mcpServers: number;
    messagingBindings: number;
    cronJobs: number;
    plugins: number;
    hooks: number;
  };
  recentJobs: Array<{ id: string; type: string; status: string; startedAt: string; completedAt: string | null }>;
  generatedAt: string;
}

export type CapabilityState = 'supported' | 'missing' | 'unknown';

export interface OrchestraCapability {
  key: string;
  label: string;
  state: CapabilityState;
  detail: string;
  installationId?: string;
  profileId?: string;
}

export interface OrchestraCapabilityInventory {
  summary: Record<CapabilityState, number>;
  capabilities: OrchestraCapability[];
  generatedAt: string;
}

function capabilityState(value: unknown): CapabilityState {
  if (value === true) return 'supported';
  if (value === false) return 'missing';
  return 'unknown';
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function countStates(capabilities: OrchestraCapability[]): Record<CapabilityState, number> {
  return capabilities.reduce<Record<CapabilityState, number>>((acc, item) => {
    acc[item.state] += 1;
    return acc;
  }, { supported: 0, missing: 0, unknown: 0 });
}

export async function getOrchestraOverview(): Promise<OrchestraOverview> {
  const db = getDb();
  const [
    installations,
    profiles,
    jobs,
    recentJobs,
    skillAssignments,
    toolsetPolicies,
    roles,
    providerConfigs,
    credentialPools,
    mcpServers,
    messagingBindings,
    cronJobs,
    plugins,
    hooks,
  ] = await Promise.all([
    db.hermesInstallation.findMany({ select: { status: true } }),
    db.hermesProfile.count(),
    db.hermesOperationJob.findMany({ select: { status: true } }),
    db.hermesOperationJob.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: { id: true, type: true, status: true, startedAt: true, completedAt: true },
    }),
    db.hermesSkillAssignment.count(),
    db.hermesToolsetPolicy.count(),
    db.hermesRole.count(),
    db.hermesProviderConfig.count(),
    db.hermesCredentialPool.count(),
    db.hermesMcpServer.count(),
    db.hermesMessagingBinding.count(),
    db.hermesCronJob.count(),
    db.hermesPluginInstall.count(),
    db.hermesHook.count(),
  ]);

  const installCount = (s: string): number => installations.filter((i) => i.status === s).length;
  const jobCount = (s: string): number => jobs.filter((j) => j.status === s).length;

  return {
    installations: {
      total: installations.length,
      running: installCount('running'),
      degraded: installCount('degraded'),
      error: installCount('error'),
    },
    profiles: { total: profiles },
    jobs: {
      queued: jobCount('queued'),
      running: jobCount('running'),
      completed: jobCount('completed'),
      failed: jobCount('failed'),
    },
    resources: {
      skillAssignments,
      toolsetPolicies,
      roles,
      providerConfigs,
      credentialPools,
      mcpServers,
      messagingBindings,
      cronJobs,
      plugins,
      hooks,
    },
    recentJobs: recentJobs.map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      startedAt: j.startedAt.toISOString(),
      completedAt: j.completedAt ? j.completedAt.toISOString() : null,
    })),
    generatedAt: new Date().toISOString(),
  };
}


export async function getOrchestraCapabilityInventory(): Promise<OrchestraCapabilityInventory> {
  const db = getDb();
  const [
    installations,
    profiles,
    skillAssignments,
    toolsetPolicies,
    mcpServers,
    messagingBindings,
    cronJobs,
    plugins,
    hooks,
  ] = await Promise.all([
    db.hermesInstallation.findMany({ include: { profiles: true }, orderBy: { hostname: 'asc' } }),
    db.hermesProfile.findMany({ include: { installation: true }, orderBy: [{ installationId: 'asc' }, { name: 'asc' }] }),
    db.hermesSkillAssignment.count(),
    db.hermesToolsetPolicy.count(),
    db.hermesMcpServer.count(),
    db.hermesMessagingBinding.count(),
    db.hermesCronJob.count(),
    db.hermesPluginInstall.count(),
    db.hermesHook.count(),
  ]);

  const capabilities: OrchestraCapability[] = [];

  for (const installation of installations) {
    const label = installation.displayName ?? installation.hostname;
    const rawStatus = parseJsonObject(installation.rawStatus);
    const metadata = parseJsonObject(installation.metadata);
    const routerConfigured = rawStatus['magnusRouterConfigured'] ?? metadata['magnusRouterConfigured'];
    capabilities.push(
      {
        key: `installation:${installation.id}:runtime`,
        label: `${label} runtime`,
        state: ['running', 'detected'].includes(installation.status) ? 'supported' : installation.status === 'not_installed' ? 'missing' : 'unknown',
        detail: `Hermes ${installation.version ?? 'version unknown'} · ${installation.status}`,
        installationId: installation.id,
      },
      {
        key: `installation:${installation.id}:dashboard`,
        label: `${label} dashboard`,
        state: installation.dashboardStatus === 'running' ? 'supported' : ['stopped', 'failed', 'error'].includes(installation.dashboardStatus) ? 'missing' : 'unknown',
        detail: `${installation.dashboardHost}:${installation.dashboardPort} · ${installation.dashboardStatus}`,
        installationId: installation.id,
      },
      {
        key: `installation:${installation.id}:api-server`,
        label: `${label} API server`,
        state: installation.apiServerEnabled ? 'supported' : 'missing',
        detail: installation.apiServerEnabled ? `${installation.apiServerHost}:${installation.apiServerPort ?? '?'}` : 'disabled',
        installationId: installation.id,
      },
      {
        key: `installation:${installation.id}:router`,
        label: `${label} Magnus Router`,
        state: capabilityState(routerConfigured),
        detail: 'Model router configuration from last sync metadata when available.',
        installationId: installation.id,
      },
    );
  }

  for (const profile of profiles) {
    const profileLabel = `${profile.installation.displayName ?? profile.installation.hostname} / ${profile.name}`;
    const cap = parseJsonObject(profile.capabilities);
    capabilities.push(
      {
        key: `profile:${profile.id}:gateway`,
        label: `${profileLabel} gateway`,
        state: profile.gatewayStatus === 'running' ? 'supported' : ['stopped', 'failed', 'error'].includes(profile.gatewayStatus) ? 'missing' : 'unknown',
        detail: `gateway ${profile.gatewayStatus}`,
        installationId: profile.installationId,
        profileId: profile.id,
      },
      {
        key: `profile:${profile.id}:checkpoints`,
        label: `${profileLabel} checkpoints`,
        state: capabilityState(cap['checkpoints'] ?? cap['checkpointing'] ?? cap['checkpointSupport']),
        detail: 'Read from synced profile capabilities.',
        installationId: profile.installationId,
        profileId: profile.id,
      },
      {
        key: `profile:${profile.id}:kanban`,
        label: `${profileLabel} Kanban`,
        state: capabilityState(cap['kanban'] ?? cap['multiAgentKanban']),
        detail: 'Read from synced profile capabilities.',
        installationId: profile.installationId,
        profileId: profile.id,
      },
      {
        key: `profile:${profile.id}:goal`,
        label: `${profileLabel} /goal`,
        state: capabilityState(cap['goal'] ?? cap['goals'] ?? cap['slashGoal']),
        detail: 'Read from synced profile capabilities.',
        installationId: profile.installationId,
        profileId: profile.id,
      },
    );
  }

  capabilities.push(
    { key: 'fleet:skills', label: 'Fleet skill assignments', state: skillAssignments > 0 ? 'supported' : 'missing', detail: `${skillAssignments} assignment${skillAssignments === 1 ? '' : 's'}` },
    { key: 'fleet:toolsets', label: 'Fleet toolset policies', state: toolsetPolicies > 0 ? 'supported' : 'missing', detail: `${toolsetPolicies} polic${toolsetPolicies === 1 ? 'y' : 'ies'}` },
    { key: 'fleet:mcp', label: 'Fleet MCP servers', state: mcpServers > 0 ? 'supported' : 'missing', detail: `${mcpServers} server${mcpServers === 1 ? '' : 's'}` },
    { key: 'fleet:messaging', label: 'Fleet messaging bindings', state: messagingBindings > 0 ? 'supported' : 'missing', detail: `${messagingBindings} binding${messagingBindings === 1 ? '' : 's'}` },
    { key: 'fleet:cron', label: 'Fleet cron jobs', state: cronJobs > 0 ? 'supported' : 'missing', detail: `${cronJobs} scheduled task${cronJobs === 1 ? '' : 's'}` },
    { key: 'fleet:plugins-hooks', label: 'Fleet plugins and hooks', state: plugins + hooks > 0 ? 'supported' : 'missing', detail: `${plugins} plugin${plugins === 1 ? '' : 's'} · ${hooks} hook${hooks === 1 ? '' : 's'}` },
  );

  return {
    summary: countStates(capabilities),
    capabilities,
    generatedAt: new Date().toISOString(),
  };
}

export interface SkillCatalogEntry {
  name: string;
  version: string;
  description: string;
  author?: string;
  entryPoint?: string;
  dependencies?: string[];
  tags?: string[];
  path?: string;
}

export interface SkillCatalog {
  schema: string;
  generatedAt: string;
  count: number;
  source: 'index' | 'walk';
  skills: SkillCatalogEntry[];
}

function getSkillsRoot(): string {
  return process.env['SKILLS_DIR'] ?? getPackageSkillsDir();
}

export async function getSkillCatalog(): Promise<SkillCatalog> {
  const root = getSkillsRoot();
  const indexFile = join(root, 'index.json');
  try {
    const raw = await readFile(indexFile, 'utf-8');
    const parsed = JSON.parse(raw) as { schema?: string; generatedAt?: string; count?: number; skills?: SkillCatalogEntry[] };
    if (parsed.skills && Array.isArray(parsed.skills)) {
      return {
        schema: parsed.schema ?? 'https://agentskills.io/schema/v1',
        generatedAt: parsed.generatedAt ?? new Date().toISOString(),
        count: parsed.count ?? parsed.skills.length,
        source: 'index',
        skills: parsed.skills,
      };
    }
  } catch {
    // fall through to walk
  }

  // Walk fallback — read every manifest.json under root/<slug>/manifest.json
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: SkillCatalogEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, 'manifest.json');
    try {
      const s = await stat(manifestPath);
      if (!s.isFile()) continue;
      const raw = await readFile(manifestPath, 'utf-8');
      const m = JSON.parse(raw) as SkillCatalogEntry;
      skills.push({ ...m, path: entry.name });
    } catch {
      continue;
    }
  }
  return {
    schema: 'https://agentskills.io/schema/v1',
    generatedAt: new Date().toISOString(),
    count: skills.length,
    source: 'walk',
    skills,
  };
}


export interface SkillAuditResult {
  slug: string;
  version: string | null;
  source: string;
  installedAssignments: number;
  dependencies: string[];
  missingDependencies: string[];
  requiredEnv: string[];
  requiredToolsets: string[];
  warnings: string[];
  updateAvailable: boolean;
  lastUsedAt: string | null;
}

function skillRecord(entry: SkillCatalogEntry): Record<string, unknown> {
  return entry as unknown as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function findCatalogSkill(slug: string): Promise<SkillCatalogEntry | null> {
  const catalog = await getSkillCatalog();
  return catalog.skills.find((skill) => skill.name === slug || skill.path === slug) ?? null;
}

export async function auditSkillCatalogEntry(slug: string): Promise<SkillAuditResult> {
  const db = getDb();
  const catalog = await getSkillCatalog();
  const entry = catalog.skills.find((skill) => skill.name === slug || skill.path === slug);
  if (!entry) throw new HttpError(404, 'NOT_FOUND', `Skill ${slug} was not found in the catalog`);
  const assignments = await db.hermesSkillAssignment.findMany({ where: { skillSlug: entry.name } });
  const known = new Set(catalog.skills.map((skill) => skill.name));
  const dependencies = entry.dependencies ?? [];
  const metadata = skillRecord(entry)['metadata'] as Record<string, unknown> | undefined;
  const requiredEnv = stringArray(skillRecord(entry)['requiredEnv'] ?? metadata?.['requiredEnv'] ?? metadata?.['env']);
  const requiredToolsets = stringArray(skillRecord(entry)['requiredToolsets'] ?? metadata?.['requiredToolsets'] ?? metadata?.['toolsets']);
  const missingDependencies = dependencies.filter((dep) => !known.has(dep));
  const warnings = [
    ...(missingDependencies.length ? [`Missing catalog dependencies: ${missingDependencies.join(', ')}`] : []),
    ...(requiredEnv.length ? [`Requires env: ${requiredEnv.join(', ')}`] : []),
    ...(assignments.some((assignment) => !assignment.enabled) ? ['One or more assignments are disabled or quarantined'] : []),
  ];
  return {
    slug: entry.name,
    version: entry.version ?? null,
    source: catalog.source,
    installedAssignments: assignments.length,
    dependencies,
    missingDependencies,
    requiredEnv,
    requiredToolsets,
    warnings,
    updateAvailable: assignments.some((assignment) => Boolean(assignment.pinnedVersion) && assignment.pinnedVersion !== entry.version),
    lastUsedAt: null,
  };
}

export async function installCatalogSkill(input: {
  slug: string;
  installationId: string;
  profileId?: string | null;
  pinnedVersion?: string | null;
  source?: string;
  actorId: string;
}) {
  const db = getDb();
  const entry = await findCatalogSkill(input.slug);
  if (!entry) throw new HttpError(404, 'NOT_FOUND', `Skill ${input.slug} was not found in the catalog`);
  const installation = await db.hermesInstallation.findUnique({ where: { id: input.installationId } });
  if (!installation) throw new HttpError(404, 'NOT_FOUND', `Hermes installation ${input.installationId} not found`);
  const profileId = input.profileId ?? '';
  const existing = await db.hermesSkillAssignment.findFirst({ where: { installationId: input.installationId, profileId, skillSlug: entry.name } });
  const metadata = JSON.stringify({ installedFrom: 'skill-catalog', catalogVersion: entry.version, installedAt: new Date().toISOString() });
  if (existing) {
    return db.hermesSkillAssignment.update({
      where: { id: existing.id },
      data: { enabled: true, pinnedVersion: input.pinnedVersion ?? entry.version ?? existing.pinnedVersion, source: input.source ?? 'agentskills.io', metadata },
    });
  }
  return db.hermesSkillAssignment.create({
    data: {
      installationId: input.installationId,
      profileId,
      skillSlug: entry.name,
      pinnedVersion: input.pinnedVersion ?? entry.version ?? null,
      source: input.source ?? 'agentskills.io',
      enabled: true,
      metadata,
      createdBy: input.actorId,
    },
  });
}

export async function previewSkillBundle(input: { slugs: string[]; installationId?: string; profileId?: string | null }) {
  const catalog = await getSkillCatalog();
  const byName = new Map(catalog.skills.map((skill) => [skill.name, skill]));
  const selected = input.slugs.map((slug) => byName.get(slug)).filter((skill): skill is SkillCatalogEntry => Boolean(skill));
  const missing = input.slugs.filter((slug) => !byName.has(slug));
  const dependencySet = new Set(selected.flatMap((skill) => skill.dependencies ?? []));
  const missingDependencies = [...dependencySet].filter((dep) => !byName.has(dep));
  return {
    selected,
    missing,
    missingDependencies,
    assignments: selected.map((skill) => ({
      installationId: input.installationId ?? '',
      profileId: input.profileId ?? null,
      skillSlug: skill.name,
      pinnedVersion: skill.version ?? null,
      source: 'agentskills.io',
      enabled: true,
    })),
  };
}

export async function applySkillBundle(input: { slugs: string[]; installationId: string; profileId?: string | null; actorId: string }) {
  const preview = await previewSkillBundle(input);
  if (preview.missing.length > 0) throw new HttpError(400, 'VALIDATION_ERROR', `Missing skills: ${preview.missing.join(', ')}`);
  const rows = [];
  for (const assignment of preview.assignments) {
    rows.push(await installCatalogSkill({
      slug: assignment.skillSlug,
      installationId: input.installationId,
      profileId: input.profileId ?? null,
      pinnedVersion: assignment.pinnedVersion,
      source: assignment.source,
      actorId: input.actorId,
    }));
  }
  return { count: rows.length, assignments: rows };
}

export async function quarantineCatalogSkill(slug: string, actorId: string): Promise<{ updated: number }> {
  const db = getDb();
  const rows = await db.hermesSkillAssignment.findMany({ where: { skillSlug: slug } });
  for (const row of rows) {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata || '{}') as Record<string, unknown>; } catch { metadata = {}; }
    await db.hermesSkillAssignment.update({
      where: { id: row.id },
      data: { enabled: false, metadata: JSON.stringify({ ...metadata, quarantinedAt: new Date().toISOString(), quarantinedBy: actorId }) },
    });
  }
  return { updated: rows.length };
}

export async function cancelHermesJob(id: string, actorId: string): Promise<{ id: string; status: string }> {
  const db = getDb();
  const job = await db.hermesOperationJob.findUnique({ where: { id } });
  if (!job) throw new HttpError(404, 'NOT_FOUND', 'Hermes operation job not found');
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return { id: job.id, status: job.status };
  }
  const updated = await db.hermesOperationJob.update({
    where: { id },
    data: {
      status: 'cancelled',
      completedAt: new Date(),
      error: `Cancelled by ${actorId}`,
    },
  });
  return { id: updated.id, status: updated.status };
}
