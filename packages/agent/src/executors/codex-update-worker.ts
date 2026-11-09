/** Runs only inside the durable execution supervisor, without agent credentials. */
import { updateCodexInProcess } from './codex-manager.js';

try {
  process.stdout.write(JSON.stringify(await updateCodexInProcess()));
} catch {
  // npm/App Server output can contain credentials. The public failure remains
  // generic; the supervisor retains private process evidence for reconciliation.
  process.stderr.write('Codex updater did not complete successfully\n');
  process.exitCode = 1;
}
