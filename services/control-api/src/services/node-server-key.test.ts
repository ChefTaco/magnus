import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowServerKeyCreation, resetServerSigningKeyCache, serverSigningKey } from './node-server-key.js';

const dir = mkdtempSync(join(tmpdir(), 'magnus-server-key-'));
afterEach(() => { resetServerSigningKeyCache(); vi.unstubAllEnvs(); });

describe('server signing key shared with command-line processes', () => {
  it('is created only by the server, and read as it is by every other process', () => {
    const file = join(dir, 'state', 'server-signing-key.json');
    vi.stubEnv('NODE_AUTH_SERVER_KEY_PATH', file);
    // A command-line process (agents upgrade) without the server's key file: refused, nothing written.
    expect(() => serverSigningKey()).toThrow(/No server signing key at .*run this command with the server's environment/);
    expect(() => statSync(file)).toThrow();
    // The server creates it at start-up.
    allowServerKeyCreation();
    const server = serverSigningKey();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // A later command-line process with the same settings signs with the very same key.
    resetServerSigningKeyCache();
    expect(serverSigningKey().keyId).toBe(server.keyId);
    rmSync(dir, { recursive: true, force: true });
  });
});
