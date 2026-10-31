#!/usr/bin/env node
/** Offline, transactional purpose-key migration for credential-rotations.json. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const names = ['API_SECRET', 'NODE_MANAGER_SECRET'];
const emptyFingerprint = createHash('sha256').update('').digest('hex').slice(0, 12);

function fail(message) {
  throw new Error(`credential-store migration: ${message}`);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) fail('expected --store/--from-env/--to-env/--backup');
    values[key.slice(2)] = value;
  }
  for (const key of ['store', 'from-env', 'to-env', 'backup']) {
    if (!values[key]) fail(`missing --${key}`);
  }
  return values;
}

function assertPrivateRegular(file, description) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail(`${description} must be a regular non-symlink file with mode 0600`);
  }
}

function parseEnv(file) {
  assertPrivateRegular(file, file);
  const result = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function rawLegacyKey(env) {
  return env.CREDENTIAL_ROTATION_KEY
    || env.MAGNUS_SECRET
    || env.JWT_SECRET
    || env.API_SECRET
    || env.NODE_MANAGER_SECRET
    || '';
}

function key(raw, label, minimumLength = 32) {
  if (raw.length < minimumLength) fail(`${label} encryption key must contain at least ${minimumLength} characters`);
  return createHash('sha256').update(raw).digest();
}

function decrypt(name, version, encryptionKey) {
  const prefix = 'enc:v1:';
  if (!version?.encryptedSecret?.startsWith(prefix)) fail(`${name} has an unsupported envelope`);
  const [ivRaw, tagRaw, ciphertextRaw] = version.encryptedSecret.slice(prefix.length).split(':');
  if (!ivRaw || !tagRaw || ciphertextRaw === undefined) fail(`${name} has a malformed envelope`);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivRaw, 'base64url'));
  decipher.setAAD(Buffer.from(`magnus:credential:${name}:${version.id}`, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  if (fingerprint(plaintext) !== version.fingerprint) fail(`${name} fingerprint mismatch`);
  return plaintext;
}

function encrypt(name, plaintext, encryptionKey, options = {}) {
  const minimumLength = options.legacyRetirementOnly ? 16 : 32;
  if (plaintext.length < minimumLength) fail(`${name} target value must contain at least ${minimumLength} characters`);
  const id = randomBytes(16).toString('base64url');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(Buffer.from(`magnus:credential:${name}:${id}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    id,
    encryptedSecret: `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`,
    fingerprint: fingerprint(plaintext),
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    ...(options.legacyRetirementOnly ? { legacyRetirementOnly: true } : {}),
  };
}

function fsyncDirectory(directory) {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function main() {
  const args = parseArgs(process.argv);
  const storePath = path.resolve(args.store);
  const backupPath = path.resolve(args.backup);
  const directory = path.dirname(storePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    fail('state directory must be a regular directory with mode 0700');
  }
  assertPrivateRegular(storePath, 'credential store');
  if (existsSync(backupPath)) fail('backup path already exists');

  const lockPath = `${storePath}.migration.lock`;
  const lockFd = openSync(lockPath, 'wx', 0o600);
  try {
    const fromEnv = parseEnv(args['from-env']);
    const toEnv = parseEnv(args['to-env']);
    const legacyFingerprint = args['legacy-source-fingerprint'] || '';
    const sourceKeyMaterial = rawLegacyKey(fromEnv);
    const weakSource = sourceKeyMaterial.length < 32;
    if (weakSource) {
      const legacyValues = [fromEnv.API_SECRET, fromEnv.JWT_SECRET, fromEnv.NODE_MANAGER_SECRET];
      if (
        !/^[0-9a-f]{64}$/.test(legacyFingerprint)
        || sourceKeyMaterial.length < 16
        || new Set(legacyValues).size !== 1
        || legacyValues[0] !== sourceKeyMaterial
        || createHash('sha256').update(sourceKeyMaterial).digest('hex') !== legacyFingerprint
      ) fail('weak source does not match the explicitly pre-attested one-time legacy credential');
    }
    const fromKey = key(sourceKeyMaterial, 'source', weakSource ? 16 : 32);
    const allowLegacyTarget = args['allow-legacy-target'] === '1';
    if (!toEnv.CREDENTIAL_ROTATION_KEY && !allowLegacyTarget) {
      fail('target CREDENTIAL_ROTATION_KEY is required');
    }
    const toKey = key(
      toEnv.CREDENTIAL_ROTATION_KEY || (allowLegacyTarget ? rawLegacyKey(toEnv) : ''),
      'target',
    );
    if (!allowLegacyTarget && (toEnv.RESULT_SIGNING_SECRET || '').length < 32) {
      fail('target RESULT_SIGNING_SECRET is required and must contain at least 32 characters');
    }
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    if (store.version !== 1 || !store.credentials || typeof store.credentials !== 'object') {
      fail('unsupported credential store schema');
    }

    let retiredEmptyResultRecord = false;
    const resultRecord = store.credentials.RESULT_SIGNING_SECRET;
    if (resultRecord) {
      const resultValue = decrypt('RESULT_SIGNING_SECRET', resultRecord.active, fromKey);
      if (resultRecord.previous || resultValue !== '' || resultRecord.active.fingerprint !== emptyFingerprint) {
        fail('unsupported RESULT_SIGNING_SECRET rotation record requires explicit operator review');
      }
      delete store.credentials.RESULT_SIGNING_SECRET;
      retiredEmptyResultRecord = true;
    }
    for (const name of names) {
      const targetValue = toEnv[name] || '';
      if (targetValue.length < 32) fail(`target ${name} is required and must contain at least 32 characters`);
      const record = store.credentials[name];
      let sourceValue = fromEnv[name] || '';
      let previousValue = '';
      if (record) {
        const active = decrypt(name, record.active, fromKey);
        if (sourceValue.length < 16 || active !== sourceValue) {
          fail(`${name} active value does not match the reviewed source environment`);
        }
        if (record.previous) {
          if (!allowLegacyTarget) {
            fail(`${name} has an active previous credential; retire it through reviewed rollout first`);
          }
          previousValue = decrypt(name, record.previous, fromKey);
          if (previousValue !== targetValue) {
            fail(`${name} previous value does not match the reviewed rollback target`);
          }
        }
      } else if (sourceValue.length < 16) {
        fail(`source ${name} is required and must contain at least 16 characters for reviewed retirement`);
      }
      const active = encrypt(name, targetValue, toKey);
      if (!allowLegacyTarget && sourceValue !== targetValue) {
        const legacyRetirementOnly = sourceValue.length < 32;
        if (legacyRetirementOnly && createHash('sha256').update(sourceValue).digest('hex') !== legacyFingerprint) {
          fail(`${name} weak source is not the pre-attested legacy credential`);
        }
        const gracePeriodMs = legacyRetirementOnly ? 60 * 60 * 1_000 : 6 * 60 * 60 * 1_000;
        const expiresAt = new Date(Date.now() + gracePeriodMs).toISOString();
        store.credentials[name] = {
          active,
          previous: encrypt(name, sourceValue, toKey, { expiresAt, legacyRetirementOnly }),
          rotatedAt: new Date().toISOString(),
          gracePeriodMs,
        };
      } else {
        store.credentials[name] = { active };
      }
    }

    copyFileSync(storePath, backupPath, 0);
    const backupFd = openSync(backupPath, 'r');
    try { fsyncSync(backupFd); } finally { closeSync(backupFd); }
    const temporary = `${storePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const temporaryFd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(temporaryFd, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
      fsyncSync(temporaryFd);
    } finally {
      closeSync(temporaryFd);
    }
    renameSync(temporary, storePath);
    fsyncDirectory(directory);
    console.log(JSON.stringify({
      migrated: names,
      environmentRotated: allowLegacyTarget ? names : [...names, 'RESULT_SIGNING_SECRET'],
      retiredEmptyResultRecord,
      apiPreviousCredentialRetained: Boolean(store.credentials.API_SECRET?.previous),
      nodePreviousCredentialRetained: Boolean(store.credentials.NODE_MANAGER_SECRET?.previous),
      fingerprints: Object.fromEntries(
        (allowLegacyTarget ? names : [...names, 'RESULT_SIGNING_SECRET'])
          .map((name) => [name, fingerprint(toEnv[name])]),
      ),
    }));
  } finally {
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
    fsyncDirectory(directory);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
