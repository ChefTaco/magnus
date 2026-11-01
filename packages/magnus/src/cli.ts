#!/usr/bin/env node
/** Entry point of the `magnus` command; see main.ts for the commands. */
import { systemIo } from './io.js';
import { ArgsError, run } from './main.js';

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
