#!/usr/bin/env node
// Entry point for `magnus-agent` (npm bin) and `node dist/index.js` (systemd).
// With no arguments it starts the agent. Commands are imported lazily so that
// `--env-file` is loaded before any module reads the environment.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';
import { enrollmentTokenFrom, parseCli, type ParsedCli } from './cli-args.js';

const USAGE = `Magnus Agent: node daemon that enrolls with a magnus-server and manages this host.

Usage:
  magnus-agent [start] [--env-file <path>]          Start the agent (default)
  magnus-agent check [--json] [--env-file <path>]   Validate configuration without starting
  magnus-agent acceptance [--json] [--wait-seconds 60]  Verify native health and recent accepted heartbeat
  magnus-agent env-schema                           Print the configuration schema as JSON
  magnus-agent install-service [--unprivileged]     (root, once) Versioned layout, upgrade launcher and systemd unit
  magnus-agent enroll --token <token>               Bind a new node key with a one-time enrollment token
  magnus-agent enroll --token-file <path|->         The same, reading the token from a file or standard input (-)
  magnus-agent identity show [--json]               Print this node's id and key fingerprints (never the key)
  magnus-agent identity rotate                      Replace the node key (signed with the key it replaces)
  magnus-agent identity reset                       Remove the node key and return to the shared node secret
  magnus-agent --help | --version

Options:
  --env-file <path>  Load environment variables from a dotenv file first.
                     Variables already set in the environment win. The agent
                     also reads $AGENT_INSTALL_DIR/.env (default ./.env).
  -h, --help         Show this help.
  -v, --version      Print the version.

Minimal configuration:
  CONTROL_API_URL        magnus-server Control API, e.g. https://magnus.example.com:4000
  NODE_MANAGER_SECRET    node credential shared with the Control API (32+ characters)
  RESULT_SIGNING_SECRET  independent result-signing key (32+ characters)
  TLS_CERT_PATH, TLS_KEY_PATH  required when NODE_ENV=production

Run "magnus-agent env-schema" for every setting.`;

