import { describe, expect, it } from 'vitest';
import { parseDiskOutput } from './health-collector.js';

describe('parseDiskOutput', () => {
  it('keeps local, network, and Unraid user-share filesystems', () => {
    const disks = parseDiskOutput([
      '/dev/sda2 ext4 1000 400 600 40% /',
      '192.0.2.30:/volume1/shared nfs4 2000 1600 400 80% /mnt/shared',
      'shfs fuse.shfs 3000 2730 270 91% /mnt/user',
    ].join('\n'));

    expect(disks.map(({ mountPoint, usagePercent }) => ({ mountPoint, usagePercent }))).toEqual([
      { mountPoint: '/', usagePercent: 40 },
      { mountPoint: '/mnt/shared', usagePercent: 80 },
      { mountPoint: '/mnt/user', usagePercent: 91 },
    ]);
    expect(disks.map((disk) => disk.filesystemType)).toEqual(['ext4', 'nfs4', 'fuse.shfs']);
  });

  it('excludes ephemeral and virtual filesystems', () => {
    const disks = parseDiskOutput([
      'tmpfs tmpfs 1000 10 990 1% /run',
      'overlay overlay 1000 500 500 50% /var/lib/docker/overlay2/example',
      '/dev/sda1 vfat 1000 10 990 1% /boot/efi',
    ].join('\n'));

    expect(disks.map((disk) => disk.mountPoint)).toEqual(['/boot/efi']);
  });
});
