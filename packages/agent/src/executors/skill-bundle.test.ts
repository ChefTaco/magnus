import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractSkillBundle } from './skill-bundle.js';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
function archive(mode = '0000644', size = '00000000004', type = '0') {
  const buffer = Buffer.alloc(2048); const header = buffer.subarray(0, 512);
  header.write('fixture/SKILL.md', 0); header.write(mode, 100, 7); header.write('0000000', 108, 7); header.write('0000000', 116, 7);
  header.write(size, 124, 11); header.write('00000000000', 136, 11); header.fill(32, 148, 156); header.write(type, 156, 1); header.write('ustar', 257, 5); header.write('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8); buffer.write('test', 512); return gzipSync(buffer);
}
it('extracts ordinary tar headers after validating their numeric fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-bundle-headers-')); dirs.push(root);
  await extractSkillBundle(archive(), root); expect(await readFile(join(root, 'fixture/SKILL.md'), 'utf8')).toBe('test');
});
it('rejects invalid modes, sizes and link entries before writing files', async () => {
  for (const bundle of [archive('invalid'), archive('7777777'), archive('0000644', 'invalid'), archive('0000644', '00000000004', '2')]) {
    const root = await mkdtemp(join(tmpdir(), 'skill-bundle-invalid-')); dirs.push(root);
    await expect(extractSkillBundle(bundle, root)).rejects.toThrow(); expect(await readdir(root)).toEqual([]);
  }
});
