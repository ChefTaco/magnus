#!/usr/bin/env node
// Entry point for `magnus-agent` (npm bin) and `node dist/index.js` (systemd).
// With no arguments it starts the agent. Commands are imported lazily so that
// `--env-file` is loaded before any module reads the environment.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { parseCli, type ParsedCli } from './cli-args.js';

const USAGE = `Magnus Agent: node daemon that enrolls with a magnus-server and manages this host.

Usage:
  magnus-agent [start] [--env-file <path>]          Start the agent (default)
  magnus-agent check [--json] [--env-file <path>]   Validate configuration without starting
  magnus-agent env-schema                           Print the configuration schema as JSON
  magnus-agent install-service [--unprivileged]     (root, once) Versioned layout, upgrade launcher and systemd unit
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

  if (cli.envFile) {
    const loaded = config({ path: resolve(cli.envFile), quiet: true });
    if (loaded.error) return fail(`cannot read --env-file ${cli.envFile}: ${loaded.error.message}`);
  }

  switch (cli.command) {
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
