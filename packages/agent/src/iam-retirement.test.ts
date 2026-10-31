import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path)) out.push(path);
  }
  return out;
}

describe('IAM retirement guard', () => {
  it('does not reintroduce the Magnus IAM agent subsystem', () => {
    expect(existsSync(join(process.cwd(), 'src/iam'))).toBe(false);
    const text = walk(join(process.cwd(), 'src')).map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const marker of [
      ['ENABLE', '_IAM'].join(''),
      ['/', 'api', '/', 'iam', '/'].join(''),
    ]) {
      expect(text).not.toContain(marker);
    }
  });
});
