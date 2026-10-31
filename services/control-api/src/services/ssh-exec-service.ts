import { withApiSshOwnership } from './managed-ssh-admission.js';
import { Client } from 'ssh2';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sshHostVerification } from './ssh-host-verification.js';

export interface SshCredentials {
  username: string;
  password?: string;
  privateKey?: string;
}

export interface SshTarget extends SshCredentials {
  hostname: string;
  port?: number;
}

export interface RemoteCommandResult {
  code: number;
  stdout: string;
  redactedStdout: string;
}

/** Channel closure is transport evidence, not a remote execution result. */
export class SshCommandOutcomeUnknownError extends Error {
  readonly code = 'SSH_COMMAND_OUTCOME_UNKNOWN';
  readonly outcome = 'unknown';
  readonly retryable = false;

  constructor() {
    super('SSH command closed without a valid exit status; outcome unknown. Reconcile remote effects before retrying.');
    this.name = 'SshCommandOutcomeUnknownError';
  }
}

/** A real SSH exit-status frame is an unsigned 32-bit integer. */
export function requireSshExitStatus(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new SshCommandOutcomeUnknownError();
  return value;
}

const SENSITIVE_LINE_PATTERNS = [
  /((?:api|access|refresh|bearer|jwt|node|iam|deploy|client)?[_-]?(?:key|token|secret|password)\s*[=:]\s*)[^\s'"`]+/gi,
  /(Authorization:\s*Bearer\s+)[^\s'"`]+/gi,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
];

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of SENSITIVE_LINE_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix: string, suffix?: string) => {
      if (suffix) return `${prefix}\n[REDACTED]\n${suffix}`;
      return `${prefix}[REDACTED]`;
    });
  }
  return redacted;
}

export function escapeForSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\\''");
}

export function resolveDeploySshCredentials(): SshCredentials {
  const username = process.env['SSH_USERNAME'];
  const password = process.env['SSH_PASSWORD'] ?? '';
  const privateKeyPath = process.env['SSH_PRIVATE_KEY_PATH'];

  if (!username) {
    throw new Error('SSH_USERNAME must be set in the server environment');
  }

  let privateKey: string | undefined;
  if (privateKeyPath) {
    const resolvedPath = resolve(privateKeyPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`SSH_PRIVATE_KEY_PATH does not exist: ${resolvedPath}`);
    }
    privateKey = readFileSync(resolvedPath, 'utf-8');
  }

  if (!password && !privateKey) {
    throw new Error('SSH_PRIVATE_KEY_PATH or SSH_PASSWORD must be set in the server environment');
  }

  return { username, password, privateKey };
}

export function execRemote(
  conn: Client,
  cmd: string,
  opts: { maxOutputBytes?: number } = {},
): Promise<RemoteCommandResult> {
  const maxOutputBytes = opts.maxOutputBytes ?? 256_000;
  return new Promise((resolvePromise, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stdout = '';
      const append = (chunk: Buffer): void => {
        if (stdout.length < maxOutputBytes) {
          stdout += chunk.toString();
          if (stdout.length > maxOutputBytes) {
            stdout = `${stdout.slice(0, maxOutputBytes)}\n[output truncated]`;
          }
        }
      };

      stream.on('data', append);
      stream.stderr.on('data', append);
      stream.on('close', (code: number | null) => {
        // SSH exit-status is an unsigned 32-bit integer. A signal-only close or
        // disconnected channel may supply null/undefined; neither proves success
        // or even that the remote process stopped. Keep private output off errors.
        let exitCode: number;
        try { exitCode = requireSshExitStatus(code); } catch (error) { reject(error); return; }
        resolvePromise({
          code: exitCode,
          stdout,
          redactedStdout: redactSensitiveText(stdout),
        });
      });
      stream.on('error', reject);
    });
  });
}

export async function runRemoteCommand(
  target: SshTarget,
  command: string,
  opts: { readyTimeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<RemoteCommandResult> {
  return withApiSshOwnership(target.hostname, 'ssh-command', () => new Promise((resolvePromise, reject) => {
    const conn = new Client();
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    conn.on('error', (err) => {
      finish(() => reject(err));
    });

    conn.on('ready', () => {
      void (async () => {
        try {
          const result = await execRemote(conn, command, { maxOutputBytes: opts.maxOutputBytes });
          finish(() => resolvePromise(result));
        } catch (err) {
          finish(() => reject(err));
        } finally {
          conn.end();
        }
      })();
    });

    conn.connect({
      ...sshHostVerification(target.hostname, target.port ?? 22),
      host: target.hostname,
      port: target.port ?? 22,
      username: target.username,
      ...(target.privateKey ? { privateKey: target.privateKey } : { password: target.password ?? '' }),
      readyTimeout: opts.readyTimeoutMs ?? 30_000,
    });
  }));
}
