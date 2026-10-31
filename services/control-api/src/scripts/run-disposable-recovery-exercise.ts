import { assertDedicatedRecoveryDatabaseUrl, reapOrphanedDisposableRecoveryFixtures,
  runDisposableRecoveryExercise } from '../services/disposable-recovery-runner.js';
import { disconnectDb } from '../db/index.js';

const scenario = process.argv[2];
const root = process.env['MAGNUS_RECOVERY_RUNNER_ROOT'];
const privateKeyFile = process.env['MAGNUS_RECOVERY_RUNNER_PRIVATE_KEY_FILE'];
const publicKeyFile = process.env['MAGNUS_RECOVERY_RUNNER_PUBLIC_KEY_FILE'];

if (scenario === '--reap-orphans' && root) {
  try {
    const result = reapOrphanedDisposableRecoveryFixtures(root);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Disposable recovery fixture reaping failed');
    process.exitCode = 1;
  }
} else if (!scenario || !root || !privateKeyFile || !publicKeyFile || !process.env['DATABASE_URL']) {
  console.error('Usage: MAGNUS_RECOVERY_RUNNER_ROOT=/absolute/path run-disposable-recovery-exercise --reap-orphans\n  or: DATABASE_URL=postgresql://magnus_recovery_runner:... MAGNUS_RECOVERY_RUNNER_ROOT=/absolute/path MAGNUS_RECOVERY_RUNNER_PRIVATE_KEY_FILE=/absolute/path MAGNUS_RECOVERY_RUNNER_PUBLIC_KEY_FILE=/absolute/path run-disposable-recovery-exercise <backup_restore|rollback|specialist_loss|coordinator_loss>');
  process.exitCode = 64;
} else {
  try {
    assertDedicatedRecoveryDatabaseUrl(process.env['DATABASE_URL']);
    const record = await runDisposableRecoveryExercise(scenario, { root, privateKeyFile, publicKeyFile });
    process.stdout.write(`${JSON.stringify({ exerciseId: record.id, targetId: record.targetId,
      scenario: record.scenario, recordSha256: record.recordSha256 })}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Disposable recovery exercise failed');
    process.exitCode = 1;
  } finally {
    await disconnectDb().catch(error => {
      console.error(error instanceof Error ? error.message : 'Recovery runner database disconnect failed');
      process.exitCode = 1;
    });
  }
}
