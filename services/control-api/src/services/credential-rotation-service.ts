/**
 * Durable encrypted credential rotation.
 *
 * Rotation state is stored as AES-256-GCM encrypted envelopes on disk. Only
 * short SHA-256 fingerprints are exposed to route handlers, audit logs, and UI
 * callers. The active secret plus one unexpired previous secret are accepted so
 * agents can roll during a grace window without fleet downtime.
 */

import { magnusHomePath } from '../utils/magnus-home.js';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const DEFAULT_GRACE_MS = 60 * 60 * 1_000; // 1 hour
const STORE_VERSION = 1;
const ENVELOPE_PREFIX = 'enc:v1:';

type CredentialName = 'API_SECRET' | 'NODE_MANAGER_SECRET' | 'RESULT_SIGNING_SECRET';

interface CredentialVersion {
  id: string;
  encryptedSecret: string;
  fingerprint: string;
  createdAt: string;
  expiresAt?: string;
  /** One-time weak legacy value accepted only as a bounded previous credential. */
  legacyRetirementOnly?: true;
}

interface CredentialRotationRecord {
  active: CredentialVersion;
  previous?: CredentialVersion;
  rotatedAt?: string;
  gracePeriodMs?: number;
}

interface CredentialStore {
  version: number;
  credentials: Partial<Record<CredentialName, CredentialRotationRecord>>;
}

export interface RotationResult {
  name: CredentialName;
  newSecret: string;
  newFingerprint: string;
  previousFingerprint: string | null;
  gracePeriodMs: number;
  expiresAt: string;
  rotatedAt: string;
}

export interface RotationStatus {
  name: string;
  activeFingerprint: string;
  previousFingerprint: string | null;
  rotatedAt: string | null;
  expiresAt: string | null;
  gracePeriodMs: number | null;
}

export interface RetirePreviousResult extends RotationStatus {
  retiredPreviousFingerprint: string | null;
}

function defaultStatePath(): string {
  return magnusHomePath('state', 'credential-rotations.json');
}

export function getCredentialRotationStatePath(): string {
  return process.env['CREDENTIAL_ROTATION_STATE_PATH'] ?? defaultStatePath();
}

function encryptionKey(): Buffer {
  const source = process.env['CREDENTIAL_ROTATION_KEY'] ?? '';
  if (source.length < 32) {
    throw new Error('CREDENTIAL_ROTATION_KEY must be a dedicated secret of at least 32 characters');
  }
  return createHash('sha256').update(source).digest();
}

export function secretFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function aadFor(name: string, id: string): Buffer {
  return Buffer.from(`magnus:credential:${name}:${id}`, 'utf-8');
}

