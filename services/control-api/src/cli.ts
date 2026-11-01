#!/usr/bin/env node
// magnus-server: npm and container entry point. Server modules read the
// environment when they are imported, so they load only after the env files
// named on the command line have been applied.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE, UsageError, type CliOptions } from './cli/args.js';
import { buildEnvSchemaDocument, renderEnvTable } from './cli/env-catalog.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(PACKAGE_ROOT, 'prisma', 'migrations');
const PRISMA_CONFIG = join(PACKAGE_ROOT, 'prisma.config.ts');

class FatalError extends Error {}
const fatal = (...lines: string[]): never => { throw new FatalError(lines.join('\n')); };

function loadEnvFiles(paths: readonly string[]): void {
  for (const path of paths) {
    const absolute = resolve(path);
    if (!existsSync(absolute)) fatal(`Configuration error: env file ${absolute} (--env-file) does not exist.`);
    try {
      process.loadEnvFile(absolute);
    } catch (error) {
      fatal(`Configuration error: cannot read env file ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // The server entry point loads MAGNUS_ENV_FILE itself; point it at the
  // first explicit file so it never falls back to a package-local .env.
  if (paths[0]) process.env['MAGNUS_ENV_FILE'] = resolve(paths[0]);
  dropEmptyValues();
}

/** Empty assignments (env files, Compose `${VAR:-}`) mean "unset". */
function dropEmptyValues(): void {
  for (const [key, value] of Object.entries(process.env)) if (value === '') delete process.env[key];
}

async function version(): Promise<string> {
  const { CONTROL_API_VERSION } = await import('./config/version.js');
  return CONTROL_API_VERSION;
}

/** Run `prisma migrate deploy` against the packaged schema and migrations. */
async function migrate(): Promise<void> {
  if (!process.env['DATABASE_URL'] && process.env['NODE_ENV'] === 'production')
    fatal('Configuration error: DATABASE_URL is required to run migrations in production.');
  const { prismaCliPath } = await import('./cli/migrations.js');
  let prismaCli: string;
  try {
    prismaCli = prismaCliPath();
  } catch {
    return fatal('Migration error: the prisma CLI package is not installed next to magnus-server.');
  }
  const code = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [prismaCli, 'migrate', 'deploy', '--config', PRISMA_CONFIG], {
      cwd: PACKAGE_ROOT, env: process.env, stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', exitCode => resolvePromise(exitCode ?? 1));
  });
  if (code !== 0) fatal(`Migration error: prisma migrate deploy exited with code ${code}.`);
  // Base rows (system actor, sentinel nodes, starter library); idempotent.
  const { getDb, disconnectDb } = await import('./db/client.js');
  const { seedDatabase } = await import('./db/seed.js');
  try {
    await seedDatabase(getDb(), () => undefined);
    console.log('  ✓ Base data present (system actor, sentinel nodes, library)');
  } finally {
    await disconnectDb();
  }
}

async function commandCheck(format: 'json' | 'table'): Promise<number> {
  const { listMissingSecrets } = await import('./utils/env.js');
  const { loadEnv } = await import('./config/env.js');
  const { featureFlags } = await import('./config/features.js');
  const { resolveDatabaseUrl } = await import('./db/client.js');
  const { checkDatabase, checkRedis, checkTls } = await import('./cli/preflight.js');
  type Result = { name: string; status: 'pass' | 'warn' | 'fail'; message: string };
  const results: Result[] = [];

  const missing = listMissingSecrets();
  results.push(missing.length === 0
    ? { name: 'secrets', status: 'pass', message: 'all required secrets are set' }
    : { name: 'secrets', status: 'fail', message: `missing or too short: ${missing.join('; ')}` });
  try {
    loadEnv();
    results.push({ name: 'environment', status: 'pass', message: 'schema validation passed' });
  } catch (error) {
    results.push({ name: 'environment', status: 'fail', message: (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 600) });
  }
  results.push(checkTls(process.env));
  let databaseUrl: string | null = null;
  try { databaseUrl = resolveDatabaseUrl(); } catch (error) {
    results.push({ name: 'database', status: 'fail', message: error instanceof Error ? error.message : String(error) });
  }
  if (databaseUrl) results.push(...await checkDatabase(databaseUrl, MIGRATIONS_DIR));
  results.push(await checkRedis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379'));
  const { checkForUpdate, updateResult } = await import('./services/update-check-service.js');
  const update = await checkForUpdate();
  results.push(updateResult(update));

  const features = featureFlags();
  const failures = results.filter(result => result.status === 'fail').length;
  if (format === 'json') {
    console.log(JSON.stringify({ version: await version(), ok: failures === 0, results, integrations: features, update }, null, 2));
    return failures === 0 ? 0 : 1;
  }
  const symbol = { pass: '✓', warn: '!', fail: '✗' } as const;
  console.log(`magnus-server ${await version()} configuration check`);
  for (const result of results) console.log(`  ${symbol[result.status]} ${result.name.padEnd(12)} ${result.message}`);

  const onOff = (value: boolean) => (value ? 'on' : 'off');
  console.log('Integrations:');
  console.log(`  Hive IAM           ${onOff(features.iam)}`);
  console.log(`  Hive Router        ${onOff(features.router)}`);
  console.log(`  HiveMem            ${onOff(features.hivemem)}`);
  console.log(`  Security Fusion    ${features.securityFusion}${features.securityFusion === 'remote' && features.securityConsoleUrl ? ` (${features.securityConsoleUrl})` : ''}`);
  console.log(`  Hermes plugin API  ${onOff(features.pluginApi)}`);
  console.log(`  Hermes registry    ${onOff(features.hermesRegistry)}`);
  console.log(`  Resource leases    ${onOff(features.resourceLeases)}`);
  console.log(`  Agent discovery    ${onOff(features.agentDiscovery)}`);

  console.log(failures === 0 ? 'Result: OK' : `Result: ${failures} problem(s) found`);
  return failures === 0 ? 0 : 1;
}

/** Applied and pending migrations, with impact notes (`--format json` for tooling). */
async function commandMigrations(format: 'json' | 'table'): Promise<number> {
  const { resolveDatabaseUrl } = await import('./db/client.js');
  const { readMigrationState } = await import('./cli/migrations.js');
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: resolveDatabaseUrl(), connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const state = await readMigrationState(client, MIGRATIONS_DIR);
    if (format === 'json') {
      console.log(JSON.stringify({ version: await version(), packaged: state.packaged, applied: [...state.applied].sort(), pending: state.pending, fresh: state.fresh }, null, 2));
    } else {
      for (const name of state.packaged) {
        const pending = state.pending.find(migration => migration.name === name);
        console.log(`  ${pending ? '…' : '✓'} ${name}${pending ? ` (pending, ${pending.impact}${pending.note ? `: ${pending.note}` : ''})` : ''}`);
      }
      console.log(state.pending.length === 0 ? 'All migrations applied.' : `${state.pending.length} pending; run \`magnus-server migrate\`.`);
    }
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** `pg_dump -Fc` into MAGNUS_BACKUP_DIR; prints JSON with the file and restore command. */
async function commandBackup(label: string | undefined): Promise<number> {
  const { resolveDatabaseUrl } = await import('./db/client.js');
  const { backupDatabase } = await import('./cli/migrations.js');
  const { defaultBackupDir } = await import('./cli/auto-migrate.js');
  const { magnusHome } = await import('./utils/magnus-home.js');
  const pg = (await import('pg')).default;
  const databaseUrl = resolveDatabaseUrl();
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const result = await backupDatabase({
      databaseUrl, client, backupDir: defaultBackupDir(process.env, magnusHome()),
      label: label ?? `manual-${await version()}`, pgDump: process.env['MAGNUS_PG_DUMP'],
    });
    console.log(JSON.stringify(result));
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** `MAGNUS_AUTO_MIGRATE=true`: back up and migrate under an advisory lock before listening. */
async function startupAutoMigrate(): Promise<void> {
  const { upgradeSettings } = await import('./config/features.js');
  const settings = upgradeSettings();
  if (!settings.autoMigrate) return;
  const { resolveDatabaseUrl } = await import('./db/client.js');
  const { autoMigrate, defaultBackupDir } = await import('./cli/auto-migrate.js');
  const { magnusHome } = await import('./utils/magnus-home.js');
  try {
    await autoMigrate({
      databaseUrl: resolveDatabaseUrl(),
      migrationsDir: MIGRATIONS_DIR,
      backupDir: defaultBackupDir(process.env, magnusHome()),
      version: await version(),
      settings,
      pgDump: process.env['MAGNUS_PG_DUMP'],
      migrate,
    });
  } catch (error) {
    if (error instanceof FatalError) throw error;
    fatal(error instanceof Error ? error.message : String(error));
  }
}

async function commandStart(options: CliOptions): Promise<void> {
  // Without --env-file the server reads its package-level .env; apply it here
  // too so startup switches such as MAGNUS_AUTO_MIGRATE see the same values.
  const packageEnv = join(PACKAGE_ROOT, '.env');
  if (!process.env['MAGNUS_ENV_FILE'] && existsSync(packageEnv)) { process.loadEnvFile(packageEnv); dropEmptyValues(); }
  if (options.migrate) await migrate();
  else await startupAutoMigrate();
  await import('./index.js');
}

async function run(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  dropEmptyValues();
  switch (options.command) {
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    case 'version':
      console.log(await version());
      return 0;
    case 'env-schema':
      if (options.format === 'table') process.stdout.write(renderEnvTable());
      else console.log(JSON.stringify(buildEnvSchemaDocument(), null, 2));
      return 0;
    case 'check':
      loadEnvFiles(options.envFiles);
      return commandCheck(options.formatGiven ? options.format : 'table');
    case 'migrations':
      loadEnvFiles(options.envFiles);
      return commandMigrations(options.formatGiven ? options.format : 'table');
    case 'backup':
      loadEnvFiles(options.envFiles);
      return commandBackup(options.label);
    case 'upgrade':
    case 'rollback': {
      const { delegateToProject } = await import('./cli/upgrade.js');
      return delegateToProject(options.command, options.passthrough, PACKAGE_ROOT);
    }
    case 'agents': {
      loadEnvFiles(options.envFiles);
      const { commandAgents } = await import('./cli/agents.js');
      return commandAgents(options.passthrough);
    }
    case 'migrate':
      loadEnvFiles(options.envFiles);
      await migrate();
      return 0;
    case 'start':
      loadEnvFiles(options.envFiles);
      await commandStart(options);
      return -1; // the server keeps the process alive
  }
}

run(process.argv.slice(2)).then(
  code => { if (code >= 0) process.exit(code); },
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`magnus-server: ${error.message}. Run \`magnus-server --help\` for usage.`);
      process.exit(2);
    }
    if (error instanceof FatalError) {
      console.error(error.message);
      process.exit(1);
    }
    console.error(`Startup error: ${error instanceof Error ? error.message : String(error)}`);
    if (process.env['MAGNUS_DEBUG']) console.error(error);
    process.exit(1);
  },
);
