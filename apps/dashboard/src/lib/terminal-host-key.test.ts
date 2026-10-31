/**
 * Unit tests for terminal-host-key — TOFU SSH host-key verification.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'terminal-hostkey-'));
  process.env['SSH_HOST_KEYS_FILE'] = join(workDir, 'known-hosts.json');
  process.env['TERMINAL_AUDIT_DIR'] = join(workDir, 'audit');
  delete process.env['SSH_HOST_KEY_PINNING'];
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env['SSH_HOST_KEYS_FILE'];
  delete process.env['TERMINAL_AUDIT_DIR'];
  delete process.env['SSH_HOST_KEY_PINNING'];
});

const { verifyTerminalHostKey } = await import('@/lib/terminal-host-key');

describe('verifyTerminalHostKey', () => {
  it('pins and accepts the first fingerprint seen for a host', () => {
    expect(verifyTerminalHostKey('node-a', 'fp-1')).toBe(true);
    expect(JSON.parse(readFileSync(process.env['SSH_HOST_KEYS_FILE']!, 'utf8'))).toEqual({
      'node-a': 'fp-1',
    });
  });

  it('accepts a matching fingerprint on later connections', () => {
    verifyTerminalHostKey('node-a', 'fp-1');
    expect(verifyTerminalHostKey('node-a', 'fp-1')).toBe(true);
  });

  it('rejects a changed fingerprint by default (enforce)', () => {
    verifyTerminalHostKey('node-a', 'fp-1');
    expect(verifyTerminalHostKey('node-a', 'fp-2')).toBe(false);
  });

  it('allows a changed fingerprint in warn mode (audit only)', () => {
    verifyTerminalHostKey('node-a', 'fp-1');
    process.env['SSH_HOST_KEY_PINNING'] = 'warn';
    expect(verifyTerminalHostKey('node-a', 'fp-2')).toBe(true);
  });

  it('pins each host independently', () => {
    verifyTerminalHostKey('node-a', 'fp-a');
    expect(verifyTerminalHostKey('node-b', 'fp-b')).toBe(true);
    expect(verifyTerminalHostKey('node-a', 'fp-b')).toBe(false);
  });

  it('fails closed when an existing pin file is malformed', () => {
    writeFileSync(process.env['SSH_HOST_KEYS_FILE']!, '{broken', { mode: 0o600 });
    expect(verifyTerminalHostKey('node-a', 'fp-1')).toBe(false);
  });

  it('fails closed when the pin file permissions are unsafe', () => {
    writeFileSync(process.env['SSH_HOST_KEYS_FILE']!, '{}', { mode: 0o600 });
    chmodSync(process.env['SSH_HOST_KEYS_FILE']!, 0o644);
    expect(verifyTerminalHostKey('node-a', 'fp-1')).toBe(false);
  });

  it('fails closed when the pin directory permissions are unsafe', () => {
    chmodSync(workDir, 0o755);
    expect(verifyTerminalHostKey('node-a', 'fp-1')).toBe(false);
  });

  it('fails closed while another filesystem enrollment lock is held', () => {
    writeFileSync(`${process.env['SSH_HOST_KEYS_FILE']!}.lock`, 'other-process\n', { mode: 0o600 });
    expect(verifyTerminalHostKey('node-a', 'fp-1')).toBe(false);
  });

  it('does not accept a first connection when the pin cannot be written', () => {
    const blockingPath = join(workDir, 'not-a-directory');
    writeFileSync(blockingPath, 'block', { mode: 0o600 });
    process.env['SSH_HOST_KEYS_FILE'] = join(blockingPath, 'known-hosts.json');
    expect(verifyTerminalHostKey('node-a', 'fp-1')).toBe(false);
  });

  it('allows store failures only in explicit warn mode', () => {
    mkdirSync(join(workDir, 'unsafe'), { mode: 0o755 });
    process.env['SSH_HOST_KEYS_FILE'] = join(workDir, 'unsafe', 'known-hosts.json');
    process.env['SSH_HOST_KEY_PINNING'] = 'warn';
    expect(verifyTerminalHostKey('node-a', 'fp-1')).toBe(true);
  });

  it('treats an unknown pinning mode as enforce', () => {
    writeFileSync(process.env['SSH_HOST_KEYS_FILE']!, '{broken', { mode: 0o600 });
    process.env['SSH_HOST_KEY_PINNING'] = 'enfroce';
    expect(verifyTerminalHostKey('node-a', 'fp-1')).toBe(false);
  });
});
