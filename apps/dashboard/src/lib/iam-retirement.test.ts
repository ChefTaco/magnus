import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
  it('does not reintroduce Magnus IAM dashboard surfaces', () => {
    const files = walk(join(process.cwd(), 'src'));
    const text = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const marker of [
      ['/', 'api', '/', 'iam-proxy'].join(''),
      ['/', 'oauth', '/', 'consent'].join(''),
      ['href="', '/', 'iam'].join(''),
    ]) {
      expect(text).not.toContain(marker);
    }
  });
});
