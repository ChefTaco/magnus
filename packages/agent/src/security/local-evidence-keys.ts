/**
 * The keys this agent MACs its own records and the legacy `signature` field of its evidence with
 * (docs/NODE_CREDENTIALS.md, "The agent's own records").
 *
 * Before 3.0.0 these were the fleet-wide `RESULT_SIGNING_SECRET` and `COMMAND_RECONCILIATION_SECRET`.
 * From 3.0.0 an agent no longer needs either: without them it uses node-local keys, created on first
 * use next to the node key (`$AGENT_INSTALL_DIR/identity/local-result.key` and
 * `local-reconciliation.key`, 0600) and never sent anywhere. They are separate from the node key so a
 * key rotation or a re-enrollment never orphans what was signed before.
 *
 *   signing      the shared key when it is configured (so an agent downgraded to 2.10.x still reads
 *                every record), else the node-local key
 *   verifying    every key a record may have been signed with: the shared key, its previous value
 *                during a rotation, and the node-local key, so a ledger written by 2.10.x stays
 *                readable after the upgrade, and stays readable after the shared key is removed as
 *                long as it is kept as `RESULT_SIGNING_PREVIOUS_SECRET`
 *
 * What the Control API relies on is the node signature (`nodeSignature`) next to the MAC; the MAC
 * made with a node-local key is only this agent's own check. Never log or return a key.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_MANAGER_SECRET, RESULT_SIGNING_SECRET } from '../env.js';
import { identityDirectory } from './node-identity.js';

export type LocalKeyPurpose = 'result' | 'reconciliation';
const FILES: Record<LocalKeyPurpose, string> = { result: 'local-result.key', reconciliation: 'local-reconciliation.key' };
const KEY = /^[a-f0-9]{64}$/;
const cache = new Map<string, string>();

function readKey(file: string): string | null {
  let metadata;
  try { metadata = lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0)
    throw new Error(`${file} must be a regular file readable only by its owner (mode 0600)`);
  const value = readFileSync(file, 'utf8').trim();
  if (!KEY.test(value)) throw new Error(`${file} is not a node-local key`);
  return value;
}

function createKey(file: string): string {
  const value = randomBytes(32).toString('hex');
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, `${value}\n`); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  try {
    // A hard link fails when the file exists: two processes creating it together keep the first key.
    linkSync(temporary, file);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readKey(file);
    if (!existing) throw new Error(`${file} could not be created`);
    return existing;
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * A node-local key, created on first use when `create` is set. Null when there is none (and it may
 * not be created) or the identity directory cannot be used.
 */
export function localKey(purpose: LocalKeyPurpose, options: { create?: boolean } = {}): string | null {
  const file = join(identityDirectory(), FILES[purpose]);
  const cached = cache.get(file);
  if (cached) return cached;
  try {
    let value = readKey(file);
    // A test without an install directory must never write a key into the working directory.
    if (!value && options.create && !(process.env['VITEST'] && !process.env['AGENT_INSTALL_DIR'])) {
      mkdirSync(identityDirectory(), { recursive: true, mode: 0o700 });
      value = createKey(file);
    }
    if (value) cache.set(file, value);
    return value;
  } catch (error) {
    console.error(`[local-evidence-keys] the node-local ${purpose} key is not usable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function usable(value: string | undefined, others: string[]): string {
  return value && value.length >= 32 && !others.some(other => other && other === value) ? value : '';
}

const nodeSecret = (): string => NODE_MANAGER_SECRET ?? '';

/** The key that signs this agent's results, receipts and proofs now: the shared result key when configured, else the node-local one. */
export function resultSigningKey(): string {
  return usable(RESULT_SIGNING_SECRET, [nodeSecret()]) || localKey('result', { create: true }) || '';
}

/** Every key a stored result, receipt or proof of this agent may carry a MAC of. */
export function resultVerificationKeys(): string[] {
  const shared = usable(RESULT_SIGNING_SECRET, [nodeSecret()]);
  const previous = usable(process.env['RESULT_SIGNING_PREVIOUS_SECRET'], [nodeSecret()]);
  return [...new Set([shared, previous, localKey('result') ?? ''].filter(Boolean))];
}

/**
 * The key of decisions this agent makes about itself (historical mutation settlements, signed by an
 * operator with `magnus-agent`'s historical-mutation tool on this host): the shared reconciliation
 * key when configured, else the node-local one. Never the result key.
 */
export function reconciliationSigningKey(): string {
  const result = resultSigningKey();
  return usable(process.env['COMMAND_RECONCILIATION_SECRET'], [nodeSecret(), result, RESULT_SIGNING_SECRET ?? '',
    process.env['RESULT_SIGNING_PREVIOUS_SECRET'] ?? '']) || localKey('reconciliation', { create: true }) || '';
}

export function reconciliationVerificationKeys(): string[] {
  const results = new Set(resultVerificationKeys());
  const shared = usable(process.env['COMMAND_RECONCILIATION_SECRET'], [nodeSecret()]);
  return [...new Set([shared, localKey('reconciliation') ?? ''].filter(key => key && !results.has(key)))];
}

/** For tests. */
export function resetLocalEvidenceKeyCache(): void {
  cache.clear();
}
