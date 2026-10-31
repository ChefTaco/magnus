'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import {
  Terminal,
  RefreshCw,
  Shield,
  Activity,
  Download,
  AlertTriangle,
  Power,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react';

interface QuickCommand {
  id: string;
  label: string;
  command: string;
  args?: string[];
  icon: React.ReactNode;
  variant: 'secondary' | 'danger' | 'primary';
  confirm?: string;
  timeoutSeconds?: number;
}

const QUICK_COMMANDS: QuickCommand[] = [
  {
    id: 'apt-update',
    label: 'apt update',
    command: 'sudo',
    args: ['apt', 'update'],
    icon: <Download className="h-3.5 w-3.5" />,
    variant: 'secondary',
    timeoutSeconds: 120,
  },
  {
    id: 'apt-upgrade',
    label: 'apt upgrade',
    command: 'sudo',
    args: ['apt', 'upgrade', '-y'],
    icon: <RefreshCw className="h-3.5 w-3.5" />,
    variant: 'secondary',
    confirm: 'This will upgrade all packages on the node. Continue?',
    timeoutSeconds: 300,
  },
  {
    id: 'magnus-status',
    label: 'magnus status',
    command: 'systemctl',
    args: ['status', 'magnus-agent', '--no-pager'],
    icon: <Activity className="h-3.5 w-3.5" />,
    variant: 'primary',
    timeoutSeconds: 15,
  },
  {
    id: 'magnus-update',
    label: 'magnus update',
    command: 'sudo',
    args: ['systemctl', 'restart', 'magnus-agent'],
    icon: <Shield className="h-3.5 w-3.5" />,
    variant: 'secondary',
    confirm: 'This will restart the Magnus agent. Continue?',
    timeoutSeconds: 30,
  },
  {
    id: 'dmesg',
    label: 'dmesg',
    command: 'sudo',
    args: ['dmesg', '--time-format=reltime', '-T'],
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
    variant: 'secondary',
    timeoutSeconds: 15,
  },
  {
    id: 'reboot',
    label: 'Reboot',
    command: 'sudo',
    args: ['reboot'],
    icon: <Power className="h-3.5 w-3.5" />,
    variant: 'danger',
    confirm: 'Are you sure you want to REBOOT this node? It will go offline temporarily.',
    timeoutSeconds: 10,
  },
];

interface CommandResult {
  commandId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

interface QuickCommandBarProps {
  nodeId: string;
  nodeStatus: string;
}

export function QuickCommandBar({ nodeId, nodeStatus }: QuickCommandBarProps): React.ReactElement {
  const [modalOpen, setModalOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeCmd, setActiveCmd] = useState<QuickCommand | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disabled = nodeStatus !== 'ONLINE';

  const runCommand = async (cmd: QuickCommand): Promise<void> => {
    if (cmd.confirm && !confirm(cmd.confirm)) return;

    setActiveCmd(cmd);
    setResult(null);
    setError(null);
    setRunning(true);
    setModalOpen(true);

    try {
      const res = await api.quickCommand.exec(nodeId, {
        command: cmd.command,
        args: cmd.args,
        timeoutSeconds: cmd.timeoutSeconds,
      });
      setResult(res.data as CommandResult);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Command execution failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="rounded border border-border bg-surface p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-[11px] text-text-muted mr-2">
            <Terminal className="h-4 w-4" />
            <span className="font-bold uppercase tracking-wider">Quick Commands</span>
          </div>
          {QUICK_COMMANDS.map((cmd) => (
            <Button
              key={cmd.id}
              variant={cmd.variant}
              size="sm"
              icon={cmd.icon}
              disabled={disabled}
              onClick={() => void runCommand(cmd)}
            >
              {cmd.label}
            </Button>
          ))}
          {disabled && (
            <span className="ml-2 text-xs text-text-muted">
              Node must be ONLINE to run commands
            </span>
          )}
        </div>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={activeCmd?.label ?? 'Command'}
        description={activeCmd ? `${activeCmd.command} ${(activeCmd.args ?? []).join(' ')}` : undefined}
        icon={<Terminal className="h-5 w-5 text-primary" />}
        className="max-w-3xl"
      >
        <div className="space-y-4">
          {/* Status line */}
          <div className="flex items-center gap-2">
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="text-xs text-primary">Executing…</span>
              </>
            ) : error ? (
              <>
                <XCircle className="h-4 w-4 text-danger" />
                <span className="text-xs text-danger">Error</span>
              </>
            ) : result ? (
              <>
                {result.exitCode === 0 ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                  <XCircle className="h-4 w-4 text-danger" />
                )}
                <span
                  className={`text-xs ${result.exitCode === 0 ? 'text-success' : 'text-danger'}`}
                >
                  Exit code: {result.exitCode}
                </span>
                <span className="text-xs text-text-muted flex items-center gap-1 ml-auto">
                  <Clock className="h-3 w-3" />
                  {(result.durationMs / 1000).toFixed(2)}s
                </span>
              </>
            ) : null}
          </div>

          {/* Error message */}
          {error && (
            <div className="rounded bg-danger/10 border border-danger/30 p-3">
              <p className="text-xs text-danger">{error}</p>
            </div>
          )}

          {/* Output */}
          {result && (
            <div className="space-y-3">
              {/* stdout */}
              {result.stdout && (
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-1">stdout</div>
                  <pre className="max-h-80 overflow-auto rounded bg-bg border border-border p-3 text-xs text-success whitespace-pre-wrap">
                    {result.stdout}
                  </pre>
                </div>
              )}

              {/* stderr */}
              {result.stderr && (
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-1">stderr</div>
                  <pre className="max-h-40 overflow-auto rounded bg-bg border border-danger/20 p-3 text-xs text-danger whitespace-pre-wrap">
                    {result.stderr}
                  </pre>
                </div>
              )}

              {/* No output */}
              {!result.stdout && !result.stderr && (
                <p className="text-xs text-text-muted italic">No output captured</p>
              )}

              {result.truncated && (
                <p className="text-xs text-warning">
                  ⚠ Output was truncated (exceeded 1MB)
                </p>
              )}
            </div>
          )}

          {/* Running placeholder */}
          {running && (
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-2" />
                <p className="text-xs text-text-muted">
                  Executing command on remote node…
                </p>
              </div>
            </div>
          )}

          <div className="flex justify-end pt-2">
            <Button variant="ghost" size="sm" onClick={() => setModalOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
