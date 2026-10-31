import { describe, expect, it } from 'vitest';
import { selectStorageMount } from './storage-evidence.js';
describe('storage investigation admission', () => {
  it('rejects arbitrary directories and pseudo filesystems', () => {
    const raw = {
      filesystems: [
        { target: '/proc', source: 'proc', fstype: 'proc' },
        { target: '/data', source: '/dev/sda', fstype: 'ext4' },
      ],
    };
    expect(() => selectStorageMount(raw, '/proc')).toThrow();
    expect(() => selectStorageMount(raw, '/data/private')).toThrow();
    expect(selectStorageMount(raw, '/data').shared).toBe(false);
  });
  it('gives the same share one identity across mount locations', () => {
    const a = selectStorageMount(
      { filesystems: [{ target: '/a', source: 'nas:/volume', fstype: 'nfs4' }] },
      '/a',
    );
    const b = selectStorageMount(
      { filesystems: [{ target: '/b', source: 'nas:/volume', fstype: 'nfs4' }] },
      '/b',
    );
    expect(a.shared).toBe(true);
    expect(a.volumeId).toBe(b.volumeId);
  });
});
