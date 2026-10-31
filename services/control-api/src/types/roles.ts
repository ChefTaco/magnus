// ─── Roles: reusable node configuration bundles ───

export type RoleStatus = 'active' | 'draft';
export type FirewallMode = 'restrictive' | 'permissive' | 'custom';
export type RoleApplicationAction = 'apply' | 'remove';
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
  createdAt: Date;
  updatedAt: Date;
}

export interface RoleWithNodes extends Role {
  nodes: Array<{ id: string; name: string; hostname: string; status: string }>;
  _count?: { nodes: number };
}

export interface RoleCreateRequest {
  name: string;
  description?: string;
  libraryFileIds?: string[];
  skillNames?: string[];
  aptPackages?: string[];
  npmPackages?: string[];
  envConfig?: Record<string, string>;
  dockerEnabled?: boolean;
  dockerNonRoot?: boolean;
  dockerImage?: string | null;
  dockerVolumes?: string[];
  firewallEnabled?: boolean;
  firewallMode?: FirewallMode;
  firewallAllowRules?: string[];
  status?: RoleStatus;
}

export interface RoleUpdateRequest {
  name?: string;
  description?: string;
  libraryFileIds?: string[];
  skillNames?: string[];
  aptPackages?: string[];
  npmPackages?: string[];
  envConfig?: Record<string, string>;
  dockerEnabled?: boolean;
  dockerNonRoot?: boolean;
  dockerImage?: string | null;
  dockerVolumes?: string[];
  firewallEnabled?: boolean;
  firewallMode?: FirewallMode;
  firewallAllowRules?: string[];
  status?: RoleStatus;
}

export interface RoleAssignRequest {
  nodeIds: string[];
  defer?: boolean;
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
  action: RoleApplicationAction;
  status: RoleApplicationStatus;
  steps: RoleApplicationStep[];
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}
