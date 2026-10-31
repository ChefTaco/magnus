import { observedDashboardEndpoint } from './hermes-dashboard-endpoint.js';
import type {
  HermesInstallation,
  HermesProfile,
  HermesOperationJob,
  HermesOperationStep,
  HermesNodeState,
  HermesRuntimeConfiguration,
} from '../types/index.js';
import { getDb } from '../db/index.js';
import { type ParsedHermesDetection } from './hermes-cli-parser.js';

// SSH-backed Hermes mutations (deploy, configure, profile, gateway, dashboard,
// API-server, and OpenClaw operations) are retired; their routes return 410.
// This module keeps inventory reads and agent-reported state recording.

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toInstallation(row: any): HermesInstallation {
  const rawStatus = parseJsonObject(row.rawStatus);
  const configuration = rawStatus['configuration'];
  const reportedConfiguration = configuration && typeof configuration === 'object' && !Array.isArray(configuration)
    ? configuration as HermesRuntimeConfiguration : null;
  const reportedToken = reportedConfiguration?.hiveMemToken;
  const tokenExpiry = reportedToken?.expiresAt ? Date.parse(reportedToken.expiresAt) : NaN;
  const currentToken = reportedToken && Number.isFinite(tokenExpiry)
    ? { ...reportedToken, status: tokenExpiry <= Date.now() ? 'expired' as const
      : reportedToken.status === 'valid' && tokenExpiry - Date.now() <= 14 * 24 * 60 * 60 * 1000
        ? 'expiring' as const : reportedToken.status }
    : reportedToken;
  return {
    id: row.id,
    nodeId: row.nodeId ?? null,
    hostname: row.hostname,
    sshPort: row.sshPort,
    displayName: row.displayName ?? null,
    installMode: row.installMode,
    hermesHome: row.hermesHome,
    hermesBin: row.hermesBin,
    version: row.version ?? null,
    status: row.status,
    gatewayStatus: row.gatewayStatus,
    dashboardHost: row.dashboardHost,
    dashboardPort: row.dashboardPort,
    dashboardStatus: row.dashboardStatus,
    apiServerEnabled: row.apiServerEnabled,
    apiServerHost: row.apiServerHost,
    apiServerPort: row.apiServerPort ?? null,
    lastDetectedAt: toIso(row.lastDetectedAt),
    lastSyncedAt: toIso(row.lastSyncedAt),
    metadata: parseJsonObject(row.metadata),
    rawStatus,
    configuration: reportedConfiguration ? { ...reportedConfiguration, hiveMemToken: currentToken } : null,
    createdAt: toIso(row.createdAt) ?? new Date().toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date().toISOString(),
    profiles: row.profiles?.map(toProfile),
  };
}

function toProfile(row: any): HermesProfile {
  return {
    id: row.id,
    installationId: row.installationId,
    name: row.name,
    description: row.description,
    profileHome: row.profileHome,
    isDefault: row.isDefault,
    providerSummary: row.providerSummary ?? null,
    modelSummary: row.modelSummary ?? null,
    distribution: row.distribution ?? null,
    gatewayStatus: row.gatewayStatus,
    apiServerEnabled: row.apiServerEnabled,
    apiServerHost: row.apiServerHost,
    apiServerPort: row.apiServerPort ?? null,
    apiServerKeyFingerprint: row.apiServerKeyFingerprint ?? null,
    capabilities: parseJsonObject(row.capabilities),
    envStatus: parseJsonObject(row.envStatus),
    metadata: parseJsonObject(row.metadata),
    lastSyncedAt: toIso(row.lastSyncedAt),
    createdAt: toIso(row.createdAt) ?? new Date().toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date().toISOString(),
    installation: row.installation
      ? {
          id: row.installation.id,
          hostname: row.installation.hostname,
          displayName: row.installation.displayName ?? null,
          status: row.installation.status,
        }
      : undefined,
  };
}

function toJob(row: any): HermesOperationJob {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    installationId: row.installationId ?? null,
    profileId: row.profileId ?? null,
    targetHost: row.targetHost ?? null,
    createdBy: row.createdBy,
    steps: parseJsonArray<HermesOperationStep>(row.steps),
    result: row.result ? parseJsonObject(row.result) : null,
    error: row.error ?? null,
    metadata: parseJsonObject(row.metadata),
    startedAt: toIso(row.startedAt) ?? new Date().toISOString(),
    completedAt: toIso(row.completedAt),
  };
}

