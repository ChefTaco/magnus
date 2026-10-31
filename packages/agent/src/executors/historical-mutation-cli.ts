/** Offline root controller. This module is never registered as an HTTP/model tool. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
import { readHostBoot, verifyHistoricalObservation, signHistoricalAssertion, validateHistoricalKeys } from './historical-mutation.js';

async function privateBytes(path: string, maximum = 16_384, installedOwner = 0): Promise<Buffer> {
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (!s.isFile() || s.nlink !== 1 || ![0, installedOwner].includes(s.uid) || s.mode & 0o077 || s.size > maximum)
      throw new Error('Private controller or installed-owner regular file required');
    return await h.readFile();
  } finally { await h.close(); }
}
async function writePrivate(path: string, value: unknown): Promise<void> {
  const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await h.writeFile(JSON.stringify(value, null, 2)); await h.sync(); } finally { await h.close(); }
}
async function main() {
  if (process.getuid?.() !== 0 || process.platform !== 'linux') throw new Error('Offline Linux root controller required');
  const [mode, ...args] = process.argv.slice(2);
  if (!['inspect', 'apply'].includes(mode ?? '') || args.length % 2) throw new Error('Usage: inspect --output FILE | apply --before FILE --records UUID,UUID --approval-ref REF --output FILE');
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    if (!['--output', '--before', '--records', '--approval-ref'].includes(key) || options[key] || !args[i + 1]) throw new Error('Invalid or duplicate option');
    options[key] = args[i + 1]!;
  }
  if (!options['--output'] || (mode === 'inspect' && Object.keys(options).length !== 1) ||
      (mode === 'apply' && Object.keys(options).length !== 4)) throw new Error('Exact mode options required');
  const install = await lstat('/opt/magnus-agent');
  if (!install.isDirectory() || install.isSymbolicLink() || install.mode & 0o077 || await realpath('/opt/magnus-agent') !== '/opt/magnus-agent')
    throw new Error('Private installed agent directory required');
  const env = parse((await privateBytes('/opt/magnus-agent/.env', 65_536, install.uid)).toString('utf8'));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  // Import after loading the installed host identity and its separate keys.
  const { MutationBarrier } = await import('./mutation-barrier.js');
  const barrier = new MutationBarrier('/opt/magnus-agent/.magnus/mutation-barrier');
  if (mode === 'inspect') {
    const observation = await barrier.historicalObservation();
    await writePrivate(options['--output'], observation);
    console.log(JSON.stringify({ mode, records: observation.records.length, boot: observation.boot,
      output: options['--output'], originalOutcomes: 'unknown' }));
    return;
  }
  const service = execFileSync('systemctl', ['show', 'magnus-agent.service', '--property=ActiveState,MainPID'], { encoding: 'utf8' });
  if (!service.includes('ActiveState=inactive') || !service.includes('MainPID=0')) throw new Error('Stop the node agent before apply');
  const keys = { result: env['RESULT_SIGNING_SECRET'] ?? '', reconciliation: env['COMMAND_RECONCILIATION_SECRET'] ?? '' };
  validateHistoricalKeys(keys);
  const before = verifyHistoricalObservation(JSON.parse((await privateBytes(options['--before']!)).toString('utf8')), keys.result);
  const ids = options['--records']!.split(',');
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !before.records.some(r => r.id === id))) throw new Error('Exact retained record IDs required');
  const boot = await readHostBoot();
  const assertion = signHistoricalAssertion({ version: 1, before, boot,
    records: before.records.filter(r => ids.includes(r.id)), disposition: 'post_boot_quiescence_outcome_unknown',
    approvalRef: options['--approval-ref']!, decisionId: randomUUID(), expiresAt: Date.now() + 300_000 }, keys.reconciliation);
  // Validate the host boundary before creating a backup or a decision file.
  const { verifyHistoricalAssertion } = await import('./historical-mutation.js');
  verifyHistoricalAssertion(assertion, keys);
  const backup = '/opt/magnus-agent/.magnus/historical-mutation-backups/' + assertion.decisionId;
  for (const directory of ['/opt/magnus-agent', '/opt/magnus-agent/.magnus', barrier.root]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || ![0, install.uid].includes(info.uid) || info.mode & 0o077 || await realpath(directory) !== directory)
      throw new Error('Controller state directory identity differs');
  }
  const backupRoot = '/opt/magnus-agent/.magnus/historical-mutation-backups';
  await mkdir(backupRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(backupRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o077) throw new Error('Private backup directory required');
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const pins: Record<string, string> = {};
  for (const name of (await readdir(barrier.root)).filter(n => /^(request-[a-f0-9-]+|drain|historical-[a-f0-9-]+)\.json$/.test(n)).sort()) {
    const bytes = await privateBytes(join(barrier.root, name), 16_384, install.uid);
    const h = await open(join(backup, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
    pins[name] = createHash('sha256').update(bytes).digest('hex');
  }
  const output = options['--output'];
  await writePrivate(output + '.decision.json', assertion);
  const receipt = await barrier.settleHistorical(assertion);
  await writePrivate(output, { receipt, backup, backupSha256: pins });
  console.log(JSON.stringify({ mode, records: ids.length, backup, output,
    originalOutcomes: 'unknown', replayPermitted: false }));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Historical reconciliation failed'); process.exitCode = 1; });
