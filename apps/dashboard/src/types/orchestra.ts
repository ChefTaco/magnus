/**
 * Orchestra types — aligned with Orchestra API response shapes.
 */

export interface OrchestraAgent {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'deprecated';
  defaultTrait: string;
  toolPolicyJson: string | null;
  targetNodeId: string | null;
  targetNodeName: string | null;
  heartbeatEnabled: boolean;
  heartbeatPrompt: string | null;
  latestVersionId: string | null;
  promotedVersionId: string | null;
  roleId: string | null;
  role?: OrchestraRoleDefinition | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  versions?: OrchestraAgentVersion[];
}

export interface OrchestraAgentVersion {
  id: string;
  agentDefinitionId: string;
  version: string;
  systemInstructions: string;
  toolPolicyJson: string;
  modelPolicyJson: string;
  memoryPolicyJson: string;
  approvalPolicyJson: string | null;
  publishedBy: string | null;
  publishedAt: string;
}

export interface OrchestraRun {
  id: string;
  agentDefinitionId: string;
  agentVersionId: string;
  status: string;
  priority: number;
  inputJson: string | null;
  outputJson: string | null;
  targetScopeJson: string | null;
  budgetJson: string | null;
  memoryContextJson: string | null;
  memoriesStoredCount: number;
  triggeredBy: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agentDefinition?: OrchestraAgent;
  agentVersion?: OrchestraAgentVersion;
  steps?: OrchestraStepRun[];
  modelInvocations?: OrchestraModelInvocation[];
  toolInvocations?: OrchestraToolInvocation[];
}

export interface OrchestraStepRun {
  id: string;
  runId: string;
  stepType: string;
  status: string;
  dependsOnJson: string;
  conditionJson: string | null;
  parentStepId: string | null;
  stepIndex: number;
  inputJson: string | null;
  outputJson: string | null;
  startedAt: string | null;
  completedAt: string | null;
  approvalRequests?: OrchestraApprovalRequest[];
}

export interface OrchestraModelInvocation {
  id: string;
  runId: string;
  stepRunId: string;
  provider: string;
  model: string;
  routingReason: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  memoryContextCount: number;
  createdAt: string;
}

export interface OrchestraToolInvocation {
  id: string;
  runId: string;
  stepRunId: string;
  toolName: string;
  argumentsJson: string;
  resultJson: string | null;
  exitStatus: string;
  policyDecision: string;
  durationMs: number;
  createdAt: string;
}

export interface OrchestraEvent {
  id: string;
  eventType: string;
  runId: string | null;
  stepRunId: string | null;
  payloadJson: string | null;
  createdAt: string;
}

export interface OrchestraHealthStatus {
  status: 'ok' | 'degraded';
  version: string;
  checks: { name: string; status: 'ok' | 'error'; message: string }[];
}

