/** Minimal env-file handling: read, append missing keys, generate secrets. */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { writeAtomic } from './project.js';

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch (error) {
    throw new Error(`Cannot read the env file ${path}: ${error instanceof Error ? error.message : String(error)}. `
      + `${existsSync(`${path}.bak`) ? `The version before the last change is in ${path}.bak.` : 'Fix the file and re-run.'}`);
  }
}

/** 64 hex characters: comfortably above every 32-character secret minimum. */
export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * One env-file value, readable unchanged by dotenv, `node --env-file` and `docker compose
 * --env-file`. Single quotes are literal in all three. A value that itself holds a single quote is
 * double-quoted when nothing in it is special there; anything else cannot be written faithfully,
 * and is refused rather than silently altered (a changed password only shows up as a failed login).
 */
export function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!/["\\$`]/.test(value)) return `"${value}"`;
  throw new Error('An env-file value cannot mix a single quote with a double quote, backslash, dollar sign or backtick; percent-encode it (in a URL) or choose another value');
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
      lines.push(`${entry.name}=${quoteEnvValue(entry.value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Append entries whose names are not already present; existing values are
 * never changed. The file is replaced atomically (same mode and owner) and
 * the previous content is kept as `<file>.bak`.
 */
export function appendMissing(path: string, entries: EnvEntry[], note: string): string[] {
  const existing = readEnvFile(path);
  const missing = entries.filter((entry) => existing[entry.name] === undefined);
  if (missing.length === 0) return [];
  const block = [`\n# ${note}`, ...missing.flatMap((entry) => [
    ...(entry.comment ? [`# ${entry.comment}`] : []),
    `${entry.name}=${quoteEnvValue(entry.value)}`,
  ])].join('\n');
  const present = existsSync(path);
  const current = present ? readFileSync(path, 'utf8') : '';
  const stats = present ? statSync(path) : null;
  if (present) copyFileSync(path, `${path}.bak`);
  writeAtomic(path, `${current.replace(/\n*$/, '\n')}${block}\n`, stats ? stats.mode & 0o777 : 0o600, stats ? { uid: stats.uid, gid: stats.gid } : undefined);
  return missing.map((entry) => entry.name);
}
