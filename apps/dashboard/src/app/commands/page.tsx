'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge, statusVariant } from '@/components/ui/badge';
import { NodeSelector } from '@/components/ui/node-selector';
import { api } from '@/lib/api-client';
import {
  Play,
  Loader2,
  RefreshCw,
  ArrowUpCircle,
  Trash2,
  RotateCcw,
  HardDrive,
  MemoryStick,
  Activity,
  Clock,
  FileText,
  ShieldCheck,
} from 'lucide-react';
import { PageTransition, PageItem } from '@/components/ui/page-transition';

// ─── Quick-action presets for common Ubuntu admin tasks ───

interface QuickAction {
  label: string;
  command: string;
  icon: React.ReactNode;
  variant?: 'default' | 'warning' | 'danger';
  description: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    label: 'Update & Upgrade',
    command: 'sudo apt update && sudo apt upgrade -y',
    icon: <RefreshCw className="h-3.5 w-3.5" />,
    description: 'Update package lists and upgrade all packages',
  },
  {
    label: 'Dist-Upgrade',
    command: 'sudo apt update && sudo apt dist-upgrade -y',
    icon: <ArrowUpCircle className="h-3.5 w-3.5" />,
    variant: 'warning',
    description: 'Full distribution upgrade with dependency resolution',
  },
  {
    label: 'Autoremove',
    command: 'sudo apt autoremove -y && sudo apt autoclean',
    icon: <Trash2 className="h-3.5 w-3.5" />,
    description: 'Remove unused packages and clean package cache',
  },
  {
    label: 'Security Updates',
    command: 'sudo apt update && sudo apt list --upgradable 2>/dev/null | grep -i security',
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
    description: 'Check for pending security updates',
  },
  {
    label: 'Disk Usage',
    command: 'df -h',
    icon: <HardDrive className="h-3.5 w-3.5" />,
    description: 'Show disk space usage on all mounted filesystems',
  },
  {
    label: 'Memory & Top',
    command: 'free -h && echo "---" && top -bn1 | head -20',
    icon: <MemoryStick className="h-3.5 w-3.5" />,
    description: 'Show memory usage and top processes',
  },
  {
    label: 'Running Services',
    command: 'systemctl list-units --type=service --state=running --no-pager',
    icon: <Activity className="h-3.5 w-3.5" />,
    description: 'List all currently running systemd services',
  },
  {
    label: 'Uptime & Load',
    command: 'uptime && cat /proc/loadavg',
    icon: <Clock className="h-3.5 w-3.5" />,
    description: 'Show system uptime and CPU load averages',
  },
  {
    label: 'Tail Syslog',
    command: 'sudo tail -100 /var/log/syslog',
    icon: <FileText className="h-3.5 w-3.5" />,
    description: 'Show the last 100 lines of the system log',
  },
  {
    label: 'Reboot',
    command: 'sudo reboot',
    icon: <RotateCcw className="h-3.5 w-3.5" />,
    variant: 'danger',
    description: 'Immediately reboot the node',
  },
];

// ─── Page ───

