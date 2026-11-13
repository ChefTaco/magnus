import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectDisks, parseDiskOutput } from './health-collector.js';

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

describe('collectDisks', () => {
  it('does not start another probe while an earlier one has not exited', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'magnus-df-'));
    try {
      const probe = join(directory, 'df');
      await writeFile(probe, `#!/bin/sh
echo started >> "${directory}/starts"
sleep 1
echo 'Filesystem Type 1B-blocks Used Avail Use% Mounted on'
echo '/dev/sda2 ext4 1000 400 600 40% /'
`);
      await chmod(probe, 0o755);
      const first = collectDisks(probe, 10_000);
      await new Promise(resolve => setTimeout(resolve, 300));
      // The earlier probe is still running: the last known result is reported at once.
      await expect(collectDisks(probe, 10_000)).resolves.toEqual([]);
      expect((await first).map(disk => disk.mountPoint)).toEqual(['/']);
      expect((await readFile(join(directory, 'starts'), 'utf8')).trim().split('\n')).toHaveLength(1);
      // Once it has exited, the next collection probes again.
      await new Promise(resolve => setTimeout(resolve, 50));
      expect((await collectDisks(probe, 10_000)).map(disk => disk.mountPoint)).toEqual(['/']);
      expect((await readFile(join(directory, 'starts'), 'utf8')).trim().split('\n')).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
