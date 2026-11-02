/** Wire shapes of /api/v1/system/updates and /api/v1/agents/upgrade. */
export interface ServerUpdateCheck {
  enabled: boolean;
  checkedAt: string | null;
  error: string | null;
  current: string;
  latest: string | null;
  latestMajor: string | null;
  updateAvailable: boolean;
  breaking: boolean;
  releases: Array<{ version: string; summary: string; notesUrl: string | null; breaking: boolean }>;
  newRequiredEnv: Array<{ name: string; component: string; secret: boolean; description: string; missingOnServer: boolean }>;
  attention: Array<{ name: string; impact: string; note: string; version: string }>;
  command: string;
}

export interface AgentSkewNode { nodeId: string; name: string; version: string }

export interface SystemUpdates {
  version: string;
  server: ServerUpdateCheck;
  agents: {
    expected: string;
    current: number;
    behind: AgentSkewNode[];
    ahead: AgentSkewNode[];
    unknown: AgentSkewNode[];
    upgradesEnabled: boolean;
    fixCommand: string | null;
  };
}

export interface AgentUpgradeReport {
  /** Known states; newer agents may report others. */
  state: 'idle' | 'staged' | 'trial' | 'confirmed' | 'reverted' | 'failed' | (string & {});
  from?: string | null;
  to?: string | null;
  requestId?: string | null;
  reason?: string | null;
  attempt?: number;
  updatedAt?: string;
}

export interface AgentSelfUpgrade {
  protocol: number;
  launcherProtocol: number | null;
  layout: 'versioned' | 'legacy' | 'container';
  enabled: boolean;
  reason?: string | null;
  upgrade?: AgentUpgradeReport | null;
  confirmSeconds?: number;
  managedEnrollment?: { nodeId: string; nodeFqdn: string } | null;
  fenceHighWater?: Record<string, string>;
  nodeVersion?: string | null;
  observedAt?: string;
}

export interface PreflightProblem {
  code: string;
  detail: string;
  blocking: boolean;
}

export interface NodePreflight {
  status: 'ok' | 'warning' | 'blocked' | 'unavailable' | 'unreachable';
  checkedAt: string;
  problems: PreflightProblem[];
  detail?: string;
  healed?: string[];
}

export interface UpgradeCandidate {
  nodeId: string;
  name: string;
  version: string;
  eligible: boolean;
  reason: string | null;
  code?: string | null;
  upgrade: AgentUpgradeReport | null;
  layout: AgentSelfUpgrade['layout'] | null;
  preflight?: NodePreflight | null;
}

/** POST /agents/upgrade with dryRun: the per-node report, nothing started. */
export interface AgentUpgradeCheck {
  dryRun: true;
  version: string;
  release: { verified: boolean; integrity: string | null; reason: string | null };
  eligible: number;
  blocked: number;
  nodes: Array<UpgradeCandidate & { cause: string | null; remedy: string | null }>;
}

export interface ReadinessProblem {
  code: string;
  detail: string;
  cause: string;
  remedy: string;
}

export interface UpgradeReadiness {
  status: 'ok' | 'not-ready' | 'unknown';
  problems: ReadinessProblem[];
  observedAt: string | null;
}

export type NodeRunState = 'pending' | 'requested' | 'watching' | 'ambiguous' | 'confirmed' | 'reverted' | 'failed' | 'refused' | 'skipped';

export interface RunAttention {
  nodeId: string;
  name: string;
  state: NodeRunState | 'excluded';
  code: string;
  failureClass: 'release' | 'node';
  detail: string | null;
  cause: string;
  remedy: string;
}

export interface AgentUpgradeRunNode {
  nodeId: string;
  name: string;
  from: string;
  state: NodeRunState;
  detail: string | null;
  code?: string | null;
  awaitingReport?: boolean;
  failureClass?: 'release' | 'node' | null;
  attempts?: number;
}

export interface AgentUpgradeRun {
  id: string;
  version: string;
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'stopped' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  concurrency: number;
  message: string | null;
  summary?: string | null;
  canaryNodeId?: string | null;
  stopRequestedBy?: string | null;
  retryOf?: string | null;
  excluded?: Array<{ nodeId: string; name: string; reason: string; code?: string | null }>;
  maxFailures?: number;
  attention?: RunAttention[];
  nodes: AgentUpgradeRunNode[];
}

export interface AgentUpgradeEligibility {
  version: string;
  serverVersion: string;
  upgradesEnabled: boolean;
  disabledReason: string | null;
  prerelease?: boolean;
  release?: { verified: boolean; integrity: string | null; reason: string | null };
  nodes: UpgradeCandidate[];
  latestRun: AgentUpgradeRun | null;
}
