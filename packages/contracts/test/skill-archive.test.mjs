import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARDENT_SKILL_ARCHIVE_LIMITS, ARDENT_STUDIO_CAPABILITY, ardentSkillInstallNodeSchema, ardentSkillInstallResultSchema,
  checkArdentSkillArchive, readSkillTar, skillFrontmatterBlock,
} from '../dist/index.js';

/** A ustar archive of [name, contents | null for a directory, type?] entries, as HiveSkills publishes them. */
function tar(entries) {
  const blocks = [];
  for (const [name, contents, type = contents === null ? '5' : '0'] of entries) {
    const body = Buffer.from(contents ?? '');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write(type, 156);
    header.write('ustar\0', 257); header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(Buffer.concat(blocks));
}
const skill = (name = 'web-research', description = 'Search the web carefully.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# Web research\n`;
const parseYaml = (source) => Object.fromEntries(source.split('\n').filter(Boolean).map((line) => line.split(/:\s*/u, 2)));

test('accepts a skill archive Ardent indexes under the requested name', () => {
  const archive = tar([['SKILL.md', skill()], ['references', null], ['references/tools.md', '# Tools\n']]);
  const checked = checkArdentSkillArchive(archive, 'web-research', parseYaml);
  assert.equal(checked.files, 2);
  assert.match(checked.skillMd, /# Web research/u);
  assert.equal(readSkillTar(archive).length, 3);
});

test('refuses unsafe paths, links, the receipt name and a missing SKILL.md', () => {
  for (const [entries, message] of [
    [[['SKILL.md', skill()], ['../escape.md', 'x']], /Unsafe/u],
    [[['SKILL.md', skill()], ['/etc/passwd', 'x']], /Unsafe/u],
    [[['SKILL.md', skill()], ['link', 'target', '2']], /regular files/u],
    [[['SKILL.md', skill()], ['SKILL.md', skill()]], /duplicate/u],
    [[['SKILL.md', skill()], ['.hiveskills.json', '{}']], /reserved/u],
    [[['README.md', '# Readme']], /root SKILL\.md/u],
    [[['SKILL.md', skill()], ['notes', 'x'], ['notes/inner.md', 'y']], /overlaps/u],
  ]) assert.throws(() => readSkillTar(tar(entries)), message, JSON.stringify(entries.map(([name]) => name)));
  const header = tar([['SKILL.md', skill()]]);
  header[10] ^= 0x01;
  assert.throws(() => readSkillTar(header), /checksum/u);
});

test('refuses archives over the Ardent install bounds', () => {
  assert.throws(() => readSkillTar(new Uint8Array(ARDENT_SKILL_ARCHIVE_LIMITS.unpackedBytes + 1)), /unpacked size/u);
  const many = [['SKILL.md', skill()], ...Array.from({ length: ARDENT_SKILL_ARCHIVE_LIMITS.entries }, (_, index) => [`f${index}.md`, 'x'])];
  assert.throws(() => readSkillTar(tar(many)), /too many entries/u);
  assert.throws(() => checkArdentSkillArchive(tar([['SKILL.md', skill() + 'x'.repeat(ARDENT_SKILL_ARCHIVE_LIMITS.skillMdBytes)]]), 'web-research', parseYaml), /64 KiB/u);
});

test('checks SKILL.md front matter the way Ardent indexes it', () => {
  assert.equal(skillFrontmatterBlock('# No front matter\n'), null);
  assert.equal(skillFrontmatterBlock('---\nname: a\n'), null);
  assert.equal(skillFrontmatterBlock(skill()), 'name: web-research\ndescription: Search the web carefully.');
  assert.throws(() => checkArdentSkillArchive(tar([['SKILL.md', '# Untitled\n']]), 'web-research', parseYaml), /no front matter/u);
  assert.throws(() => checkArdentSkillArchive(tar([['SKILL.md', skill('other-skill')]]), 'web-research', parseYaml), /names the skill other-skill/u);
  assert.throws(() => checkArdentSkillArchive(tar([['SKILL.md', skill('web-research', '')]]), 'web-research', parseYaml), /description/u);
  assert.throws(() => checkArdentSkillArchive(tar([['SKILL.md', skill()]]), 'web-research', () => { throw new Error('bad'); }), /not valid YAML/u);
});

test('the node body carries the verified archive, and the answer reports enablement separately', () => {
  assert.equal(ARDENT_STUDIO_CAPABILITY.skillInstall, 3);
  const body = { source: 'hiveskills', name: 'web-research', version: '1.2.0', sha256: 'a'.repeat(64), archive_base64: 'H4sIAAAA' };
  assert.equal(ardentSkillInstallNodeSchema.safeParse(body).success, true);
  assert.equal(ardentSkillInstallNodeSchema.safeParse({ ...body, enable: true }).success, false);
  assert.equal(ardentSkillInstallNodeSchema.safeParse({ ...body, archive_base64: 'x'.repeat(1_398_105) }).success, false);
  assert.equal(ardentSkillInstallResultSchema.safeParse({ source: 'hiveskills', name: 'web-research', version: '1.2.0', sha256: 'a'.repeat(64),
    files: 1, changed: true, enabled: false, revision: null, enable_error: 'The Ardent revision changed', activation_required: true }).success, true);
});
