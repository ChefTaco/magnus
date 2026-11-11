export interface CommandObservation {
  id: string;
  status: string;
  result?: { stdout: string; stderr: string; exitCode: number } | null;
}

export function commandOutput(command?: CommandObservation): string {
  if (!command) return 'Waiting for command status…';
  if (command.result) return `Exit: ${command.result.exitCode}\n\n--- stdout ---\n${command.result.stdout}\n--- stderr ---\n${command.result.stderr}`;
  return commandFinished(command.status)
    ? `${command.status}: no output was recorded.`
    : `${command.status}: waiting for result…`;
}

function commandFinished(status: string): boolean {
  return ['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(status.toUpperCase());
}

/** Observe existing commands only. A retry never dispatches or replays work. */
export function watchCommandResults(
  ids: readonly string[],
  load: (id: string) => Promise<CommandObservation>,
  update: (command: CommandObservation) => void,
  failed: (id: string, error: unknown) => void,
  intervalMs = 1500,
): () => void {
  const pending = new Set(ids);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async (): Promise<void> => {
    await Promise.all([...pending].map(async id => {
      try {
        const command = await load(id);
        if (stopped) return;
        if (command.id !== id) throw new Error('Command response identity differs');
        update(command);
        if (commandFinished(command.status)) pending.delete(id);
      } catch (error) {
        if (!stopped) failed(id, error);
      }
    }));
    if (!stopped && pending.size) timer = setTimeout(() => { void poll(); }, intervalMs);
  };
  if (pending.size) void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
