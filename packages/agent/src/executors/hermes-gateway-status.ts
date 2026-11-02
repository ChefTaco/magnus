/**
 * Classifies `hermes gateway status` and systemd-style output. Mirrored
 * byte-for-byte by the server's copy, which also carries the Python port used
 * by SSH detection; a server test pins all three to one table.
 *
 * `systemctl status` output appends a journal tail, so a running service can
 * print "Stopped ..." or "error" from an earlier run. A systemd `Active:` line
 * is therefore authoritative. Without one, only summary lines count, and on
 * those a negative state outranks a failure, which outranks a positive one.
 */
export type HermesGatewayState = 'running' | 'inactive' | 'failed' | 'unknown';

const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const ACTIVE_LINE = /^\s*active:\s*([a-z-]+)(?:\s*\(([^)]*)\))?/;
const IGNORED_LINE = new RegExp([
  // Journal tail: "Nov 02 10:00:00 host ..." or "2026-11-02 10:00:00 ...".
  String.raw`^\s*(?:[a-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2})`,
  // systemctl status fields other than Active, its unit title and its process tree.
  String.raw`^\s*(?:loaded|docs|main pid|tasks|memory|cpu|cgroup|process|drop-in|triggeredby|invocation|status|ip|mem peak)\s*:`,
  String.raw`^\s*[●○×↻✗✓]?\s*\S+\.service\b`,
  String.raw`^\s*[│├└]`,
  // Boot and session settings say nothing about the gateway's current state.
  String.raw`\b(?:linger|auto-?start|on boot|at boot)\b`,
  // systemctl could not ask: that is not evidence about the gateway either.
  String.raw`failed to connect to bus`,
].join('|'));
const HEALTHY_PHRASE = /\b(?:no|0|zero)\s+(?:errors?|failures?|failed)\b|\b(?:last|previous|recent)\s+(?:errors?|failures?)\b.*$/g;
const NEGATIVE = /\b(?:not[\s_-]+(?:running|active|started|loaded|installed)|isn'?t\s+running|inactive|stopped|disabled|dead|exited|could not be found)\b/;
const FAILED = /\b(?:failed|failure|crashed|fatal|errors?|errored|unhealthy|not[\s_-]+healthy)\b/;
const POSITIVE = /\b(?:running|active|healthy)\b/;

function activeLineState(state: string, detail: string): HermesGatewayState {
  if (state === 'active') return detail.startsWith('exited') ? 'inactive' : 'running';
  if (state === 'reloading') return 'running';
  if (state === 'inactive' || state === 'deactivating') return 'inactive';
  if (state === 'failed') return 'failed';
  // A unit waiting to restart after a crash is failing, one starting up is not known yet.
  if (state === 'activating') return detail.includes('auto-restart') ? 'failed' : 'unknown';
  return 'unknown';
}

export function parseGatewayStatusText(text: string): HermesGatewayState {
  const lines = text.replace(ANSI_COLOUR, '').toLowerCase().split(/\r?\n/);
  const activeStates = lines.flatMap((line) => {
    const match = ACTIVE_LINE.exec(line);
    return match ? [activeLineState(match[1] ?? '', match[2] ?? '')] : [];
  });
  if (activeStates.length > 0) {
    // User and system units can both print a status block.
    for (const state of ['running', 'failed', 'inactive'] as const) if (activeStates.includes(state)) return state;
    return 'unknown';
  }
  const summary = lines.filter((line) => !IGNORED_LINE.test(line)).map((line) => line.replace(HEALTHY_PHRASE, ' '));
  if (summary.some((line) => NEGATIVE.test(line))) return 'inactive';
  if (summary.some((line) => FAILED.test(line))) return 'failed';
  if (summary.some((line) => POSITIVE.test(line))) return 'running';
  return 'unknown';
}
