import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSkillSchema, updateSkillSchema } from '../schemas/skills.js';
import { createSkill, deleteSkill, getSkill, getSkillFile, updateSkill, updateSkillFile } from './skill-service.js';

let root: string;
let skills: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'magnus-skills-'));
  skills = path.join(root, 'skills');
  await mkdir(skills);
  process.env['SKILLS_DIR'] = skills;
});

afterEach(async () => {
  delete process.env['SKILLS_DIR'];
  await rm(root, { recursive: true, force: true });
});

describe('skill storage stays inside the skills directory', () => {
  it('creates a skill with its manifest and entry point', async () => {
    const skill = await createSkill({ name: 'disk-check', version: '1.2.0' });
    expect(skill.files.sort()).toEqual(['manifest.json', 'run.sh']);
    expect(await readFile(path.join(skills, 'disk-check', 'run.sh'), 'utf-8')).toContain('echo "disk-check v1.2.0"');
  });

  it.each(['../escaped', '..', 'a/b', '/tmp/absolute', 'with space', 'semi;colon', ''])('refuses to create a skill named %j', async (name) => {
    await expect(createSkill({ name, version: '1.0.0' })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(await readdir(root)).toEqual(['skills']);
    expect(await readdir(skills)).toEqual([]);
  });

  it.each(['../../outside.sh', '/tmp/outside.sh', 'sub/run.sh', '..'])('refuses the entry point %j and creates nothing', async (entryPoint) => {
    await expect(createSkill({ name: 'disk-check', version: '1.0.0', entryPoint })).rejects.toMatchObject({ status: 400 });
    await expect(updateSkill('disk-check', { entryPoint })).rejects.toBeTruthy();
    expect(await readdir(root)).toEqual(['skills']);
    expect(await readdir(skills)).toEqual([]);
  });

  it('keeps shell syntax in a version out of the generated script', async () => {
    await createSkill({ name: 'disk-check', version: '1.0.0"; touch /tmp/owned; echo "' });
    const script = await readFile(path.join(skills, 'disk-check', 'run.sh'), 'utf-8');
    expect(script).toContain('echo "disk-check"');
    expect(script).not.toContain('touch');
  });

  it('never reads or writes a file of another skill or outside the directory', async () => {
    await createSkill({ name: 'disk', version: '1.0.0' });
    await createSkill({ name: 'disk-check', version: '1.0.0' });
    await writeFile(path.join(root, 'secret.txt'), 'outside');

    // A sibling whose name starts with this skill's name used to pass the prefix check.
    await expect(updateSkillFile('disk', '../disk-check/run.sh', 'changed')).rejects.toMatchObject({ status: 400 });
    await expect(updateSkillFile('disk', '../../secret.txt', 'changed')).rejects.toMatchObject({ status: 400 });
    expect(await getSkillFile('disk', '../disk-check/manifest.json')).toBeNull();
    expect(await getSkillFile('disk', '../../secret.txt')).toBeNull();
    expect(await getSkill('../skills/disk')).toBeNull();
    expect(await readFile(path.join(skills, 'disk-check', 'run.sh'), 'utf-8')).not.toBe('changed');
    expect(await readFile(path.join(root, 'secret.txt'), 'utf-8')).toBe('outside');

    await updateSkillFile('disk', 'notes.md', 'kept');
    expect(await getSkillFile('disk', 'notes.md')).toBe('kept');
  });

  it('refuses to delete outside the skills directory', async () => {
    await expect(deleteSkill('..')).rejects.toMatchObject({ status: 400 });
    await expect(deleteSkill('../skills')).rejects.toMatchObject({ status: 400 });
    expect(await readdir(root)).toEqual(['skills']);
  });

  it('refuses the same input at the route schemas', () => {
    expect(createSkillSchema.safeParse({ name: '../x', version: '1.0.0' }).success).toBe(false);
    expect(createSkillSchema.safeParse({ name: 'ok-name_1', version: '1.0.0', entryPoint: '../x.sh' }).success).toBe(false);
    expect(updateSkillSchema.safeParse({ entryPoint: 'a/b.sh' }).success).toBe(false);
    expect(createSkillSchema.safeParse({ name: 'ok-name_1', version: '1.0.0', entryPoint: 'main.sh' }).success).toBe(true);
  });
});
