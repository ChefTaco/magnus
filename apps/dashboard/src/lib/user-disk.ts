import type { DiskInfo } from '@/types/contracts';

export const USER_DISK_WARNING_PERCENT = 80;
export const USER_DISK_CRITICAL_PERCENT = 95;

type SerializedDisks = string | DiskInfo[] | null | undefined;

const SYSTEM_MOUNT_PREFIXES = ['/boot', '/snap', '/var/lib/docker/', '/var/lib/containers/'];
const READ_ONLY_FILESYSTEMS = new Set(['iso9660', 'squashfs']);

export function parseDisks(disks: SerializedDisks): DiskInfo[] {
  if (Array.isArray(disks)) return disks;
  if (!disks) return [];

  try {
    const parsed = JSON.parse(disks) as unknown;
    return Array.isArray(parsed) ? parsed as DiskInfo[] : [];
  } catch {
    return [];
  }
}

/** Return the primary user-data filesystem, falling back to the root filesystem. */
export function getUserDisk(disks: SerializedDisks): DiskInfo | null {
  const parsed = parseDisks(disks);
  const dataDisks = parsed
    .filter((disk) => disk.mountPoint.startsWith('/mnt/') || disk.mountPoint.startsWith('/srv/'))
    .sort((a, b) => b.usagePercent - a.usagePercent);
  return parsed.find((disk) => disk.mountPoint === '/mnt/user')
    ?? parsed.find((disk) => disk.mountPoint === '/home')
    ?? dataDisks[0]
    ?? parsed.find((disk) => disk.mountPoint === '/')
    ?? null;
}

/** Return the fullest workload-relevant persistent filesystem for fleet severity. */
export function getWorstPersistentDisk(disks: SerializedDisks): DiskInfo | null {
  return parseDisks(disks)
    .filter((disk) => (
      disk.mountPoint === '/'
      || disk.mountPoint === '/home'
      || disk.mountPoint.startsWith('/home/')
      || disk.mountPoint.startsWith('/mnt/')
      || disk.mountPoint.startsWith('/srv/')
    ))
    .filter((disk) => !SYSTEM_MOUNT_PREFIXES.some((prefix) => disk.mountPoint === prefix || disk.mountPoint.startsWith(prefix)))
    .filter((disk) => !READ_ONLY_FILESYSTEMS.has((disk.filesystemType ?? '').toLowerCase()))
    .sort((a, b) => b.usagePercent - a.usagePercent)[0] ?? null;
}

export function getUserDiskSeverity(
  usagePercent: number,
): 'normal' | 'warning' | 'critical' {
  if (usagePercent >= USER_DISK_CRITICAL_PERCENT) return 'critical';
  if (usagePercent >= USER_DISK_WARNING_PERCENT) return 'warning';
  return 'normal';
}
