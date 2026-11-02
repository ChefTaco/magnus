/** Text helpers for the "Upgrade agents" dialog. */
import { apiErrorMessage, httpErrorBody } from './http-error-body';
import { upgradeRemedy } from '@hivemagnus/magnus-contracts/upgrade-remedies';
import type { AgentUpgradeEligibility, AgentUpgradeRun, UpgradeReadiness } from '@/types/upgrades';

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

const RETRIED = ['failed', 'refused', 'skipped', 'requested', 'watching', 'ambiguous'];

/** The nodes of a finished run a retry would pick up: left over, or held back by the check. */
export function retryCount(run: AgentUpgradeRun | null): number {
  if (!run || run.status === 'running') return 0;
  return run.nodes.filter((node) => RETRIED.includes(node.state)).length
    + (run.excluded ?? []).filter((node) => node.code && !upgradeRemedy(node.code).informational).length;
}

/** A finished run with nodes that a retry would pick up. */
export function retryable(run: AgentUpgradeRun | null): boolean {
  return retryCount(run) > 0;
}

/** How a finished run reads at a glance. */
export function runHeadline(run: AgentUpgradeRun): string {
  switch (run.status) {
    case 'succeeded': return 'Last run: succeeded';
    case 'partial': return `Last run: partial, ${run.attention?.length ?? 0} node(s) need attention`;
    case 'failed': return run.suspectedRelease ? 'Last run: failed, a release problem is suspected but unproven' : 'Last run: failed, on evidence about the release';
    default: return `Last run: ${run.status}`;
  }
}

/** Cause and remedy for a code the check reports. */
export function remedyText(code: string | null | undefined): string {
  return upgradeRemedy(code).remedy;
}

/** One line per problem, for a hover title. */
export function readinessTitle(readiness: UpgradeReadiness): string {
  return readiness.problems.map((problem) => `${problem.code}: ${problem.detail}. ${problem.remedy}`).join('\n');
}

export function nodeDetail(node: AgentUpgradeRun['nodes'][number]): string | null {
  if (!node.detail) return node.code ?? null;
  return node.code && !node.detail.includes(node.code) ? `${node.code}: ${node.detail}` : node.detail;
}
