import { config } from 'dotenv';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env') });

const apply = process.argv.includes('--apply');
const restore = process.argv.includes('--restore-backup');
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const backupPath = option('--backup');
const { getDb, disconnectDb } = await import('../src/db/index.js');
const {
  applyWebhookCredentialMigration,
  assertWebhookMigrationCanApply,
  inspectWebhookCredentialMigration,
} = await import('../src/services/webhook-credential-migration.js');

assertWebhookMigrationCanApply(apply);
assertWebhookMigrationCanApply(restore);

type BackupRow = { id: string; secret: string | null; headers: string };

function assertPrivateFile(file: string): void {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error('Webhook credential backup must be a regular non-symlink mode-0600 file');
  }
}

function writeBackup(file: string, rows: BackupRow[]): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || (directoryMetadata.mode & 0o077) !== 0) {
    throw new Error('Webhook credential backup directory must be mode 0700');
  }
  const temporary = `${file}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    temporaryExists = true;
    writeFileSync(descriptor, `${JSON.stringify({ version: 1, rows })}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    temporaryExists = false;
    chmodSync(file, 0o600);
    const directoryDescriptor = openSync(directory, 'r');
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryExists) {
      try { unlinkSync(temporary); } catch { /* retain the original write error */ }
    }
  }
}

function readBackup(file: string): BackupRow[] {
  assertPrivateFile(file);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; rows?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.rows)) throw new Error('Webhook credential backup is invalid');
  return parsed.rows.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Webhook credential backup row ${index} is invalid`);
    const row = raw as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || (row['secret'] !== null && typeof row['secret'] !== 'string') || typeof row['headers'] !== 'string') {
      throw new Error(`Webhook credential backup row ${index} is invalid`);
    }
    return { id: row['id'], secret: row['secret'], headers: row['headers'] } as BackupRow;
  });
}

async function main(): Promise<void> {
  const db = getDb();
  if (restore) {
    if (!backupPath) throw new Error('--restore-backup requires --backup <path>');
    const original = readBackup(resolve(backupPath));
    await db.$transaction(async (transaction) => {
      const current = await transaction.webhookEndpoint.findMany({ orderBy: { id: 'asc' } });
      if (current.length !== original.length || current.some((row, index) => row.id !== original[index]?.id)) {
        throw new Error('Webhook credential backup no longer matches the endpoint set');
      }
      for (const row of original) {
        await transaction.webhookEndpoint.update({
          where: { id: row.id },
          data: { secret: row.secret, headers: row.headers },
        });
      }
      const verified = await transaction.webhookEndpoint.findMany({ orderBy: { id: 'asc' } });
      if (verified.some((row, index) => row.secret !== original[index]?.secret || row.headers !== original[index]?.headers)) {
        throw new Error('Webhook credential backup restore verification failed');
      }
    }, { maxWait: 5_000, timeout: 60_000 });
    process.stdout.write(`Webhook credential backup restored and verified: ${original.length} endpoint(s)\n`);
    return;
  }
  if (!apply) {
    const rows = await db.webhookEndpoint.findMany({ orderBy: { id: 'asc' } });
    const result = inspectWebhookCredentialMigration(rows);
    process.stdout.write(`Webhook credential migration dry run: ${result.pending}/${result.total} endpoint(s) require migration\n`);
    return;
  }
  if (!backupPath) throw new Error('--apply requires --backup <path>');
  const before = await db.webhookEndpoint.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, secret: true, headers: true },
  });
  writeBackup(resolve(backupPath), before);
  const result = await applyWebhookCredentialMigration(db);
  process.stdout.write(`Webhook credential migration applied and verified: ${result.migrated}/${result.total} endpoint(s) migrated\n`);
}

try {
  await main();
} finally {
  await disconnectDb();
}
