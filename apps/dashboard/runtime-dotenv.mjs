import { readFileSync, writeFileSync } from 'node:fs';

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function serializeDotenvValue(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
    throw new Error('dotenv values must be single-line strings without NUL bytes');
  }
  return Buffer.from(value, 'utf8').toString('base64');
}

export function upsertDotenvValues(source, values) {
  const keys = Object.keys(values);
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) throw new Error(`invalid dotenv key: ${key}`);
  }
  const keySet = new Set(keys.flatMap((key) => [key, `${key}_B64`]));
  const lines = source.split(/\r?\n/).filter((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    return !match || !keySet.has(match[1]);
  });
  while (lines.at(-1) === '') lines.pop();
  for (const key of keys) lines.push(`${key}_B64=${serializeDotenvValue(values[key])}`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [envFile, valuesFile] = process.argv.slice(2);
  if (!envFile || !valuesFile) throw new Error('usage: runtime-dotenv.mjs <env-file> <values-json>');
  const values = JSON.parse(readFileSync(valuesFile, 'utf8'));
  const source = readFileSync(envFile, 'utf8');
  writeFileSync(envFile, upsertDotenvValues(source, values), { mode: 0o600 });
}
