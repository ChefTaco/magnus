import { describe, expect, it } from 'vitest';
import { canRequestCodexUpdate } from './codex-update';

describe('Codex update action', () => {
  it('remains available when the release lookup is unknown', () => {
    expect(canRequestCodexUpdate({ installed: true, latestVersion: null, updateAvailable: false, updateSupported: true })).toBe(true);
  });

  it('is hidden only when an installed client is confirmed current', () => {
    expect(canRequestCodexUpdate({ installed: true, latestVersion: '0.154.0', updateAvailable: false, updateSupported: true })).toBe(false);
    expect(canRequestCodexUpdate({ installed: false, latestVersion: null, updateAvailable: false, updateSupported: true })).toBe(false);
    expect(canRequestCodexUpdate({ installed: true, latestVersion: null, updateAvailable: false, updateSupported: false })).toBe(false);
  });
});
