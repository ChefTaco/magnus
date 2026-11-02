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
  nodeVersion?: string | null;
  observedAt?: string;
}

export interface UpgradeCandidate {
  nodeId: string;
  name: string;
  version: string;
  eligible: boolean;
  reason: string | null;
  upgrade: AgentUpgradeReport | null;
  layout: AgentSelfUpgrade['layout'] | null;
}

export type NodeRunState = 'pending' | 'requested' | 'confirmed' | 'reverted' | 'failed' | 'refused' | 'skipped';

export interface AgentUpgradeRunNode {
  nodeId: string;
  name: string;
  from: string;
  state: NodeRunState;
  detail: string | null;
  code?: string | null;
  awaitingReport?: boolean;
}

export interface AgentUpgradeRun {
  id: string;
  version: string;
  status: 'running' | 'succeeded' | 'failed' | 'stopped' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  concurrency: number;
  message: string | null;
  summary?: string | null;
  canaryNodeId?: string | null;
  stopRequestedBy?: string | null;
  retryOf?: string | null;
  excluded?: Array<{ nodeId: string; name: string; reason: string }>;
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
