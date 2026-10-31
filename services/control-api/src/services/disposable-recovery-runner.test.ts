import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessRecoveryExercise, buildRecoveryExerciseRecord } from './recovery-exercises.js';
import { assertDedicatedRecoveryDatabaseUrl, buildDisposableRecoveryRun, DISPOSABLE_RECOVERY_ORPHAN_AGE_MS,
  reapOrphanedDisposableRecoveryFixtures, runDisposableRecoveryExercise,
  type DisposableRecoveryScenario } from './disposable-recovery-runner.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'magnus-disposable-runner-test-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateKeyFile = join(root, 'private.json');
  const publicKeyFile = join(root, 'public.json');
  writeFileSync(privateKeyFile, JSON.stringify({ schemaVersion: 1, issuer: 'fixture-runner', keyId: 'key-1',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
  writeFileSync(publicKeyFile, JSON.stringify({ schemaVersion: 1, issuer: 'fixture-runner', keyId: 'key-1',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) }), { mode: 0o600 });
  chmodSync(privateKeyFile, 0o600); chmodSync(publicKeyFile, 0o600);
  let tick = Date.parse('2026-09-20T12:00:00.000Z');
  const now = () => { const value = new Date(tick); tick += 1_000; return value; };
  return { root, privateKeyFile, publicKeyFile, now };
}

function currentProcessIdentity() {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8').trim();
  const fieldsAfterCommand = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  return {
    runnerBootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    runnerStartTimeTicks: fieldsAfterCommand[19]!,
  };
}

describe('disposable recovery runner', () => {
  it.each(['backup_restore', 'rollback', 'specialist_loss', 'coordinator_loss'] as const)(
    'observes, signs, and verifies one isolated %s exercise', (scenario: DisposableRecoveryScenario) => {
      const run = buildDisposableRecoveryRun(scenario, fixture());
      const createdAt = new Date(run.receipt.issuedAt);
      createdAt.setSeconds(createdAt.getSeconds() + 1);
      const inventorySha256 = createHash('sha256').update('coherent-empty-inventory').digest('hex');
      const record = buildRecoveryExerciseRecord(run.input, run.receipt, run.trust, inventorySha256, createdAt);
      const result = assessRecoveryExercise(record.id, record, false, createdAt.getTime(), inventorySha256, run.trust);
      expect(result).toMatchObject({ verified: true, isolated: true, runnerReceiptValid: true,
        scenarioSemanticsValid: true, runtimeEvidenceComplete: true, hashesPreserved: true,
        provenance: 'magnus_recovery_exercise_store' });
      expect(record.targetId).toMatch(/^disposable:magnus-disposable-/);
      expect(record.scenario).toBe(scenario);
    });

  it('rejects writable roots and private-key aliases before creating an exercise', () => {
    const writable = fixture();
    chmodSync(writable.root, 0o777);
    expect(() => buildDisposableRecoveryRun('backup_restore', writable)).toThrow(/owner-controlled/);

    const aliased = fixture();
    const alias = join(aliased.root, 'private-link.json');
    symlinkSync(aliased.privateKeyFile, alias);
    expect(() => buildDisposableRecoveryRun('rollback', { ...aliased, privateKeyFile: alias })).toThrow();
  });

  it('rejects a private signer that does not match the public trust pin', () => {
    const configured = fixture();
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(configured.privateKeyFile, JSON.stringify({ schemaVersion: 1, issuer: 'fixture-runner', keyId: 'key-1',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
    chmodSync(configured.privateKeyFile, 0o600);
    expect(() => buildDisposableRecoveryRun('coordinator_loss', configured)).toThrow(/trust pin/);
  });

  it.each(['backup_restore', 'rollback', 'specialist_loss', 'coordinator_loss'] as const)(
    'retains the %s fixture through the sink and independently checks its scenario behavior', async scenario => {
      const configured = fixture();
      let fixtureRoot = '';
      await runDisposableRecoveryExercise(scenario, configured, async (input, receipt, createdAt, trust) => {
        fixtureRoot = join(configured.root, input.targetId.slice('disposable:'.length));
        expect(existsSync(fixtureRoot)).toBe(true);
        const ownerFile = join(fixtureRoot, '.magnus-disposable-owner.json');
        expect(JSON.parse(readFileSync(ownerFile, 'utf8'))).toMatchObject({
          schemaVersion: 1,
          fixtureName: input.targetId.slice('disposable:'.length),
          runnerPid: process.pid,
          ...currentProcessIdentity(),
        });
        expect(lstatSync(ownerFile).mode & 0o777).toBe(0o600);
        expect(readdirSync(fixtureRoot).filter(name => name.endsWith('.tmp'))).toEqual([]);
        const startedAt = Date.parse(input.startedAt); const recoveredAt = Date.parse(input.recoveredAt);
        for (const row of input.runtimeEvidence) {
          const observedAt = Date.parse(row.observedAt);
          if (row.phase === 'before') expect(observedAt).toBeLessThanOrEqual(startedAt);
          else expect(observedAt).toBeGreaterThanOrEqual(recoveredAt);
        }
        if (scenario === 'rollback') {
          const baseline = input.runtimeEvidence.find(row => row.kind === 'release_baseline')!.observation;
          expect(readFileSync(join(fixtureRoot, 'scenario', 'release.active'), 'utf8').trim()).toBe(baseline['toRevision']);
          expect(baseline['fromRevision']).not.toBe(baseline['toRevision']);
        } else if (scenario === 'specialist_loss') {
          const observed = JSON.parse(readFileSync(join(fixtureRoot, 'scenario', 'specialist-loss.json'), 'utf8'));
          expect(observed.original.role).toBe('specialist-fixture');
          expect(observed.successor.role).toBe('magnus-fixture');
          expect(observed.original.pid).not.toBe(observed.successor.pid);
          expect(observed.original.lossSignal).toBe('SIGKILL');
          expect(observed.original.workSha256).toBe(observed.successor.workSha256);
          expect(input.runtimeEvidence.find(row => row.kind === 'delegation_recovery')!.observation)
            .toMatchObject({ originalPid: observed.original.pid, successorPid: observed.successor.pid,
              workSha256: observed.original.workSha256 });
        } else if (scenario === 'coordinator_loss') {
          const observed = JSON.parse(readFileSync(join(fixtureRoot, 'scenario', 'coordinator-loss.json'), 'utf8'));
          expect(observed.original.role).toBe('coordinator-fixture');
          expect(observed.successor.role).toBe('magnus-fixture');
          expect(observed.successor.epoch).toBe(observed.original.epoch + 1);
          expect(observed.successor.contenderRejected).toBe(true);
          expect(observed.original.lossSignal).toBe('SIGKILL');
          expect(input.runtimeEvidence.find(row => row.kind === 'leadership_recovery')!.observation)
            .toMatchObject({ originalPid: observed.original.pid, successorPid: observed.successor.pid,
              leadershipPort: observed.original.port, originalEpoch: observed.original.epoch,
              successorEpoch: observed.successor.epoch, contenderRejected: true });
        } else {
          expect(existsSync(join(fixtureRoot, 'scenario', 'backup'))).toBe(true);
        }
        const inventorySha256 = createHash('sha256').update('coherent-empty-inventory').digest('hex');
        return buildRecoveryExerciseRecord(input, receipt, trust, inventorySha256, createdAt);
      });
      expect(existsSync(fixtureRoot)).toBe(false);
    });

  it('cleans the disposable fixture when the durable sink rejects it', async () => {
    const configured = fixture();
    await expect(runDisposableRecoveryExercise('backup_restore', configured,
      async () => { throw new Error('fixture sink rejection'); })).rejects.toThrow(/sink rejection/);
    expect(readdirSync(configured.root).filter(name => name.startsWith('magnus-disposable-'))).toEqual([]);
  });

  it('reaps only expired dead fixtures in its reserved namespace', () => {
    const configured = fixture();
    const nowMs = Date.parse('2026-09-20T18:00:00.000Z');
    const identity = currentProcessIdentity();
    const makeCandidate = (suffix: string, ageMs: number, runnerPid?: number,
      processIdentity = identity) => {
      const name = `magnus-disposable-${suffix}`;
      const path = join(configured.root, name);
      mkdirSync(path, { mode: 0o700 });
      if (runnerPid !== undefined) writeFileSync(join(path, '.magnus-disposable-owner.json'), JSON.stringify({
        schemaVersion: 1, fixtureName: name, runnerPid, ...processIdentity,
        createdAt: new Date(nowMs - ageMs).toISOString(),
      }), { mode: 0o600 });
      else utimesSync(path, new Date(nowMs - ageMs), new Date(nowMs - ageMs));
      return { name, path };
    };
    const expired = makeCandidate('ABC123', DISPOSABLE_RECOVERY_ORPHAN_AGE_MS + 1, 999_999_999);
    const preMarkerCrash = makeCandidate('DEF456', DISPOSABLE_RECOVERY_ORPHAN_AGE_MS + 1);
    const young = makeCandidate('GHI789', DISPOSABLE_RECOVERY_ORPHAN_AGE_MS - 1, 999_999_999);
    const active = makeCandidate('JKL012', DISPOSABLE_RECOVERY_ORPHAN_AGE_MS + 1, process.pid);
    const reusedPid = makeCandidate('MNO345', DISPOSABLE_RECOVERY_ORPHAN_AGE_MS + 1, process.pid, {
      ...identity, runnerStartTimeTicks: (BigInt(identity.runnerStartTimeTicks) + 1n).toString(),
    });
    mkdirSync(join(configured.root, 'magnus-disposable-not-owned-by-runner'), { mode: 0o700 });

    const result = reapOrphanedDisposableRecoveryFixtures(configured.root, nowMs);

    expect(result.reaped).toEqual([expired.name, preMarkerCrash.name, reusedPid.name]);
    expect(result.preservedYoung).toEqual([young.name]);
    expect(result.preservedActive).toEqual([active.name]);
    expect(existsSync(expired.path)).toBe(false);
    expect(existsSync(preMarkerCrash.path)).toBe(false);
    expect(existsSync(young.path)).toBe(true);
    expect(existsSync(active.path)).toBe(true);
    expect(existsSync(reusedPid.path)).toBe(false);
    expect(existsSync(join(configured.root, 'magnus-disposable-not-owned-by-runner'))).toBe(true);
  });

  it('deletes only the inode moved to quarantine and leaves a replacement at the original path', () => {
    const configured = fixture();
    const nowMs = Date.parse('2026-09-20T18:00:00.000Z');
    const name = 'magnus-disposable-ABC123';
    const path = join(configured.root, name);
    mkdirSync(path, { mode: 0o700 });
    utimesSync(path, new Date(nowMs - DISPOSABLE_RECOVERY_ORPHAN_AGE_MS - 1),
      new Date(nowMs - DISPOSABLE_RECOVERY_ORPHAN_AGE_MS - 1));

    const result = reapOrphanedDisposableRecoveryFixtures(configured.root, nowMs, {
      afterQuarantine(originalPath) {
        mkdirSync(originalPath, { mode: 0o700 });
        writeFileSync(join(originalPath, 'replacement'), 'untouched');
      },
    });

    expect(result.reaped).toEqual([name]);
    expect(readFileSync(join(path, 'replacement'), 'utf8')).toBe('untouched');
    expect(readdirSync(configured.root).filter(entry => entry.includes('.reap-'))).toEqual([]);
  });

  it('preserves both objects when the quarantine path is replaced before verification', () => {
    const configured = fixture();
    const nowMs = Date.parse('2026-09-20T18:00:00.000Z');
    const name = 'magnus-disposable-ABC123';
    const path = join(configured.root, name);
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, 'original'), 'preserved');
    utimesSync(path, new Date(nowMs - DISPOSABLE_RECOVERY_ORPHAN_AGE_MS - 1),
      new Date(nowMs - DISPOSABLE_RECOVERY_ORPHAN_AGE_MS - 1));
    let heldPath = '';
    let replacementPath = '';

    const result = reapOrphanedDisposableRecoveryFixtures(configured.root, nowMs, {
      afterQuarantine(_originalPath, quarantinePath) {
        heldPath = `${quarantinePath}.held`;
        replacementPath = quarantinePath;
        renameSync(quarantinePath, heldPath);
        mkdirSync(quarantinePath, { mode: 0o700 });
        writeFileSync(join(quarantinePath, 'replacement'), 'untouched');
      },
    });

    expect(result.reaped).toEqual([]);
    expect(result.preservedUnsafe).toEqual([name]);
    expect(readFileSync(join(heldPath, 'original'), 'utf8')).toBe('preserved');
    expect(readFileSync(join(replacementPath, 'replacement'), 'utf8')).toBe('untouched');
  });

  it('preserves unsafe candidates instead of following aliases or malformed ownership', () => {
    const configured = fixture();
    const nowMs = Date.parse('2026-09-20T18:00:00.000Z');
    const malformed = join(configured.root, 'magnus-disposable-ABC123');
    mkdirSync(malformed, { mode: 0o700 });
    writeFileSync(join(malformed, '.magnus-disposable-owner.json'), '{}', { mode: 0o600 });
    const alias = join(configured.root, 'magnus-disposable-DEF456');
    symlinkSync(malformed, alias);

    const result = reapOrphanedDisposableRecoveryFixtures(configured.root, nowMs);

    expect(result.preservedUnsafe).toEqual(['magnus-disposable-ABC123', 'magnus-disposable-DEF456']);
    expect(existsSync(malformed)).toBe(true);
    expect(existsSync(alias)).toBe(true);
  });

  it('requires absolute paths and a distinct dedicated database role', () => {
    const configured = fixture();
    expect(() => buildDisposableRecoveryRun('backup_restore', { ...configured, root: 'relative' })).toThrow(/absolute/);
    expect(() => assertDedicatedRecoveryDatabaseUrl(undefined)).toThrow(/required/);
    expect(() => assertDedicatedRecoveryDatabaseUrl('postgresql://magnus:secret@db/magnus')).toThrow(/dedicated/);
    expect(assertDedicatedRecoveryDatabaseUrl(
      'postgresql://magnus_recovery_runner:secret@db/magnus')).toContain('magnus_recovery_runner');
  });
});
