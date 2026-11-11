export const UPTIME_DIAGNOSTIC = { command: '/usr/bin/uptime', timeoutSeconds: 60 } as const;

/** Keep the diagnostic aligned with its completion policy; other commands retain their budget. */
export function commandExecutionBudget(command: string): number {
  return command === UPTIME_DIAGNOSTIC.command ? UPTIME_DIAGNOSTIC.timeoutSeconds : 300;
}
