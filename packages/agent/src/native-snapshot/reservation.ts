import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** A stopped snapshot cannot be escaped by restarting the native manager. */
export async function assertNoNativeSnapshotReservation(install = resolve(process.env['AGENT_INSTALL_DIR'] ?? process.cwd())): Promise<void> {
  const file = join(install, '.native-snapshot-reservation.json');
  const info = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (info) throw new Error('A native snapshot session holds this manager stopped; inspect its journal and use native-snapshot resume, without replaying incomplete work');
}
