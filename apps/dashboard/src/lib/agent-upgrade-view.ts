/** Text helpers for the "Upgrade agents" dialog. */
import { apiErrorMessage, httpErrorBody } from './http-error-body';
import type { AgentUpgradeEligibility, AgentUpgradeRun } from '@/types/upgrades';

/** The server's `{ error: { code, message } }` instead of "Request failed with status code 409". */
export async function upgradeErrorMessage(cause: unknown): Promise<string> {
  const body = await httpErrorBody(cause);
  const message = apiErrorMessage(body);
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (message) return typeof code === 'string' && !message.includes(code) ? `${message} (${code})` : message;
  return cause instanceof Error ? cause.message : String(cause);
}

export function isNotFound(cause: unknown): boolean {
  return (cause as { response?: { status?: number } } | null)?.response?.status === 404;
}

export function targetDescription(eligibility: AgentUpgradeEligibility): string {
  const bundled = eligibility.version === eligibility.serverVersion ? ' (the agent version bundled with this server)' : '';
  const unverified = eligibility.release && !eligibility.release.verified ? `; not verified on the registry: ${eligibility.release.reason ?? 'unknown'}` : '';
  return `Target: magnus-agent ${eligibility.version}${bundled}${eligibility.prerelease ? ', a prerelease' : ''}${unverified}`;
}

/** A finished run with nodes that a retry would pick up. */
export function retryable(run: AgentUpgradeRun | null): boolean {
  return Boolean(run && run.status !== 'running' && run.nodes.some((node) => ['failed', 'refused', 'skipped', 'requested'].includes(node.state)));
}

export function nodeDetail(node: AgentUpgradeRun['nodes'][number]): string | null {
  if (!node.detail) return node.code ?? null;
  return node.code && !node.detail.includes(node.code) ? `${node.code}: ${node.detail}` : node.detail;
}
