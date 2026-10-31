'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api-client';
import { useControlNode } from '@/lib/control-node-context';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, statusVariant } from '@/components/ui/badge';
import { NodeSelector } from '@/components/ui/node-selector';
import { RoleModal } from '@/components/roles/role-modal';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import {
  ShieldCheck,
  Plus,
  Pencil,
  Trash2,
  Play,
  UserMinus,
  Server,
  Package,
  FileText,
  Container,
  Shield,
  Loader2,
  RefreshCw,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  SkipForward,
} from 'lucide-react';

// ─── Types ───

export interface RoleData {
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
  firewallMode: string;
  firewallAllowRules: string[];
  status: string;
  nodes?: Array<{ id: string; name: string; hostname: string; status: string }>;
  _count?: { nodes: number };
  createdAt: string;
  updatedAt: string;
}

interface ApplicationData {
  id: string;
  nodeId: string;
  roleId: string;
  action: string;
  status: string;
  steps: Array<{ name: string; status: string; error?: string; startedAt?: string; completedAt?: string }>;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  role?: { name: string };
  node?: { name: string };
}

// ─── Page ───

interface RolesPageClientProps {
  initialRoles: RoleData[];
}

export default function RolesPageClient({ initialRoles }: RolesPageClientProps): React.ReactElement {
  const { activeNode } = useControlNode();
  const [roles, setRoles] = useState<RoleData[]>(initialRoles);
  const [selectedRole, setSelectedRole] = useState<RoleData | null>(null);
  const [applications, setApplications] = useState<ApplicationData[]>([]);
  const [loading, setLoading] = useState(!initialRoles.length);
  const [isFirstLoad, setIsFirstLoad] = useState(initialRoles.length > 0);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editRole, setEditRole] = useState<RoleData | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignNodeIds, setAssignNodeIds] = useState<string[]>([]);
  const [assignDefer, setAssignDefer] = useState(false);
  const [assigning, setAssigning] = useState(false);

  // ── Fetch ──

  const fetchRoles = useCallback(async () => {
    try {
      const res = await api.roles.list();
      setRoles((res.data ?? []) as RoleData[]);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRoleDetail = useCallback(async (id: string) => {
    try {
      const [roleRes, appsRes] = await Promise.all([
        api.roles.get(id),
        api.roles.applications.list({ roleId: id }),
      ]);
      const detail = roleRes.data as RoleData;
      setSelectedRole(detail);
      setApplications((appsRes.data ?? []) as ApplicationData[]);
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    if (isFirstLoad) {
      setIsFirstLoad(false);
      return;
    }
    void fetchRoles();
  }, [fetchRoles, activeNode.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh selected role detail
  useEffect(() => {
    if (!selectedRole) return;
    const interval = setInterval(() => {
      void fetchRoleDetail(selectedRole.id);
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedRole, fetchRoleDetail]);

  // ── Actions ──

  const openCreate = (): void => {
    setModalMode('create');
    setEditRole(null);
    setModalOpen(true);
  };

  const openEdit = (role: RoleData): void => {
    setModalMode('edit');
    setEditRole(role);
    setModalOpen(true);
  };

  const deleteRole = async (role: RoleData): Promise<void> => {
    if (!confirm(`Delete role "${role.name}"? This will unassign all nodes.`)) return;
    try {
      await api.roles.delete(role.id);
      if (selectedRole?.id === role.id) setSelectedRole(null);
      await fetchRoles();
    } catch {
      // silently fail
    }
  };

  const handleSaved = async (): Promise<void> => {
    await fetchRoles();
    if (selectedRole) await fetchRoleDetail(selectedRole.id);
  };

  const handleAssign = async (): Promise<void> => {
    if (!selectedRole || assignNodeIds.length === 0) return;
    setAssigning(true);
    try {
      await api.roles.assign(selectedRole.id, { nodeIds: assignNodeIds, defer: assignDefer });
      setAssignOpen(false);
      setAssignNodeIds([]);
      await fetchRoleDetail(selectedRole.id);
      await fetchRoles();
    } catch {
      // silently fail
    } finally {
      setAssigning(false);
    }
  };

  const handleUnassign = async (nodeId: string): Promise<void> => {
    if (!selectedRole) return;
    if (!confirm('Unassign this node? This will remove the role configuration.')) return;
    try {
      await api.roles.unassign(selectedRole.id, { nodeIds: [nodeId] });
      await fetchRoleDetail(selectedRole.id);
      await fetchRoles();
    } catch {
      // silently fail
    }
  };

  const handleReapply = async (): Promise<void> => {
    if (!selectedRole) return;
    try {
      await api.roles.apply(selectedRole.id);
      await fetchRoleDetail(selectedRole.id);
    } catch {
      // silently fail
    }
  };

  const selectRole = (role: RoleData): void => {
    setSelectedRole(role);
    void fetchRoleDetail(role.id);
  };

  // ── Render helpers ──

  const stepIcon = (status: string): React.ReactElement => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
      case 'failed': return <XCircle className="h-3.5 w-3.5 text-danger" />;
      case 'running': return <Loader2 className="h-3.5 w-3.5 text-primary animate-spin" />;
      case 'skipped': return <SkipForward className="h-3.5 w-3.5 text-text-muted" />;
      default: return <Clock className="h-3.5 w-3.5 text-text-muted" />;
    }
  };

  const featureBadges = (role: RoleData): React.ReactElement => (
    <div className="flex flex-wrap gap-1">
      {role.aptPackages.length > 0 && (
        <span className="inline-flex items-center rounded bg-success/10 px-1.5 py-0.5 text-[10px] text-success">
          {role.aptPackages.length} apt
        </span>
      )}
      {role.npmPackages.length > 0 && (
        <span className="inline-flex items-center rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
          {role.npmPackages.length} npm
        </span>
      )}
      {role.libraryFileIds.length > 0 && (
        <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
          {role.libraryFileIds.length} library
        </span>
      )}
      {role.dockerEnabled && (
        <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">Docker</span>
      )}
      {role.firewallEnabled && (
        <span className="inline-flex items-center rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">UFW</span>
      )}
    </div>
  );

  // ── Layout ──

  return (
    <PageTransition className="space-y-6">
      {/* Header */}
      <PageItem>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold uppercase tracking-wider">Roles</h1>
          <p className="mt-1 text-[11px] text-text-muted uppercase tracking-wider">
            Define reusable node configurations with packages, files, Docker sandboxing, and firewall rules
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void fetchRoles()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
            Refresh
          </Button>
          <Button size="sm" onClick={openCreate} icon={<Plus className="h-3.5 w-3.5" />}>
            New Role
          </Button>
        </div>
      </div>
      </PageItem>

      <PageItem>
      <div className="grid grid-cols-12 gap-6">
        {/* ── Left: Role List ── */}
        <div className="col-span-4">
          <Card>
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
              </div>
            ) : roles.length === 0 ? (
              <div className="text-center py-8">
                <ShieldCheck className="mx-auto h-10 w-10 text-text-muted mb-2" />
                <p className="text-[11px] text-text-muted">No roles yet</p>
                <Button size="sm" className="mt-3" onClick={openCreate} icon={<Plus className="h-3.5 w-3.5" />}>
                  Create First Role
                </Button>
              </div>
            ) : (
              <div className="space-y-1">
                {roles.map((role) => (
                  <button
                    key={role.id}
                    onClick={() => selectRole(role)}
                    className={`w-full text-left rounded px-3 py-3 transition-all ${
                      selectedRole?.id === role.id
                        ? 'bg-primary/10 border border-primary/50'
                        : 'hover:bg-surface-hover hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)] border border-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-bold">{role.name}</span>
                      <div className="flex items-center gap-1.5">
                        <Badge variant={role.status === 'active' ? 'success' : 'warning'}>
                          {role.status}
                        </Badge>
                        <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
                      </div>
                    </div>
                    {role.description && (
                      <p className="text-xs text-text-muted truncate mb-1.5">{role.description}</p>
                    )}
                    <div className="flex items-center justify-between">
                      {featureBadges(role)}
                      <span className="text-xs text-text-muted flex items-center gap-1">
                        <Server className="h-3 w-3" />
                        {role._count?.nodes ?? 0}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* ── Right: Role Detail ── */}
        <div className="col-span-8">
          {!selectedRole ? (
            <Card>
              <div className="text-center py-16">
                <ShieldCheck className="mx-auto h-12 w-12 text-text-muted mb-3" />
                <p className="text-[11px] text-text-muted">Select a role to view details</p>
              </div>
            </Card>
          ) : (
            <div className="space-y-4">
              {/* Role header */}
              <Card>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-bold">{selectedRole.name}</h2>
                      <Badge variant={selectedRole.status === 'active' ? 'success' : 'warning'}>
                        {selectedRole.status}
                      </Badge>
                    </div>
                    {selectedRole.description && (
                      <p className="text-[11px] text-text-muted mt-1">{selectedRole.description}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => openEdit(selectedRole)} icon={<Pencil className="h-3.5 w-3.5" />}>
                      Edit
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => void deleteRole(selectedRole)} icon={<Trash2 className="h-3.5 w-3.5" />}>
                      Delete
                    </Button>
                  </div>
                </div>

                {/* Configuration summary */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Packages */}
                  <div className="rounded border border-border bg-bg p-3 hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)] transition-all">
                    <div className="flex items-center gap-2 mb-2">
                      <Package className="h-4 w-4 text-success" />
                      <span className="text-[11px] font-bold uppercase tracking-wider">Packages</span>
                    </div>
                    <p className="text-xs text-text-muted">
                      {selectedRole.aptPackages.length > 0
                        ? `apt: ${selectedRole.aptPackages.join(', ')}`
                        : 'No apt packages'}
                    </p>
                    <p className="text-xs text-text-muted mt-0.5">
                      {selectedRole.npmPackages.length > 0
                        ? `npm: ${selectedRole.npmPackages.join(', ')}`
                        : 'No npm packages'}
                    </p>
                    {Object.keys(selectedRole.envConfig).length > 0 && (
                      <p className="text-xs text-text-muted mt-1">
                        {Object.keys(selectedRole.envConfig).length} env var(s): {Object.keys(selectedRole.envConfig).join(', ')}
                      </p>
                    )}
                  </div>

                  {/* Skills & Jobs */}
                  <div className="rounded border border-border bg-bg p-3 hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)] transition-all">
                    <div className="flex items-center gap-2 mb-2">
                      <FileText className="h-4 w-4 text-primary" />
                      <span className="text-[11px] font-bold uppercase tracking-wider">Skills & Jobs</span>
                    </div>
                    <p className="text-xs text-text-muted">
                      {selectedRole.libraryFileIds.length} library item(s) assigned
                    </p>
                  </div>

                  {/* Docker + Firewall */}
                  <div className="rounded border border-border bg-bg p-3 hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)] transition-all">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="flex gap-1.5">
                        <Container className="h-4 w-4 text-primary" />
                        <Shield className="h-4 w-4 text-warning" />
                      </div>
                      <span className="text-[11px] font-bold uppercase tracking-wider">Sandbox & Firewall</span>
                    </div>
                    <p className="text-xs text-text-muted">
                      Docker: {selectedRole.dockerEnabled ? `Enabled${selectedRole.dockerNonRoot ? ' (non-root)' : ''}` : 'Disabled'}
                    </p>
                    <p className="text-xs text-text-muted mt-0.5">
                      Firewall: {selectedRole.firewallEnabled ? `${selectedRole.firewallMode} mode` : 'Disabled'}
                    </p>
                  </div>
                </div>
              </Card>

              {/* Assigned Nodes */}
              <Card
                title="Assigned Nodes"
                action={
                  <div className="flex gap-2">
                    {(selectedRole.nodes?.length ?? 0) > 0 && (
                      <Button variant="secondary" size="sm" onClick={() => void handleReapply()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
                        Re-apply All
                      </Button>
                    )}
                    <Button size="sm" onClick={() => setAssignOpen(true)} icon={<Plus className="h-3.5 w-3.5" />}>
                      Assign Nodes
                    </Button>
                  </div>
                }
              >
                {!selectedRole.nodes || selectedRole.nodes.length === 0 ? (
                  <div className="text-center py-6">
                    <Server className="mx-auto h-8 w-8 text-text-muted mb-2" />
                    <p className="text-xs text-text-muted">No nodes assigned to this role</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {selectedRole.nodes.map((node) => (
                      <div
                        key={node.id}
                        className="flex items-center justify-between rounded border border-border bg-bg px-3 py-2 hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)] transition-all"
                      >
                        <div className="flex items-center gap-3">
                          <Server className="h-4 w-4 text-text-muted" />
                          <div>
                            <p className="text-[11px] font-bold">{node.name}</p>
                            <p className="text-xs text-text-muted">{node.hostname}</p>
                          </div>
                          <Badge variant={statusVariant(node.status)}>{node.status}</Badge>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleUnassign(node.id)}
                          icon={<UserMinus className="h-3.5 w-3.5" />}
                        >
                          Unassign
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Assign modal overlay */}
                {assignOpen && (
                  <div className="mt-4 rounded border border-primary/30 bg-primary/5 p-4">
                    <h4 className="text-[11px] font-bold uppercase tracking-wider mb-3">Assign Nodes to "{selectedRole.name}"</h4>
                    <NodeSelector
                      value={assignNodeIds}
                      onChange={(v) => setAssignNodeIds(v as string[])}
                      multi
                      showAll
                      label="Select nodes"
                    />
                    <label className="flex items-center gap-2 mt-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={assignDefer}
                        onChange={(e) => setAssignDefer(e.target.checked)}
                        className="accent-primary"
                      />
                      <span className="text-xs text-text-muted">Defer application (assign only, don&apos;t apply yet)</span>
                    </label>
                    <div className="flex justify-end gap-2 mt-3">
                      <Button variant="secondary" size="sm" onClick={() => { setAssignOpen(false); setAssignNodeIds([]); }}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void handleAssign()}
                        disabled={assigning || assignNodeIds.length === 0}
                        icon={assigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      >
                        {assigning ? 'Assigning…' : `Assign ${assignNodeIds.length} Node(s)`}
                      </Button>
                    </div>
                  </div>
                )}
              </Card>

              {/* Application History */}
              <Card title="Application History" description="Recent role apply/remove operations">
                {applications.length === 0 ? (
                  <p className="text-xs text-text-muted py-4 text-center">No applications yet</p>
                ) : (
                  <div className="space-y-3">
                    {applications.slice(0, 10).map((app) => (
                      <div key={app.id} className="rounded border border-border bg-bg p-3 hover:border-primary/30 transition-all">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={
                                app.action === 'apply'
                                  ? 'info'
                                  : 'warning'
                              }
                            >
                              {app.action}
                            </Badge>
                            <span className="text-xs text-text-muted">
                              {app.node?.name ?? app.nodeId}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant={statusVariant(app.status)}>{app.status}</Badge>
                            <span className="text-xs text-text-muted">
                              {new Date(app.createdAt).toLocaleString()}
                            </span>
                          </div>
                        </div>

                        {/* Steps */}
                        {app.steps.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {app.steps.map((step, i) => (
                              <div
                                key={i}
                                className="flex items-center gap-1.5 rounded bg-surface px-2 py-1"
                                title={step.error ?? step.name}
                              >
                                {stepIcon(step.status)}
                                <span className="text-[11px] text-text-muted">{step.name}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {app.error && (
                          <div className="mt-2 flex items-start gap-1.5 text-xs text-danger">
                            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                            <span className="truncate">{app.error}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>
      </div>
      </PageItem>

      {/* Create/Edit Modal */}
      <RoleModal
        open={modalOpen}
        mode={modalMode}
        role={editRole}
        onClose={() => setModalOpen(false)}
        onSaved={() => void handleSaved()}
      />
    </PageTransition>
  );
}
