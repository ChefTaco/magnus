'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api-client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal, inputClass } from '@/components/ui/modal';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import { cn } from '@/lib/utils';
import {
  SlidersHorizontal,
  RefreshCw,
  Plus,
  Trash2,
  Pause,
  Play,
  Clock,
  Server,
  Loader2,
  Terminal,
  AlertTriangle,
} from 'lucide-react';
import type { Node, CronJobSpec, SkillBundle } from '@/types/contracts';

// Existing scheduled analysis jobs use this compatibility prefix.
const AI_JOB_PREFIX = '[AI]';

// ── Schedule presets ──
const SCHEDULE_PRESETS = [
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Every hour',       value: '0 * * * *' },
  { label: 'Every 6 hours',    value: '0 */6 * * *' },
  { label: 'Daily at midnight',value: '0 0 * * *' },
  { label: 'Custom…',          value: '__custom__' },
];

function describeSchedule(s: string): string {
  const found = SCHEDULE_PRESETS.find((p) => p.value === s);
  return found && found.value !== '__custom__' ? found.label : s;
}

// ── Add scheduled skill job modal ──

interface AddJobModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  nodes: Node[];
  skills: SkillBundle[];
}

function AddJobModal({ open, onClose, onCreated, nodes, skills }: AddJobModalProps): React.ReactElement | null {
  const [name, setName] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [skillName, setSkillName] = useState('');
  const [schedulePreset, setSchedulePreset] = useState(SCHEDULE_PRESETS[2]!.value); // hourly default
  const [customSchedule, setCustomSchedule] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schedule = schedulePreset === '__custom__' ? customSchedule : schedulePreset;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !nodeId || !skillName || !schedule.trim()) {
      setError('All fields are required.');
      return;
    }

    const selectedSkill = skills.find((s) => s.name === skillName);
    const entryPoint = selectedSkill?.entryPoint ?? 'run.sh';
    const command = `~/.magnus/skills/${skillName}/${entryPoint}`;

    setSaving(true);
    try {
      await api.cron.create({
        name: `${AI_JOB_PREFIX} ${name.trim()}`,
        description: `Scheduled analysis job: run ${skillName} skill`,
        nodeId,
        schedule: schedule.trim(),
        command,
        args: [],
        timeoutSeconds: 300,
      });
      onCreated();
      onClose();
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create cron job.');
    } finally {
      setSaving(false);
    }
  }

  function resetForm(): void {
    setName('');
    setNodeId('');
    setSkillName('');
    setSchedulePreset(SCHEDULE_PRESETS[2]!.value);
    setCustomSchedule('');
    setError(null);
  }

  return (
    <Modal open={open} title="New Scheduled Skill Job" onClose={() => { onClose(); resetForm(); }}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-muted">Job Name</label>
          <input
            className={inputClass}
            type="text"
            placeholder="e.g. Log Analyzer — Prod"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <p className="mt-1 text-[10px] text-text-muted">Will be prefixed with <code className="text-primary/80">{AI_JOB_PREFIX}</code></p>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-muted">Target Node</label>
          <select className={inputClass} value={nodeId} onChange={(e) => setNodeId(e.target.value)} required>
            <option value="">Select a node…</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.hostname}) — {n.status}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-muted">Skill</label>
          <select className={inputClass} value={skillName} onChange={(e) => setSkillName(e.target.value)} required>
            <option value="">Select a skill…</option>
            {skills.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} — {s.description}
              </option>
            ))}
          </select>
          {skillName && (
            <p className="mt-1 text-[10px] font-mono text-text-muted">
              Command: <span className="text-primary/80">~/.magnus/skills/{skillName}/{skills.find((s) => s.name === skillName)?.entryPoint ?? 'run.sh'}</span>
            </p>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-muted">Schedule</label>
          <select
            className={inputClass}
            value={schedulePreset}
            onChange={(e) => setSchedulePreset(e.target.value)}
          >
            {SCHEDULE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          {schedulePreset === '__custom__' && (
            <input
              className={cn(inputClass, 'mt-2 font-mono')}
              type="text"
              placeholder="Cron expression, e.g. 0 */4 * * *"
              value={customSchedule}
              onChange={(e) => setCustomSchedule(e.target.value)}
              required
            />
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => { onClose(); resetForm(); }}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
            Create Job
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Scheduled skill jobs section ──

function ScheduledSkillJobsSection(): React.ReactElement {
  const [jobs, setJobs] = useState<CronJobSpec[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [skills, setSkills] = useState<SkillBundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cronRes, nodesRes, skillsRes] = await Promise.allSettled([
        api.cron.list(),
        api.nodes.list(),
        api.skills.list(),
      ]);

      if (cronRes.status === 'fulfilled') {
        const allJobs = cronRes.value.data ?? [];
        setJobs(allJobs.filter((j) => j.name.startsWith(AI_JOB_PREFIX)));
      }
      if (nodesRes.status === 'fulfilled') setNodes(nodesRes.value.data ?? []);
      if (skillsRes.status === 'fulfilled') setSkills(skillsRes.value.data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(id: string): Promise<void> {
    setDeletingId(id);
    try {
      await api.cron.delete(id);
      setJobs((prev) => prev.filter((j) => j.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleToggle(job: CronJobSpec): Promise<void> {
    const newStatus = job.status === 'active' ? 'paused' : 'active';
    setTogglingId(job.id);
    try {
      await api.cron.update(job.id, { status: newStatus });
      setJobs((prev) => prev.map((j) => j.id === job.id ? { ...j, status: newStatus } : j));
    } finally {
      setTogglingId(null);
    }
  }

  function getNodeName(nodeId: string): string {
    return nodes.find((n) => n.id === nodeId)?.name ?? nodeId;
  }

  const displayName = (job: CronJobSpec): string => job.name.replace(/^\[AI\]\s*/, '');

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-text">Skill Cron Jobs</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Deterministic cron jobs that run node skills and record results in Magnus command history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
          <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Job
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-text-muted py-6">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded border border-dashed border-border py-8 text-center">
          <Terminal className="h-8 w-8 mx-auto mb-3 text-text-muted/40" />
          <p className="text-sm text-text-muted">No scheduled skill jobs yet.</p>
          <p className="text-xs text-text-muted/60 mt-1">Click &ldquo;Add Job&rdquo; to create a skill-based analysis cron job.</p>
        </div>
      ) : (
        <div className="space-y-2 mt-3">
          {jobs.map((job) => (
            <div
              key={job.id}
              className={cn(
                'flex items-start gap-3 rounded border border-border px-3 py-2.5 transition-colors',
                job.status === 'paused' && 'opacity-60',
              )}
            >
              {/* Status dot */}
              <div className="mt-1 shrink-0">
                {job.status === 'active' ? (
                  <span className="block h-2 w-2 rounded-full bg-success" />
                ) : job.status === 'error' ? (
                  <span className="block h-2 w-2 rounded-full bg-danger" />
                ) : (
                  <span className="block h-2 w-2 rounded-full bg-text-muted/40" />
                )}
              </div>

              {/* Details */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-text">{displayName(job)}</span>
                  <Badge variant="default" className="text-[10px]">{job.status}</Badge>
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <span className="flex items-center gap-1 text-[11px] text-text-muted">
                    <Clock className="h-3 w-3" />
                    {describeSchedule(job.schedule)}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-text-muted">
                    <Server className="h-3 w-3" />
                    {getNodeName(job.nodeId)}
                  </span>
                  {job.lastRunAt && (
                    <span className="text-[11px] text-text-muted/70">
                      Last run: {new Date(job.lastRunAt).toLocaleString()}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[10px] font-mono text-text-muted/60 truncate">{job.command}</p>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggle(job)}
                  disabled={togglingId === job.id || job.status === 'error'}
                  title={job.status === 'active' ? 'Pause' : 'Resume'}
                  className="h-7 w-7 p-0"
                >
                  {togglingId === job.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : job.status === 'active' ? (
                    <Pause className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(job.id)}
                  disabled={deletingId === job.id}
                  title="Delete"
                  className="h-7 w-7 p-0 text-danger/70 hover:text-danger"
                >
                  {deletingId === job.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <AddJobModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={load}
        nodes={nodes}
        skills={skills}
      />
    </Card>
  );
}

// ── Page ──

export default function OperationsPage(): React.ReactElement {
  return (
    <PageTransition>
      <PageItem>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded border border-primary/30 bg-primary/10">
            <SlidersHorizontal className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold uppercase tracking-widest text-text">Operations</h1>
            <p className="text-xs text-text-muted">Configure scheduled skill analysis jobs</p>
          </div>
        </div>
      </PageItem>

      <PageItem>
        <ScheduledSkillJobsSection />
      </PageItem>
    </PageTransition>
  );
}
