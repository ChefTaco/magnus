#!/usr/bin/env node
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NEW_MARKER = 'enc2:';
const LEGACY_MARKER = 'enc:';
const CREDENTIAL_FIELDS = ['apiSecret', 'token'];

function fail(message) {
  throw new Error(`dashboard credential migration: ${message}`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) fail('invalid arguments');
    result[name.slice(2)] = value;
  }
  const expected = ['candidate-env', 'current-env', 'mode', 'state'];
  if (Object.keys(result).sort().join(',') !== expected.sort().join(',')) fail('unexpected arguments');
  if (!['preserve', 'rotate'].includes(result.mode)) fail('mode must be preserve or rotate');
  return result;
}

function parseEnvironment(file, optional = false) {
  if (optional && file === '-') return { lines: [], values: new Map() };
  const source = readFileSync(file, 'utf8');
  const values = new Map();
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) fail(`${path.basename(file)} contains a malformed environment line`);
    const [, name, encoded] = match;
    if (values.has(name)) fail(`${path.basename(file)} contains duplicate ${name}`);
    let value = encoded.trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ['"', "'"].includes(value[0])) {
      value = value.slice(1, -1);
    }
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) fail(`${name} contains forbidden bytes`);
    values.set(name, value);
  }
  return { lines, values };
}

function setEnvironmentValue(environment, name, value) {
  if (!/^[A-Za-z0-9._~+/=-]{32,512}$/.test(value)) fail(`${name} contains unsupported characters`);
  let replaced = false;
  environment.lines = environment.lines.map((line) => {
    if (!line.startsWith(`${name}=`)) return line;
    replaced = true;
    return `${name}=${value}`;
  });
  if (!replaced) environment.lines.push(`${name}=${value}`);
  environment.values.set(name, value);
}

function keyBytes(secret, name, minimumLength = 32) {
  if ((secret ?? '').length < minimumLength) fail(`${name} must contain at least ${minimumLength} characters`);
  return createHash('sha256').update(secret).digest();
}

function decryptEnvelope(value, secret, marker) {
  const parts = value.slice(marker.length).split(':');
  if (parts.length !== 3) fail('stored credential ciphertext is malformed');
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64'));
  if (iv.length !== 12 || tag.length !== 16) fail('stored credential ciphertext has invalid parameters');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyBytes(secret, 'credential decryption key', marker === LEGACY_MARKER ? 1 : 32),
      iv,
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    fail(`stored credential failed authenticated decryption (${error instanceof Error ? error.message : 'unknown error'})`);
  }
}

function encryptEnvelope(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(secret, 'CONTROL_NODE_CREDENTIAL_KEY'), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${NEW_MARKER}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

function assertRegularPrivateFile(file) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${path.basename(file)} must be a regular non-symlink file`);
  if ((metadata.mode & 0o777) !== 0o600) fail(`${path.basename(file)} must have mode 0600`);
}

function atomicWrite(file, contents) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.dashboard-credential-migration.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  let exists = false;
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    exists = true;
    try {
      writeFileSync(descriptor, contents, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
    exists = false;
    const directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  } finally {
    if (exists) {
      try { unlinkSync(temporary); } catch {}
    }
  }
}

function migrateState(file, oldKey, legacyKeys, newKey) {
  assertRegularPrivateFile(file);
  let records;
  try { records = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('control-node state is not valid JSON'); }
  if (!Array.isArray(records)) fail('control-node state must contain an array');
  let changed = false;
  const migrated = records.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`control-node entry ${index} is invalid`);
    const next = { ...entry };
    if ('nodeManagerSecret' in next) {
      delete next.nodeManagerSecret;
      changed = true;
    }
    for (const field of CREDENTIAL_FIELDS) {
      const value = next[field];
      if (value === undefined || value === '') continue;
      if (typeof value !== 'string') fail(`control-node entry ${index} has invalid ${field}`);
      if (value.startsWith(NEW_MARKER) && oldKey === newKey) continue;
      let plaintext;
      if (value.startsWith(NEW_MARKER)) {
        if (!oldKey) fail('existing enc2 credentials have no current CONTROL_NODE_CREDENTIAL_KEY');
        plaintext = decryptEnvelope(value, oldKey, NEW_MARKER);
      } else if (value.startsWith(LEGACY_MARKER)) {
        if (legacyKeys.length === 0) fail('legacy credentials have no prior JWT_SECRET or SESSION_SECRET');
        const authenticated = [];
        for (const legacyKey of legacyKeys) {
          try { authenticated.push(decryptEnvelope(value, legacyKey, LEGACY_MARKER)); } catch {}
        }
        if (authenticated.length !== 1) fail('legacy credential did not authenticate against exactly one prior key');
        [plaintext] = authenticated;
      } else {
        plaintext = value;
      }
      next[field] = encryptEnvelope(plaintext, newKey);
      if (decryptEnvelope(next[field], newKey, NEW_MARKER) !== plaintext) fail('credential round-trip verification failed');
      changed = true;
    }
    return next;
  });
  if (changed) atomicWrite(file, `${JSON.stringify(migrated, null, 2)}\n`);
  const residual = readFileSync(file, 'utf8');
  if (/"(?:apiSecret|token)"\s*:\s*"enc:(?!2:)/.test(residual)) {
    fail('legacy ciphertext remained after migration');
  }
  if (/"nodeManagerSecret"\s*:/.test(residual)) fail('retired node-manager credential remained after migration');
}

const args = parseArgs(process.argv.slice(2));
const candidate = parseEnvironment(args['candidate-env']);
const current = parseEnvironment(args['current-env'], true);
const oldKey = current.values.get('CONTROL_NODE_CREDENTIAL_KEY') ?? '';
const suppliedKey = candidate.values.get('CONTROL_NODE_CREDENTIAL_KEY') ?? '';
const newKey = args.mode === 'preserve' && oldKey.length >= 32 ? oldKey : suppliedKey;
keyBytes(newKey, 'CONTROL_NODE_CREDENTIAL_KEY');
for (const name of ['API_SECRET', 'SESSION_SECRET', 'JWT_SECRET']) {
  const value = candidate.values.get(name);
  if (value && value === newKey) fail(`CONTROL_NODE_CREDENTIAL_KEY must be distinct from ${name}`);
}
if (args.mode === 'rotate' && oldKey.length >= 32 && oldKey === newKey) fail('explicit rotation did not change CONTROL_NODE_CREDENTIAL_KEY');
setEnvironmentValue(candidate, 'CONTROL_NODE_CREDENTIAL_KEY', newKey);
const legacyKeys = [...new Set([
  current.values.get('JWT_SECRET') ?? '',
  current.values.get('SESSION_SECRET') ?? '',
].filter(Boolean))];
if (args.state !== '-') migrateState(args.state, oldKey, legacyKeys, newKey);
atomicWrite(args['candidate-env'], `${candidate.lines.join('\n').replace(/\n+$/, '')}\n`);
process.stdout.write(`dashboard-credential-migration=${oldKey.length >= 32 && oldKey !== newKey ? 'rekeyed' : 'verified'}\n`);
