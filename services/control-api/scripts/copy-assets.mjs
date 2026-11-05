#!/usr/bin/env node
// Copies non-TypeScript runtime assets into dist/ after `tsc --build`, and links the workspace
// package this one bundles so that `npm pack` includes it.
import { cpSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkInto } from '../../../packages/oathweave/scripts/link-into-consumer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
cpSync(join(root, 'src', 'ai'), join(root, 'dist', 'ai'), { recursive: true });
chmodSync(join(root, 'dist', 'cli.js'), 0o755);
linkInto(root);
