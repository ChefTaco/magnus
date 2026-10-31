#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import {
  appendFileSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--') && all[index + 1] && !all[index + 1].startsWith('--')) {
    pairs.push([value.slice(2), all[index + 1]]);
  }
  return pairs;
}, []));
const required = [
  'file',
  'installation',
  'node-id',
  'hostname',
  'expected-fingerprint',
  'approved-by',
  'approval-id',
  'identity-evidence',
];
for (const name of required) {
  if (!args[name]) throw new Error(`--${name} is required`);
}
if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(args['expected-fingerprint'])) {
  throw new Error('--expected-fingerprint must be an OpenSSH SHA256 fingerprint');
}
const overlapMinutes = Number(args['overlap-minutes'] ?? 60);
if (!Number.isInteger(overlapMinutes) || overlapMinutes < 5 || overlapMinutes > 24 * 60) {
  throw new Error('--overlap-minutes must be an integer from 5 through 1440');
}

const file = args.file;
const directory = dirname(file);
const lockFile = `${file}.rotation.lock`;
let lockFd = null;

function fingerprintLines(output) {
  return [...new Set(output.split('\n').flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[0].startsWith('#')) return [];
    const raw = Buffer.from(fields[2], 'base64');
    return [`SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`];
  }))];
}

function durableReplace(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  const fd = openSync(temporary, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directoryFd = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

try {
  const directoryInfo = lstatSync(directory);
  const expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : directoryInfo.uid;
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || directoryInfo.uid !== expectedUid || (directoryInfo.mode & 0o777) !== 0o700) {
    throw new Error('authorization directory must be owned by the operator and mode 0700');
  }
  const fileInfo = lstatSync(file);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()
    || fileInfo.uid !== expectedUid || (fileInfo.mode & 0o777) !== 0o600) {
    throw new Error('authorization file must be owned by the operator and mode 0600');
  }
  lockFd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  writeFileSync(lockFd, `${process.pid}\n`);
  fsyncSync(lockFd);

  const document = JSON.parse(readFileSync(file, 'utf8'));
  if (![1, 2].includes(document?.version)) throw new Error('unsupported authorization document version');
  const authorization = document.installations?.[args.installation];
  if (!authorization
    || authorization.nodeId !== args['node-id']
    || (authorization.hostname && authorization.hostname !== args.hostname)) {
    throw new Error('installation, node identity, and hostname do not match reviewed inventory');
  }
  const resolved = [...new Set((await lookup(args.hostname, { all: true, verbatim: true })).map((row) => row.address))].sort();
  const authorizedAddresses = [...new Set(authorization.addresses ?? [])].sort();
  if (JSON.stringify(resolved) !== JSON.stringify(authorizedAddresses)) {
    throw new Error('hostname resolution no longer matches the reviewed address inventory');
  }
  for (const address of authorizedAddresses) {
    const observed = fingerprintLines(execFileSync(
      'ssh-keyscan',
      ['-T', '5', '-p', String(authorization.sshPort ?? 22), address],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ));
    if (!observed.includes(args['expected-fingerprint'])) {
      throw new Error(`expected host key was not observed at reviewed address ${address}`);
    }
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + overlapMinutes * 60_000).toISOString();
  const existingKeys = document.version === 2 && Array.isArray(authorization.keys)
    ? authorization.keys
    : (authorization.hostKeySha256 ?? []).map((fingerprint) => ({
      fingerprint,
      state: 'active',
      firstSeenAt: document.generatedAt ?? now.toISOString(),
      source: 'legacy-inventory',
    }));
  if (existingKeys.some((key) => key.fingerprint === args['expected-fingerprint'] && key.state === 'active')) {
    throw new Error('expected host key is already active');
  }
  const retainedKeys = existingKeys
    .filter((key) => key.state !== 'overlap' || Date.parse(key.expiresAt) > now.getTime())
    .map((key) => ({
      ...key,
      state: 'overlap',
      expiresAt,
    }));
  const identityEvidenceSha256 = createHash('sha256').update(args['identity-evidence']).digest('hex');
  const rotated = {
    ...authorization,
    hostname: args.hostname,
    hostKeySha256: undefined,
    keys: [
      {
        fingerprint: args['expected-fingerprint'],
        state: 'active',
        firstSeenAt: now.toISOString(),
        source: 'approved-rotation',
        approvedAt: now.toISOString(),
        approvedBy: args['approved-by'],
        approvalId: args['approval-id'],
        identityEvidenceSha256,
      },
      ...retainedKeys,
    ],
  };
  const nextDocument = {
    ...document,
    version: 2,
    updatedAt: now.toISOString(),
    installations: { ...document.installations, [args.installation]: rotated },
  };

  const auditPath = args['audit-file'] ?? join(directory, 'hermes-ssh-rotation-audit.jsonl');
  try {
    const auditInfo = lstatSync(auditPath);
    if (!auditInfo.isFile() || auditInfo.isSymbolicLink()
      || auditInfo.uid !== expectedUid || (auditInfo.mode & 0o777) !== 0o600) {
      throw new Error('rotation audit file must be owned by the operator and mode 0600');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  appendFileSync(auditPath, `${JSON.stringify({
    timestamp: now.toISOString(),
    event: 'host_key_rotation_approved',
    installationId: args.installation,
    nodeId: args['node-id'],
    hostname: args.hostname,
    newFingerprint: args['expected-fingerprint'],
    previousFingerprints: retainedKeys.map((key) => key.fingerprint),
    overlapExpiresAt: expiresAt,
    approvedBy: args['approved-by'],
    approvalId: args['approval-id'],
    identityEvidenceSha256,
  })}\n`, { mode: 0o600 });
  const auditFd = openSync(auditPath, constants.O_RDONLY);
  try { fsyncSync(auditFd); } finally { closeSync(auditFd); }
  durableReplace(file, `${JSON.stringify(nextDocument, null, 2)}\n`);
  console.log(`Approved host-key rotation for ${args.installation}; overlap expires ${expiresAt}`);
} finally {
  if (lockFd !== null) {
    closeSync(lockFd);
    try { unlinkSync(lockFile); } catch { /* fail closed on the next attempted rotation */ }
  }
}