export default function CommandsPage(): React.ReactElement {
  const [command, setCommand] = useState('');
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [results, setResults] = useState<Array<{ id: string; nodeId: string; status: string }>>([]);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [preview, setPreview] = useState<Array<{ id: string; name: string; status: string; stale: boolean; allowed: boolean }> | null>(null);

  const dispatch = async (): Promise<void> => {
    if (!command.trim() || selectedNodeIds.length === 0) return;
    setRunning(true);
    setOutput(null);

    try {
      const idempotencyKey = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const res = await api.commands.dispatch(
        { nodeIds: selectedNodeIds, command, args: [], timeoutSeconds: 300, idempotencyKey },
        idempotencyKey,
      );

      const data = res.data as { commands: Array<{ id: string; nodeId: string; status: string }> };
      setResults(data.commands);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Dispatch failed';
      setOutput(message);
    } finally {
      setRunning(false);
    }
  };

  const dryRun = async (): Promise<void> => {
    if (!command.trim() || selectedNodeIds.length === 0) return;
    setRunning(true);
    setPreview(null);
    setOutput(null);
    try {
      const idempotencyKey = `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await api.commands.dispatch(
        { nodeIds: selectedNodeIds, command, args: [], timeoutSeconds: 300, idempotencyKey, dryRun: true },
        idempotencyKey,
      );
      const data = res.data as unknown as { targets: Array<{ id: string; name: string; status: string; stale: boolean; allowed: boolean }> };
      setPreview(data.targets);
    } catch (err: unknown) {
      setOutput(err instanceof Error ? err.message : 'Dry run failed');
    } finally {
      setRunning(false);
    }
  };

  const fetchResult = async (commandId: string): Promise<void> => {
    try {
      const res = await api.commands.result(commandId);
      const data = res.data as { stdout: string; stderr: string; exitCode: number };
      setOutput(`Exit: ${data.exitCode}\n\n--- stdout ---\n${data.stdout}\n--- stderr ---\n${data.stderr}`);
    } catch {
      setOutput('Result not yet available');
    }
  };

  return (
    <PageTransition className="space-y-6">
      <PageItem>
      <div>
        <h1 className="text-lg font-bold uppercase tracking-wider">Command Dispatch</h1>
        <p className="mt-1 text-[11px] text-text-muted uppercase tracking-wider">
          Execute bash commands across your Magnus nodes
        </p>
      </div>
      </PageItem>

      {/* Quick Actions */}
      <PageItem>
      <Card title="Quick Actions" description="Common Ubuntu administration tasks — click to pre-fill the command">
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((qa) => (
            <button
              key={qa.label}
              onClick={() => setCommand(qa.command)}
              title={qa.description}
              className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all ${
                qa.variant === 'danger'
                  ? 'border-danger/40 bg-danger/5 text-danger hover:bg-danger/10 hover:shadow-[0_0_8px_rgba(255,23,68,0.2)]'
                  : qa.variant === 'warning'
                    ? 'border-warning/40 bg-warning/5 text-warning hover:bg-warning/10 hover:shadow-[0_0_8px_rgba(255,179,0,0.2)]'
                    : 'border-border bg-bg text-text-muted hover:border-primary/40 hover:text-primary hover:shadow-[0_0_8px_var(--color-glow)]'
              } ${command === qa.command ? 'ring-1 ring-primary shadow-[0_0_12px_var(--color-glow)]' : ''}`}
            >
              {qa.icon}
              {qa.label}
            </button>
          ))}
        </div>
      </Card>
      </PageItem>

      {/* Dispatch Form */}
      <PageItem>
      <Card title="Dispatch Command">
        <div className="space-y-4">
          <NodeSelector
            value={selectedNodeIds}
            onChange={(v) => setSelectedNodeIds(Array.isArray(v) ? v : [v])}
            multi
            showAll
            label="Target Nodes"
          />

          <div>
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-text-muted">Command</label>
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="ls -la /opt/magnus"
              rows={3}
              className="w-full rounded border border-border bg-bg px-3 py-2 text-xs outline-none focus:border-primary focus:shadow-[0_0_8px_var(--color-glow)] transition-all"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void dryRun()} disabled={running || !command.trim() || selectedNodeIds.length === 0}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Dry run
            </Button>
            <Button onClick={() => void dispatch()} disabled={running || !command.trim() || selectedNodeIds.length === 0}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? 'Dispatching…' : `Execute on ${selectedNodeIds.length} node${selectedNodeIds.length !== 1 ? 's' : ''}`}
            </Button>
          </div>
        </div>
      </Card>
      </PageItem>

      {preview && (
        <PageItem>
        <Card title="Dry Run Preview" description="Targets marked stale are blocked by policy before dispatch">
          <div className="grid gap-2 sm:grid-cols-2">
            {preview.map((target) => (
              <div key={target.id} className="flex items-center justify-between rounded border border-border/50 bg-bg/40 px-3 py-2 text-xs">
                <div>
                  <div className="font-semibold text-text">{target.name}</div>
                  <div className="text-[10px] text-text-muted">{target.status}{target.stale ? ' · stale heartbeat' : ''}</div>
                </div>
                <Badge variant={target.allowed ? 'success' : 'warning'}>
                  {target.allowed ? 'Allowed' : 'Blocked'}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
        </PageItem>
      )}

      {/* Results */}
      {results.length > 0 && (
        <PageItem>
        <Card title="Dispatched Commands">
          <div className="space-y-2">
            {results.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded border border-border/50 px-4 py-2 hover:border-primary/20 transition-colors">
                <div className="text-[11px]">
                  <span className="text-primary">{r.id.slice(0, 12)}…</span>
                  <span className="ml-3 text-text-muted">→ {r.nodeId.slice(0, 12)}…</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                  <Button variant="ghost" size="sm" onClick={() => void fetchResult(r.id)}>
                    View Result
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
        </PageItem>
      )}

      {/* Output */}
      {output && (
        <PageItem>
        <Card title="Output">
          <pre className="max-h-96 overflow-auto rounded border border-border bg-bg p-4 text-[11px] leading-relaxed text-primary/90">
            {output}
          </pre>
        </Card>
        </PageItem>
      )}
    </PageTransition>
  );
}
