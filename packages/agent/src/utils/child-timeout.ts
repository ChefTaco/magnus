import type { ChildProcess } from 'node:child_process';

const ESCALATION_MS = 5_000;

/**
 * Arm a deadline for a child process: SIGTERM at `timeoutMs`, SIGKILL if it
 * has not exited 5s later, and finally release its output pipes so `close`
 * fires even when a descendant still holds them open. Returns a disarm
 * function to call from the child's `close`/`error` handlers.
 */
export function armChildTimeout(child: ChildProcess, timeoutMs: number, onTimeout: () => void): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  timers.push(setTimeout(() => {
    onTimeout();
    child.kill('SIGTERM');
    timers.push(setTimeout(() => {
      if (!exited()) child.kill('SIGKILL');
      timers.push(setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, ESCALATION_MS));
    }, ESCALATION_MS));
  }, timeoutMs));
  return () => { for (const timer of timers) clearTimeout(timer); };
}
