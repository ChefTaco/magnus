#!/usr/bin/env node
/** Entry point of the `magnus` command; see main.ts for the commands. */
import { spawnSync } from 'node:child_process';
import { systemIo } from './io.js';
import { ArgsError, run } from './main.js';

// Node.js fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY is set at startup.
const proxy = process.env['HTTPS_PROXY'] || process.env['https_proxy'] || process.env['HTTP_PROXY'] || process.env['http_proxy'];
if (proxy && !process.env['NODE_USE_ENV_PROXY']) {
  const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
  process.exit(child.status ?? 1);
}

run(systemIo(), process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ArgsError) {
      console.error(`magnus: ${error.message}. Run \`magnus --help\` for usage.`);
      process.exit(2);
    }
    console.error(`magnus: ${error instanceof Error ? error.message : String(error)}`);
    if (process.env['MAGNUS_DEBUG'] && error instanceof Error) console.error(error.stack);
    process.exit(1);
  },
);
