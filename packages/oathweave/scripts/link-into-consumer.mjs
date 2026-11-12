#!/usr/bin/env node
// This package is never published: the packages that use it carry it in their tarball through
// bundleDependencies. `npm pack` run in a workspace only sees that workspace's own node_modules, and
// silently omits a dependency hoisted to the repository root, so each consumer links this package
// there as the last step of its build. Node resolves the link to this same source, so nothing is
// copied. The link goes when node_modules does; `npm run check:packs` fails if a tarball lacks it.
//
// @hivemagnus/hive-common, jose and zod are peer dependencies for the same reason: npm would pack a linked package's regular
// dependencies at paths outside the tarball root. Consumers depend on them directly instead.
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function linkInto(consumer) {
  if (!existsSync(join(packageRoot, 'dist', 'index.js'))) throw new Error('Build @hivemagnus/magnus-oathweave before its consumers');
  const link = join(consumer, 'node_modules', '@hivemagnus', 'magnus-oathweave');
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(relative(dirname(link), packageRoot), link, 'dir');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) linkInto(process.cwd());
