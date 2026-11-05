/**
 * The one place SSH is spoken. Destination and identity come from the resolved target and service
 * configuration. A shell with a PTY is the only channel opened: no exec, no environment, no
 * forwarding. Host keys are checked against the approved fingerprints, and nothing is learned.
 */
import { readFileSync, statSync } from 'node:fs';
import ssh2, { type ClientChannel } from 'ssh2';
import { GatewayError } from './errors.js';
import { hostKeyFingerprint } from './known-hosts.js';
import type { SshTarget } from './target.js';

// ssh2 is CommonJS, and Node's ESM loader does not see its exports as named ones.
const { Client, utils } = ssh2;
type SshClient = InstanceType<typeof Client>;

// ssh-rsa signs with SHA-1. Any OpenSSH from the last decade offers rsa-sha2 for the same key.
const algorithms = { serverHostKey: { remove: ['ssh-rsa'] } } as const;

const READY_TIMEOUT_MS = 12_000;
const CONNECT_TIMEOUT_MS = 15_000;

export interface PtySize { cols: number; rows: number }

export interface ShellChannel {
  /** Returns false when the remote side is not keeping up. */
  write(data: string): boolean;
  readonly congested: boolean;
  resize(size: PtySize): void;
  pause(): void;
  resume(): void;
  onData(listener: (chunk: Buffer) => void): void;
  /** Fires once. `exitCode` is the remote shell's status, or null if the connection was simply lost. */
  onClose(listener: (exitCode: number | null) => void): void;
  /** Ends the channel and connection, immediately. */
  terminate(): void;
}

export type ShellConnector = (target: SshTarget, size: PtySize) => Promise<ShellChannel>;

export interface SshIdentity { username: string; privateKey: Buffer }

/** Load the restricted key once at startup. A missing or exposed key stops the service. */
export function loadSshIdentity(username: string, path: string): SshIdentity {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) throw new Error('FLEET_GATEWAY_SSH_USERNAME is not a valid account name');
  // A mounted secret is commonly a symlink, so check what it points at.
  const info = statSync(path);
  if (!info.isFile()) throw new Error('FLEET_GATEWAY_SSH_PRIVATE_KEY_PATH is not a regular file');
  if ((info.mode & 0o027) !== 0) throw new Error('FLEET_GATEWAY_SSH_PRIVATE_KEY_PATH must not be writable by group or accessible to others');
  const privateKey = readFileSync(path);
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw new Error('FLEET_GATEWAY_SSH_PRIVATE_KEY_PATH does not hold a usable unencrypted private key');
  return { username, privateKey };
}

function channelFor(client: SshClient, stream: ClientChannel): ShellChannel {
  let closed = false;
  let exitCode: number | null = null;
  const closeListeners: Array<(code: number | null) => void> = [];
  const close = () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(exitCode);
    client.destroy();
  };
  stream.on('exit', (code: unknown) => { if (typeof code === 'number') exitCode = code; });
  stream.on('close', close);
  stream.on('error', close);
  client.on('close', close);
  client.on('error', close);
  return {
    write: (data) => stream.write(data),
    get congested() { return stream.writableNeedDrain; },
    resize: ({ cols, rows }) => { stream.setWindow(rows, cols, 0, 0); },
    // Both: a node can send extended data even on a PTY, and only a paused stream stops the window.
    pause: () => { stream.pause(); stream.stderr.pause(); },
    resume: () => { stream.resume(); stream.stderr.resume(); },
    onData: (listener) => {
      stream.on('data', listener);
      stream.stderr.on('data', listener);
    },
    onClose: (listener) => {
      if (closed) listener(exitCode);
      else closeListeners.push(listener);
    },
    terminate: close,
  };
}

/** A real client bound to one identity and fixed options. */
export function sshConnector(identity: SshIdentity): ShellConnector {
  return (target, size) => new Promise<ShellChannel>((resolve, reject) => {
    const client = new Client();
    const expected = new Set(target.fingerprints);
    let refusedKey: string | undefined;
    let settled = false;
    const connectionFailed = () => {
      if (refusedKey === undefined) return new GatewayError('SSH_CONNECT_FAILED');
      const changed = new GatewayError('HOST_KEY_CHANGED');
      changed.observedFingerprint = refusedKey;
      return changed;
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new GatewayError('SSH_CONNECT_FAILED')), CONNECT_TIMEOUT_MS);
    client.on('error', () => fail(connectionFailed()));
    client.on('close', () => fail(connectionFailed()));
    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows, width: 0, height: 0 }, (error, stream) => {
        if (error) return fail(new GatewayError('SSH_CONNECT_FAILED'));
        if (settled) { client.destroy(); return; }
        settled = true;
        clearTimeout(timer);
        resolve(channelFor(client, stream));
      });
    });
    try {
      client.connect({
        host: target.address,
        port: target.port,
        username: identity.username,
        privateKey: identity.privateKey,
        tryKeyboard: false,
        agentForward: false,
        algorithms: algorithms as never,
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          const fingerprint = hostKeyFingerprint(key);
          if (expected.has(fingerprint)) return true;
          refusedKey = fingerprint;
          return false;
        },
      });
    } catch {
      fail(new GatewayError('SSH_CONNECT_FAILED'));
    }
  });
}

/** Handshake without authenticating, to report the key a node presents. For the trust commands only. */
export function scanHostKey(address: string, port: number, username: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let observed: string | undefined;
    const finish = () => {
      client.destroy();
      if (observed) resolve(observed);
      else reject(new Error('The node did not complete an SSH key exchange'));
    };
    client.on('error', finish);
    client.on('close', finish);
    client.connect({
      host: address,
      port,
      username,
      tryKeyboard: false,
      algorithms: algorithms as never,
      readyTimeout: READY_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        observed = hostKeyFingerprint(key);
        setImmediate(finish);
        return false;
      },
    });
  });
}
