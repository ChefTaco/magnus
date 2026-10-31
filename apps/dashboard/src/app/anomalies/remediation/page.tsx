'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import type { RemediationRule, RemediationExecution } from '@/types/contracts';
import {
  ArrowLeft,
  ChevronDown,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
  Zap,
} from 'lucide-react';

const METRICS = ['*', 'cpu', 'memory', 'disk', 'swap'] as const;
const SEVERITIES = ['warning', 'critical'] as const;

const statusColors: Record<string, string> = {
  triggered: 'bg-primary/20 text-primary',
  running: 'bg-warning/20 text-warning',
  completed: 'bg-success/20 text-success',
  failed: 'bg-danger/20 text-danger',
  skipped: 'bg-text-muted/20 text-text-muted',
};

type RuleFormData = {
  name: string;
  description: string;
  metric: string;
  severityThreshold: string;
  agentDefinitionId: string;
  input: string;
  cooldownMinutes: number;
  maxConcurrentRuns: number;
  nodeFilter: string;
  enabled: boolean;
};

const emptyForm: RuleFormData = {
  name: '',
  description: '',
  metric: '*',
  severityThreshold: 'critical',
  agentDefinitionId: 'diagnostics.v1',
  input: '',
  cooldownMinutes: 60,
  maxConcurrentRuns: 1,
  nodeFilter: '',
  enabled: true,
};

