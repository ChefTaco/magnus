/**
 * Strict SSH host-key trust. The server only ever reads this store: nothing is learned from a
 * connection. An operator approves a key through `magnus-fleet-gateway trust` after comparing its
 * fingerprint with one read on the node itself. See README, "Trusting a host key".
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { GatewayError } from './errors.js';

export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const LOCK_WAIT_MS = 2_000;

const approvalSchema = z.object({
  fingerprint: z.string().regex(FINGERPRINT),
  approvedBy: z.string().min(1).max(128),
  approvalRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/),
  approvedAt: z.iso.datetime(),
}).strict();

export const trustedNodeSchema = z.object({
  /** The inventory hostname or address this approval covers. The gateway connects here. */
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65_535),
  keys: z.array(approvalSchema).min(1).max(8),
}).strict();

export type TrustedNode = z.infer<typeof trustedNodeSchema>;

const storeSchema = z.object({
  version: z.literal(1),
  nodes: z.array(z.object({ nodeId: z.string().min(1).max(128), trust: trustedNodeSchema }).strict()).max(100_000),
}).strict();

export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function assertPrivatePath(path: string, kind: 'directory' | 'file'): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) throw new Error(`known-hosts ${kind} is not a regular ${kind}`);
  if (typeof process.geteuid === 'function' && info.uid !== process.geteuid()) throw new Error(`known-hosts ${kind} is not owned by the service account`);
  const expected = kind === 'directory' ? 0o700 : 0o600;
  if ((info.mode & 0o777) !== expected) throw new Error(`known-hosts ${kind} permissions must be ${expected.toString(8)}`);
}

function readStore(file: string): Map<string, TrustedNode> {
  assertPrivatePath(dirname(file), 'directory');
  assertPrivatePath(file, 'file');
  const text = readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new Error('known-hosts store is too large');
  const store = storeSchema.parse(JSON.parse(text));
  const nodes = new Map<string, TrustedNode>();
  for (const { nodeId, trust } of store.nodes) {
    if (nodes.has(nodeId)) throw new Error('known-hosts store repeats a node');
    nodes.set(nodeId, trust);
  }
  return nodes;
}

export function createKnownHosts(file: string) {
  return {
    /** The approved record for a node, or undefined. Anything wrong with the store refuses every connection. */
    lookup(nodeId: string): TrustedNode | undefined {
      let nodes: Map<string, TrustedNode>;
      try {
        nodes = readStore(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (error as NodeJS.ErrnoException).path === file) return undefined;
        throw new GatewayError('TRUST_STORE_UNAVAILABLE');
      }
      return nodes.get(nodeId);
    },
  };
}

export type KnownHosts = ReturnType<typeof createKnownHosts>;

function durableWrite(file: string, nodes: Map<string, TrustedNode>): void {
  const directory = dirname(file);
  const temporary = join(directory, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const document = { version: 1, nodes: [...nodes].map(([nodeId, trust]) => ({ nodeId, trust })) };
  let fd: number | null = null;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeSync(fd, `${JSON.stringify(document, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* the temporary may not exist */ }
    throw error;
  }
}

/** Serializes one approval against any other operator running the same command. */
function withStoreLock<T>(file: string, change: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    return change();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

function loadForChange(file: string): Map<string, TrustedNode> {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivatePath(directory, 'directory');
  try {
    return readStore(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
}

export interface Approval { fingerprint: string; approvedBy: string; approvalRef: string; approvedAt: string }

/** First trust for a node. Refuses when the node already has a record: replacing one is deliberate. */
export function approveNewNode(file: string, nodeId: string, host: string, port: number, approval: Approval): void {
  withStoreLock(file, () => {
    const nodes = loadForChange(file);
    if (nodes.has(nodeId)) throw new Error('This node already has an approved host key; use trust rotate');
    nodes.set(nodeId, trustedNodeSchema.parse({ host, port, keys: [approval] }));
    durableWrite(file, nodes);
  });
}

/** Replace a key the operator names exactly, or add another of the node's real host keys. */
export function rotateKey(file: string, nodeId: string, previous: string | undefined, approval: Approval): void {
  withStoreLock(file, () => {
    const nodes = loadForChange(file);
    const existing = nodes.get(nodeId);
    if (!existing) throw new Error('This node has no approved host key; use trust add');
    if (previous !== undefined && !existing.keys.some((key) => key.fingerprint === previous)) throw new Error('The previous fingerprint is not approved for this node');
    const keys = existing.keys.filter((key) => key.fingerprint !== previous && key.fingerprint !== approval.fingerprint);
    nodes.set(nodeId, trustedNodeSchema.parse({ ...existing, keys: [...keys, approval] }));
    durableWrite(file, nodes);
  });
}

export function removeNode(file: string, nodeId: string): boolean {
  return withStoreLock(file, () => {
    const nodes = loadForChange(file);
    const removed = nodes.delete(nodeId);
    if (removed) durableWrite(file, nodes);
    return removed;
  });
}

export function listNodes(file: string): Array<{ nodeId: string; trust: TrustedNode }> {
  return [...loadForChange(file)].map(([nodeId, trust]) => ({ nodeId, trust }));
}
