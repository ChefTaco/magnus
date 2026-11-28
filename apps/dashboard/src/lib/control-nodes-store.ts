import 'server-only';

/**
 * Shared file-backed store for control node configuration.
 *
 * Centralises the read/write logic previously duplicated in
 * `app/api/control-nodes/route.ts`, `app/api/control-nodes/[id]/route.ts`,
 * and `app/api/proxy/allowed-targets.ts`.
 *
 * `withNodesMutex` serialises all read-modify-write operations to prevent
 * TOCTOU races between concurrent API requests, and every write holds the
 * state lock file that `magnus-ui credentials --reencrypt` also takes, so the
 * two never overwrite each other.
 */

import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import type { ControlNode, StoredControlNode } from '@/lib/control-nodes';
import { encryptSecret, decryptSecret, requiresCredentialMigration } from '@/lib/secret-cipher';
import { withControlNodeStateLock } from '../../runtime-control-node-credentials.mjs';

const CONFIG_DIR = process.env['NODE_ENV'] === 'test' && process.env['MAGNUS_CONTROL_NODES_CONFIG_DIR']
  ? path.resolve(process.env['MAGNUS_CONTROL_NODES_CONFIG_DIR'])
  : path.resolve(process.cwd(), '.magnus');
const CONFIG_FILE = path.join(CONFIG_DIR, 'control-nodes.json');

// ── In-process mutex for read-modify-write serialisation ────────────
let mutexChain: Promise<void> = Promise.resolve();

/**
 * Run `job` after every earlier write in this process, holding the state lock
 * that other processes (`magnus-ui credentials --reencrypt`) take too.
 */
function serialised<T>(job: () => Promise<T>): Promise<T> {
  const run = mutexChain.then(async () => {
    await ensureConfigDirectory(true);
    return withControlNodeStateLock(CONFIG_FILE, job);
  });
  // Ensure chain never rejects — errors propagate only to the caller
  mutexChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Serialise a read-modify-write operation against the control-nodes file.
 * `fn` receives the current list and must return the (possibly mutated) list
 * to be persisted. Returns whatever `fn` returns after writing.
 */
export async function withNodesMutex<T>(
  fn: (nodes: StoredControlNode[]) => StoredControlNode[] | { nodes: StoredControlNode[]; result: T },
): Promise<T> {
  return serialised(async () => {
    // The write below re-encrypts everything, so a pending migration needs no separate write.
    const { nodes } = await readStoredNodes();
    const out = fn(nodes);
    if (Array.isArray(out)) {
      await writeNodes(out);
      return undefined as T;
    }
    await writeNodes(out.nodes);
    return out.result;
  });
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function assertPrivateDirectory(metadata: Awaited<ReturnType<typeof lstat>>): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (Number(metadata.mode) & 0o777) !== 0o700) {
    throw new Error('Control-node state directory must be a non-symlink directory with mode 0700');
  }
}

function assertPrivateFile(metadata: Awaited<ReturnType<typeof lstat>>): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || (Number(metadata.mode) & 0o777) !== 0o600) {
    throw new Error('Control-node state must be a regular non-symlink file with mode 0600');
  }
}

async function ensureConfigDirectory(create: boolean): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(CONFIG_DIR);
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (!create) return false;
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    await chmod(CONFIG_DIR, 0o700);
    metadata = await lstat(CONFIG_DIR);
  }
  assertPrivateDirectory(metadata);
  return true;
}

function parseStoredNodes(raw: string): StoredControlNode[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Control-node state must contain an array');
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Control-node state entry ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    for (const field of ['id', 'name', 'url', 'createdAt'] as const) {
      if (typeof record[field] !== 'string' || !record[field]) {
        throw new Error(`Control-node state entry ${index} has an invalid ${field}`);
      }
    }
    for (const field of ['apiSecret', 'token'] as const) {
      if (record[field] !== undefined && typeof record[field] !== 'string') {
        throw new Error(`Control-node state entry ${index} has an invalid ${field}`);
      }
    }
    return {
      id: record['id'] as string,
      name: record['name'] as string,
      url: record['url'] as string,
      apiSecret: record['apiSecret'] as string | undefined,
      token: record['token'] as string | undefined,
      createdAt: record['createdAt'] as string,
    };
  });
}

