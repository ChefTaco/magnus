import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectDisks, parseDiskOutput, parseWazuhManagerAddresses } from './health-collector.js';

describe('parseWazuhManagerAddresses', () => {
  it('reads a Wazuh 5 endpoint without the scheme, port, or path', () => {
    for (const [endpoint, host] of [
      [' manager.example.com ', 'manager.example.com'],
      ['https://manager.example.com:1517/wazuh-manager', 'manager.example.com'],
      ['manager.example.com:8443/gateway', 'manager.example.com'],
      ['192.0.2.5:1517', '192.0.2.5'],
      ['https://[2001:db8::1]:1517/', '2001:db8::1'],
      ['[fe80::1%eth0]:1517', 'fe80::1%eth0'],
    ]) {
      expect(parseWazuhManagerAddresses(
        `<ossec_config><agent><manager><endpoint>${endpoint}</endpoint></manager></agent></ossec_config>`,
      )).toEqual([host]);
    }
  });

  it('reports the last manager block, as the Wazuh 5 agent uses only that one', () => {
    expect(parseWazuhManagerAddresses(`
      <ossec_config>
        <agent><manager><endpoint>first.example.com</endpoint></manager></agent>
      </ossec_config>
      <ossec_config>
        <agent><manager><endpoint>manager.example.com:1517</endpoint></manager></agent>
      </ossec_config>
    `)).toEqual(['manager.example.com']);
  });

  it('prefers the Wazuh 5 endpoint over deprecated and legacy addresses', () => {
    expect(parseWazuhManagerAddresses(`
      <ossec_config>
        <client><server><address>legacy.example.com</address></server></client>
        <agent><manager>
          <address>deprecated.example.com</address><port>1514</port>
          <endpoint>manager.example.com</endpoint>
        </manager></agent>
      </ossec_config>
    `)).toEqual(['manager.example.com']);
    expect(parseWazuhManagerAddresses(`
      <ossec_config>
        <client><server><address>legacy.example.com</address></server></client>
        <agent><manager><address>deprecated.example.com</address></manager></agent>
      </ossec_config>
    `)).toEqual(['deprecated.example.com']);
  });

  it('preserves legacy failover addresses and ignores comments and unrelated sections', () => {
    expect(parseWazuhManagerAddresses(`
      <ossec_config>
        <!-- <agent><manager><endpoint>comment.example.com</endpoint></manager></agent> -->
        <client>
          <server><address>primary.example.com</address><port>1514</port></server>
          <server><address>2001:db8::2</address></server>
          <server><address>primary.example.com</address></server>
        </client>
        <agent><enrollment><endpoint>enrollment.example.com</endpoint></enrollment></agent>
        <integration><address>integration.example.com</address></integration>
      </ossec_config>
    `)).toEqual(['primary.example.com', '2001:db8::2']);
  });

  it('ignores invalid endpoints and refuses entity declarations', () => {
    for (const endpoint of ['https://operator:fake-password@manager.example.com', 'http://manager.example.com', '']) {
      expect(parseWazuhManagerAddresses(
        `<ossec_config><agent><manager><endpoint>${endpoint}</endpoint></manager></agent></ossec_config>`,
      )).toEqual([]);
    }
    expect(parseWazuhManagerAddresses(`
      <!DOCTYPE ossec_config [<!ENTITY host "manager.example.com">]>
      <ossec_config><agent><manager><endpoint>&host;</endpoint></manager></agent></ossec_config>
    `)).toEqual([]);
  });
});

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