async function resolveTarget(input: {
  nodeId?: string;
  hostname?: string;
  sshPort?: number;
  hermesHome?: string;
  hermesBin?: string;
}): Promise<{ nodeId: string | null; hostname: string; sshPort: number; hermesHome: string; hermesBin: string; displayName: string | null }> {
  const db = getDb();
  if (input.nodeId) {
    const node = await db.node.findUnique({ where: { id: input.nodeId }, select: { id: true, name: true, hostname: true, ipAddress: true } });
    if (!node) throw new Error('Node not found');
    return {
      nodeId: node.id,
      hostname: input.hostname ?? node.hostname ?? node.ipAddress,
      sshPort: input.sshPort ?? 22,
      hermesHome: input.hermesHome ?? '~/.hermes',
      hermesBin: input.hermesBin ?? 'hermes',
      displayName: node.name,
    };
  }

  if (!input.hostname) throw new Error('hostname is required');
  return {
    nodeId: null,
    hostname: input.hostname,
    sshPort: input.sshPort ?? 22,
    hermesHome: input.hermesHome ?? '~/.hermes',
    hermesBin: input.hermesBin ?? 'hermes',
    displayName: input.hostname,
  };
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function booleanField(record: Record<string, unknown>, fallback: boolean, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function profileFromNodeRecord(record: Record<string, unknown>, hermesHome: string): ParsedHermesDetection['profiles'][number] | null {
  const name = stringField(record, 'name', 'profile', 'profile_name') ?? '';
  if (!name) return null;
  return {
    name,
    description: stringField(record, 'description') ?? '',
    profileHome: stringField(record, 'profileHome', 'profile_home')
      ?? hermesHome.replace(/\/+$/, '') + '/profiles/' + name,
    isDefault: booleanField(record, name === 'default', 'isDefault', 'is_default', 'default'),
    gatewayStatus: (stringField(record, 'gatewayStatus', 'gateway_status') ?? 'unknown') as any,
    apiServerEnabled: booleanField(record, false, 'apiServerEnabled', 'api_server_enabled'),
    apiServerHost: stringField(record, 'apiServerHost', 'api_server_host') ?? '127.0.0.1',
    apiServerPort: numberField(record, 'apiServerPort', 'api_server_port'),
    providerSummary: stringField(record, 'providerSummary', 'provider_summary'),
    modelSummary: stringField(record, 'modelSummary', 'model_summary', 'model'),
    distribution: stringField(record, 'distribution'),
    metadata: record['metadata'] && typeof record['metadata'] === 'object' && !Array.isArray(record['metadata'])
      ? record['metadata'] as Record<string, unknown>
      : { source: 'managed-node-state' },
  };
}

function detectionFromNodeState(state: HermesNodeState): ParsedHermesDetection {
  return {
    installed: state.installed,
    status: state.status,
    version: state.version,
    hermesBin: state.hermesBin,
    hermesHome: state.hermesHome,
    gatewayStatus: state.gatewayStatus,
    dashboardStatus: state.dashboardStatus,
    ...observedDashboardEndpoint(state),
    apiServerEnabled: state.apiServerEnabled,
    apiServerHost: state.apiServerHost,
    apiServerPort: state.apiServerPort,
    profiles: state.profiles.map((profile) => profileFromNodeRecord(profile, state.hermesHome)).filter((profile): profile is ParsedHermesDetection['profiles'][number] => Boolean(profile)),
    skills: state.skills ?? [],
    toolsets: state.toolsets ?? [],
    providers: state.providers ?? [],
    plugins: state.plugins ?? [],
    messagingBindings: [],
    raw: { ...state, configuration: state.configuration },
  };
}

async function upsertDetectedResources(params: {
  installationId: string;
  detection: ParsedHermesDetection;
  profileIdsByName: Map<string, string>;
  now: Date;
}): Promise<void> {
  const db = getDb();
  const createdBy = 'system';
  const globalProfileId = '';

  for (const skill of params.detection.skills) {
    await db.hermesSkillAssignment.upsert({
      where: {
        installationId_profileId_skillSlug: {
          installationId: params.installationId,
          profileId: globalProfileId,
          skillSlug: skill.slug,
        },
      },
      create: {
        installationId: params.installationId,
        profileId: globalProfileId,
        skillSlug: skill.slug,
        source: skill.source,
        enabled: skill.enabled,
        status: 'applied',
        metadata: JSON.stringify({ ...skill.metadata, category: skill.category, detectedBy: 'hermes-detection' }),
        lastSyncedAt: params.now,
        createdBy,
      },
      update: {
        // Detection is observed state. Never turn an operator's desired
        // assignment back on or replace its registry source with local state.
        lastSyncedAt: params.now,
      },
    });
  }

  for (const toolset of params.detection.toolsets) {
    await db.hermesToolsetPolicy.upsert({
      where: {
        installationId_profileId_toolset: {
          installationId: params.installationId,
          profileId: globalProfileId,
          toolset: toolset.toolset,
        },
      },
      create: {
        installationId: params.installationId,
        profileId: globalProfileId,
        toolset: toolset.toolset,
        enabled: toolset.enabled,
        approvalMode: 'auto',
        status: 'applied',
        metadata: JSON.stringify({ ...toolset.metadata, detectedBy: 'hermes-detection' }),
        lastSyncedAt: params.now,
        createdBy,
      },
      update: {
        lastSyncedAt: params.now,
      },
    });
  }

  const providersByProfile = new Map<string, ParsedHermesDetection['providers']>();
  for (const provider of params.detection.providers) {
    const profileId = provider.profileName ? params.profileIdsByName.get(provider.profileName) ?? globalProfileId : globalProfileId;
    providersByProfile.set(profileId, [...(providersByProfile.get(profileId) ?? []), provider]);
  }
  for (const [profileId, providers] of providersByProfile) {
    const chain = Array.from(new Set(providers.map((provider) => provider.provider).filter(Boolean)));
    if (chain.length === 0) continue;
    await db.hermesProviderConfig.upsert({
      where: { installationId_profileId: { installationId: params.installationId, profileId } },
      create: {
        installationId: params.installationId,
        profileId,
        chainJson: JSON.stringify(chain),
        sortStrategy: 'priority',
        status: 'applied',
        metadata: JSON.stringify({ providers, detectedBy: 'hermes-detection' }),
        lastSyncedAt: params.now,
        createdBy,
      },
      update: {
        chainJson: JSON.stringify(chain),
        status: 'applied',
        metadata: JSON.stringify({ providers, detectedBy: 'hermes-detection' }),
        lastSyncedAt: params.now,
      },
    });
  }

  for (const binding of params.detection.messagingBindings) {
    await db.hermesMessagingBinding.upsert({
      where: {
        installationId_profileId_platform: {
          installationId: params.installationId,
          profileId: globalProfileId,
          platform: binding.platform,
        },
      },
      create: {
        installationId: params.installationId,
        profileId: globalProfileId,
        platform: binding.platform,
        channelIdsJson: JSON.stringify(binding.channelIds),
        voiceEnabled: binding.voiceEnabled,
        voiceModel: binding.voiceModel,
        ttsProvider: binding.ttsProvider,
        secretRef: binding.secretRef,
        status: binding.status,
        metadata: JSON.stringify({ ...binding.metadata, detectedBy: 'hermes-detection' }),
        lastSyncedAt: params.now,
        createdBy,
      },
      update: {
        channelIdsJson: JSON.stringify(binding.channelIds),
        voiceEnabled: binding.voiceEnabled,
        voiceModel: binding.voiceModel,
        ttsProvider: binding.ttsProvider,
        secretRef: binding.secretRef,
        status: binding.status,
        metadata: JSON.stringify({ ...binding.metadata, detectedBy: 'hermes-detection' }),
        lastSyncedAt: params.now,
      },
    });
  }

  for (const plugin of params.detection.plugins) {
    await db.hermesPluginInstall.upsert({
      where: {
        installationId_profileId_pluginSlug: {
          installationId: params.installationId,
          profileId: globalProfileId,
          pluginSlug: plugin.slug,
        },
      },
      create: {
        installationId: params.installationId,
        profileId: globalProfileId,
        pluginSlug: plugin.slug,
        pluginType: plugin.pluginType,
        pinnedVersion: plugin.version,
        status: plugin.status,
        healthState: plugin.healthState,
        metadata: JSON.stringify({ ...plugin.metadata, detectedBy: 'hermes-detection' }),
        lastSyncedAt: params.now,
        createdBy,
      },
      update: {
        healthState: plugin.healthState,
        lastSyncedAt: params.now,
      },
    });
  }
}

async function upsertInstallationFromDetection(params: {
  target: Awaited<ReturnType<typeof resolveTarget>>;
  detection: ParsedHermesDetection;
  installMode?: string;
}): Promise<HermesInstallation> {
  const db = getDb();
  const now = new Date();
  const detection = params.detection;
  const installation = await db.hermesInstallation.upsert({
    where: {
      hostname_hermesHome: {
        hostname: params.target.hostname,
        hermesHome: detection.hermesHome,
      },
    },
    create: {
      nodeId: params.target.nodeId,
      hostname: params.target.hostname,
      sshPort: params.target.sshPort,
      displayName: params.target.displayName,
      installMode: params.installMode ?? 'existing',
      hermesHome: detection.hermesHome,
      hermesBin: detection.hermesBin,
      version: detection.version,
      status: detection.status,
      gatewayStatus: detection.gatewayStatus,
      dashboardStatus: detection.dashboardStatus,
      ...observedDashboardEndpoint(detection),
      apiServerEnabled: detection.apiServerEnabled,
      apiServerHost: detection.apiServerHost,
      apiServerPort: detection.apiServerPort,
      rawStatus: JSON.stringify(detection.raw),
      metadata: JSON.stringify({ detectedBy: 'magnus-control-api' }),
      lastDetectedAt: now,
      lastSyncedAt: now,
    },
    update: {
      nodeId: params.target.nodeId,
      sshPort: params.target.sshPort,
      displayName: params.target.displayName,
      installMode: params.installMode ?? undefined,
      hermesBin: detection.hermesBin,
      version: detection.version,
      status: detection.status,
      gatewayStatus: detection.gatewayStatus,
      dashboardStatus: detection.dashboardStatus,
      ...observedDashboardEndpoint(detection),
      apiServerEnabled: detection.apiServerEnabled,
      apiServerHost: detection.apiServerHost,
      apiServerPort: detection.apiServerPort,
      rawStatus: JSON.stringify(detection.raw),
      lastDetectedAt: now,
      lastSyncedAt: now,
    },
  });

  const staleNodeRows = detection.status === 'not_installed' ? [] : [
    ...(params.target.nodeId ? [{ nodeId: params.target.nodeId }] : []),
    { hostname: params.target.hostname },
    ...(params.target.displayName ? [{ displayName: params.target.displayName }] : []),
  ];
  if (staleNodeRows.length > 0) {
    await db.hermesInstallation.deleteMany({
      where: {
        id: { not: installation.id },
        OR: staleNodeRows,
      },
    });
  }

  const profileIdsByName = new Map<string, string>();
  for (const profile of detection.profiles) {
    const profileRow = await db.hermesProfile.upsert({
      where: {
        installationId_name: {
          installationId: installation.id,
          name: profile.name,
        },
      },
      create: {
        installationId: installation.id,
        name: profile.name,
        description: profile.description,
        profileHome: profile.profileHome,
        isDefault: profile.isDefault,
        providerSummary: profile.providerSummary,
        modelSummary: profile.modelSummary,
        distribution: profile.distribution,
        gatewayStatus: profile.gatewayStatus,
        apiServerEnabled: profile.apiServerEnabled,
        apiServerHost: profile.apiServerHost,
        apiServerPort: profile.apiServerPort,
        capabilities: JSON.stringify({}),
        envStatus: JSON.stringify({ apiServerEnabled: profile.apiServerEnabled }),
        metadata: JSON.stringify(profile.metadata),
        lastSyncedAt: now,
      },
      update: {
        description: profile.description,
        profileHome: profile.profileHome,
        isDefault: profile.isDefault,
        providerSummary: profile.providerSummary,
        modelSummary: profile.modelSummary,
        distribution: profile.distribution,
        gatewayStatus: profile.gatewayStatus,
        apiServerEnabled: profile.apiServerEnabled,
        apiServerHost: profile.apiServerHost,
        apiServerPort: profile.apiServerPort,
        envStatus: JSON.stringify({ apiServerEnabled: profile.apiServerEnabled }),
        lastSyncedAt: now,
      },
    });
    profileIdsByName.set(profile.name, profileRow.id);
  }

  if (detection.profiles.length > 0) {
    await db.hermesProfile.deleteMany({
      where: {
        installationId: installation.id,
        name: { notIn: detection.profiles.map((profile) => profile.name) },
      },
    });
  }

  await upsertDetectedResources({ installationId: installation.id, detection, profileIdsByName, now });

  const hydrated = await db.hermesInstallation.findUnique({ where: { id: installation.id }, include: { profiles: true } });
  return toInstallation(hydrated ?? installation);
}

function hostInventoryKey(row: { hostname: string; displayName?: string | null }): string {
  return (row.displayName || row.hostname.split('.')[0] || row.hostname).trim().toLowerCase();
}

function collapseDetectedHostAliases<T extends { hostname: string; displayName?: string | null; status: string }>(rows: T[]): T[] {
  const hasInstalledAlias = new Map<string, boolean>();
  for (const row of rows) {
    const key = hostInventoryKey(row);
    hasInstalledAlias.set(key, (hasInstalledAlias.get(key) ?? false) || row.status !== 'not_installed');
  }
  const seenMissing = new Set<string>();
  return rows.filter((row) => {
    const key = hostInventoryKey(row);
    if (row.status !== 'not_installed') return true;
    if (hasInstalledAlias.get(key) || seenMissing.has(key)) return false;
    seenMissing.add(key);
    return true;
  });
}

export async function listHermesInstallations(): Promise<HermesInstallation[]> {
  const rows = await getDb().hermesInstallation.findMany({ orderBy: { updatedAt: 'desc' }, include: { profiles: true } });
  return collapseDetectedHostAliases(rows).map(toInstallation);
}

export async function getHermesInstallation(id: string): Promise<HermesInstallation | null> {
  const row = await getDb().hermesInstallation.findUnique({ where: { id }, include: { profiles: true } });
  return row ? toInstallation(row) : null;
}

export async function recordManagedHermesState(nodeId: string, state: HermesNodeState): Promise<void> {
  const target = await resolveTarget({
    nodeId,
    hermesHome: state.hermesHome,
    hermesBin: state.hermesBin,
  });
  await upsertInstallationFromDetection({
    target,
    detection: detectionFromNodeState(state),
    installMode: state.installMode,
  });
}

export async function listHermesProfiles(installationId?: string): Promise<HermesProfile[]> {
  const rows = await getDb().hermesProfile.findMany({
    where: installationId ? { installationId } : undefined,
    orderBy: { updatedAt: 'desc' },
    include: { installation: true },
  });
  return rows.map(toProfile);
}

export interface HermesApiServerStatus {
  profileId: string;
  installationId: string;
  enabled: boolean;
  host: string;
  port: number | null;
  keyFingerprint: string | null;
  lastSyncedAt: string | null;
}

export async function getHermesApiServerStatus(profileId: string): Promise<HermesApiServerStatus> {
  const profile = await getDb().hermesProfile.findUnique({ where: { id: profileId } });
  if (!profile) throw new Error('Hermes profile not found');
  return {
    profileId: profile.id,
    installationId: profile.installationId,
    enabled: profile.apiServerEnabled,
    host: profile.apiServerHost,
    port: profile.apiServerPort,
    keyFingerprint: profile.apiServerKeyFingerprint,
    lastSyncedAt: profile.lastSyncedAt ? profile.lastSyncedAt.toISOString() : null,
  };
}

export async function listHermesJobs(filters: { status?: string; type?: string; category?: string; installationId?: string; profileId?: string; limit?: number }): Promise<HermesOperationJob[]> {
  const rows = await getDb().hermesOperationJob.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.category ? { type: { startsWith: filters.category } } : {}),
      ...(filters.installationId ? { installationId: filters.installationId } : {}),
      ...(filters.profileId ? { profileId: filters.profileId } : {}),
    },
    orderBy: { startedAt: 'desc' },
    take: filters.limit ?? 20,
  });
  return rows.map(toJob);
}

export async function getHermesJob(id: string): Promise<HermesOperationJob | null> {
  const row = await getDb().hermesOperationJob.findUnique({ where: { id } });
  return row ? toJob(row) : null;
}