function fail(message: string): number {
  console.error(`magnus-agent: ${message}`);
  return 1;
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

export async function main(argv: string[]): Promise<number | null> {
  let cli: ParsedCli;
  try { cli = parseCli(argv); }
  catch (error) { return fail(`${(error as Error).message}. Run "magnus-agent --help".`); }

  if (cli.version || cli.command === 'version') { console.log(version()); return 0; }
  if (cli.help || cli.command === 'help') { console.log(USAGE); return 0; }

  if (cli.command === 'start' || cli.command === 'install-service') {
    const { nodeRuntimeCheck } = await import('./node-runtime.js');
    const runtime = nodeRuntimeCheck();
    if (runtime.status === 'fail') return fail(runtime.message);
  }

  if (cli.envFile) {
    const loaded = config({ path: resolve(cli.envFile), quiet: true });
    if (loaded.error) return fail(`cannot read --env-file ${cli.envFile}: ${loaded.error.message}`);
  }

  switch (cli.command) {
    case 'acceptance': {
      // The node key lives next to the .env: the probe signs with it (an agent in enforce mode needs that).
      if (!process.env['AGENT_INSTALL_DIR'] && cli.envFile) process.env['AGENT_INSTALL_DIR'] = dirname(resolve(cli.envFile));
      const { runAgentAcceptance } = await import('./acceptance.js');
      const result = await runAgentAcceptance(cli.rest, process.env, version());
      if (cli.rest.includes('--json')) console.log(JSON.stringify(result));
      else console.log(result.ok ? 'Native agent health and heartbeat accepted.' : `Native agent acceptance failed: ${result.reason}`);
      return result.ok ? 0 : 1;
    }
    case 'start':
      if (cli.rest.length > 0) return fail(`unexpected argument for start: ${cli.rest[0]}`);
      await import('./start.js');
      return null;
    case 'env-schema': {
      const { buildEnvSchemaDocument } = await import('./env-catalog.js');
      console.log(JSON.stringify(buildEnvSchemaDocument(), null, 2));
      return 0;
    }
    case 'check': {
      const json = cli.rest.includes('--json');
      const unknown = cli.rest.find(arg => arg !== '--json');
      if (unknown) return fail(`unexpected argument for check: ${unknown}`);
      const installDir = process.env['AGENT_INSTALL_DIR'] ?? process.cwd();
      config({ path: resolve(installDir, '.env'), quiet: true });
      const { configurationErrors, CONTROL_API_URL, HOST_FQDN } = await import('./env.js');
      const { agentPrivileged, privilegedFeatureStatus } = await import('./privileged.js');
      const errors = configurationErrors();
      const { nodeRuntimeCheck } = await import('./node-runtime.js');
      const runtime = nodeRuntimeCheck();
      if (runtime.status === 'fail') errors.unshift(runtime.message);
      const features = privilegedFeatureStatus();
      const report = { ok: errors.length === 0, version: version(), hostFqdn: HOST_FQDN, controlApiUrl: CONTROL_API_URL,
        privileged: agentPrivileged(), features, errors };
      if (json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`magnus-agent ${report.version} on ${report.hostFqdn} -> ${report.controlApiUrl}`);
        console.log(`Privileged mode: ${report.privileged ? 'on' : 'off'}`);
        for (const item of features) console.log(`  ${item.enabled ? 'enabled ' : 'disabled'}  ${item.feature}: ${item.covers}`);
        console.log(report.ok ? 'Configuration OK' : errors.map(error => `  - ${error}`).join('\n'));
      }
      return report.ok ? 0 : 1;
    }
    case 'enroll': {
      // --token-file keeps the token off the process table (`-` reads standard input).
      const parsed = enrollmentTokenFrom(cli.rest, path => readFileSync(path, { encoding: 'utf8' }).slice(0, 4096));
      if ('error' in parsed) return fail(parsed.error);
      const { token } = parsed;
      config({ path: resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.env'), quiet: true });
      const { enrollWithToken } = await import('./node-enrollment.js');
      const result = await enrollWithToken(token);
      if (!result.ok) return fail(`enrollment failed: ${result.reason}`);
      console.log(`Enrolled as node ${result.nodeId}.`);
      console.log(`  node key fingerprint:   ${result.keyFingerprint}`);
      console.log(`  server key fingerprint: ${result.serverKeyFingerprint}`);
      console.log('A running agent picks the new key up within a few seconds; no restart is needed.');
      return 0;
    }
    case 'identity': {
      const [action, ...extra] = cli.rest;
      config({ path: resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd(), '.env'), quiet: true });
      if (action === 'show' && extra.every(arg => arg === '--json')) {
        const { describeNodeIdentity } = await import('./node-enrollment.js');
        const identity = describeNodeIdentity();
        if (extra.includes('--json')) console.log(JSON.stringify(identity, null, 2));
        else if (identity.state === 'none') console.log('No node key: this agent uses the shared node secret.');
        else if (identity.state === 'unbound') console.log(`Node key ${identity.keyFingerprint} exists but the Control API has not bound it yet.`);
        else {
          console.log(`Node ${identity.nodeId} (${identity.origin}, bound ${identity.boundAt})`);
          console.log(`  node key fingerprint:    ${identity.keyFingerprint}`);
          console.log(`  pinned server key(s):    ${(identity.serverKeyFingerprints ?? []).join(', ')}`);
        }
        return 0;
      }
      if (action === 'rotate' && extra.length === 0) {
        const { rotateNodeKey } = await import('./node-enrollment.js');
        const result = await rotateNodeKey();
        if (!result.ok) return fail(`rotation failed: ${result.reason}`);
        console.log(`Node key rotated. New fingerprint: ${result.keyFingerprint}. The previous key stays valid until ${result.retiresAt}.`);
        return 0;
      }
      if (action === 'reset' && extra.length === 0) {
        const { resetNodeIdentity } = await import('./security/node-identity.js');
        console.log(resetNodeIdentity()
          ? 'Node key removed. This agent now uses the shared node secret.\nThe Control API still refuses the shared secret for this node until an administrator resets its credentials\n(POST /api/v1/nodes/<id>/credentials/reset) or issues an enrollment token.'
          : 'There was no node key to remove.');
        return 0;
      }
      return fail('usage: magnus-agent identity show [--json] | rotate | reset');
    }
    case 'install-service': {
      const { installService } = await import('./upgrade/install-service.js');
      return installService(cli.rest);
    }
    default:
      return fail(`unknown command: ${cli.command}. Run "magnus-agent --help".`);
  }
}

const exitCode = await main(process.argv.slice(2));
if (exitCode !== null) process.exitCode = exitCode;
