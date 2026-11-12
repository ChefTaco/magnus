import { readFileSync } from 'node:fs';
import { satisfiesRange } from '@hivemagnus/magnus-contracts';
import { z } from 'zod';

const manifest = z.object({ engines: z.object({ node: z.string().min(1) }) })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

/** Keep native health and CLI admission aligned with the packaged security minimum. */
export function nodeRuntimeCheck(version = process.version): {
  name: 'node-version'; status: 'pass' | 'fail'; message: string;
} {
  const range = manifest.engines.node;
  const supported = satisfiesRange(version, range);
  return {
    name: 'node-version',
    status: supported ? 'pass' : 'fail',
    message: supported ? version : `requires Node.js ${range}; this node runs ${version}`,
  };
}
