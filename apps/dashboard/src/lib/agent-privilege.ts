/**
 * Node agents running unprivileged answer root-only features (cron, users,
 * system updates, Ardent management) with 403 AGENT_NOT_PRIVILEGED. The Control
 * API may pass that body through or wrap it in its own error text, so detect
 * both and show a clear "disabled on this node" message instead of a failure.
 */
const FEATURE_LABELS: Record<string, string> = {
  cron: 'Cron management',
  users: 'User management',
  'system-updates': 'Automatic system updates',
  'ardent-management': 'Ardent management',
  'docker-group-remediation': 'Docker group remediation',
  'credential-renewal': 'Credential renewal',
  'execution-supervisor': 'The execution supervisor',
};

function featureLabel(feature: string | undefined): string {
  if (!feature) return 'This feature';
  return FEATURE_LABELS[feature] ?? feature;
}

/** Message for an AGENT_NOT_PRIVILEGED error body, or null for any other error. */
export function agentDisabledMessage(body: unknown): string | null {
  const text = typeof body === 'string' ? body : body == null ? '' : JSON.stringify(body);
  if (!text.includes('AGENT_NOT_PRIVILEGED') && !/is disabled: agent is not privileged/.test(text)) return null;
  const feature = /"feature"\s*:\s*\\?"([a-z-]+)/.exec(text)?.[1] ?? /([a-z-]+) is disabled: agent is not privileged/.exec(text)?.[1];
  return `${featureLabel(feature)} is disabled on this node (its agent runs unprivileged).`;
}
