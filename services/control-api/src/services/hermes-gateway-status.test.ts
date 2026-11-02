import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGatewayStatusText, type HermesGatewayState } from './hermes-gateway-status.js';
import { parseGatewayStatusText as agentParse } from '../../../../packages/agent/src/executors/hermes-gateway-status.js';
import { GATEWAY_STATUS_PYTHON, buildHermesDetectionScript, normalizeServiceStatus } from './hermes-cli-parser.js';

const JOURNAL = 'Nov 02 10:00:00 node-1 systemd[1]: Stopped Hermes gateway.\nNov 02 10:00:01 node-1 hermes[42]: ERROR: transient upstream error';
const LOADED = 'Loaded: loaded (/etc/systemd/system/hermes-gateway.service; enabled; preset: enabled)';
const TABLE: Array<[string, HermesGatewayState]> = [
  ['Active: inactive (dead)', 'inactive'],
  [`${LOADED}\n     Active: inactive (dead) since Mon 2026-11-02 10:00:00 UTC`, 'inactive'],
  ['Active: active (running) since Mon 2026-11-02 10:00:00 UTC; 1h ago', 'running'],
  [`● hermes-gateway.service - Hermes gateway\n${LOADED}\n     Active: active (running)\n   Main PID: 42 (hermes)\n${JOURNAL}`, 'running'],
  ['Loaded: loaded (/etc/x.service; disabled; preset: enabled)\nActive: active (running)', 'running'],
  ['Active: failed (Result: exit-code)', 'failed'],
  ['Active: activating (start) since now', 'unknown'],
  ['Active: activating (auto-restart) (Result: exit-code)', 'failed'],
  ['Active: deactivating (stop-sigterm)', 'inactive'],
  ['Active: active (exited)', 'inactive'],
  ['Active: inactive (dead)\nActive: active (running)', 'running'],
  [LOADED, 'unknown'],
  ['not running', 'inactive'],
  ['Gateway is not running', 'inactive'],
  ['✗ Gateway is not running\n  To start: hermes gateway', 'inactive'],
  ['✗ User gateway service is stopped\n  Run: hermes gateway start', 'inactive'],
  ['stopped', 'inactive'],
  ['inactive', 'inactive'],
  ['disabled', 'inactive'],
  ['dead', 'inactive'],
  ['Unit hermes-gateway could not be found.', 'inactive'],
  ['Gateway service is not installed', 'inactive'],
  ['failed', 'failed'],
  ['error: could not reach gateway', 'failed'],
  ['Gateway is unhealthy', 'failed'],
  ['Failed to connect to bus: No medium found', 'unknown'],
  ['running', 'running'],
  ['active', 'running'],
  ['healthy', 'running'],
  ['✓ Gateway is running (PID: 42)', 'running'],
  ['\u001b[32m✓ User gateway service is running\u001b[0m', 'running'],
  ['Gateway is running\nNo errors in the last hour', 'running'],
  ['Gateway is running\nLast error: upstream timeout', 'running'],
  [`Gateway is running (PID: 42)\n${JOURNAL}`, 'running'],
  ['✓ Gateway is running\n⚠ Linger is disabled for this user', 'running'],
  ['activating', 'unknown'],
  ['', 'unknown'],
  ['Hermes Agent v0.12.0', 'unknown'],
];

describe('Hermes gateway status classification', () => {
  it.each(TABLE)('classifies %j as %s', (text, expected) => {
    expect(parseGatewayStatusText(text)).toBe(expected);
    expect(agentParse(text)).toBe(expected);
  });

  it('keeps the agent and server copies byte-identical', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(read('./hermes-gateway-status.ts')).toBe(read('../../../../packages/agent/src/executors/hermes-gateway-status.ts'));
  });

  const hasPython = spawnSync('python3', ['--version']).status === 0;
  it.skipIf(!hasPython)('gives the same answers from the SSH detection script', () => {
    const program = `import json, re, sys\n${GATEWAY_STATUS_PYTHON}\nprint(json.dumps([parse_gateway_status(t) for t in json.load(sys.stdin)]))`;
    const output = execFileSync('python3', ['-c', program], { input: JSON.stringify(TABLE.map(([text]) => text)), encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual(TABLE.map(([, expected]) => expected));
  });

  it('embeds the classifier and never tests substrings of gateway or dashboard text', () => {
    const script = buildHermesDetectionScript({ hermesHome: '/home/operator/.hermes', hermesBin: 'hermes' });
    expect(script).toContain('def parse_gateway_status(text):');
    expect(script).not.toMatch(/'active' in (gateway|dash)_text/);
    expect(script).not.toContain("'running' in gateway_text");
  });

  it('normalizes free-form profile states without losing the exact ones', () => {
    expect(normalizeServiceStatus('Not Running')).toBe('inactive');
    expect(normalizeServiceStatus('inactive')).toBe('inactive');
    expect(normalizeServiceStatus('stopped')).toBe('stopped');
    expect(normalizeServiceStatus('active')).toBe('running');
    expect(normalizeServiceStatus('error')).toBe('error');
    expect(normalizeServiceStatus(undefined)).toBe('unknown');
  });
});