function encryptSecret(name: string, id: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(aadFor(name, id));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decryptSecret(name: string, version: CredentialVersion): string {
  if (!version.encryptedSecret.startsWith(ENVELOPE_PREFIX)) {
    throw new Error(`Credential ${name} is not encrypted`);
  }

  const payload = version.encryptedSecret.slice(ENVELOPE_PREFIX.length);
  const [ivRaw, tagRaw, ciphertextRaw] = payload.split(':');
  if (!ivRaw || !tagRaw || ciphertextRaw === undefined) {
    throw new Error(`Credential ${name} has a malformed encrypted envelope`);
  }

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAAD(aadFor(name, version.id));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return decipher.update(Buffer.from(ciphertextRaw, 'base64url')).toString('utf-8') + decipher.final('utf-8');
}

function emptyStore(): CredentialStore {
  return { version: STORE_VERSION, credentials: {} };
}

function readStore(): CredentialStore {
  const statePath = getCredentialRotationStatePath();
  if (!existsSync(statePath)) return emptyStore();
  const metadata = lstatSync(statePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error('Credential rotation state must be a regular non-symlink file with mode 0600');
  }
  const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as CredentialStore;
  if (parsed.version !== STORE_VERSION || !parsed.credentials || typeof parsed.credentials !== 'object') {
    throw new Error('Credential rotation state has an unsupported schema');
  }
  return parsed;
}

function writeStore(store: CredentialStore): void {
  const statePath = getCredentialRotationStatePath();
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  const fileDescriptor = openSync(tmpPath, 'r');
  try {
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  renameSync(tmpPath, statePath);
  const directoryDescriptor = openSync(path.dirname(statePath), 'r');
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeVersion(name: CredentialName, plaintext: string, createdAt = nowIso(), expiresAt?: string): CredentialVersion {
  assertCredentialSecret(name, plaintext);
  const id = randomBytes(16).toString('base64url');
  return {
    id,
    encryptedSecret: encryptSecret(name, id, plaintext),
    fingerprint: secretFingerprint(plaintext),
    createdAt,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function assertCredentialSecret(name: CredentialName, value: string): void {
  if (value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
}

function decryptValidatedSecret(
  name: CredentialName,
  version: CredentialVersion,
  allowLegacyRetirement = false,
): string {
  const value = decryptSecret(name, version);
  if (version.legacyRetirementOnly) {
    const createdAt = Date.parse(version.createdAt);
    const expiresAt = version.expiresAt ? Date.parse(version.expiresAt) : Number.NaN;
    if (
      !allowLegacyRetirement
      || value.length < 16
      || value.length >= 32
      || !Number.isFinite(createdAt)
      || !Number.isFinite(expiresAt)
      || expiresAt <= createdAt
      || expiresAt - createdAt > DEFAULT_GRACE_MS
    ) {
      throw new Error(`Credential ${name} has an invalid one-time legacy retirement envelope`);
    }
  } else {
    assertCredentialSecret(name, value);
  }
  if (secretFingerprint(value) !== version.fingerprint) {
    throw new Error(`Credential ${name} fingerprint does not match its encrypted value`);
  }
  return value;
}

function isExpired(version: CredentialVersion | undefined, atMs = Date.now()): boolean {
  return Boolean(version?.expiresAt && Date.parse(version.expiresAt) <= atMs);
}

function pruneExpired(store: CredentialStore): boolean {
  let changed = false;
  for (const record of Object.values(store.credentials)) {
    if (record?.previous && isExpired(record.previous)) {
      delete record.previous;
      changed = true;
    }
  }
  return changed;
}

function ensureRecord(name: CredentialName, currentValue: string): { store: CredentialStore; record: CredentialRotationRecord } {
  assertCredentialSecret(name, currentValue);
  const store = readStore();
  const changed = pruneExpired(store);
  const existing = store.credentials[name];

  if (existing) {
    decryptValidatedSecret(name, existing.active);
    if (existing.previous) decryptValidatedSecret(name, existing.previous, true);
    if (changed) writeStore(store);
    return { store, record: existing };
  }

  const active = makeVersion(name, currentValue);
  const record: CredentialRotationRecord = { active };
  store.credentials[name] = record;
  writeStore(store);
  return { store, record };
}

/**
 * Return the active secret for callers that need to talk to agents.
 */
export function resolveCredentialSecret(name: CredentialName, currentValue: string): string {
  const { record } = ensureRecord(name, currentValue);
  return decryptValidatedSecret(name, record.active);
}

/**
 * Start a durable rotation and return the generated plaintext only to the
 * caller responsible for distributing it. Route responses should redact it.
 */
export function rotateCredential(
  name: CredentialName,
  currentValue: string,
  gracePeriodMs = DEFAULT_GRACE_MS,
): RotationResult {
  const { store, record } = ensureRecord(name, currentValue);
  const currentSecret = decryptValidatedSecret(name, record.active);
  const rotatedAt = nowIso();
  const expiresAt = new Date(Date.now() + gracePeriodMs).toISOString();
  const newSecret = randomBytes(32).toString('base64url');
  const previous = makeVersion(name, currentSecret, record.active.createdAt, expiresAt);
  const active = makeVersion(name, newSecret, rotatedAt);

  store.credentials[name] = {
    active,
    previous,
    rotatedAt,
    gracePeriodMs,
  };
  writeStore(store);

  return {
    name,
    newSecret,
    newFingerprint: active.fingerprint,
    previousFingerprint: previous.fingerprint,
    gracePeriodMs,
    expiresAt,
    rotatedAt,
  };
}

/**
 * Verify a provided secret against the current value plus any unexpired
 * previous secret. This remains synchronous for auth middleware.
 */
export function verifyWithRotation(
  name: CredentialName,
  currentValue: string,
  provided: string,
): boolean {
  const { store, record } = ensureRecord(name, currentValue);
  let changed = false;

  if (safeEqual(provided, decryptValidatedSecret(name, record.active))) return true;

  if (record.previous && isExpired(record.previous)) {
    delete record.previous;
    changed = true;
  }

  if (changed) writeStore(store);
  return Boolean(record.previous && safeEqual(provided, decryptValidatedSecret(name, record.previous, true)));
}

export function getCredentialStatus(name: CredentialName, currentValue: string): RotationStatus {
  assertCredentialSecret(name, currentValue);
  const store = readStore();
  const record = store.credentials[name];
  if (!record) {
    return {
      name,
      activeFingerprint: secretFingerprint(currentValue),
      previousFingerprint: null,
      rotatedAt: null,
      expiresAt: null,
      gracePeriodMs: null,
    };
  }
  decryptValidatedSecret(name, record.active);
  if (record.previous) decryptValidatedSecret(name, record.previous, true);
  const previous = record.previous && !isExpired(record.previous) ? record.previous : undefined;
  return {
    name,
    activeFingerprint: record.active.fingerprint,
    previousFingerprint: previous?.fingerprint ?? null,
    rotatedAt: record.rotatedAt ?? null,
    expiresAt: previous?.expiresAt ?? null,
    gracePeriodMs: record.gracePeriodMs ?? null,
  };
}

export function retirePreviousCredential(name: CredentialName, currentValue: string): RetirePreviousResult {
  const { store, record } = ensureRecord(name, currentValue);
  const retiredPreviousFingerprint = record.previous?.fingerprint ?? null;
  if (record.previous) {
    delete record.previous;
    writeStore(store);
  }
  return {
    name,
    activeFingerprint: record.active.fingerprint,
    previousFingerprint: null,
    retiredPreviousFingerprint,
    rotatedAt: record.rotatedAt ?? null,
    expiresAt: null,
    gracePeriodMs: record.gracePeriodMs ?? null,
  };
}

/** List active credential rotations for admin visibility. */
export function listActiveRotations(): RotationStatus[] {
  const store = readStore();
  return Object.entries(store.credentials).map(([name, record]) => {
    const credentialName = name as CredentialName;
    decryptValidatedSecret(credentialName, record.active);
    if (record.previous) decryptValidatedSecret(credentialName, record.previous, true);
    const previous = record.previous && !isExpired(record.previous) ? record.previous : undefined;
    return {
      name,
      activeFingerprint: record.active.fingerprint,
      previousFingerprint: previous?.fingerprint ?? null,
      rotatedAt: record.rotatedAt ?? null,
      expiresAt: previous?.expiresAt ?? null,
      gracePeriodMs: record.gracePeriodMs ?? null,
    };
  });
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
