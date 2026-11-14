/**
 * `magnus-server node-auth server-key [status|stage|promote|retire]`: the server signing key's
 * rotation from the command line, on the key file the server reads (docs/NODE_CREDENTIALS.md,
 * "Rotating the server key"). The running server picks a change up within a second.
 *
 * The command line cannot see which agents pin a staged key (only the running server hears their
 * heartbeats), so `promote` here needs `--force`; the admin route
 * `POST /api/v1/node-credentials/server-key/promote` checks the pins first.
 */
import { keyFingerprint } from '../security/node-request-auth.js';
import { promoteNextServerKey, retirePreviousServerKey, serverKeyRotationState, serverSigningKeyPath, ServerKeyRotationError,
  stageNextServerKey, type ServerKeyRotationState } from '../services/node-server-key.js';

export const NODE_AUTH_USAGE = `Usage: magnus-server node-auth server-key <status|stage|promote|retire> [options]

  status                 Show the active key, a staged next key, the replaced key and its grace, and retired keys
  stage                  Create a next key; agents pin it from their next heartbeat on
  promote --force        Sign with the next key from now on (the admin route checks agent pins first)
  retire                 Destroy the replaced key's private part once its grace has passed (--force: now)

Options:
  --grace-hours <n>      promote: how long agents may still sign for the replaced key (default 168)
  --force                promote: without the pin check; retire: before the grace period ends
  --format json          print the state as JSON
  --env-file <path>      the server's env file (MAGNUS_HOME, NODE_AUTH_SERVER_KEY_PATH)
`;

function render(state: ServerKeyRotationState): string {
  return [
    `server key file: ${serverSigningKeyPath()}`,
    `  active    ${state.active.keyFingerprint}  created ${state.active.createdAt ?? 'unknown'}`,
    `  next      ${state.next ? `${state.next.keyFingerprint}  staged ${state.next.createdAt ?? 'unknown'}` : '-'}`,
    `  previous  ${state.previous ? `${state.previous.keyFingerprint}  replaced ${state.previous.promotedAt}, accepted until ${state.previous.retireAfter}${state.previous.inGrace ? '' : ' (grace over: retire it)'}` : '-'}`,
    `  retired   ${state.retired.length ? state.retired.map(entry => keyFingerprint(entry.keyId)).join(', ') : '-'}`,
  ].join('\n');
}

export async function commandNodeAuth(args: readonly string[], out: (line: string) => void = line => console.log(line)): Promise<number> {
  const [group, action = 'status', ...rest] = args;
  if (group !== 'server-key' || args.includes('--help') || args.includes('-h')) { out(NODE_AUTH_USAGE); return group === 'server-key' ? 0 : 2; }
  const force = rest.includes('--force');
  const json = rest.includes('--format=json') || (rest.includes('--format') && rest[rest.indexOf('--format') + 1] === 'json');
  const graceAt = rest.indexOf('--grace-hours');
  const graceHours = graceAt >= 0 ? Number(rest[graceAt + 1]) : undefined;
  if (graceHours !== undefined && (!Number.isInteger(graceHours) || graceHours < 1 || graceHours > 90 * 24)) {
    out('magnus-server node-auth: --grace-hours must be a whole number of hours from 1 to 2160');
    return 2;
  }
  try {
    let state: ServerKeyRotationState;
    if (action === 'status') state = serverKeyRotationState();
    else if (action === 'stage') state = stageNextServerKey();
    else if (action === 'promote') {
      if (!force) {
        out('magnus-server node-auth: promote from the command line needs --force: it cannot see which agents pin the next key. '
          + 'Check GET /api/v1/node-credentials/summary (serverKeyRotation.agents) first, or use POST /api/v1/node-credentials/server-key/promote.');
        return 2;
      }
      state = promoteNextServerKey(graceHours ? { graceMs: graceHours * 3_600_000 } : {});
    } else if (action === 'retire') state = retirePreviousServerKey({ force });
    else { out(NODE_AUTH_USAGE); return 2; }
    out(json ? JSON.stringify(state, null, 2) : render(state));
    if (action !== 'status') out('Back up the key file with the database: it holds the private keys agents pin.');
    return 0;
  } catch (error) {
    if (error instanceof ServerKeyRotationError) { out(`magnus-server node-auth: ${error.code}: ${error.message}`); return 1; }
    throw error;
  }
}