export default function RemediationPage(): React.ReactElement {
  const [rules, setRules] = useState<RemediationRule[]>([]);
  const [executions, setExecutions] = useState<RemediationExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'rules' | 'executions'>('rules');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesResp, execResp] = await Promise.allSettled([
        api.remediation.listRules(),
        api.remediation.listExecutions({ pageSize: 50 }),
      ]);
      if (rulesResp.status === 'fulfilled') setRules(rulesResp.value.data ?? []);
      if (execResp.status === 'fulfilled') setExecutions(execResp.value.data?.executions ?? []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editingId) {
        await api.remediation.updateRule(editingId, {
          ...form,
          nodeFilter: form.nodeFilter || null,
        } as Partial<RemediationRule>);
      } else {
        await api.remediation.createRule({
          ...form,
          nodeFilter: form.nodeFilter || undefined,
        } as RemediationRule & { name: string; agentDefinitionId: string });
      }
      setShowCreate(false);
      setEditingId(null);
      setForm(emptyForm);
      await load();
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setActionError(null);
    try {
      const result = await api.remediation.deleteRule(id);
      if (!result.success) throw new Error('The control API did not confirm deletion.');

      setRules((current) => current.filter((rule) => rule.id !== id));
      setDeleteConfirmationId(null);
      setExpandedId((current) => current === id ? null : current);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to delete this remediation rule.');
    } finally {
      setDeletingId(null);
    }
  };

  const startEdit = (rule: RemediationRule) => {
    setForm({
      name: rule.name,
      description: rule.description,
      metric: rule.metric,
      severityThreshold: rule.severityThreshold,
      agentDefinitionId: rule.agentDefinitionId,
      input: rule.input,
      cooldownMinutes: rule.cooldownMinutes,
      maxConcurrentRuns: rule.maxConcurrentRuns,
      nodeFilter: rule.nodeFilter ?? '',
      enabled: rule.enabled,
    });
    setEditingId(rule.id);
    setShowCreate(true);
  };

  const toggleEnabled = async (rule: RemediationRule) => {
    await api.remediation.updateRule(rule.id, { enabled: !rule.enabled } as Partial<RemediationRule>);
    await load();
  };

  const filtered = rules.filter((r) =>
    !search || r.name.toLowerCase().includes(search.toLowerCase()) || r.description.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <PageTransition>
      <PageItem>
        <div className="flex items-center justify-between">
          <div>
            <Link href="/anomalies" className="mb-2 inline-flex items-center gap-1 text-xs uppercase tracking-wider text-text-muted hover:text-primary">
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to anomalies
            </Link>
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              <h1 className="text-2xl font-bold uppercase tracking-wider text-text">Auto-Remediation</h1>
            </div>
            <p className="mt-1 text-xs uppercase tracking-wider text-text-muted">
              Rules that record remediation decisions when anomalies are detected
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted hover:border-primary/40 hover:text-primary">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {tab === 'rules' && (
              <button
                onClick={() => { setShowCreate(true); setEditingId(null); setForm(emptyForm); }}
                className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-xs font-semibold uppercase tracking-wider text-white hover:bg-primary/80"
              >
                <Plus className="h-3.5 w-3.5" />
                New Rule
              </button>
            )}
          </div>
        </div>
      </PageItem>

      {/* Tabs */}
      <PageItem>
        <div className="flex gap-1 border-b border-border/50">
          <button
            onClick={() => setTab('rules')}
            className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${tab === 'rules' ? 'border-b-2 border-primary text-primary' : 'text-text-muted hover:text-text'}`}
          >
            Rules ({rules.length})
          </button>
          <button
            onClick={() => setTab('executions')}
            className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${tab === 'executions' ? 'border-b-2 border-primary text-primary' : 'text-text-muted hover:text-text'}`}
          >
            Executions ({executions.length})
          </button>
        </div>
      </PageItem>

      {/* Create/Edit form */}
      {showCreate && (
        <PageItem>
          <Card className="p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-text-muted">
                {editingId ? 'Edit Rule' : 'Create New Rule'}
              </h2>
              <button onClick={() => { setShowCreate(false); setEditingId(null); }} className="text-text-muted hover:text-text">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded border border-border/50 bg-surface px-3 py-2 text-sm text-text" placeholder="disk-cleanup-rule" />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Versioned runbook *</label>
                <select value={form.agentDefinitionId} onChange={(e) => setForm({ ...form, agentDefinitionId: e.target.value })} className="w-full rounded border border-border/50 bg-surface px-3 py-2 text-sm text-text" ><option value="diagnostics.v1">diagnostics.v1 — uptime</option><option value="restart-service.v1">restart-service.v1 — approved application restart</option></select>
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Metric</label>
                <select value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value })} className="w-full rounded border border-border/50 bg-surface px-3 py-2 text-sm text-text">
                  {METRICS.map((m) => <option key={m} value={m}>{m === '*' ? 'All Metrics' : m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Severity Threshold</label>
                <select value={form.severityThreshold} onChange={(e) => setForm({ ...form, severityThreshold: e.target.value })} className="w-full rounded border border-border/50 bg-surface px-3 py-2 text-sm text-text">
                  {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Cooldown (minutes)</label>
                <input type="number" min={1} max={10080} value={form.cooldownMinutes} onChange={(e) => setForm({ ...form, cooldownMinutes: Number(e.target.value) })} className="w-full rounded border border-border/50 bg-surface px-3 py-2 text-sm text-text" />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Max Concurrent Runs</label>
                <input type="number" min={1} max={10} value={form.maxConcurrentRuns} onChange={(e) => setForm({ ...form, maxConcurrentRuns: Number(e.target.value) })} className="w-full rounded border border-border/50 bg-surface px-3 py-2 text-sm text-text" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Description</label>
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full rounded border border-border/50 bg-surface px-3 py-2 text-sm text-text" placeholder="Preview a bounded diagnostic when a metric needs investigation" />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Node Filter</label>
                <input value={form.nodeFilter} onChange={(e) => setForm({ ...form, nodeFilter: e.target.value })} className="w-full rounded border border-border/50 bg-surface px-3 py-2 text-sm text-text" placeholder="Optional: node ID or name" />
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">
                  Runbook configuration (JSON) <span className="normal-case font-normal">(supports {'{{metric}}'}, {'{{value}}'}, {'{{nodeId}}'}, {'{{nodeName}}'}, {'{{zScore}}'}, {'{{severity}}'})</span>
                </label>
                <textarea value={form.input} onChange={(e) => setForm({ ...form, input: e.target.value })} rows={3} className="w-full rounded border border-border/50 bg-surface px-3 py-2 text-sm text-text font-mono" placeholder={'{"applicationId":"configured-application-id"}'} />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} id="rule-enabled" className="rounded border-border" />
                <label htmlFor="rule-enabled" className="text-xs uppercase tracking-wider text-text-muted">Enabled</label>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button onClick={() => void handleSave()} disabled={saving || !form.name || !form.agentDefinitionId} className="inline-flex items-center gap-2 rounded bg-primary px-4 py-2 text-xs font-semibold uppercase tracking-wider text-white hover:bg-primary/80 disabled:opacity-50">
                <Save className="h-3.5 w-3.5" />
                {saving ? 'Saving…' : editingId ? 'Update' : 'Create'}
              </button>
              <button onClick={() => { setShowCreate(false); setEditingId(null); }} className="rounded border border-border px-4 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted hover:text-text">
                Cancel
              </button>
            </div>
          </Card>
        </PageItem>
      )}

      {/* Rules Tab */}
      {tab === 'rules' && (
        <PageItem>
          <Card className="p-4">
            {/* Search */}
            <div className="mb-4 flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search rules" className="w-full rounded border border-border/50 bg-surface pl-9 pr-3 py-2 text-sm text-text" />
              </div>
            </div>

            {actionError && (
              <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                <span>{actionError}</span>
                <button onClick={() => setActionError(null)} className="font-semibold uppercase tracking-wider hover:text-danger">Dismiss</button>
              </div>
            )}

            {filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-text-muted">
                {rules.length === 0 ? 'No remediation rules defined. Create one to get started.' : 'No rules match your search.'}
              </p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border/50 text-left">
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Rule</th>
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Metric</th>
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Threshold</th>
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Cooldown</th>
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Runs</th>
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Status</th>
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {filtered.map((rule) => (
                    <Fragment key={rule.id}>
                      <tr
                        key={rule.id}
                        className="cursor-pointer hover:bg-surface-hover/50 transition-colors"
                        onClick={() => setExpandedId(expandedId === rule.id ? null : rule.id)}
                      >
                        <td className="py-3 pr-3">
                          <div className="flex items-center gap-2">
                            <ChevronDown className={`h-3.5 w-3.5 text-text-muted transition-transform ${expandedId === rule.id ? 'rotate-180' : ''}`} />
                            <div>
                              <p className="text-sm font-semibold text-text">{rule.name}</p>
                              {rule.description && <p className="text-xs text-text-muted">{rule.description}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="py-3 pr-3">
                          <span className="rounded bg-surface px-2 py-0.5 text-xs font-mono text-text-muted">{rule.metric === '*' ? 'all' : rule.metric}</span>
                        </td>
                        <td className="py-3 pr-3">
                          <span className={`rounded px-2 py-0.5 text-xs ${rule.severityThreshold === 'critical' ? 'bg-danger/20 text-danger' : 'bg-warning/20 text-warning'}`}>
                            {rule.severityThreshold}
                          </span>
                        </td>
                        <td className="py-3 pr-3 text-xs text-text-muted">{rule.cooldownMinutes}m</td>
                        <td className="py-3 pr-3 text-xs text-text-muted">{rule._count?.executions ?? 0}</td>
                        <td className="py-3 pr-3">
                          <button
                            onClick={(e) => { e.stopPropagation(); void toggleEnabled(rule); }}
                            className={`rounded px-2 py-0.5 text-xs font-semibold ${rule.enabled ? 'bg-success/20 text-success' : 'bg-text-muted/20 text-text-muted'}`}
                          >
                            {rule.enabled ? 'active' : 'disabled'}
                          </button>
                        </td>
                        <td className="py-3">
                          <div className="flex items-center gap-1">
                            <button onClick={(e) => { e.stopPropagation(); startEdit(rule); }} title="Edit" className="rounded p-1.5 text-text-muted hover:bg-surface hover:text-primary">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            {deleteConfirmationId === rule.id ? (
                              <>
                                <button
                                  onClick={(e) => { e.stopPropagation(); void handleDelete(rule.id); }}
                                  disabled={deletingId === rule.id}
                                  title="Confirm delete"
                                  className="rounded bg-danger/20 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-danger hover:bg-danger/30 disabled:opacity-50"
                                >
                                  {deletingId === rule.id ? 'Deleting…' : 'Delete'}
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setDeleteConfirmationId(null); }}
                                  title="Cancel delete"
                                  className="rounded p-1.5 text-text-muted hover:bg-surface hover:text-text"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); setActionError(null); setDeleteConfirmationId(rule.id); }}
                                title="Delete"
                                className="rounded p-1.5 text-text-muted hover:bg-surface hover:text-danger"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expandedId === rule.id && (
                        <tr>
                          <td colSpan={7} className="border-b border-border/30 bg-surface/30 px-6 py-4">
                            <div className="grid grid-cols-2 gap-4 text-xs lg:grid-cols-4">
                              <div>
                                <p className="text-text-muted uppercase tracking-wider">Versioned runbook</p>
                                <p className="mt-1 font-mono text-text">{rule.agentDefinitionId}</p>
                              </div>
                              <div>
                                <p className="text-text-muted uppercase tracking-wider">Max Concurrent</p>
                                <p className="mt-1 text-text">{rule.maxConcurrentRuns}</p>
                              </div>
                              <div>
                                <p className="text-text-muted uppercase tracking-wider">Node Filter</p>
                                <p className="mt-1 text-text font-mono">{rule.nodeFilter ?? 'none'}</p>
                              </div>
                              <div>
                                <p className="text-text-muted uppercase tracking-wider">Created</p>
                                <p className="mt-1 text-text">{new Date(rule.createdAt).toLocaleString()}</p>
                              </div>
                              {rule.input && (
                                <div className="col-span-2 lg:col-span-4">
                                  <p className="text-text-muted uppercase tracking-wider">Runbook configuration (JSON)</p>
                                  <pre className="mt-1 rounded border border-border/50 bg-bg/40 p-2 font-mono text-text text-[11px] whitespace-pre-wrap">{rule.input}</pre>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </PageItem>
      )}

      {/* Executions Tab */}
      {tab === 'executions' && (
        <PageItem>
          <Card className="p-4">
            {executions.length === 0 ? (
              <p className="py-8 text-center text-sm text-text-muted">No remediation executions yet.</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border/50 text-left">
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Rule</th>
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Node</th>
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Status</th>
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Legacy Run</th>
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Triggered</th>
                    <th className="pb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Input</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {executions.map((exec) => (
                    <tr key={exec.id} className="hover:bg-surface-hover/50">
                      <td className="py-3 pr-3 text-sm text-text">{exec.rule?.name ?? exec.ruleId}</td>
                      <td className="py-3 pr-3 text-xs font-mono text-text-muted">{exec.nodeId}</td>
                      <td className="py-3 pr-3">
                        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${statusColors[exec.status] ?? ''}`}>
                          {exec.status}
                        </span>
                      </td>
                      <td className="py-3 pr-3">
                        {exec.orchestraRunId ? (
                          <span className="text-xs font-mono text-text-muted">{exec.orchestraRunId.slice(0, 12)}…</span>
                        ) : (
                          <span className="text-xs text-text-muted">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-3 text-xs text-text-muted">{new Date(exec.triggeredAt).toLocaleString()}</td>
                      <td className="py-3 text-xs text-text-muted max-w-xs"><details><summary>Review plan and outcome</summary><pre className="whitespace-pre-wrap">{exec.input}</pre><pre className="whitespace-pre-wrap">{exec.output}</pre></details>{exec.status === 'pending_approval' && <button className="mt-2 rounded border border-primary p-2" onClick={() => { if (!window.confirm('Approve this displayed runbook plan?')) return; void fetch(`/api/proxy/remediation/executions/${encodeURIComponent(exec.id)}/approve`, { method: 'POST' }).then(async r => { if (!r.ok) throw new Error(`Approval failed: HTTP ${r.status}`); window.location.reload(); }).catch(e => setActionError(String(e))); }}>Approve displayed plan</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </PageItem>
      )}
    </PageTransition>
  );
}
