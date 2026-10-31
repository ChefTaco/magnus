import ky, { HTTPError, type KyInstance } from 'ky';
import { currentTraceId } from './trace';
import type {
  ApiResponse,
  Node,
  HealthSnapshot,
  RemoteCommand,
  CommandResult,
  CommandDispatchResponse,
  CronJobSpec,
  FilePatchTask,
  FileReadResponse,
  SkillBundle,
  SkillRegistryEntry,
  SkillVersionSummary,
  SkillInstallation,
  SkillFileContent,
  AuditEvent,
  StatsOverview,
  Role,
  RoleApplication,
  LibraryCategory,
  LibraryFile,
  Notification,
  AnomalyEvent,
  AnomalySummary,
  AnomalyCorrelationDetails,
  AiConversation,
  AiMessage,
  AiChatResponse,
  AiHeartbeatPrompt,
  OllamaModel,
  AiSettings,
  InsightsResponse,
  PinnedAiInsight,
  ModelProfiles,
  AiScratchpadEntry,
  SharedAiConversation,
  ExportFormat,
  RemediationRule,
  RemediationExecution,
  DiskForecast,
  TailscaleExpirySummary,
} from '../types/contracts';
import type { HermesConfigFile, HermesInstallation, HermesOperationJob, HermesProfile } from '../types/orchestra';
import type { CodexDeviceAuthSession, CodexInstallation } from '../types/codex';
import type { ArdentFleetInstallation, ArdentProfileSummary } from '@hivemagnus/magnus-contracts';
import { normalizeProxyTarget, proxyTargetHeaders } from './proxy-target';
import { agentDisabledMessage } from './agent-privilege';

/** Dashboard API client — calls the control-api via Ky. */
class DashboardApiClient {
  private client: KyInstance;
  private _baseUrl: string;

  constructor() {
    this._baseUrl = ''; // Empty target selects the server-configured canonical API.
    this.client = this.createClient(this._baseUrl);
  }

  /** Get the current base URL this client is pointing at. */
  get baseUrl(): string {
    return this._baseUrl;
  }

  /** Get auth headers for SSE/stream connections that bypass ky. */
  getAuthHeaders(): Record<string, string> {
    return proxyTargetHeaders(this._baseUrl);
  }

  /** Reconfigure the client to point at a different Control Node. */
  reconfigure(baseUrl: string): void {
    this._baseUrl = normalizeProxyTarget(baseUrl) ?? '';
    this.client = this.createClient(this._baseUrl);
  }

  private createClient(baseUrl: string): KyInstance {
    // Route all API traffic through the Next.js server-side proxy so the
    // browser never makes direct TLS connections to remote control nodes
    // (which would fail for self-signed certs).
    // The browser sends only the selected target. The proxy resolves credentials
    // from protected server state and ignores client auth headers.
    return ky.create({
      prefix: '/api/proxy',
      timeout: 180_000,
      hooks: {
        beforeRequest: [
          ({ request }) => {
            // Tell the proxy which control node to forward to
            if (baseUrl) request.headers.set('x-proxy-target', baseUrl); else request.headers.delete('x-proxy-target');

            // Attach a trace id for cross-service correlation
            if (!request.headers.get('x-trace-id')) {
              request.headers.set('x-trace-id', currentTraceId());
            }

          },
        ],
        beforeError: [
          async ({ error }) => {
            // Features disabled on an unprivileged node agent are not failures.
            if (error instanceof HTTPError && error.response.status === 403) {
              const message = agentDisabledMessage(error.data);
              if (message) {
                error.name = 'AgentNotPrivilegedError';
                error.message = message;
              }
            }
            return error;
          },
        ],
      },
    });
  }

