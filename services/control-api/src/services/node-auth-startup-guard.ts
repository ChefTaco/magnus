/**
 * The start-up guard of 3.0.0 (docs/NODE_CREDENTIALS.md, "Upgrading to 3.0.0").
 *
 * `enforce` is the default from 3.0.0, but a server that was upgraded without being made ready must
 * not lock its own fleet out. So a server whose `NODE_AUTH_MODE` is unset checks the inventory before
 * it listens: while any real node has no active key, has only revoked keys, or runs an agent that does
 * not sign its evidence (or a 2.10.0/2.10.1 agent that enforce cannot reach), it refuses to start and
 * names them, with the two ways out. An explicit mode is the operator's decision: `enforce` starts
 * whatever the fleet looks like, and `compat` or `warn` start with a deprecation warning.
 *
 * Internal pseudo-nodes (`__control-api__`, `__dashboard__`) and decommissioned nodes never count.
 */
import { nodeAuthDeprecationWarning, nodeAuthModeSetting, type NodeAuthModeSetting } from './node-auth-config.js';
import { nodeCredentialStore } from './node-credential-store.js';
import { fleetBlockers, STARTUP_BLOCKERS, type EnforceBlocker } from './node-credential-summary.js';
import { serverSigningKey } from './node-server-key.js';

export type StartupGuardResult =
  | { ok: true; setting: NodeAuthModeSetting; warnings: string[] }
  | { ok: false; setting: NodeAuthModeSetting; blockers: EnforceBlocker[]; message: string };

const DESCRIPTIONS: Record<string, string> = {
  SERVER_KEY_UNAVAILABLE: 'the server signing key cannot be read',
  NODES_WITHOUT_KEY: 'without a node key (still on the shared node secret)',
  NODES_REVOKED: 'whose node keys were all revoked',
  NODES_NOT_SIGNING_EVIDENCE: 'whose agent does not sign its evidence with the node key (an agent older than 2.10.0, or not told yet)',
  AGENTS_NEED_UPGRADE: 'running agent 2.10.0 or 2.10.1, whose managed requests enforce mode cannot reach',
};

function describe(blocker: EnforceBlocker): string {
  if (blocker.code === 'SERVER_KEY_UNAVAILABLE') return `  - ${DESCRIPTIONS[blocker.code]}`;
  const named = blocker.nodes.slice(0, 10).map(node => `${node.name} (${node.id})`).join(', ');
  const more = blocker.count > 10 ? ` and ${blocker.count - 10} more` : '';
  return `  - ${blocker.count} node(s) ${DESCRIPTIONS[blocker.code]}: ${named}${more}`;
}

/** The refusal text: what enforce would lock out, and the two ways out. */
export function startupGuardMessage(blockers: readonly EnforceBlocker[]): string {
  return [
    'Refusing to start: NODE_AUTH_MODE is not set, so this server would run in enforce mode (the default since 3.0.0), which accepts',
    'node signatures and node-signed evidence only. Enforce mode would lock out:',
    ...blockers.map(describe),
    'Either:',
    '  1. enroll or upgrade them first: run the previous release again (`magnus upgrade` switches back by itself when a start fails),',
    '     upgrade those agents to 2.10.2 or later and let each bind its key (or `magnus-agent enroll --token` with a token from',
    '     POST /api/v1/nodes/<nodeId>/enrollment-token), and start this release once GET /api/v1/node-credentials/summary reports no blockers; or',
    '  2. set NODE_AUTH_MODE=compat (or warn) explicitly in this server\'s environment: the shared node secret keeps working for this',
    '     major (deprecated, removed in the next), and you switch to enforce once the summary is clean.',
    'See docs/NODE_CREDENTIALS.md, "Upgrading to 3.0.0".',
  ].join('\n');
}

/**
 * Decide whether this server may start. Reads the inventory only when the mode is unset. Throws only
 * when the database cannot be read and the decision therefore cannot be made.
 */
export async function nodeAuthStartupGuard(env: NodeJS.ProcessEnv = process.env): Promise<StartupGuardResult> {
  const setting = nodeAuthModeSetting(env);
  const deprecation = nodeAuthDeprecationWarning(env);
  if (setting.explicit) return { ok: true, setting, warnings: deprecation ? [deprecation] : [] };
  let keyAvailable = true;
  try { serverSigningKey(); } catch { keyAvailable = false; }
  const blockers = fleetBlockers(await nodeCredentialStore.fleet(), keyAvailable)
    .filter(blocker => STARTUP_BLOCKERS.includes(blocker.code));
  if (blockers.length > 0) return { ok: false, setting, blockers, message: startupGuardMessage(blockers) };
  return { ok: true, setting, warnings: [] };
}
