/** Minimal env-file handling: read, append missing keys, generate secrets. */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
}

/** 64 hex characters: comfortably above every 32-character secret minimum. */
export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@%+,=-]*$/.test(value) ? value : `'${value.replace(/'/g, '')}'`;
}

export interface EnvEntry {
  name: string;
  value: string;
  comment?: string;
}

export function renderEnv(header: string, sections: Array<{ title: string; entries: EnvEntry[] }>): string {
  const lines = header.split('\n').map((line) => `# ${line}`.trimEnd());
  for (const section of sections) {
    lines.push('', `# ── ${section.title} ──`);
    for (const entry of section.entries) {
      if (entry.comment) lines.push(`# ${entry.comment}`);
      lines.push(`${entry.name}=${quote(entry.value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Append entries whose names are not already present; existing values are never changed. */
export function appendMissing(path: string, entries: EnvEntry[], note: string): string[] {
  const existing = readEnvFile(path);
  const missing = entries.filter((entry) => existing[entry.name] === undefined);
  if (missing.length === 0) return [];
  const block = [`\n# ${note}`, ...missing.flatMap((entry) => [
    ...(entry.comment ? [`# ${entry.comment}`] : []),
    `${entry.name}=${quote(entry.value)}`,
  ])].join('\n');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, `${current.replace(/\n*$/, '\n')}${block}\n`, { mode: 0o600 });
  return missing.map((entry) => entry.name);
}