function decryptStoredCredential(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  const decrypted = decryptSecret(value);
  if (!decrypted || (value.startsWith('enc:') && decrypted.startsWith('enc:'))) {
    throw new Error(`Stored control-node ${field} could not be decrypted`);
  }
  return decrypted;
}

function credentialFingerprint(value: string | undefined): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Convert a decrypted server record to the only shape allowed across the API. */
export function toControlNodeDto(node: StoredControlNode): ControlNode {
  return {
    id: node.id,
    name: node.name,
    url: node.url,
    hasApiSecret: Boolean(node.apiSecret),
    apiSecretFingerprint: credentialFingerprint(node.apiSecret),
    hasToken: Boolean(node.token),
    tokenFingerprint: credentialFingerprint(node.token),
    createdAt: node.createdAt,
  };
}

/** Read every saved control node (returns `[]` when no file exists). */
export async function readNodes(): Promise<StoredControlNode[]> {
  const first = await readStoredNodes();
  if (!first.migrationRequired) return first.nodes;
  // Migrate in the write queue and under the state lock, from a fresh read, so neither a
  // concurrent save here nor a rewrite by another process is undone.
  return serialised(async () => {
    const fresh = await readStoredNodes();
    if (fresh.migrationRequired) await writeNodes(fresh.nodes);
    return fresh.nodes;
  });
}

async function readStoredNodes(): Promise<{ nodes: StoredControlNode[]; migrationRequired: boolean }> {
  if (!(await ensureConfigDirectory(false))) {
    return { nodes: [], migrationRequired: false };
  }

  let pathMetadata;
  try {
    pathMetadata = await lstat(CONFIG_FILE);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return { nodes: [], migrationRequired: false };
  }
  assertPrivateFile(pathMetadata);

  const file = await open(CONFIG_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const openedMetadata = await file.stat();
    assertPrivateFile(openedMetadata);
    if (openedMetadata.dev !== pathMetadata.dev || openedMetadata.ino !== pathMetadata.ino) {
      throw new Error('Control-node state changed while it was being opened');
    }
    raw = await file.readFile({ encoding: 'utf-8' });
  } finally {
    await file.close();
  }

  const storedNodes = parseStoredNodes(raw);
  const migrationRequired = raw.includes('"nodeManagerSecret"') || storedNodes.some((node) =>
    requiresCredentialMigration(node.apiSecret)
    || requiresCredentialMigration(node.token));
  const nodes = storedNodes.map((node) => ({
    ...node,
    apiSecret: decryptStoredCredential(node.apiSecret, 'apiSecret'),
    token: decryptStoredCredential(node.token, 'token'),
  }));
  return { nodes: nodes.map((node) => ({ ...node })), migrationRequired };
}

/** Persist the full control-node list, creating the config dir if needed. */
export async function writeNodes(nodes: StoredControlNode[]): Promise<void> {
  await ensureConfigDirectory(true);
  try {
    const existing = await lstat(CONFIG_FILE);
    assertPrivateFile(existing);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  // Encrypt both credential forms before writing to disk.
  const toWrite = nodes.map((n) => ({
    ...n,
    apiSecret: n.apiSecret ? encryptSecret(n.apiSecret) : n.apiSecret,
    token: n.token ? encryptSecret(n.token) : n.token,
  }));
  const temporary = path.join(
    CONFIG_DIR,
    `.control-nodes.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let temporaryExists = false;
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    try {
      await file.writeFile(`${JSON.stringify(toWrite, null, 2)}\n`, { encoding: 'utf-8' });
      await file.chmod(0o600);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, CONFIG_FILE);
    temporaryExists = false;
    assertPrivateFile(await lstat(CONFIG_FILE));
    const directory = await open(CONFIG_DIR, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
  }
}
