/**
 * Drift Collector — compares actual system state against expected role config.
 * Reports drift findings back to the control API on demand.
 *
 * Mounted at POST /api/v1/drift/scan — called by the control API.
 * Every probe runs through execFile with an argument vector and a deadline;
 * check names are never interpreted by a shell.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { logger } from '../utils/logger.js';

export type DriftCheckType = 'package' | 'file' | 'service' | 'sysctl' | 'user';

export interface DriftCheck {
  type: DriftCheckType;
  name: string;
  expected: string;
  actual: string;
  status: 'match' | 'drifted' | 'missing' | 'error';
}

export interface DriftScanRequest {
  checks: Array<{
    type: DriftCheckType;
    name: string;
    expected: string;
  }>;
}

const PROBE_TIMEOUT_MS = 10_000;
const MAX_CONTENT_BYTES = 1024 * 1024;
const PACKAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,127}$/;
const UNIT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9:._@-]{0,255}$/;
const SYSCTL_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/;
const USER_NAME = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}\$?$/;

interface ProbeResult { code: number; stdout: string }

/** Run a probe without a shell; a non-zero exit is a result, not an exception. */
function probe(file: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (!error) return resolve({ code: 0, stdout: stdout.trim() });
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === 'number' && !error.killed) return resolve({ code, stdout: stdout.trim() });
        reject(error);
      });
  });
}

/**
 * Run a drift scan against a list of expected checks.
 * Returns per-check results.
 */
export async function runDriftScan(request: DriftScanRequest): Promise<DriftCheck[]> {
  const results: DriftCheck[] = [];

  for (const check of request.checks) {
    try {
      switch (check.type) {
        case 'package':
          results.push(await checkPackage(check.name, check.expected));
          break;
        case 'file':
          results.push(await checkFile(check.name, check.expected));
          break;
        case 'service':
          results.push(await checkService(check.name, check.expected));
          break;
        case 'sysctl':
          results.push(await checkSysctl(check.name, check.expected));
          break;
        case 'user':
          results.push(await checkUser(check.name, check.expected));
          break;
        default:
          results.push({ type: check.type, name: check.name, expected: check.expected, actual: 'unknown', status: 'error' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('DriftCollector: Check failed', { type: check.type, name: check.name, error: msg });
      results.push({ type: check.type, name: check.name, expected: check.expected, actual: `error: ${msg}`, status: 'error' });
    }
  }

  return results;
}

function invalidName(type: DriftCheckType, name: string, expected: string): DriftCheck {
  return { type, name, expected, actual: 'invalid name', status: 'error' };
}

async function checkPackage(name: string, expectedVersion: string): Promise<DriftCheck> {
  if (!PACKAGE_NAME.test(name)) return invalidName('package', name, expectedVersion);
  let actual = '';
  try {
    const dpkg = await probe('dpkg-query', ['-W', '-f=${Version}', '--', name]);
    if (dpkg.code === 0) actual = dpkg.stdout;
  } catch { /* dpkg unavailable; fall through to rpm */ }
  if (!actual) {
    try {
      const rpm = await probe('rpm', ['-q', '--qf', '%{VERSION}', '--', name]);
      if (rpm.code === 0) actual = rpm.stdout;
    } catch { /* rpm unavailable */ }
  }

  if (!actual) return { type: 'package', name, expected: expectedVersion, actual: 'not installed', status: 'missing' };

  // 'any' means just check it's installed, any version is fine
  if (expectedVersion === 'any' || expectedVersion === 'installed' || expectedVersion === '*') {
    return { type: 'package', name, expected: expectedVersion, actual, status: 'match' };
  }

  return { type: 'package', name, expected: expectedVersion, actual, status: actual.includes(expectedVersion) ? 'match' : 'drifted' };
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

async function checkFile(path: string, expected: string): Promise<DriftCheck> {
  if (!path.startsWith('/') || path.includes('\0')) return invalidName('file', path, expected);
  let info;
  try {
    info = await stat(path);
  } catch {
    return { type: 'file', name: path, expected, actual: 'missing', status: 'missing' };
  }

  if (expected === 'exists') {
    return { type: 'file', name: path, expected, actual: 'exists', status: 'match' };
  }
  if (!info.isFile()) return { type: 'file', name: path, expected, actual: 'not a regular file', status: 'error' };

  // Check SHA-256 hash
  if (expected.startsWith('sha256:')) {
    try {
      const hash = await sha256File(path);
      return { type: 'file', name: path, expected, actual: `sha256:${hash}`, status: hash === expected.slice(7).toLowerCase() ? 'match' : 'drifted' };
    } catch {
      return { type: 'file', name: path, expected, actual: 'error reading', status: 'error' };
    }
  }

  // Check content contains expected (bounded read)
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_CONTENT_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const matches = buffer.subarray(0, bytesRead).toString('utf8').includes(expected);
      return { type: 'file', name: path, expected, actual: matches ? 'contains match' : 'content differs', status: matches ? 'match' : 'drifted' };
    } finally {
      await handle.close();
    }
  } catch {
    return { type: 'file', name: path, expected, actual: 'unreadable', status: 'error' };
  }
}

async function checkService(name: string, expected: string): Promise<DriftCheck> {
  if (!UNIT_NAME.test(name)) return invalidName('service', name, expected);
  // is-active exits 3 for inactive and is-enabled exits 1 for disabled; both
  // still print the state, which is what we compare.
  const [active, enabled] = await Promise.all([
    probe('systemctl', ['is-active', '--', name]),
    probe('systemctl', ['is-enabled', '--', name]),
  ]);
  const actual = `${active.stdout || 'unknown'}/${enabled.stdout || 'unknown'}`;

  // Expected format: "active/enabled", "active", "inactive", etc.
  const matches = expected === actual || actual.split('/').includes(expected);
  return { type: 'service', name, expected, actual, status: matches ? 'match' : 'drifted' };
}

async function checkSysctl(key: string, expected: string): Promise<DriftCheck> {
  if (!SYSCTL_KEY.test(key)) return invalidName('sysctl', key, expected);
  const result = await probe('sysctl', ['-n', '--', key]);
  if (result.code !== 0) return { type: 'sysctl', name: key, expected, actual: 'unknown', status: 'error' };
  return { type: 'sysctl', name: key, expected, actual: result.stdout, status: result.stdout === expected ? 'match' : 'drifted' };
}

async function checkUser(name: string, expected: string): Promise<DriftCheck> {
  if (!USER_NAME.test(name)) return invalidName('user', name, expected);
  const result = await probe('id', ['--', name]);
  if (result.code !== 0 || !result.stdout) {
    return { type: 'user', name, expected, actual: 'not found', status: expected === 'absent' ? 'match' : 'missing' };
  }
  if (expected === 'exists') return { type: 'user', name, expected, actual: 'exists', status: 'match' };
  if (expected === 'absent') return { type: 'user', name, expected, actual: 'exists', status: 'drifted' };
  return { type: 'user', name, expected, actual: result.stdout, status: result.stdout.includes(expected) ? 'match' : 'drifted' };
}
