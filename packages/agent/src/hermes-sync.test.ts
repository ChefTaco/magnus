import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseToolSurface, pluginEnabled, safeInstallPath, verifyArtifact } from './hermes-sync.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

describe('Hermes sync immutable skill and tool inventory', () => {
  it('accepts category paths and rejects parent traversal, absolute paths, and empty segments', () => {
    expect(safeInstallPath('writing/book-blueprint')).toBe(true);
    for (const path of ['../escape', '/absolute', 'writing//book', 'writing/./book', ''])
      expect(safeInstallPath(path)).toBe(false);
  });

  it('checks the whole artifact and each file before a skill can be installed', () => {
    const bytes = Buffer.from('---\nname: book\ndescription: Blueprint\n---\n');
    const artifact = { format: 'magnus-hermes-skill-v1', installPath: 'writing/book',
      files: [{ path: 'SKILL.md', contentBase64: bytes.toString('base64'), sha256: sha(bytes), mode: 420 }] };
    expect(verifyArtifact(artifact, sha(JSON.stringify(artifact))).installPath).toBe('writing/book');
    expect(() => verifyArtifact(artifact, '0'.repeat(64))).toThrow('hash mismatch');
    const forged = { ...artifact, files: [{ ...artifact.files[0], sha256: '0'.repeat(64) }] };
    expect(() => verifyArtifact(forged, sha(JSON.stringify(forged)))).toThrow('file hash mismatch');
  });

  it('extracts the actual enabled platform tools from native Hermes summary output', () => {
    const summary = '\x1b[1m☤ Tool Summary\x1b[0m\n  🖥️  CLI  (2/3)\n    ✓ 💻 Terminal & Processes\n    ✓ 📚 Skills\n  📱 Telegram  (1/3)\n    ✓ 📚 Skills\n';
    const clean = summary.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    expect(parseToolSurface(clean)).toEqual([
      { platform: 'cli', enabled: ['💻 Terminal & Processes', '📚 Skills'] },
      { platform: 'telegram', enabled: ['📚 Skills'] },
    ]);
    expect(() => parseToolSurface('Tool Summary\n')).toThrow();
  });

  it('recognizes enabled plugin status without treating Hermes not enabled as enabled', () => {
    expect(pluginEnabled('enabled')).toBe(true);
    expect(pluginEnabled('not enabled')).toBe(false);
    expect(pluginEnabled('disabled')).toBe(false);
  });
});