export interface OrchestraInferencePolicy {
  id: string;
  name: string;
  isDefault: boolean;
  tiersJson: string;
  budgetDefaultsJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestraToolPolicy {
  id: string;
  name: string;
  isDefault: boolean;
  rulesJson: string;
  rules?: ToolPolicyRule[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolPolicyRule {
  tool: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

export interface OrchestraSkillRegistryEntry {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  author: string;
  source: string;
  sourceUrl: string | null;
  entryPoint: string;
  dependencies: string[];
  metadata: Record<string, unknown>;
  latestVersion: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  versions?: OrchestraSkillVersion[];
  tags?: OrchestraSkillTag[];
  _count?: { versions: number; tags: number };
}

export interface OrchestraSkillVersion {
  id: string;
  skillId: string;
  version: string;
  changelog: string;
  contentHash: string;
  files: { path: string; content: string }[];
  entryPoint: string;
  sizeBytes: number;
  publishedBy: string;
  createdAt: string;
}

export interface OrchestraSkillTag {
  id: string;
  skillId: string;
  tag: string;
  versionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestraRoleDefinition {
  id: string;
  name: string;
  description: string;
  skillNames: string[];
  aptPackages: string[];
  npmPackages: string[];
  envConfig: Record<string, string>;
  dockerEnabled: boolean;
  dockerNonRoot: boolean;
  dockerImage: string | null;
  dockerVolumes: string[];
  firewallEnabled: boolean;
  firewallMode: string;
  firewallAllowRules: string[];
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// --- Approval types ---

export interface OrchestraApprovalRequest {
  id: string;
  runId: string;
  stepRunId: string | null;
  title: string;
  description: string | null;
  toolName: string | null;
  argsJson: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedBy: string;
  decidedBy: string | null;
  decision: string | null;
  reason: string | null;
  expiresAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  run?: OrchestraRun;
  stepRun?: OrchestraStepRun;
}

// --- Cost analysis types ---

export interface CostSummary {
  period: { days: number; since: string };
  totals: {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    invocations: number;
    avgLatencyMs: number;
  };
  byModel: Array<{
    model: string;
    cost: number;
    invocations: number;
    inputTokens: number;
    outputTokens: number;
    avgLatency: number;
  }>;
  byAgent: Array<{
    agentId: string;
    name: string;
    cost: number;
    invocations: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byDay: Array<{
    date: string;
    cost: number;
    invocations: number;
    tokens: number;
  }>;
}

export interface RunCost {
  id: string;
  agentName: string;
  status: string;
  cost: number;
  tokens: number;
  invocations: number;
  avgLatencyMs: number;
  createdAt: string;
  completedAt: string | null;
}

// --- DAG types ---

export interface DagNode {
  id: string;
  stepType: string;
  status: string;
  stepIndex: number;
  dependsOn: string[];
  condition: Record<string, unknown> | null;
  parentStepId: string | null;
  duration: number | null;
  approval: {
    id: string;
    title: string;
    status: string;
    decidedBy: string | null;
    decision: string | null;
  } | null;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface RunDag {
  nodes: DagNode[];
  edges: DagEdge[];
}

// ── Consciousness Dashboard Types ───────────────────────────────────────────

export interface ConsciousnessDashboard {
  agent: { id: string; name: string };
  state: {
    valence: number;
    confidence: Record<string, number>;
    driveCount: number;
    goalCount: number;
    beliefCount: number;
    lastReflectionAt: string | null;
    reflectionCount: number;
  };
  valenceHistory: ValencePoint[];
  beliefGraph: { nodes: BeliefNode[]; edges: BeliefEdge[] };
  driveRadar: DrivePoint[];
  goalTimeline: GoalEntry[];
  calibrationData: CalibrationPoint[];
  attention: { heuristics: unknown[]; anomalyPatterns: unknown[] };
  deliberationLog: DeliberationEntry[];
  commitments: CommitmentSummary;
  recentEvents: ConsciousnessEvent[];
  revisionSummary: RevisionSummary;
  dualProcessStats: { pathRatio: { system1: number; system2: number; total: number }; cacheStats: unknown };
  counterfactualSummary: { retrospectives: number; premortems: number; regrets: number };
  kernel: KernelSummary | null;
  snapshots: SnapshotEntry[];
}

export interface ValencePoint {
  timestamp: string;
  valence: number;
  trigger: string;
  runId?: string;
}

export interface BeliefNode {
  id: string;
  claim: string;
  domain: string;
  confidence: number;
  source: string;
  quarantined: boolean;
  corroborations: number;
  contradictions: number;
}

export interface BeliefEdge {
  from: string;
  to: string;
  type: string;
}

export interface DrivePoint {
  name: string;
  strength: number;
}

export interface GoalEntry {
  description: string;
  status: string;
  priority: number;
  progress: number;
  proposedAt?: string;
  source?: string;
}

export interface CalibrationPoint {
  domain: string;
  confidence: number;
}

export interface DeliberationEntry {
  id: string;
  decision: string;
  verdict: string;
  reasoning: string;
  deliberatedAt: string;
  principlesConsidered: Array<{
    principleId: string;
    principleText: string;
    assessment: string;
    reasoning: string;
  }>;
}

export interface CommitmentSummary {
  total: number;
  active: number;
  fulfilled: number;
  broken: number;
  items: Array<{
    id: string;
    description: string;
    status: string;
    madeToEntity: string;
    deadline?: string;
  }>;
}

export interface ConsciousnessEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RevisionSummary {
  totalProposals: number;
  pending: number;
  applied: number;
  reverted: number;
  goalProposals: number;
  pendingGoals: number;
}

export interface KernelSummary {
  roleDescription: string;
  interactionStyle: string;
  coreValues: string[];
  name: string;
}

export interface SnapshotEntry {
  id: string;
  timestamp: string;
  trigger: string;
  runId?: string;
  valence: number;
  confidence: Record<string, number>;
  activeGoalCount: number;
  structuredBeliefCount: number;
  quarantinedBeliefCount: number;
  reflectionCount: number;
  topDrive: string;
  dominantDomains: string[];
}

// ─── Visual Workflow Builder Types ───────────────────────────────────────────

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type WorkflowType = 'agentic' | 'remediation' | 'iam' | 'fleet' | 'webhook' | 'scheduled';
export type WorkflowCategory =
  | 'fleet_remediation'
  | 'node_onboarding'
  | 'webhook_agent'
  | 'scheduled_compliance'
  | 'iam_review'
  | 'multi_agent'
  | 'incident_triage';

export type WorkflowNodeType =
  | 'manual_trigger' | 'webhook_trigger' | 'schedule_trigger' | 'anomaly_trigger'
  | 'audit_event_trigger' | 'fleet_threshold_trigger' | 'chat_trigger' | 'child_workflow_trigger'
  | 'agent' | 'ad_hoc_agent' | 'supervisor_agent' | 'reviewer_agent' | 'multi_agent_fanout' | 'child_workflow_call'
  | 'run_command' | 'read_patch_file' | 'deploy_upgrade_agent' | 'query_node_health' | 'query_topology' | 'pull_from_library' | 'register_migrate_node'
  | 'approval_gate' | 'policy_check' | 'role_check' | 'escalate_human' | 'notify_operator'
  | 'branch_if' | 'filter' | 'merge' | 'aggregate' | 'map_transform' | 'dedupe' | 'delay_wait' | 'retry_wrapper'
  | 'prompt_inference' | 'trait_model_route' | 'retrieve_memory' | 'write_memory' | 'summarize_context' | 'extract_structured'
  | 'js_expression' | 'python_snippet' | 'http_request' | 'raw_json_transform'
  | 'note';

export type WorkflowTriggerType = 'manual' | 'schedule' | 'webhook' | 'anomaly' | 'audit_event' | 'fleet_threshold' | 'chat' | 'child_workflow';

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  type: WorkflowType;
  tags: string[];
  viewRoles: string[];
  editRoles: string[];
  publishRoles: string[];
  runRoles: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  latestVersion?: { id: string; version: number; publishedAt: string | null } | null;
  lastRun?: { id: string; status: string; createdAt: string } | null;
}

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  canvasData: WorkflowCanvasData;
  snapshotConfig: Record<string, unknown>;
  changelog: string;
  publishedAt: string | null;
  createdBy: string;
  createdAt: string;
  nodes?: WorkflowNodeRecord[];
  edges?: WorkflowEdgeRecord[];
}

export interface WorkflowCanvasData {
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
  viewport: { x: number; y: number; zoom: number };
}

export interface WorkflowCanvasNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: { label: string; description?: string; config: Record<string, unknown> };
  parentId?: string;
}

export interface WorkflowCanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  data?: { condition?: Record<string, unknown>; label?: string };
}

export interface WorkflowNodeRecord {
  id: string;
  versionId: string;
  nodeId: string;
  type: WorkflowNodeType;
  positionX: number;
  positionY: number;
  config: Record<string, unknown>;
  label: string;
  description: string;
}

export interface WorkflowEdgeRecord {
  id: string;
  versionId: string;
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  condition: Record<string, unknown> | null;
  label: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: WorkflowCategory;
  canvasData: WorkflowCanvasData;
  tags: string[];
  isBuiltIn: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: { nodeId?: string; edgeId?: string; code: string; message: string }[];
  warnings: { nodeId?: string; code: string; message: string }[];
}
export type HermesInstallationStatus =
  | 'unknown'
  | 'not_installed'
  | 'detected'
  | 'needs_setup'
  | 'running'
  | 'degraded'
  | 'error';

export type HermesServiceStatus =
  | 'unknown'
  | 'not_installed'
  | 'inactive'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'error';

export type HermesInstallMode = 'unknown' | 'official-script' | 'pip' | 'git' | 'existing';
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

export interface HermesDetectedSkill {
  slug: string;
  category: string | null;
  source: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

export interface HermesDetectedPlugin {
  slug: string;
  pluginType: string;
  version: string | null;
  status: string;
  healthState: string;
  metadata: Record<string, unknown>;
}

export interface HermesDetectedProvider {
  profileName: string | null;
  provider: string;
  model: string | null;
  configured: boolean;
  metadata: Record<string, unknown>;
}

export interface HermesDetectedToolset {
  toolset: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
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
  rawStatus: Record<string, unknown> & {
    skills?: HermesDetectedSkill[];
    plugins?: HermesDetectedPlugin[];
    providers?: HermesDetectedProvider[];
    toolsets?: HermesDetectedToolset[];
  };
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
  type: string;
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

export interface HermesConfigFile {
  installationId: string;
  path: string;
  configYaml: string;
  exists: boolean;
  lastSyncedAt: string | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Hermes Agent — fleet resource shapes (mirrors magnus-api Prisma rows)
// ──────────────────────────────────────────────────────────────────────────────

export interface HermesSkillAssignment {
  id: string;
  installationId: string;
  profileId: string;
  skillSlug: string;
  pinnedVersion: string | null;
  source: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  status: string;
  error: string | null;
  metadata: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesToolsetPolicy {
  id: string;
  installationId: string;
  profileId: string;
  toolset: string;
  enabled: boolean;
  approvalMode: string;
  perToolHooks: string;
  allowList: string;
  denyList: string;
  lastSyncedAt: string | null;
  status: string;
  metadata: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesRole {
  id: string;
  name: string;
  description: string;
  personalityMd: string;
  personalityRef: string | null;
  toolsetsJson: string;
  skillsJson: string;
  providerJson: string;
  cronJson: string;
  messagingJson: string;
  metadata: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesProviderConfig {
  id: string;
  installationId: string;
  profileId: string;
  chainJson: string;
  sortStrategy: string;
  whitelistJson: string;
  blacklistJson: string;
  visionOverride: string | null;
  compressionOverride: string | null;
  lastSyncedAt: string | null;
  status: string;
  metadata: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesCredentialPool {
  id: string;
  name: string;
  provider: string;
  rotationPolicy: string;
  secretRefsJson: string;
  metadata: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesCredentialPoolAttachment {
  id: string;
  poolId: string;
  installationId: string;
  profileId: string;
  status: string;
  lastSyncedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesMcpServer {
  id: string;
  name: string;
  transport: string;
  endpoint: string;
  argsJson: string;
  envJson: string;
  toolFilterJson: string;
  samplingEnabled: boolean;
  metadata: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesMcpServerAttachment {
  id: string;
  serverId: string;
  installationId: string;
  profileId: string;
  status: string;
  lastSyncedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesMessagingBinding {
  id: string;
  installationId: string;
  profileId: string;
  platform: string;
  channelIdsJson: string;
  voiceEnabled: boolean;
  voiceModel: string | null;
  ttsProvider: string | null;
  secretRef: string | null;
  metadata: string;
  status: string;
  lastSyncedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesCronJob {
  id: string;
  installationId: string;
  profileId: string;
  name: string;
  prompt: string;
  cronExpr: string;
  naturalLanguage: string | null;
  attachedSkillsJson: string;
  deliveryJson: string;
  enabled: boolean;
  status: string;
  lastRunAt: string | null;
  metadata: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesPluginInstall {
  id: string;
  installationId: string;
  profileId: string;
  pluginSlug: string;
  pluginType: string;
  pinnedVersion: string | null;
  status: string;
  healthState: string;
  lastSyncedAt: string | null;
  metadata: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HermesHook {
  id: string;
  installationId: string;
  profileId: string;
  event: string;
  target: string;
  configJson: string;
  enabled: boolean;
  status: string;
  lastSyncedAt: string | null;
  metadata: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

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

export interface SkillCatalogEntry {
  name: string;
  version: string;
  description: string;
  author?: string;
  entryPoint?: string;
  dependencies?: string[];
  tags?: string[];
  path?: string;
  source?: string;
  requiredEnv?: string[];
  requiredToolsets?: string[];
  metadata?: Record<string, unknown>;
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

export interface SkillBundlePreview {
  selected: SkillCatalogEntry[];
  missing: string[];
  missingDependencies: string[];
  assignments: Array<{ installationId: string; profileId: string | null; skillSlug: string; pinnedVersion: string | null; source: string; enabled: boolean }>;
}

export interface SkillCatalog {
  schema: string;
  generatedAt: string;
  count: number;
  source: 'index' | 'walk';
  skills: SkillCatalogEntry[];
}
