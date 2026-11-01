/**
 * Side effects behind one interface so the upgrade engine can be tested with
 * a scripted host: commands, HTTP, clock, prompts and logging.
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline/promises';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Capture output instead of streaming it to the terminal. */
  capture?: boolean;
  /** Write this to the child's stdin. */
  input?: string;
  /** Redirect stdout to this file descriptor (for dumps). */
  stdoutFd?: number;
  stdinFd?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Io {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  fetch: typeof fetch;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  warn(line: string): void;
  /** Interactive yes/no; returns false when there is no terminal. */
  confirm(question: string): Promise<boolean>;
  /**
   * Status code of a GET to a loopback health URL, or null when nothing
   * answers. Certificates are not verified: this only asks whether the local
   * process is up; the runtime file confirms which version it is.
   */
  probe(url: string): Promise<number | null>;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  isRoot: boolean;
}

export class CommandError extends Error {
  constructor(message: string, readonly result?: RunResult) {
    super(message);
  }
}

export function systemIo(): Io {
  return {
    run: (command, args, options = {}) => new Promise((resolve, reject) => {
      const stdin = options.stdinFd ?? (options.input !== undefined ? 'pipe' : 'ignore');
      const stdout = options.stdoutFd ?? (options.capture ? 'pipe' : 'inherit');
      const stderr = options.capture ? 'pipe' : 'inherit';
      const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: [stdin, stdout, stderr] });
      let out = '';
      let err = '';
      child.stdout?.on('data', (chunk) => { out += String(chunk); });
      child.stderr?.on('data', (chunk) => { err += String(chunk); });
      if (options.input !== undefined) child.stdin?.end(options.input);
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }));
    }),
    fetch: globalThis.fetch.bind(globalThis),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
    warn: (line) => console.error(line),
    confirm: async (question) => {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    probe: (url) => new Promise((resolve) => {
      const target = new URL(url);
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(target, { method: 'GET', timeout: 5_000, rejectUnauthorized: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
      req.end();
    }),
    env: process.env,
    nodeVersion: process.version,
    isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  };
}

/** Run and throw with the tail of stderr on a non-zero exit. */
export async function mustRun(io: Io, command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  let result: RunResult;
  try {
    result = await io.run(command, args, options);
  } catch (error) {
    throw new CommandError(`${command} could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n');
    throw new CommandError(`${command} ${args.slice(0, 2).join(' ')} exited with ${result.code}${detail ? `:\n${detail}` : ''}`, result);
  }
  return result;
}
