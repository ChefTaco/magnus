#!/usr/bin/env node
/** Fail CI when a process-wide or per-connection TLS verification bypass returns. */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
  .filter((file) => existsSync(file))
  .filter((file) => /\.(?:ts|tsx|js|mjs|cjs|sh|py)$/.test(file))
  .filter((file) => !file.includes('.test.') && file !== 'scripts/check-tls-bypasses.mjs');
const forbidden = [
  /rejectUnauthorized\s*:\s*false/,
  /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0/,
  /curl\b[^\n]*\s(?:--insecure|-[A-Za-z]*k[A-Za-z]*)(?![A-Za-z])/,
  /_create_unverified_context\s*\(/,
  /verify\s*=\s*False/,
  /check_hostname\s*=\s*False/,
  /CERT_NONE/,
];
const violations = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  source.split(/\r?\n/).forEach((line, index) => {
    if (forbidden.some((pattern) => pattern.test(line))) violations.push(`${file}:${index + 1}`);
  });
}
if (violations.length > 0) {
  console.error(`TLS verification bypasses found:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log(`TLS bypass scan passed (${files.length} source files)`);
