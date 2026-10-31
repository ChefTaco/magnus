#!/usr/bin/env node
/** Fixed cron entrypoint. Load the installed private environment before runtime imports. */
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The deployment helper installs the tarball below the stable host directory;
// its private .env and .magnus ledger are outside node_modules and survive upgrades.
const install = basename(packageRoot) === 'magnus-agent' && basename(dirname(packageRoot)) === '@hivemagnus'
  && basename(dirname(dirname(packageRoot))) === 'node_modules'
  ? resolve(packageRoot, '../../..') : packageRoot;
for (const key of ['CONTROL_API_URL', 'HOST_FQDN', 'NODE_MANAGER_SECRET', 'NODE_MANAGER_SECRET_PREVIOUS',
  'RESULT_SIGNING_SECRET', 'MAGNUS_EXECUTION_SUPERVISOR_ENABLED', 'CONTROL_API_CA_PATH', 'COMMAND_RECONCILIATION_SECRET']) delete process.env[key];
const loaded = config({ path: resolve(install, '.env'), quiet: true, override: true });
if (loaded.error) throw new Error('Installed scheduler environment is unavailable');
process.env['AGENT_INSTALL_DIR'] = install;
const { ManagedScheduler } = await import('./managed-scheduler.js');
const { schedulerAuthority } = await import('./scheduler-authority.js');
const scheduler = new ManagedScheduler();
const [action, id, revision, ...extra] = process.argv.slice(2);
try {
  if (extra.length || !id || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid scheduler arguments');
  const authority = schedulerAuthority();
  const row = action === 'trigger' && revision && /^[1-9]\d{0,9}$/.test(revision) && Number(revision) <= 2147483647
    ? await scheduler.trigger(id, Number(revision), authority)
    : action === 'recover' && revision === undefined ? await scheduler.recover(id, authority) : undefined;
  if (!row) throw new Error('Unsupported scheduler operation');
  console.log(JSON.stringify({ occurrenceId: row.occurrenceId, state: row.state, settlementPending: row.settlementPending }));
  process.exitCode = row.state === 'completed' && !row.settlementPending ? 0 : 1;
} catch {
  console.error('Managed scheduler occurrence unavailable; no automatic replay'); process.exitCode = 1;
}
