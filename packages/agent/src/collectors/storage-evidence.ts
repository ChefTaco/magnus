import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Hono } from 'hono';
const exec = promisify(execFile);
const TYPES = new Set(['ext4', 'ext3', 'xfs', 'btrfs', 'zfs', 'nfs', 'nfs4', 'cifs']);
export function selectStorageMount(raw: unknown, mount: string) {
  const entries = (
    raw as { filesystems?: Array<{ target: string; source: string; fstype: string }> }
  )?.filesystems;
  const entry = entries?.find((e) => e.target === mount);
  if (!entry || !TYPES.has(entry.fstype) || !mount.startsWith('/') || /[\r\n\0]/.test(mount))
    throw new Error('Choose an exact supported persistent mount');
  const shared = ['nfs', 'nfs4', 'cifs'].includes(entry.fstype);
  const volumeId = createHash('sha256')
    .update(
      `${shared ? 'share' : (process.env['HOST_FQDN'] ?? 'local')}:${entry.fstype}:${entry.source}`,
    )
    .digest('hex');
  return { ...entry, shared, volumeId };
}
export async function collectStorageEvidence(mount: string) {
  const started = Date.now();
  const { stdout: mounts } = await exec(
    'findmnt',
    ['--json', '--list', '--output', 'TARGET,SOURCE,FSTYPE'],
    { timeout: 2000, maxBuffer: 131072 },
  );
  const selected = selectStorageMount(JSON.parse(mounts), mount);
  // Never recursively scan network shares: inode walking itself can overload the NAS.
  if (selected.shared)
    return {
      ...selected,
      observedAt: new Date().toISOString(),
      status: 'unknown',
      directories: [],
      explanation:
        'Shared volume: count this volumeId once across hosts. Exported file totals cannot explain NAS snapshots, reservations or server-side usage; request storage-side accounting.',
    };
  let output = '';
  let complete = true;
  try {
    output = (
      await exec(
        'ionice',
        ['-c', '3', 'nice', '-n', '19', 'du', '-x', '--block-size=1', '--max-depth=1', '--', mount],
        { timeout: 10000, maxBuffer: 131072, killSignal: 'SIGKILL' },
      )
    ).stdout;
  } catch (error) {
    complete = false;
    output = String((error as { stdout?: string }).stdout ?? '').slice(0, 131072);
  }
  const directories = output
    .split('\n')
    .flatMap((line) => {
      const match = /^(\d+)\t([^\r\n]+)$/.exec(line);
      return match ? [{ path: match[2], bytes: Number(match[1]) }] : [];
    })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 20);
  return {
    ...selected,
    observedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    status: complete ? 'pass' : 'partial',
    directories,
    explanation:
      'Read-only allocated-byte sample, one filesystem, top 20. Compare successive reports for growth; permission errors or time limits make totals incomplete.',
  };
}
export const storageEvidenceRoutes = new Hono();
let active = false;
storageEvidenceRoutes.get('/', async (c) => {
  if (active)
    return c.json({ success: false, error: 'A storage investigation is already running' }, 429);
  const mount = c.req.query('mount');
  if (!mount || mount.length > 4096)
    return c.json({ success: false, error: 'Mount required' }, 400);
  active = true;
  try {
    return c.json({ success: true, data: await collectStorageEvidence(mount) });
  } catch {
    return c.json({ success: false, error: 'Storage evidence unavailable for this mount' }, 400);
  } finally {
    active = false;
  }
});