  // ── Generic helpers ──

  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<ApiResponse<T>> {
    const searchParams: Record<string, string> = {};
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) searchParams[k] = String(v);
      }
    }
    return this.client.get(path, { searchParams }).json();
  }

  async post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    return this.client.post(path, { json: body, headers }).json();
  }

  async patch<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.client.patch(path, { json: body }).json();
  }

  async put<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.client.put(path, { json: body }).json();
  }

  async del<T>(path: string): Promise<ApiResponse<T>> {
    return this.client.delete(path).json();
  }

  // ── Domain methods ──

  nodes = {
    list: (params?: { page?: number; pageSize?: number; status?: string }) =>
      this.get<Node[]>('nodes', params),
    get: (id: string) => this.get<Node>(`nodes/${id}`),
    register: (data: unknown) => this.post<Node>('nodes/register', data),
    update: (id: string, data: unknown) => this.patch<Node>(`nodes/${id}`, data),
    repairAddress: (
      id: string,
      data: { ipAddress?: string; hostname?: string; resolveDns?: boolean },
    ) =>
      this.post<{
        changed: boolean;
        source: 'manual' | 'dns' | 'existing';
        previousIpAddress: string;
        node: Node;
      }>(`nodes/${id}/repair-address`, data),
    delete: (id: string) => this.del<{ deleted: boolean }>(`nodes/${id}`),
    health: (id: string) => this.get<HealthSnapshot>(`nodes/${id}/health`),
    gpu: (id: string, period: '6h' | '24h' | '7d' = '24h') =>
      this.get<import('@/types/contracts').GpuTelemetryResponse>(`nodes/${id}/gpu`, { period }),
    forecast: (id: string, days = 30) => this.get<{
      nodeId: string;
      hostname: string | null;
      lookbackDays: number;
      forecasts: DiskForecast[];
    }>(`health/${id}/forecast`, { days }),
    wazuh: (id: string) => this.get<{
      nodeId: string;
      observedAt: string;
      wazuh: import('@/types/contracts').WazuhAgentInfo | null;
    }>(`nodes/${id}/wazuh`),
    wazuhSummary: () => this.get<{
      total: number;
      reporting: number;
      installed: number;
      active: number;
      failed: number;
      nodes: Array<{
        id: string;
        name: string;
        hostname: string;
        nodeStatus: string;
        lastHeartbeatAt: string | null;
        observedAt: string | null;
        wazuh: import('@/types/contracts').WazuhAgentInfo | null;
      }>;
    }>('nodes/wazuh/summary'),
    systemUpdatesSummary: () => this.get<{
      total: number;
      reporting: number;
      enabled: number;
      actionNeeded: number;
      rebootRequired: number;
      nodes: Array<{
        id: string;
        name: string;
        hostname: string;
        nodeStatus: string;
        lastHeartbeatAt: string | null;
        observedAt: string | null;
        systemUpdates: import('@/types/contracts').SystemUpdateInfo | null;
      }>;
    }>('nodes/system-updates/summary'),
    tailscaleSummary: () => this.get<TailscaleExpirySummary>('nodes/tailscale/summary'),
    enableSystemUpdates: (id: string) =>
      this.post<import('@/types/contracts').SystemUpdateInfo>(`nodes/${id}/system-updates/enable`),
    healthHistory: (id: string, limit?: number) =>
      this.get<HealthSnapshot[]>(`nodes/${id}/health/history`, { limit }),
  };

  commands = {
    dispatch: (data: unknown, idempotencyKey: string) =>
      this.post<CommandDispatchResponse>('commands', data, { 'x-idempotency-key': idempotencyKey }),
    get: (id: string) => this.get<RemoteCommand>(`commands/${id}`),
    result: (id: string) => this.get<CommandResult>(`commands/${id}/result`),
    cancel: (id: string, reason: string) => this.post<{ cancelled: boolean }>(`commands/${id}/cancel`, { reason }),
  };

  cron = {
    list: (nodeId?: string) => this.get<CronJobSpec[]>('cron', nodeId ? { nodeId } : undefined),
    get: (id: string) => this.get<CronJobSpec>(`cron/${id}`),
    create: (data: unknown) => this.post<CronJobSpec>('cron', data),
    update: (id: string, data: unknown) => this.patch<CronJobSpec>(`cron/${id}`, data),
    delete: (id: string) => this.del<{ deleted: boolean }>(`cron/${id}`),
  };

  files = {
    update: (data: unknown) => this.post<FilePatchTask[]>('files/update', data),
    read: (nodeId: string, filePath: string) =>
      this.get<FileReadResponse>('files/read', { nodeId, filePath }),
  };

  skills = {
    list: () => this.get<SkillBundle[]>('skills'),
    get: (name: string) => this.get<SkillBundle>(`skills/${name}`),
    create: (data: unknown) => this.post<SkillBundle>('skills', data),
    update: (name: string, data: unknown) => this.patch<SkillBundle>(`skills/${name}`, data),
    delete: (name: string) => this.del<{ deleted: boolean }>(`skills/${name}`),
    push: (data: unknown) => this.post<{ installations: Array<{ nodeId: string; status: string; installationId: string }> }>('skills/push', data),
    installations: (nodeId: string) => this.get<SkillInstallation[]>(`skills/installations/${nodeId}`),
    getFile: (name: string, fileName: string) => this.get<SkillFileContent>(`skills/${name}/files/${fileName}`),
    updateFile: (name: string, fileName: string, content: string) =>
      this.client.put(`skills/${name}/files/${fileName}`, { json: { content } }).json() as Promise<{ success: boolean; data: SkillFileContent }>,
    // Registry methods
    registry: {
      list: () => this.get<SkillRegistryEntry[]>('skills/registry'),
      get: (slug: string) => this.get<SkillRegistryEntry>(`skills/registry/${slug}`),
      sync: () => this.post<{ synced: number }>('skills/registry/sync', {}),
      publish: (slug: string, data: { version: string; changelog?: string; tags?: string[] }) =>
        this.post<SkillRegistryEntry>(`skills/registry/${slug}/publish`, data),
      versions: (slug: string) => this.get<SkillVersionSummary[]>(`skills/registry/${slug}/versions`),
      versionDetail: (slug: string, version: string) =>
        this.get<SkillVersionSummary>(`skills/registry/${slug}/versions/${version}`),
      setTag: (slug: string, data: { tag: string; versionId: string }) =>
        this.post<SkillRegistryEntry>(`skills/registry/${slug}/tags`, data),
      delete: (slug: string) => this.del<{ deleted: boolean }>(`skills/registry/${slug}`),
    },
  };

  logs = {
    query: (query: unknown) => this.post<{ logs: Array<{ timestamp: string; level: string; message: string; source: string; nodeId?: string; service?: string }> }>('logs/query', query),
    ingest: (entries: unknown[]) => this.post<{ ingested: number }>('logs/ingest', entries),
  };

  audit = {
    list: (params?: { page?: number; pageSize?: number; action?: string; date?: string }) =>
      this.get<AuditEvent[]>('audit', params),
    days: () => this.get<string[]>('audit/days'),
  };

  hermes = {
    installations: () => this.get<HermesInstallation[]>('hermes/installations'),
    installation: (id: string) => this.get<HermesInstallation>(`hermes/installations/${id}`),
    detect: (data: { nodeId?: string; hostname?: string; sshPort?: number; hermesHome?: string; hermesBin?: string }) =>
      this.post<{ job: HermesOperationJob; installation: HermesInstallation }>('hermes/detect', data),
    deploy: (data: {
      nodeId?: string;
      hostname?: string;
      sshPort?: number;
      hermesHome?: string;
      hermesBin?: string;
      installMethod?: 'official-script' | 'pip';
      dashboardPort?: number;
      enableDashboard?: boolean;
      enableDashboardTui?: boolean;
      startGateway?: boolean;
    }, idempotencyKey: string) =>
      this.post<HermesOperationJob>('hermes/deploy', data, { 'x-idempotency-key': idempotencyKey }),
    sync: (installationId: string) =>
      this.post<{ job: HermesOperationJob; installation: HermesInstallation }>(`hermes/installations/${installationId}/sync`),
    configure: (installationId: string) =>
      this.post<HermesOperationJob>(`hermes/installations/${installationId}/configure`),
    config: (installationId: string) =>
      this.get<HermesConfigFile>(`hermes/installations/${installationId}/config`),
    updateConfig: (installationId: string, data: { configYaml: string }) =>
      this.patch<HermesOperationJob>(`hermes/installations/${installationId}/config`, data),
    update: (installationId: string) =>
      this.post<HermesOperationJob>(`hermes/installations/${installationId}/update`),
    uninstall: (installationId: string) =>
      this.del<HermesOperationJob>(`hermes/installations/${installationId}`),
    profiles: (installationId?: string) =>
      installationId
        ? this.get<HermesProfile[]>(`hermes/installations/${installationId}/profiles`)
        : this.get<HermesProfile[]>('hermes/profiles'),
    createProfile: (installationId: string, data: { name: string; description?: string; distribution?: string; setDefault?: boolean }) =>
      this.post<HermesOperationJob>(`hermes/installations/${installationId}/profiles`, data),
    updateProfile: (profileId: string, data: { description?: string; renameTo?: string }) =>
      this.patch<HermesOperationJob>(`hermes/profiles/${profileId}`, data),
    deleteProfile: (profileId: string) =>
      this.del<HermesOperationJob>(`hermes/profiles/${profileId}`),
    describeProfile: (profileId: string) =>
      this.post<HermesOperationJob>(`hermes/profiles/${profileId}/describe-auto`),
    gatewayAction: (profileId: string, action: 'install' | 'start' | 'stop' | 'restart' | 'status') =>
      this.post<HermesOperationJob>(`hermes/profiles/${profileId}/gateway/${action}`),
    dashboardAction: (installationId: string, action: 'install' | 'start' | 'stop' | 'restart' | 'status' | 'launch') =>
      this.post<HermesOperationJob>(`hermes/installations/${installationId}/dashboard/${action}`),
    enableApiServer: (profileId: string, data: { host?: string; port?: number; apiKey?: string }) =>
      this.post<HermesOperationJob>(`hermes/profiles/${profileId}/api-server/enable`, data),
    disableApiServer: (profileId: string) =>
      this.post<HermesOperationJob>(`hermes/profiles/${profileId}/api-server/disable`),
    apiServerStatus: (profileId: string) =>
      this.get<{ profileId: string; installationId: string; enabled: boolean; host: string; port: number | null; keyFingerprint: string | null; lastSyncedAt: string | null }>(`hermes/profiles/${profileId}/api-server/status`),
    rotateApiServerKey: (profileId: string, data: { apiKey?: string }) =>
      this.post<HermesOperationJob>(`hermes/profiles/${profileId}/api-server/rotate-key`, data),
    migrationDryRun: (data: { installationId: string; profileName?: string; sourcePath?: string; preset?: 'full' | 'user-data'; overwrite?: boolean; migrateSecrets?: boolean }) =>
      this.post<HermesOperationJob>('hermes/migration/openclaw/dry-run', data),
    migrationApply: (data: { installationId: string; profileName?: string; sourcePath?: string; preset?: 'full' | 'user-data'; overwrite?: boolean; migrateSecrets?: boolean }, idempotencyKey: string) =>
      this.post<HermesOperationJob>('hermes/migration/openclaw/apply', data, { 'x-idempotency-key': idempotencyKey }),
    jobs: (params?: { status?: string; type?: string; limit?: number }) =>
      this.get<HermesOperationJob[]>('hermes/jobs', params),
    job: (id: string) => this.get<HermesOperationJob>(`hermes/jobs/${id}`),
  };

  ardent = {
    installations: () => this.get<ArdentFleetInstallation[]>('ardent/installations'),
    installation: (nodeId: string) => this.get<ArdentFleetInstallation>(`ardent/installations/${encodeURIComponent(nodeId)}`),
    profiles: () => this.get<Array<ArdentProfileSummary & { nodeId: string; nodeName: string; hostname: string; installationVersion: string | null; reachable: boolean }>>('ardent/profiles'),
    resource: <T>(nodeId: string, profile: string, resource: string, params?: Record<string, string | number | undefined>) =>
      this.get<T>(`ardent/installations/${encodeURIComponent(nodeId)}/profiles/${encodeURIComponent(profile)}/${resource}`, params),
    action: <T>(nodeId: string, profile: string, action: string, body?: unknown, target?: string) =>
      this.client.post(`ardent/installations/${encodeURIComponent(nodeId)}/profiles/${encodeURIComponent(profile)}/action`,
        { json: { action, ...(target ? { target } : {}), body: body ?? {} },
          timeout: action === 'package-install' ? 620_000 : action === 'profile-import-hermes' ? 100_000 : action.startsWith('service-') ? 125_000 : 55_000 }).json<ApiResponse<T>>(),
  };

  codex = {
    installations: (refreshLatest = false) =>
      this.get<CodexInstallation[]>('codex/installations', { refreshLatest: refreshLatest ? 'true' : undefined }),
    installation: (nodeId: string, refreshLatest = false) =>
      this.get<CodexInstallation>(`codex/installations/${nodeId}`, { refreshLatest: refreshLatest ? 'true' : undefined }),
    update: (nodeId: string) =>
      this.post<CodexInstallation>(`codex/installations/${nodeId}/update`),
    logout: (nodeId: string) =>
      this.post<CodexInstallation>(`codex/installations/${nodeId}/logout`),
    startDeviceAuth: (nodeId: string) =>
      this.post<CodexDeviceAuthSession>(`codex/installations/${nodeId}/device-auth`),
    deviceAuth: (nodeId: string, sessionId: string) =>
      this.get<CodexDeviceAuthSession>(`codex/installations/${nodeId}/device-auth/${sessionId}`),
    cancelDeviceAuth: (nodeId: string, sessionId: string) =>
      this.post<CodexDeviceAuthSession>(`codex/installations/${nodeId}/device-auth/${sessionId}/cancel`),
  };

  orchestra = {
    overview: () => this.get<import('../types/orchestra').OrchestraOverview>('orchestra/overview'),
    capabilities: () => this.get<import('../types/orchestra').OrchestraCapabilityInventory>('orchestra/capabilities'),
    skillCatalog: () => this.get<import('../types/orchestra').SkillCatalog>('orchestra/skill-catalog'),
    auditCatalogSkill: (slug: string) => this.get<import('../types/orchestra').SkillAuditResult>(`orchestra/skill-catalog/${encodeURIComponent(slug)}/audit`),
    installCatalogSkill: (data: { slug: string; installationId: string; profileId?: string | null; pinnedVersion?: string | null; source?: string }) =>
      this.post<import('../types/orchestra').HermesSkillAssignment>('orchestra/skill-catalog/install', data),
    quarantineCatalogSkill: (slug: string) => this.post<{ updated: number }>(`orchestra/skill-catalog/${encodeURIComponent(slug)}/quarantine`, {}),
    previewSkillBundle: (data: { slugs: string[]; installationId?: string; profileId?: string | null }) =>
      this.post<import('../types/orchestra').SkillBundlePreview>('orchestra/skill-bundles/preview', data),
    applySkillBundle: (data: { slugs: string[]; installationId: string; profileId?: string | null }) =>
      this.post<{ count: number; assignments: import('../types/orchestra').HermesSkillAssignment[] }>('orchestra/skill-bundles/apply', data),
    cancelJob: (id: string) => this.post<{ id: string; status: string }>(`orchestra/jobs/${id}/cancel`),
    testProvider: (data: { installationId: string; profileId?: string | null; provider: string }) =>
      this.post<{ status: string; message: string }>('orchestra/providers/test', data),
    skillAssignments: {
      list: (params?: { installationId?: string; profileId?: string }) =>
        this.get<import('../types/orchestra').HermesSkillAssignment[]>('orchestra/skill-assignments', params),
      create: (data: unknown) => this.post<import('../types/orchestra').HermesSkillAssignment>('orchestra/skill-assignments', data),
      update: (id: string, data: unknown) => this.patch<import('../types/orchestra').HermesSkillAssignment>(`orchestra/skill-assignments/${id}`, data),
      delete: (id: string) => this.del<unknown>(`orchestra/skill-assignments/${id}`),
    },
    toolsetPolicies: {
      list: (params?: { installationId?: string; profileId?: string }) =>
        this.get<import('../types/orchestra').HermesToolsetPolicy[]>('orchestra/toolset-policies', params),
      upsert: (data: unknown) => this.put<import('../types/orchestra').HermesToolsetPolicy>('orchestra/toolset-policies', data),
      update: (id: string, data: unknown) => this.patch<import('../types/orchestra').HermesToolsetPolicy>(`orchestra/toolset-policies/${id}`, data),
      delete: (id: string) => this.del<unknown>(`orchestra/toolset-policies/${id}`),
    },
    roles: {
      list: () => this.get<import('../types/orchestra').HermesRole[]>('orchestra/roles'),
      get: (id: string) => this.get<import('../types/orchestra').HermesRole>(`orchestra/roles/${id}`),
      create: (data: unknown) => this.post<import('../types/orchestra').HermesRole>('orchestra/roles', data),
      update: (id: string, data: unknown) => this.patch<import('../types/orchestra').HermesRole>(`orchestra/roles/${id}`, data),
      delete: (id: string) => this.del<unknown>(`orchestra/roles/${id}`),
      apply: (id: string, data: { installationId: string; profileId?: string | null }) =>
        this.post<unknown>(`orchestra/roles/${id}/apply`, data),
    },
    providers: {
      get: (params: { installationId: string; profileId?: string }) =>
        this.get<import('../types/orchestra').HermesProviderConfig | null>('orchestra/providers', params),
      upsert: (data: unknown) => this.put<import('../types/orchestra').HermesProviderConfig>('orchestra/providers', data),
    },
    credentialPools: {
      list: () => this.get<import('../types/orchestra').HermesCredentialPool[]>('orchestra/credential-pools'),
      create: (data: unknown) => this.post<import('../types/orchestra').HermesCredentialPool>('orchestra/credential-pools', data),
      update: (id: string, data: unknown) => this.patch<import('../types/orchestra').HermesCredentialPool>(`orchestra/credential-pools/${id}`, data),
      delete: (id: string) => this.del<unknown>(`orchestra/credential-pools/${id}`),
      attach: (id: string, data: { installationId: string; profileId?: string | null }) =>
        this.post<unknown>(`orchestra/credential-pools/${id}/attach`, data),
      detach: (attachmentId: string) => this.del<unknown>(`orchestra/credential-pools/attachments/${attachmentId}`),
    },
    mcpServers: {
      list: () => this.get<import('../types/orchestra').HermesMcpServer[]>('orchestra/mcp-servers'),
      create: (data: unknown) => this.post<import('../types/orchestra').HermesMcpServer>('orchestra/mcp-servers', data),
      update: (id: string, data: unknown) => this.patch<import('../types/orchestra').HermesMcpServer>(`orchestra/mcp-servers/${id}`, data),
      delete: (id: string) => this.del<unknown>(`orchestra/mcp-servers/${id}`),
      attach: (id: string, data: { installationId: string; profileId?: string | null }) =>
        this.post<unknown>(`orchestra/mcp-servers/${id}/attach`, data),
      detach: (attachmentId: string) => this.del<unknown>(`orchestra/mcp-servers/attachments/${attachmentId}`),
    },
    messagingBindings: {
      list: (params?: { installationId?: string; profileId?: string }) =>
        this.get<import('../types/orchestra').HermesMessagingBinding[]>('orchestra/messaging-bindings', params),
      create: (data: unknown) => this.post<import('../types/orchestra').HermesMessagingBinding>('orchestra/messaging-bindings', data),
      update: (id: string, data: unknown) => this.patch<import('../types/orchestra').HermesMessagingBinding>(`orchestra/messaging-bindings/${id}`, data),
      delete: (id: string) => this.del<unknown>(`orchestra/messaging-bindings/${id}`),
    },
    cronJobs: {
      list: (params?: { installationId?: string; profileId?: string }) =>
        this.get<import('../types/orchestra').HermesCronJob[]>('orchestra/cron-jobs', params),
      create: (data: unknown) => this.post<import('../types/orchestra').HermesCronJob>('orchestra/cron-jobs', data),
      update: (id: string, data: unknown) => this.patch<import('../types/orchestra').HermesCronJob>(`orchestra/cron-jobs/${id}`, data),
      delete: (id: string) => this.del<unknown>(`orchestra/cron-jobs/${id}`),
    },
    plugins: {
      list: (params?: { installationId?: string; profileId?: string }) =>
        this.get<import('../types/orchestra').HermesPluginInstall[]>('orchestra/plugins', params),
      install: (data: unknown) => this.post<import('../types/orchestra').HermesPluginInstall>('orchestra/plugins', data),
      remove: (id: string) => this.del<unknown>(`orchestra/plugins/${id}`),
    },
    hooks: {
      list: (params?: { installationId?: string; profileId?: string }) =>
        this.get<import('../types/orchestra').HermesHook[]>('orchestra/hooks', params),
      create: (data: unknown) => this.post<import('../types/orchestra').HermesHook>('orchestra/hooks', data),
      update: (id: string, data: unknown) => this.patch<import('../types/orchestra').HermesHook>(`orchestra/hooks/${id}`, data),
      delete: (id: string) => this.del<unknown>(`orchestra/hooks/${id}`),
    },
  };

  quickCommand = {
    exec: (nodeId: string, data: { command: string; args?: string[]; timeoutSeconds?: number }) =>
      this.post<{ commandId: string; exitCode: number; stdout: string; stderr: string; durationMs: number; truncated: boolean }>(`quick-command/${nodeId}/exec`, data),
  };

  discovery = {
    scan: (timeoutMs?: number) =>
      this.post<Array<{ ip: string; port: number; hostname?: string; agentVersion?: string }>>('discovery/scan', { timeoutMs }),
  };

  stats = {
    overview: () => this.get<StatsOverview>('stats/overview'),
  };

  roles = {
    list: () => this.get<Role[]>('roles'),
    get: (id: string) => this.get<Role>(`roles/${id}`),
    create: (data: unknown) => this.post<Role>('roles', data),
    update: (id: string, data: unknown) => this.patch<Role>(`roles/${id}`, data),
    delete: (id: string) => this.del<{ deleted: boolean }>(`roles/${id}`),
    assign: (id: string, data: { nodeIds: string[]; defer?: boolean }) =>
      this.post<{ assigned: number }>(`roles/${id}/assign`, data),
    unassign: (id: string, data: { nodeIds: string[] }) =>
      this.post<{ unassigned: number }>(`roles/${id}/unassign`, data),
    apply: (id: string, data?: { nodeIds?: string[] }) =>
      this.post<{ applicationId: string }>(`roles/${id}/apply`, data ?? {}),
    applications: {
      list: (params?: { roleId?: string; nodeId?: string; status?: string }) =>
        this.get<RoleApplication[]>('roles/applications/list', params),
      get: (id: string) => this.get<RoleApplication>(`roles/applications/${id}`),
    },
  };

  notifications = {
    list: (params?: { page?: number; pageSize?: number; isRead?: boolean; severity?: string; type?: string; nodeId?: string }) =>
      this.get<{ notifications: Notification[]; total: number; page: number; pageSize: number }>('notifications', params as Record<string, string | number | undefined>),
    unreadCount: () =>
      this.get<{ count: number }>('notifications/unread-count'),
    markRead: (ids: string[]) =>
      this.post<{ marked: number }>('notifications/read', { ids }),
    markAllRead: () =>
      this.post<{ marked: number }>('notifications/read-all'),
  };

  library = {
    categories: {
      list: () => this.get<LibraryCategory[]>('library/categories'),
      create: (data: { name: string; description?: string; color?: string; sortOrder?: number }) =>
        this.post<LibraryCategory>('library/categories', data),
      update: (id: string, data: { name?: string; description?: string; color?: string; sortOrder?: number }) =>
        this.patch<LibraryCategory>(`library/categories/${id}`, data),
      delete: (id: string) => this.del<{ deleted: boolean }>(`library/categories/${id}`),
    },
    files: {
      list: (params?: { query?: string; categoryId?: string; mimeType?: string; page?: number; pageSize?: number }) =>
        this.get<LibraryFile[]>('library/files', params),
      get: (id: string) => this.get<LibraryFile>(`library/files/${id}`),
      create: (data: { name: string; fileName: string; mimeType?: string; content: string; categoryId?: string | null; tags?: string[] }) =>
        this.post<LibraryFile>('library/files', data),
      update: (id: string, data: { name?: string; fileName?: string; mimeType?: string; content?: string; categoryId?: string | null; tags?: string[] }) =>
        this.patch<LibraryFile>(`library/files/${id}`, data),
      delete: (id: string) => this.del<{ deleted: boolean }>(`library/files/${id}`),
      move: (data: { fileIds: string[]; categoryId: string | null }) =>
        this.post<{ moved: number }>('library/files/move', data),
    },
  };

  anomalies = {
    list: (params?: { nodeId?: string; metric?: string; severity?: string; resolved?: string; page?: number; pageSize?: number }) =>
      this.get<{ anomalies: AnomalyEvent[]; total: number }>('anomalies', params),
    summary: () =>
      this.get<AnomalySummary>('anomalies/summary'),
    correlation: (id: string) =>
      this.get<AnomalyCorrelationDetails>(`anomalies/event/${id}/correlation`),
    nodeSummary: (nodeId: string) =>
      this.get<{ total: number; active: number; byMetric: Record<string, number>; recent: AnomalyEvent[] }>(`anomalies/${nodeId}/summary`),
    resolve: (id: string) =>
      this.post<{ success: boolean }>(`anomalies/${id}/resolve`),
    resolveNode: (nodeId: string, metric?: string) =>
      this.post<{ resolved: number }>('anomalies/resolve-node', { nodeId, metric }),
  };

  remediation = {
    listRules: () =>
      this.get<RemediationRule[]>('remediation/rules'),
    getRule: (id: string) =>
      this.get<RemediationRule>(`remediation/rules/${id}`),
    createRule: (data: Partial<RemediationRule> & { name: string; agentDefinitionId: string }) =>
      this.post<RemediationRule>('remediation/rules', data),
    updateRule: (id: string, data: Partial<RemediationRule>) =>
      this.patch<RemediationRule>(`remediation/rules/${id}`, data),
    deleteRule: (id: string) =>
      this.del<{ success: boolean }>(`remediation/rules/${id}`),
    listExecutions: (params?: { ruleId?: string; nodeId?: string; status?: string; page?: number; pageSize?: number }) =>
      this.get<{ executions: RemediationExecution[]; total: number; page: number; pageSize: number }>('remediation/executions', params),
    trigger: (data: { anomalyEventId: string; ruleId: string }) =>
      this.post<{ executionId: string; orchestraRunId: string | null }>('remediation/trigger', data),
  };

  assistant = {
    chat: (data: { message: string; conversationId?: string; nodeId?: string; controlNodeName?: string; controlNodeId?: string; replMode?: boolean; thinkingMode?: 'off' | 'standard' | 'deep'; maxToolRounds?: number }) =>
      this.post<AiChatResponse>('assistant/chat', data),
    conversations: (params?: { type?: string; status?: string; page?: number; pageSize?: number }) =>
      this.get<{ conversations: AiConversation[]; total: number }>('assistant/conversations', params),
    messages: (conversationId: string, params?: { page?: number; pageSize?: number }) =>
      this.get<{ messages: AiMessage[]; total: number }>(`assistant/conversations/${conversationId}`, params),
    forkConversation: (conversationId: string, fromMessageId?: string) =>
      this.post<AiConversation>(`assistant/conversations/${conversationId}/fork`, { fromMessageId }),
    shareConversation: (conversationId: string, ttlHours?: number) =>
      this.post<{ token: string; expiresAt: string }>(`assistant/conversations/${conversationId}/share`, { ttlHours }),
    getSharedConversation: (token: string) =>
      this.get<SharedAiConversation>(`assistant/shares/${token}`),
    getScratchpad: (conversationId: string) =>
      this.get<{ entries: AiScratchpadEntry[] }>(`assistant/conversations/${conversationId}/scratchpad`),
    clearScratchpad: (conversationId: string) =>
      this.del<{ success: boolean }>(`assistant/conversations/${conversationId}/scratchpad`),
    markConversationRead: (conversationId: string) =>
      this.post<{ marked: number }>(`assistant/conversations/${conversationId}/read`),
    archiveConversation: (conversationId: string) =>
      this.post<{ success: boolean }>(`assistant/conversations/${conversationId}/archive`),
    deleteConversation: (conversationId: string) =>
      this.del<{ success: boolean }>(`assistant/conversations/${conversationId}`),
    unreadCount: () =>
      this.get<{ unread: number }>('assistant/unread'),
    markMessagesRead: (messageIds: string[]) =>
      this.post<{ marked: number }>('assistant/messages/read', { messageIds }),
    getHeartbeatPrompt: () =>
      this.get<AiHeartbeatPrompt>('assistant/heartbeat-prompt'),
    updateHeartbeatPrompt: (content: string) =>
      this.put<{ success: boolean }>('assistant/heartbeat-prompt', { content }),
    resetHeartbeatPrompt: () =>
      this.del<{ success: boolean }>('assistant/heartbeat-prompt'),
    listModels: () =>
      this.get<{ models: OllamaModel[] }>('assistant/models'),
    getModelContext: (name: string) =>
      this.get<{ contextLength: number | null }>(`assistant/models/${encodeURIComponent(name)}/context`),
    getSettings: () =>
      this.get<AiSettings>('assistant/settings'),
    updateSettings: (settings: Partial<AiSettings>) =>
      this.patch<AiSettings>('assistant/settings', settings),

    // Streaming chat - returns the raw Response for SSE handling
    chatStreamUrl: () => `${this._baseUrl}/assistant/chat/stream`,

    // Tool call approval
    approveToolCall: (messageId: string) =>
      this.post<{ messageId: string; executed: boolean }>(`assistant/messages/${messageId}/approve`),
    rejectToolCall: (messageId: string) =>
      this.post<{ messageId: string; rejected: boolean }>(`assistant/messages/${messageId}/reject`),
    confirmCommand: (messageId: string) =>
      this.post<AiChatResponse>(`assistant/messages/${messageId}/confirm`),

    // Conversation export
    exportConversation: (conversationId: string, format: ExportFormat = 'markdown') =>
      this.client.get(`assistant/conversations/${conversationId}/export`, {
        searchParams: { format },
      }).then((r) => r.text()),

    // AI Insights
    getInsights: () =>
      this.get<InsightsResponse>('assistant/insights'),
    listPinnedInsights: () =>
      this.get<{ pins: PinnedAiInsight[] }>('assistant/insights/pins'),
    pinInsight: (insight: { title: string; body: string; severity: 'critical' | 'warning' | 'info' | 'success'; category: string; nodeId?: string; generatedAt?: string }) =>
      this.post<PinnedAiInsight>('assistant/insights/pins', insight),
    unpinInsight: (id: string) =>
      this.del<{ success: boolean }>(`assistant/insights/pins/${id}`),

    // Model profiles
    getModelProfiles: () =>
      this.get<ModelProfiles>('assistant/model-profiles'),
    updateModelProfiles: (profiles: ModelProfiles) =>
      this.patch<ModelProfiles>('assistant/model-profiles', Object.fromEntries(
        profiles.map((profile) => [profile.taskType, {
          provider: profile.provider,
          model: profile.model,
          fallbacks: profile.fallbacks,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
          maxToolRounds: profile.maxToolRounds,
          thinkingMode: profile.thinkingMode,
        }]),
      )),
  };

  selfUpdate = {
    status: () =>
      this.get<{
        controlApiVersion: string;
        agentVersion: string;
        repoRoot: string;
        gitBranch: string | null;
        gitCommit: string | null;
        lastChecked: string | null;
        isGitRepo: boolean;
      }>('self-update/status'),
    version: () =>
      this.get<{ controlApiVersion: string; agentVersion: string }>('self-update/version'),
    check: () =>
      this.post<{
        available: boolean;
        behindBy: number;
        currentCommit: string;
        remoteCommit: string;
        error?: string;
      }>('self-update/check'),
    apply: (restart?: boolean) =>
      this.post<{
        success: boolean;
        updated: boolean;
        previousVersion: string;
        currentVersion: string;
        gitOutput?: string;
        buildOutput?: string;
        error?: string;
        restart?: { scheduled: boolean; method: string } | null;
      }>('self-update/apply', { restart }),
    restart: () =>
      this.post<{ message: string; scheduled: boolean; method: string }>('self-update/restart'),
  };

  libraryDeploy = {
    deploy: (data: { fileId: string; nodeIds: string[]; overwrite?: boolean }) =>
      this.post<Array<{ nodeId: string; nodeName: string; status: string; error?: string }>>('library/deploy', data),
  };

  // ── Webhooks ──

  webhooks = {
    list: () =>
      this.get<{ endpoints: WebhookEndpoint[] }>('webhooks').then((r) => r.data!.endpoints),
    get: (id: string) =>
      this.get<{ endpoint: WebhookEndpoint }>(`webhooks/${id}`).then((r) => r.data!.endpoint),
    create: (data: WebhookCreateInput) =>
      this.post<{ endpoint: WebhookEndpoint }>('webhooks', data).then((r) => r.data!.endpoint),
    update: (id: string, data: WebhookUpdateInput) =>
      this.patch<{ endpoint: WebhookEndpoint }>(`webhooks/${id}`, data).then((r) => r.data!.endpoint),
    delete: (id: string) =>
      this.del<{ success: boolean }>(`webhooks/${id}`),
    deliveries: (id: string, page = 1, pageSize = 20) =>
      this.get<{ deliveries: WebhookDelivery[]; total: number }>(`webhooks/${id}/deliveries?page=${page}&pageSize=${pageSize}`).then((r) => r.data!),
    test: (id: string) =>
      this.post<{ success: boolean; error?: string }>(`webhooks/${id}/test`).then((r) => r.data!),
    redeliver: (endpointId: string, deliveryId: string) =>
      this.post<{ deliveryId: string }>(`webhooks/${endpointId}/deliveries/${deliveryId}/redeliver`).then((r) => r.data!),
  };
}

export const api = new DashboardApiClient();

// ── Webhook types ──

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  type: string;
  secretConfigured: boolean;
  events: string;
  headersConfigured: boolean;
  active: boolean;
  retries: number;
  timeoutMs: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { deliveries: number };
}

export interface WebhookCreateInput {
  name: string;
  url: string;
  type?: string;
  secret?: string;
  events?: string[];
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
}

export interface WebhookUpdateInput {
  name?: string;
  url?: string;
  type?: string;
  secret?: string | null;
  events?: string[];
  headers?: Record<string, string>;
  active?: boolean;
  retries?: number;
  timeoutMs?: number;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  event: string;
  payload: string;
  status: string;
  httpStatus: number | null;
  response: string | null;
  error: string | null;
  attempts: number;
  deliveredAt: string | null;
  createdAt: string;
}
