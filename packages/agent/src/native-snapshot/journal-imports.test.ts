import { describe, expect, it } from 'vitest';
import { journalImports } from '../../journal-imports.mjs';

describe('journal module import review', () => {
  it('sees single- and double-quoted, multi-line and bare side-effect imports', () => {
    const source = [
      "import Database from './sqlite.js';",
      'import { z } from "zod";',
      "import {\n  readFile,\n  stat,\n} from 'node:fs/promises';",
      "import 'node:os';",
      'import "./side-effect.js";',
      "export { inspect } from './inspect.js';",
      "export const label = 'not an import';",
      'const later = "from \'nowhere\'";',
    ].join('\n');
    expect(journalImports(source)).toEqual(['./inspect.js', './side-effect.js', './sqlite.js', 'node:fs/promises', 'node:os', 'zod']);
  });

  it('matches the shipped Ardent module with its reviewed imports', async () => {
    const { readFile } = await import('node:fs/promises');
    const { createRequire } = await import('node:module');
    const { dirname, join, resolve } = await import('node:path');
    const ardent = resolve(dirname(createRequire(import.meta.url).resolve('@hivemagnus/ardent')), '..');
    expect(journalImports(await readFile(join(ardent, 'dist/journal.js'), 'utf8')))
      .toEqual(['./sqlite.js', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:os', 'node:path', 'node:stream/promises', 'zod']);
  });
});
