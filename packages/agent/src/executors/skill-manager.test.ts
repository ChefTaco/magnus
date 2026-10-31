import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { managedExecution, type ManagedExecutionContext } from '../security/managed-context.js';
import { assertSkillDirectoryAnchor, openSkillDirectoryAnchor, publishSkillBundle, recoverSkillPublication, skillBundleSha256, type SkillPublicationBody } from './skill-publication.js';

let base: string; let root: string; let outside: string; let app: Hono;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function body(version = '1.0.0', text = 'fixture'): SkillPublicationBody {
  const manifest = JSON.stringify({ name: 'fixture-skill', version });
  const entries = [{ path: 'README.md', mode: 0o644 as const, contentBase64: Buffer.from(text).toString('base64'), sha256: digest(text) },
    { path: 'manifest.json', mode: 0o644 as const, contentBase64: Buffer.from(manifest).toString('base64'), sha256: digest(manifest) },
    { path: 'scripts/run.sh', mode: 0o755 as const, contentBase64: Buffer.from('#!/bin/sh\ntrue\n').toString('base64'), sha256: digest('#!/bin/sh\ntrue\n') }];
  const bundle = { format: 'magnus-skill-bundle-v1' as const, entries };
  return { skillName: 'fixture-skill', version, bundle, bundleSha256: skillBundleSha256(bundle) };
}
function context(commandId = 'publish-one', requestSha256 = 'a'.repeat(64)): ManagedExecutionContext {
  return { claim: { leaseId: 'lease-one', nodeId: 'fixture', nodeFqdn: 'fixture.lab' }, commandId, requestSha256,
    coordination: { version: 1, resourceKey: 'node:fixture', fence: '1', expiresAt: Date.now() + 60_000 } };
}
function install(value: unknown, ctx?: ManagedExecutionContext) {
  const invoke = () => app.request('/skills/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return ctx ? managedExecution.run(ctx, invoke) : invoke();
}
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'skill-publication-')); root = join(base, 'skills'); outside = join(base, 'outside');
  vi.stubEnv('SKILLS_DIR', root); const { skillRoutes } = await import('./skill-manager.js'); app = new Hono().route('/skills', skillRoutes);
});
beforeEach(async () => {
  await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
  await mkdir(outside); await writeFile(join(outside, 'sentinel'), 'untouched');
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); });

