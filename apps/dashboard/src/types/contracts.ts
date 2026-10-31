// Minimal contract types used by magnus-ui
// These are kept in sync with magnus-api/src/types/api.ts

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  pagination?: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

// ─── Node ───

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
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Health ───

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

export interface TailscaleNodeKeyInfo {
  status: string;
  backendState: string;
  dnsName: string | null;
  online: boolean | null;
  keyExpiry: string | null;
  daysRemaining: number | null;
  expiryEnabled: boolean;
  expired: boolean;
  requiresRenewal: boolean;
}

export interface TailscaleExpirySummary {
  total: number;
  reporting: number;
  expiryEnabled: number;
  expiringSoon: number;
  expired: number;
  warningDays: number;
  nodes: Array<{
    id: string;
    name: string;
    hostname: string;
    nodeStatus: string;
    lastHeartbeatAt: string | null;
    observedAt: string | null;
    tailscale: TailscaleNodeKeyInfo | null;
  }>;
}

export interface HealthSnapshot {
  id: string;
  nodeId: string;
  timestamp: string;
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

export interface GpuDeviceMetric {
  index: number;
  vendor: 'nvidia' | 'amd';
  name: string;
  uuid: string | null;
  utilizationPercent: number | null;
  fanPercent: number | null;
  temperatureCelsius: number | null;
}

export interface GpuSnapshotPoint {
  sampledAt: string;
  sampleIntervalSeconds: number;
  status: 'ok' | 'unavailable' | 'error';
  devices: GpuDeviceMetric[];
  maxUtilizationPercent: number | null;
  maxFanPercent: number | null;
}

export interface GpuTelemetryResponse {
  period: '6h' | '24h' | '7d';
  latest: GpuSnapshotPoint | null;
  history: GpuSnapshotPoint[];
}

// ─── Commands ───

export type CommandStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

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
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result?: CommandResult | null;
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

export interface CommandDispatchResponse {
  commands: Array<{
    id: string;
    nodeId: string;
    status: CommandStatus;
  }>;
}

// ─── Cron ───

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
  lastRunAt: string | null;
  lastRunExitCode: number | null;
  nextRunAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Files ───

export interface FilePatchTask {
  id: string;
  nodeId: string;
  filePath: string;
  direction: 'push' | 'pull';
  content: string | null;
  checksum: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  error: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

export interface FileReadResponse {
  filePath: string;
  content: string;
  sizeBytes: number;
  checksum: string;
  exists: boolean;
}

// ─── Skills ───

export type SkillStatus = 'available' | 'installing' | 'installed' | 'failed' | 'removed';

export interface SkillBundle {
  name: string;
  version: string;
  description: string;
  author: string;
  entryPoint: string;
  dependencies: string[];
  tags: string[];
  files: string[];
  installations?: Array<{ nodeId: string; status: string; version: string }>;
}

export interface SkillRegistryEntry {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  author: string;
  source: 'local' | 'imported' | 'clawhub';
  sourceUrl: string | null;
  latestVersion: string | null;
  status: 'active' | 'deprecated' | 'hidden';
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
  sizeBytes: number;
  fileCount: number;
  publishedBy: string;
  createdAt: string;
}

export interface SkillTagEntry {
  tag: string;
  version: string;
  versionId: string;
}

export interface SkillInstallation {
  id: string;
  skillName: string;
  nodeId: string;
  version: string;
  status: SkillStatus;
  installedAt: string | null;
  error: string | null;
}

export interface SkillFileContent {
  fileName: string;
  content: string;
}

// ─── Audit ───

export interface AuditEvent {
  id: string;
  action: string;
  actorId: string;
  actorType: 'user' | 'agent' | 'system';
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  ipAddress: string | null;
  timestamp: string;
}

// ─── Stats ───

export interface StatsOverview {
  totalNodes: number;
  onlineNodes: number;
  offlineNodes: number;
  degradedNodes: number;
  pendingCommands: number;
  activeCronJobs: number;
  totalSkills: number;
  unreadNotifications: number;
}

// ─── Roles ───

export type RoleStatus = 'active' | 'draft';
export type FirewallMode = 'restrictive' | 'permissive' | 'custom';
export type RoleApplicationStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface Role {
  id: string;
  name: string;
  description: string;
  libraryFileIds: string[];
  skillNames: string[];
  aptPackages: string[];
  npmPackages: string[];
  envConfig: Record<string, string>;
  dockerEnabled: boolean;
  dockerNonRoot: boolean;
  dockerImage: string | null;
  dockerVolumes: string[];
  firewallEnabled: boolean;
  firewallMode: FirewallMode;
  firewallAllowRules: string[];
  status: RoleStatus;
  createdAt: string;
  updatedAt: string;
  nodes?: Array<{ id: string; name: string; hostname: string; status: string }>;
  _count?: { nodes: number };
}

export interface RoleApplicationStep {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RoleApplication {
  id: string;
  nodeId: string;
  roleId: string;
  action: 'apply' | 'remove';
  status: RoleApplicationStatus;
  steps: RoleApplicationStep[];
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// ─── Library ───

export interface LibraryCategory {
  id: string;
  name: string;
  description: string;
  color: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  fileCount?: number;
}

export interface LibraryFile {
  id: string;
  name: string;
  fileName: string;
  mimeType: string;
  content?: string;
  sizeBytes: number;
  categoryId: string | null;
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  category?: Pick<LibraryCategory, 'id' | 'name' | 'color'> | null;
}

// ─── Notifications ───

export type NotificationType =
  | 'node.offline'
  | 'node.degraded'
  | 'node.recovered'
  | 'command.failed'
  | 'deploy.failed'
  | 'upgrade.failed';

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface Notification {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  nodeId: string | null;
  nodeName: string | null;
  sourceRef: string | null;
  metadata: Record<string, unknown>;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

// ─── Anomaly Detection ───

export type AnomalySeverity = 'info' | 'warning' | 'critical';

export interface AnomalyEvent {
  id: string;
  nodeId: string;
  metric: string;
  value: number;
  zScore: number;
  mean: number;
  stdDev: number;
  severity: AnomalySeverity;
  resolved: boolean;
  resolvedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  createdAt: string;
  node?: { name: string; hostname: string };
}

export interface AnomalySummary {
  totalActive: number;
  byNode: Array<{ nodeId: string; nodeName: string; count: number; metrics: string[] }>;
  bySeverity: Record<string, number>;
}

export interface AnomalyCorrelationDetails {
  anomaly: {
    id: string;
    nodeId: string;
    metric: string;
    value: number;
    severity: string;
    zScore: number;
    createdAt: string;
    resolved: boolean;
  };
  group: {
    id: string;
    pattern: string;
    timeWindow: { start: string; end: string };
    affectedNodes: string[];
    metrics: string[];
    anomalies: Array<{ id: string; nodeId: string; metric: string; value: number; severity: string; zScore: number; createdAt: string }>;
    relatedCommands: Array<{ id: string; nodeId: string; command: string; status: string; createdAt: string }>;
  };
  analysis: {
    blastRadius: 'single-node' | 'multi-node';
    suspectedTriggers: string[];
    recommendedActions: string[];
    summary: string;
  };
}

// ─── Auto-Remediation ───

export interface RemediationRule {
  id: string;
  name: string;
  description: string;
  metric: string;
  severityThreshold: string;
  agentDefinitionId: string;
  input: string;
  cooldownMinutes: number;
  maxConcurrentRuns: number;
  nodeFilter: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  _count?: { executions: number };
}

export interface RemediationExecution {
  id: string;
  ruleId: string;
  anomalyEventId: string;
  nodeId: string;
  orchestraRunId: string | null;
  status: 'pending_approval' | 'approving' | 'triggered' | 'running' | 'completed' | 'failed' | 'skipped';
  input: string;
  output: string | null;
  triggeredAt: string;
  completedAt: string | null;
  rule?: { name: string; metric: string; agentDefinitionId: string };
}

// ─── AI Fleet Assistant ───

export interface AiConversation {
  id: string;
  title: string;
  type: 'chat' | 'heartbeat' | 'analysis' | 'a2a';
  nodeId: string | null;
  status: 'active' | 'archived';
  summary: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  parentId?: string | null;
  forkedFromMessageId?: string | null;
  messageCount?: number;
  childCount?: number;
  lastMessage?: { content: string; role: string; createdAt: string } | null;
  agentDefinitionId?: string;
  agentDefinition?: { id: string; name: string };
  _count?: { messages: number };
}

export interface AiMessage {
  id: string;
  conversationId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls: AiToolResult[];
  thinking?: string;
  structuredAnalysis?: unknown;
  tokenCount: number;
  pendingApproval: Record<string, unknown> | null;
  isRead: boolean;
  readAt: string | null;
  modelUsed?: string;
  createdAt: string;
}

export interface AiToolResult {
  name: string;
  success: boolean;
  result: unknown;
  error?: string;
}

export interface AiChatResponse {
  conversationId: string;
  messageId: string;
  content: string;
  toolCalls: AiToolResult[];
  tokenCount: number;
  thinking?: string;
  structuredAnalysis?: unknown;
}

export type AiProviderId = 'ollama' | 'llamacpp' | 'openai' | 'anthropic' | 'openrouter';

export interface AiHeartbeatPrompt {
  content: string;
  isCustom: boolean;
}

export interface OllamaModel {
  name: string;
  size: number;
  parameterSize: string;
  family: string;
  quantizationLevel: string;
}

export interface AiSettings {
  model: string;
  defaultModel: string;
  maxContextTokens: number;
  systemPrompt: string | null;
  isCustomSystemPrompt: boolean;
  defaultSystemPrompt?: string;
  thinkingMode: 'off' | 'standard' | 'deep';
  showReasoning: boolean;
  maxToolRounds: number;
  replEnabled: boolean;
  structuredOutputsEnabled: boolean;
}

// ─── AI Streaming ───

export type AiStreamEventType =
  | 'thinking'
  | 'thinking-token'
  | 'content-delta'
  | 'tool-start'
  | 'tool-result'
  | 'scratchpad-update'
  | 'done'
  | 'error';

export interface AiStreamEvent {
  type: AiStreamEventType;
  conversationId?: string;
  messageId?: string;
  content?: string;
  toolName?: string;
  toolResult?: AiToolResult;
  tokenCount?: number;
  error?: string;
}

// ─── AI Model Profiles ───

export interface ModelProfile {
  taskType: string;
  provider?: AiProviderId;
  model: string;
  fallbacks?: Array<{
    provider: AiProviderId;
    model: string;
  }>;
  temperature?: number;
  maxTokens?: number;
  maxToolRounds?: number;
  thinkingMode?: 'off' | 'standard' | 'deep';
  routePurpose?: string;
  routeReason?: string;
  routeSource?: 'built-in' | 'saved' | 'custom';
}

export type ModelProfiles = ModelProfile[];

// ─── AI Insights ───

export interface AiInsight {
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical' | 'success';
  category: string;
  nodeId?: string;
}

export interface HeartbeatStructuredAnalysis {
  generatedAt?: string;
  status: 'healthy' | 'degraded' | 'critical';
  severity?: 'info' | 'warning' | 'critical' | 'success';
  summary: string;
  anomalies: Array<{
    nodeId: string;
    nodeName?: string;
    metric: string;
    severity: 'critical' | 'warning' | 'info';
    description: string;
  }>;
  trends: Array<{
    metric: string;
    direction: 'up' | 'down' | 'stable';
    description: string;
  }>;
  recommendations: Array<{
    priority: 'high' | 'medium' | 'low';
    action: string;
    nodeId?: string;
  }>;
  insights: AiInsight[];
  anomalyCounts?: {
    total: number;
    critical: number;
    warning: number;
  };
  hotspotNodes?: Array<{
    nodeId: string;
    nodeName: string;
    count: number;
    metrics: string[];
  }>;
}

export interface InsightsResponse {
  insights: AiInsight[];
  generatedAt: string;
  conversationId?: string;
}

export interface PinnedAiInsight extends AiInsight {
  id: string;
  pinnedAt: string;
  generatedAt?: string;
}

export interface AiScratchpadEntry {
  name: string;
  source: string;
  summary: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SharedAiConversation {
  token: string;
  expiresAt: string;
  conversation: AiConversation;
  messages: AiMessage[];
}

export type ExportFormat = 'markdown' | 'json' | 'csv';
