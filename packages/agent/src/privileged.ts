/**
 * Privileged mode. With MAGNUS_AGENT_PRIVILEGED=true (the default) the agent
 * runs as root and every executor is available. With false it runs as an
 * ordinary account: features that need root are disabled up front and their
 * routes answer 403 AGENT_NOT_PRIVILEGED instead of failing half-way.
 */
import type { MiddlewareHandler } from 'hono';

export type PrivilegedFeature = 'cron' | 'users' | 'system-updates' | 'docker-group-remediation'
  | 'ardent-management' | 'credential-renewal' | 'execution-supervisor';

/** Features that need root, with the routes or loops they cover. */
export const PRIVILEGED_FEATURES: ReadonlyArray<{ feature: PrivilegedFeature; covers: string }> = [
  { feature: 'cron', covers: '/api/v1/cron/* (system and managed crontab, scheduler inventory and drain)' },
  { feature: 'users', covers: '/api/v1/users/* (local account provisioning and passwords)' },
  { feature: 'system-updates', covers: 'POST /api/v1/health/system-updates/enable (APT package install, systemd timers)' },
  { feature: 'docker-group-remediation', covers: 'heartbeat docker-group check (adding a user to the docker group)' },
  { feature: 'ardent-management', covers: 'POST /api/v1/ardent/action (Ardent package, profile and service management)' },
  { feature: 'credential-renewal', covers: 'background HiveMem token and listener certificate renewal' },
  { feature: 'execution-supervisor', covers: 'MAGNUS_EXECUTION_SUPERVISOR_ENABLED (transient systemd units for commands)' },
];

/** Read on every call so tests and `check` see the current environment. */
export function agentPrivileged(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['MAGNUS_AGENT_PRIVILEGED'] ?? 'true').toLowerCase() !== 'false';
}

export function isRoot(): boolean {
  return typeof process.geteuid === 'function' && process.geteuid() === 0;
}

export function notPrivilegedMessage(feature: PrivilegedFeature): string {
  return `${feature} is disabled: agent is not privileged (MAGNUS_AGENT_PRIVILEGED=false)`;
}

export class AgentNotPrivilegedError extends Error {
  constructor(readonly feature: PrivilegedFeature) {
    super(notPrivilegedMessage(feature));
    this.name = 'AgentNotPrivilegedError';
  }
}

/** Route guard: 403 with a stable code when the agent runs unprivileged. */
export function requirePrivileged(feature: PrivilegedFeature): MiddlewareHandler {
  return async (c, next) => {
    if (agentPrivileged()) return next();
    return c.json({ success: false, error: { code: 'AGENT_NOT_PRIVILEGED', feature, message: notPrivilegedMessage(feature) } }, 403);
  };
}

/** Feature posture for `magnus-agent check` and the health check. */
export function privilegedFeatureStatus(env: NodeJS.ProcessEnv = process.env): Array<{ feature: PrivilegedFeature; enabled: boolean; covers: string }> {
  const privileged = agentPrivileged(env);
  return PRIVILEGED_FEATURES.map(item => ({ ...item, enabled: privileged }));
}