describe('atomic managed skill publication', () => {
  it('fails closed for legacy URL, empty, and unmanaged publication requests', async () => {
    expect((await install({ skillName: 'fixture-skill', version: '1.0.0', downloadUrl: 'https://fixture.invalid/a.tgz' })).status).toBe(409);
    expect((await install(body())).status).toBe(409);
    expect(await lstat(root).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
  });

  it('publishes the exact verified tree through one rename and replays the immutable result', async () => {
    const input = body(); const ctx = context(); const first = await install(input, ctx);
    expect(first.status).toBe(200); const firstBody = await first.json();
    const target = join(root, input.skillName, input.version);
    expect(await readFile(join(target, 'README.md'), 'utf8')).toBe('fixture');
    expect((await lstat(join(target, 'scripts/run.sh'))).mode & 0o777).toBe(0o755);
    expect(firstBody.data).toMatchObject({ bundleSha256: input.bundleSha256, commandId: ctx.commandId, requestSha256: ctx.requestSha256 });
    const receipt = JSON.parse(await readFile(join(target, '.magnus-publication.json'), 'utf8'));
    expect(receipt.treeSha256).toBe(firstBody.data.treeSha256);
    const replay = await install(input, ctx); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(firstBody);
    expect((await readdir(root)).filter(name => name.startsWith('.skill-publish-'))).toEqual([]);
  });

  it('rejects noncanonical content, path order, entry digests, and bundle digest before touching the target', async () => {
    for (const mutate of [
      (value: SkillPublicationBody) => { value.bundle.entries.reverse(); },
      (value: SkillPublicationBody) => { value.bundle.entries[0]!.path = '../escape'; },
      (value: SkillPublicationBody) => { value.bundle.entries[0]!.sha256 = '0'.repeat(64); },
      (value: SkillPublicationBody) => { value.bundleSha256 = '0'.repeat(64); },
    ]) {
      const value = structuredClone(body()); mutate(value); const response = await install(value, context()); expect(response.status).toBe(400);
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
    }
  });

  it('keeps one skill version bound to its original command and exact content', async () => {
    expect((await install(body(), context())).status).toBe(200);
    expect((await install(body(), context('successor', 'b'.repeat(64)))).status).toBe(409);
    expect((await install(body('1.0.0', 'changed'), context())).status).toBe(409);
    expect(await readFile(join(root, 'fixture-skill', '1.0.0', 'README.md'), 'utf8')).toBe('fixture');
  });

  it('detects post-publication file and mode changes instead of signing a replay', async () => {
    const input = body(); const ctx = context(); expect((await install(input, ctx)).status).toBe(200);
    const file = join(root, 'fixture-skill', '1.0.0', 'README.md'); await writeFile(file, 'tampered');
    expect((await install(input, ctx)).status).toBe(409);
    await writeFile(file, 'fixture'); await chmod(file, 0o600);
    expect((await install(input, ctx)).status).toBe(409);
  });

  it('rejects symlink pivots without altering their referents', async () => {
    await mkdir(root, { mode: 0o755 }); await symlink(outside, join(root, 'fixture-skill'));
    expect((await install(body(), context())).status).toBe(400);
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
  });

  it.each(['root', 'skill'])('detects %s parent replacement while its original directory descriptor remains held', async kind => {
    await mkdir(join(root, 'fixture-skill'), { recursive: true, mode: 0o755 });
    const original = kind === 'root' ? root : join(root, 'fixture-skill'); const moved = `${original}.moved`;
    const handle = await openSkillDirectoryAnchor(original);
    try {
      await rename(original, moved); await symlink(outside, original);
      await expect(assertSkillDirectoryAnchor(original, handle)).rejects.toMatchObject({ code: 'SKILL_PARENT_REPLACED' });
    } finally { await handle.close(); }
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
  });

  it('rejects a configured skills root with a symlinked ancestor before creating its leaf', async () => {
    const actualParent = join(base, 'actual-parent'); const linkedParent = join(base, 'linked-parent');
    await mkdir(actualParent); await symlink(actualParent, linkedParent);
    await expect(publishSkillBundle(body(), context(), join(linkedParent, 'skills'))).rejects.toMatchObject({ code: 'UNSAFE_SKILL_PATH' });
    expect(await lstat(join(actualParent, 'skills')).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
  });

  it('detects a verified staged-payload inode swap before visibility', async () => {
    const input = body('4.0.0'); const ctx = context('payload-race', 'e'.repeat(64)); const raceRoot = join(base, 'payload-race-root');
    const stage = join(raceRoot, `.skill-publish-${digest(`${ctx.commandId}\0${ctx.requestSha256}`)}`);
    await expect(publishSkillBundle(input, ctx, raceRoot, { beforeVisibility: async () => {
      const staged = join(stage, 'container', input.version); await rename(staged, join(stage, 'stolen-payload')); await mkdir(staged);
    } })).rejects.toMatchObject({ code: 'SKILL_PARENT_REPLACED' });
    expect(await lstat(join(raceRoot, input.skillName)).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
    expect((await lstat(join(stage, 'stolen-payload'))).isDirectory()).toBe(true);
  });

  it('rolls back only its exact published inode when the configured root is replaced after rename', async () => {
    const input = body('5.0.0'); const ctx = context('post-race', 'f'.repeat(64)); const raceRoot = join(base, 'post-race-root');
    const movedRoot = `${raceRoot}.moved`;
    await expect(publishSkillBundle(input, ctx, raceRoot, { afterVisibility: async () => {
      await rename(raceRoot, movedRoot); await symlink(outside, raceRoot);
    } })).rejects.toMatchObject({ code: 'UNSAFE_SKILL_PATH' });
    expect(await lstat(join(movedRoot, input.skillName)).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
  });

  it('revalidates the exact tree after rename and rolls back its corrupted inode', async () => {
    const input = body('5.1.0'); const ctx = context('post-tree-race', '5'.repeat(64)); const raceRoot = join(base, 'tree-race-root');
    await expect(publishSkillBundle(input, ctx, raceRoot, { afterVisibility: async () => {
      await writeFile(join(raceRoot, input.skillName, input.version, 'README.md'), 'changed-after-rename');
    } })).rejects.toMatchObject({ code: 'SKILL_TREE_MISMATCH' });
    expect(await lstat(join(raceRoot, input.skillName)).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
  });

  it.each(['delete-recreate', 'content-swap'])('pins the exact receipt through visibility and rolls back a %s attack', async attack => {
    const version = attack === 'delete-recreate' ? '5.2.0' : '5.3.0'; const input = body(version);
    const ctx = context(`receipt-${attack}`, attack === 'delete-recreate' ? '8'.repeat(64) : '9'.repeat(64));
    const raceRoot = join(base, `receipt-${attack}-root`);
    await expect(publishSkillBundle(input, ctx, raceRoot, { afterVisibility: async () => {
      const receiptPath = join(raceRoot, input.skillName, input.version, '.magnus-publication.json');
      const raw = await readFile(receiptPath, 'utf8');
      if (attack === 'delete-recreate') {
        await rm(receiptPath); await writeFile(receiptPath, raw, { mode: 0o400 });
      } else {
        const changed = { ...JSON.parse(raw), nodeId: 'substituted-node' };
        await chmod(receiptPath, 0o600); await writeFile(receiptPath, JSON.stringify(changed)); await chmod(receiptPath, 0o400);
      }
    } })).rejects.toMatchObject({ code: 'SKILL_RECEIPT_MISMATCH' });
    expect(await lstat(join(raceRoot, input.skillName)).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
  });

  it('checks cancellation and lease expiry at the no-effect boundary', async () => {
    const expired = context(); expired.coordination!.expiresAt = Date.now() - 1;
    expect((await install(body(), expired)).status).toBe(409);
    const controller = new AbortController(); controller.abort(); const cancelled = { ...context(), signal: controller.signal };
    expect((await install(body(), cancelled)).status).toBe(409);
    expect(await lstat(join(root, 'fixture-skill', '1.0.0')).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
  });

  it('never cleans a preexisting stage that this attempt did not create', async () => {
    const ctx = context(); await mkdir(root, { mode: 0o755 });
    const stage = join(root, `.skill-publish-${digest(`${ctx.commandId}\0${ctx.requestSha256}`)}`);
    await mkdir(stage, { mode: 0o700 }); await writeFile(join(stage, 'unowned'), 'preserve');
    expect((await install(body(), ctx)).status).toBe(409);
    expect(await readFile(join(stage, 'unowned'), 'utf8')).toBe('preserve');
  });

  it('recovers exact committed evidence or terminal no-effect without republishing', async () => {
    const input = body(); const ctx = context(); const committed = await install(input, ctx); const expected = await committed.text();
    expect(await recoverSkillPublication(input, ctx, root)).toEqual({ status: 200, body: expected });
    const absent = body('2.0.0'); const noEffect = await recoverSkillPublication(absent, context('publish-two', 'c'.repeat(64)), root);
    expect(noEffect.status).toBe(409); expect(JSON.parse(noEffect.body).data.effect).toBe('none');
    expect(await lstat(join(root, 'fixture-skill', '2.0.0')).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
  });

  it('recovers no effect from the new-skill crash state between its two staging renames', async () => {
    const input = body('3.0.0'); const ctx = context('publish-three', 'd'.repeat(64));
    const source = join(base, 'source'); const published = await publishSkillBundle(input, ctx, source);
    await mkdir(root, { mode: 0o755 });
    const stage = join(root, `.skill-publish-${digest(`${ctx.commandId}\0${ctx.requestSha256}`)}`);
    const container = join(stage, 'container'); await mkdir(container, { recursive: true, mode: 0o755 });
    await rename(join(source, input.skillName, input.version), join(container, input.version));
    await writeFile(join(stage, 'journal.json'), JSON.stringify({ version: 1, state: 'staged', skillName: input.skillName,
      skillVersion: input.version, bundleSha256: input.bundleSha256, treeSha256: published.data.treeSha256,
      commandId: ctx.commandId, requestSha256: ctx.requestSha256 }), { mode: 0o400 });
    const recovered = await recoverSkillPublication(input, ctx, root);
    expect(recovered.status).toBe(409); expect(JSON.parse(recovered.body).data.effect).toBe('none');
    expect(await lstat(stage).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
    expect(await lstat(join(root, input.skillName)).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
  });

  it('recovers no effect from container-plus-payload and receipt-write crash residue', async () => {
    const input = body('6.0.0'); const ctx = context('publish-six', '6'.repeat(64)); const source = join(base, 'source-six');
    const published = await publishSkillBundle(input, ctx, source); await mkdir(root, { mode: 0o755 });
    const stage = join(root, `.skill-publish-${digest(`${ctx.commandId}\0${ctx.requestSha256}`)}`);
    await mkdir(join(stage, 'container'), { recursive: true, mode: 0o755 });
    await rename(join(source, input.skillName, input.version), join(stage, 'payload'));
    await rename(join(stage, 'payload', '.magnus-publication.json'),
      join(stage, 'payload', `.magnus-publication.json.write-${randomUUID()}`));
    await writeFile(join(stage, 'journal.json'), JSON.stringify({ version: 1, state: 'staged', skillName: input.skillName,
      skillVersion: input.version, bundleSha256: input.bundleSha256, treeSha256: published.data.treeSha256,
      commandId: ctx.commandId, requestSha256: ctx.requestSha256 }), { mode: 0o400 });
    const recovered = await recoverSkillPublication(input, ctx, root);
    expect(recovered.status).toBe(409); expect(JSON.parse(recovered.body).data.effect).toBe('none');
    expect(await lstat(stage).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
  });

  it('recovers no effect from an interrupted atomic journal write', async () => {
    const input = body('7.0.0'); const ctx = context('publish-seven', '7'.repeat(64)); await mkdir(root, { mode: 0o755 });
    const stage = join(root, `.skill-publish-${digest(`${ctx.commandId}\0${ctx.requestSha256}`)}`); await mkdir(stage, { mode: 0o700 });
    await writeFile(join(stage, `journal.json.write-${randomUUID()}`), '{"version":', { mode: 0o400 });
    const recovered = await recoverSkillPublication(input, ctx, root);
    expect(recovered.status).toBe(409); expect(JSON.parse(recovered.body).data.effect).toBe('none');
    expect(await lstat(stage).catch(error => (error as NodeJS.ErrnoException).code)).toBe('ENOENT');
  });
});
