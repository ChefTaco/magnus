// ─── Local Magnus contracts formerly provided by the retired shared package ───

export type NodeStatus = 'online' | 'offline' | 'degraded' | 'provisioning' | 'decommissioned';

export interface Node {
  id: string;
  name: string;
  hostname: string;
  ipAddress: string;
  port: number;
  status: NodeStatus;
  os: string;
  arch: string;
  tags: string[];
  metadata: Record<string, unknown>;
  roleId?: string | null;
  role?: { id: string; name: string } | null;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NodeRegistrationRequest {
  name: string;
  hostname: string;
  ipAddress: string;
  port: number;
  os: string;
  arch: string;
  fqdn?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  agentVersion: string;
}

export interface NodeRegistrationResponse {
  nodeId: string;
  token: string;
  controlApiUrl: string;
}

export interface NodeUpdateRequest {
  name?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  status?: NodeStatus;
  roleId?: string | null;
}

export interface NodeAddressRepairRequest {
  ipAddress?: string;
  hostname?: string;
  resolveDns?: boolean;
}

export interface NodeAddressRepairResponse {
  changed: boolean;
  source: 'manual' | 'dns' | 'existing';
  previousIpAddress: string;
  node: Node;
}

export type AgentStatus = 'running' | 'stopped' | 'updating' | 'error';

export interface Agent {
  id: string;
  nodeId: string;
  version: string;
  status: AgentStatus;
  pid: number | null;
  startedAt: Date;
  lastCheckIn: Date;
  capabilities: string[];
}

export interface AgentVersionInfo {
  version: string;
  checksum: string;
  downloadUrl: string;
  releaseNotes: string;
  releasedAt: Date;
}

export interface AgentUpdateRequest {
  targetVersion: string;
  force?: boolean;
}

export interface AgentUpdateResponse {
  accepted: boolean;
  currentVersion: string;
  targetVersion: string;
  estimatedDowntimeSeconds: number;
}

export interface CpuInfo {
  usagePercent: number;
  cores: number;
  model: string;
  loadAverage: [number, number, number];
}

export interface MemoryInfo {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export interface DiskInfo {
  mountPoint: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
  filesystem: string;
  filesystemType?: string;
}

export interface NetworkInfo {
  interface: string;
  rxBytes: number;
  txBytes: number;
  rxErrors: number;
  txErrors: number;
  ipAddress: string;
}

export interface ServiceInfo {
  name: string;
  status: 'active' | 'inactive' | 'failed' | 'unknown';
  pid: number | null;
  memoryBytes: number | null;
  cpuPercent: number | null;
  details?: string;
  targetUser?: string | null;
  remediationAttempted?: boolean;
  remediationSucceeded?: boolean;
  requiresRecheck?: boolean;
}

export type WazuhAgentServiceStatus =
  | 'active'
  | 'inactive'
  | 'failed'
  | 'not_installed'
  | 'unknown';

export interface WazuhAgentInfo {
  installed: boolean;
  serviceStatus: WazuhAgentServiceStatus;
  enabled: 'enabled' | 'disabled' | 'static' | 'unknown';
  version: string | null;
  managerAddresses: string[];
}

export interface SystemUpdateInfo {
  supported: boolean;
  platform: string;
  automaticUpdates: 'enabled' | 'disabled' | 'partial' | 'unsupported' | 'unknown';
  unattendedUpgradesInstalled: boolean;
  periodicUpdateListsEnabled: boolean;
  periodicUnattendedUpgradeEnabled: boolean;
  fullUpgradePolicyEnabled: boolean;
  timers: Array<{ name: string; enabled: boolean; active: boolean; state: string }>;
  rebootRequired: boolean;
  rebootRequiredPackages: string[];
}

export interface HealthSnapshot {
  id: string;
  nodeId: string;
  timestamp: Date;
  cpu: CpuInfo;
  memory: MemoryInfo;
  disks: DiskInfo[];
  network: NetworkInfo[];
  services: ServiceInfo[];
  wazuh: WazuhAgentInfo;
  systemUpdates: SystemUpdateInfo;
  cockpitAvailable: boolean;
  source: 'cockpit' | 'system-probe';
}

export interface Heartbeat {
  nodeId: string;
  agentVersion: string;
  timestamp: Date;
  uptimeSeconds: number;
  status: 'healthy' | 'degraded' | 'critical';
  fqdn?: string;
}

export type HealthProvider = 'cockpit' | 'system-probe';

export interface HealthCheck {
  name: string;
  status: 'pass' | 'fail';
  latencyMs?: number;
  message?: string;
}

export interface DiskForecast {
  mountPoint: string;
  currentUsagePercent: number;
  growthRatePerDay: number;
  estimatedFullDate: string | null;
  daysUntilFull: number | null;
  confidence: number;
  workloadClass: 'models' | 'downloads-cache' | 'general';
  recommendation: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogSource = 'agent' | 'system' | 'journald' | 'application' | 'cron' | 'command' | 'control-api' | 'dashboard';

export interface LogChunk {
  id: string;
  nodeId: string;
  source: LogSource;
  level: LogLevel;
  message: string;
  timestamp: Date;
  metadata: Record<string, unknown>;
}

export interface LogQuery {
  nodeId?: string;
  source?: LogSource;
  level?: LogLevel;
  search?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface LogQueryResult {
  logs: LogChunk[];
  total: number;
  hasMore: boolean;
}

export interface LogStreamOptions {
  nodeIds?: string[];
  sources?: LogSource[];
  levels?: LogLevel[];
  follow: boolean;
}

export type CommandStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';
export type CommandRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RemoteCommand {
  id: string;
  nodeId: string;
  command: string;
  args: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  timeoutSeconds: number;
  status: CommandStatus;
  riskLevel: CommandRiskLevel;
  idempotencyKey: string;
  createdBy: string;
  approvedBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface CommandResult {
  id: string;
  commandId: string;
  nodeId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export interface CommandDispatchRequest {
  nodeIds: string[];
  command: string;
  args?: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  timeoutSeconds?: number;
  idempotencyKey: string;
}

export interface CommandDispatchResponse {
  commands: Array<{ id: string; nodeId: string; status: CommandStatus }>;
}

export interface CommandCancelRequest {
  commandId: string;
  reason: string;
}

export type CronJobStatus = 'active' | 'paused' | 'error' | 'deleted';

export interface CronJobSpec {
  id: string;
  nodeId: string;
  name: string;
  description: string;
  schedule: string;
  command: string;
  args: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  timeoutSeconds: number;
  status: CronJobStatus;
  lastRunAt: Date | null;
  lastRunExitCode: number | null;
  nextRunAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CronJobCreateRequest {
  nodeId: string;
  name: string;
  description?: string;
  schedule: string;
  command: string;
  args?: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface CronJobUpdateRequest {
  name?: string;
  description?: string;
  schedule?: string;
  command?: string;
  args?: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  timeoutSeconds?: number;
  status?: CronJobStatus;
}

export interface CronJobExecution {
  id: string;
  cronJobId: string;
  nodeId: string;
  startedAt: Date;
  completedAt: Date | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number | null;
}

export type SkillStatus = 'available' | 'installing' | 'installed' | 'failed' | 'removed';
export type SkillSource = 'local' | 'imported' | 'clawhub';
export type SkillRegistryStatus = 'active' | 'deprecated' | 'hidden';

export interface SkillBundle {
  name: string;
  version: string;
  description: string;
  author: string;
  entryPoint: string;
  dependencies: string[];
  tags: string[];
  files: string[];
}

export interface SkillBundleWithInstallations extends SkillBundle {
  installations: Array<{ nodeId: string; status: string; version: string }>;
}

export interface SkillRegistryEntry {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  author: string;
  source: SkillSource;
  sourceUrl: string | null;
  entryPoint: string;
  dependencies: string[];
  metadata: Record<string, unknown>;
  latestVersion: string | null;
  status: SkillRegistryStatus;
  createdAt: string;
  updatedAt: string;
  versions?: SkillVersionSummary[];
  tags?: SkillTagEntry[];
  installations?: Array<{ nodeId: string; status: string; version: string }>;
}

export interface SkillVersionSummary {
  id: string;
  version: string;
  changelog: string;
  contentHash: string;
  entryPoint: string;
  sizeBytes: number;
  fileCount: number;
  publishedBy: string;
  createdAt: string;
}

export interface SkillVersionDetail extends SkillVersionSummary {
  files: SkillVersionFile[];
}

export interface SkillVersionFile {
  path: string;
  size: number;
  sha256: string;
}

export interface SkillTagEntry {
  id: string;
  tag: string;
  versionId: string;
  version?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillPublishRequest {
  slug: string;
  version: string;
  changelog?: string;
  tags?: string[];
}

export interface SkillTagSetRequest {
  tag: string;
  versionId: string;
}

export interface SkillPublishResponse {
  entry: SkillRegistryEntry;
  version: SkillVersionSummary;
}

export interface SkillInstallation {
  id: string;
  skillName: string;
  nodeId: string;
  version: string;
  status: SkillStatus;
  registryEntryId: string | null;
  versionHash: string | null;
  bundleSha256: string | null;
  treeSha256: string | null;
  workflowCommandId: string | null;
  workflowRequestSha256: string | null;
  workflowReceiptSha256: string | null;
  installedAt: Date | null;
  error: string | null;
}

export interface SkillPushRequest {
  nodeIds: string[];
  skillName: string;
  version?: string;
  force?: boolean;
}

export interface SkillPullRequest {
  nodeId: string;
  skillName: string;
}

export interface SkillPushResponse {
  installations: Array<{ nodeId: string; status: SkillStatus; installationId: string }>;
}

export interface SkillCreateRequest {
  name: string;
  version: string;
  description?: string;
  entryPoint?: string;
  dependencies?: string[];
  tags?: string[];
}

export interface SkillUpdateRequest {
  version?: string;
  description?: string;
  entryPoint?: string;
  dependencies?: string[];
  tags?: string[];
}

export interface SkillFileContent {
  fileName: string;
  content: string;
}

export type FileSyncStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
export type FileSyncDirection = 'push' | 'pull';

export interface FilePatchTask {
  id: string;
  nodeId: string;
  filePath: string;
  direction: FileSyncDirection;
  content: string | null;
  checksum: string | null;
  previousChecksum: string | null;
  status: FileSyncStatus;
  error: string | null;
  createdBy: string;
  createdAt: Date;
  completedAt: Date | null;
}

export interface FileUpdateRequest {
  nodeIds: string[];
  filePath: string;
  content: string;
  createIfMissing?: boolean;
}

export interface FileReadRequest {
  nodeId: string;
  filePath: string;
}

export interface FileReadResponse {
  nodeId: string;
  filePath: string;
  content: string;
  checksum: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export interface FileListRequest {
  nodeId: string;
  directory: string;
  recursive?: boolean;
  pattern?: string;
}

export interface FileListItem {
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: Date;
}

export interface FileListResponse {
  nodeId: string;
  directory: string;
  files: FileListItem[];
}

export type RolloutStatus = 'created' | 'in_progress' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type RolloutStrategy = 'all_at_once' | 'canary' | 'rolling' | 'targeted';

export interface ExecutionRun {
  id: string;
  type: 'command' | 'file_update' | 'skill_push' | 'agent_update' | 'cron_sync';
  rolloutStrategy: RolloutStrategy;
  status: RolloutStatus;
  totalNodes: number;
  completedNodes: number;
  failedNodes: number;
  targetNodeIds: string[];
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface RolloutCreateRequest {
  type: ExecutionRun['type'];
  strategy: RolloutStrategy;
  targetNodeIds: string[];
  payload: Record<string, unknown>;
  canaryPercent?: number;
  maxFailurePercent?: number;
  concurrency?: number;
}

export interface RolloutProgress {
  rolloutId: string;
  status: RolloutStatus;
  completedNodes: string[];
  failedNodes: Array<{ nodeId: string; error: string }>;
  pendingNodes: string[];
  progressPercent: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  meta?: { total?: number; page?: number; pageSize?: number; hasMore?: boolean };
}

export interface ApiError {
  success: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface PaginationParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface IdempotencyHeader {
  'x-idempotency-key': string;
}

export interface NodeAuthHeader {
  'x-node-token': string;
}

export type ObservationSource = 'health-collector' | 'log-collector' | 'drift-collector' | 'memory-search' | 'approval-event' | 'orchestra-event' | 'agent-heartbeat' | 'telemetry' | 'user-report' | 'external';
export type ObservationModality = 'metric' | 'log' | 'drift' | 'event' | 'memory' | 'alert' | 'narrative';
export type ObservationScope = 'node' | 'cluster' | 'service' | 'agent' | 'fleet' | 'system';

export interface ObservationProvenance {
  collector: string;
  stage: 'raw' | 'normalized' | 'correlated' | 'summarized';
  transformations?: string[];
}

export interface Observation {
  id: string;
  source: ObservationSource;
  modality: ObservationModality;
  scope: ObservationScope;
  timestamp: string;
  provenance: ObservationProvenance;
  confidence: number;
  relatedEntityId: string | null;
  relatedEntityName?: string;
  summary: string;
  payload: Record<string, unknown>;
  severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
  correlationId?: string;
}

export type HermesInstallationStatus = 'unknown' | 'not_installed' | 'detected' | 'needs_setup' | 'running' | 'degraded' | 'error';
export type HermesServiceStatus = 'unknown' | 'not_installed' | 'inactive' | 'running' | 'stopped' | 'failed' | 'error';
export type HermesInstallMode = 'unknown' | 'official-script' | 'pip' | 'git' | 'existing';
export type HermesOperationType = 'detect' | 'deploy' | 'configure' | 'config.update' | 'sync' | 'update' | 'uninstall' | 'profile.create' | 'profile.update' | 'profile.delete' | 'profile.describe' | 'gateway.action' | 'dashboard.action' | 'api_server.enable' | 'api_server.disable' | 'openclaw.dry_run' | 'openclaw.apply';
export type HermesOperationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface HermesRuntimeConfiguration {
  configPresent: boolean;
  configPath?: string | null;
  envPath?: string | null;
  envKeys?: string[];
  modelProvider: string | null;
  modelName: string | null;
  modelBaseUrl: string | null;
  openaiRuntime: 'auto' | 'codex_app_server' | null;
  magnusRouterConfigured: boolean;
  memoryProvider: string | null;
  hiveMemConfigured: boolean;
  hiveMemPluginInstalled: boolean;
  hiveMemApiUrl: string | null;
  hiveMemToken?: { status: 'missing' | 'valid' | 'expiring' | 'expired' | 'rejected' | 'unreachable' | 'unknown'; expiresAt: string | null; checkedAt: string } | null;
  magnusSkills: { status: 'available' | 'not_configured'; message: string };
}

export interface HermesNodeState {
  installed: boolean;
  status: HermesInstallationStatus;
  installMode: 'official-script' | 'existing';
  version: string | null;
  hermesBin: string;
  hermesHome: string;
  gatewayStatus: HermesServiceStatus;
  dashboardStatus: HermesServiceStatus;
  dashboardHost?: string;
  dashboardPort?: number;
  apiServerEnabled: boolean;
  apiServerHost: string;
  apiServerPort: number | null;
  profiles: Array<Record<string, unknown>>;
  skills?: Array<{
    slug: string;
    category: string | null;
    source: string;
    enabled: boolean;
    metadata: Record<string, unknown>;
  }>;
  toolsets?: Array<{
    toolset: string;
    enabled: boolean;
    metadata: Record<string, unknown>;
  }>;
  providers?: Array<{
    profileName: string | null;
    provider: string;
    model: string | null;
    configured: boolean;
    metadata: Record<string, unknown>;
  }>;
  plugins?: Array<{
    slug: string;
    pluginType: string;
    version: string | null;
    status: string;
    healthState: string;
    metadata: Record<string, unknown>;
  }>;
  configuration: HermesRuntimeConfiguration;
  rawChecks: Record<string, unknown>;
}

export interface HermesManagedConfiguration {
  openaiRuntime?: 'auto' | 'codex_app_server';
  router?: { baseUrl: string; model: string; apiKey?: string };
  hiveMem?: {
    apiUrl: string;
    token?: string;
    workspaceId?: string;
    defaultScope?: 'private' | 'shared';
    recallMode?: 'hybrid' | 'context' | 'tools' | 'off';
    pluginFiles?: Array<{ path: string; content: string }>;
  };
}

export type CodexAuthStatus =
  | 'authenticated'
  | 'not_authenticated'
  | 'wrong_auth_mode'
  | 'expired_logged_out'
  | 'error';

export interface CodexNodeState {
  installed: boolean;
  user: string;
  userHome: string;
  codexHome: string;
  codexBin: string | null;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  provenance: 'standalone' | 'npm' | 'nvm' | 'fnm' | 'asdf' | 'mise' | 'volta' | 'pnpm' | 'bun' | 'nix' | 'snap' | 'unknown';
  updateSupported: boolean;
  auth: {
    status: CodexAuthStatus;
    mode: 'chatgpt' | 'apiKey' | 'other' | null;
    oauth: boolean;
    tokenExpiresAt: string | null;
    tokenExpired: boolean | null;
    refreshTokenPresent: boolean;
    lastRefreshAt: string | null;
    planType: string | null;
    autoLoggedOut: boolean;
    message: string;
  };
  checkedAt: string;
  error: string | null;
}

export interface CodexDeviceAuthSession {
  id: string;
  status: 'pending' | 'completed' | 'failed' | 'expired' | 'cancelled';
  verificationUrl: string;
  userCode: string;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface HermesInstallation {
  id: string;
  nodeId: string | null;
  hostname: string;
  sshPort: number;
  displayName: string | null;
  installMode: HermesInstallMode;
  hermesHome: string;
  hermesBin: string;
  version: string | null;
  status: HermesInstallationStatus;
  gatewayStatus: HermesServiceStatus;
  dashboardHost: string;
  dashboardPort: number;
  dashboardStatus: HermesServiceStatus;
  apiServerEnabled: boolean;
  apiServerHost: string;
  apiServerPort: number | null;
  lastDetectedAt: string | null;
  lastSyncedAt: string | null;
  metadata: Record<string, unknown>;
  rawStatus: Record<string, unknown>;
  configuration: HermesRuntimeConfiguration | null;
  createdAt: string;
  updatedAt: string;
  profiles?: HermesProfile[];
}

export interface HermesProfile {
  id: string;
  installationId: string;
  name: string;
  description: string;
  profileHome: string;
  isDefault: boolean;
  providerSummary: string | null;
  modelSummary: string | null;
  distribution: string | null;
  gatewayStatus: HermesServiceStatus;
  apiServerEnabled: boolean;
  apiServerHost: string;
  apiServerPort: number | null;
  apiServerKeyFingerprint: string | null;
  capabilities: Record<string, unknown>;
  envStatus: Record<string, unknown>;
  metadata: Record<string, unknown>;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  installation?: Pick<HermesInstallation, 'id' | 'hostname' | 'displayName' | 'status'>;
}

export interface HermesOperationStep {
  step: string;
  status: 'queued' | 'running' | 'done' | 'error';
  message: string;
  timestamp: string;
}

export interface HermesOperationJob {
  id: string;
  type: HermesOperationType;
  status: HermesOperationStatus;
  installationId: string | null;
  profileId: string | null;
  targetHost: string | null;
  createdBy: string;
  steps: HermesOperationStep[];
  result: Record<string, unknown> | null;
  error: string | null;
  metadata: Record<string, unknown>;
  startedAt: string;
  completedAt: string | null;
}
