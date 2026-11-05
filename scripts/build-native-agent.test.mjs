import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertPinnedImage,
  validateRuntimeTree,
  copyRuntimeTree,
  buildNativeAgent,
} from './build-native-agent.mjs';
test('native export requires an immutable image before any Docker command', () => {
  for (const value of [
    'magnus-agent:latest',
    'magnus-agent:candidate',
    'sha256:short',
    'example.com/agent@sha256:' + 'g'.repeat(64),
  ])
    assert.throws(() => assertPinnedImage(value), /exact reviewed image/);
  assert.doesNotThrow(() => assertPinnedImage('sha256:' + '0'.repeat(64)));
});
test('native product layouts are explicitly owned and reviewed before Docker access', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'magnus-native-product-'));
  try {
    const execute = () => { throw Error('Reached immutable image review'); };
    for (const product of ['magnus', 'ardent', 'codex'])
      assert.throws(() => buildNativeAgent({ image: 'sha256:' + '0'.repeat(64), output: join(temporary, product), product }, execute), /immutable image review/);
    assert.throws(() => buildNativeAgent({ image: 'sha256:' + '0'.repeat(64), output: join(temporary, 'other'), product: '../other' }, execute), /owned native product/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
test('native runtime review refuses model assets and directory link cycles', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'magnus-native-boundary-'));
  try {
    const root = join(temporary, 'runtime');
    mkdirSync(root);
    const weights = join(root, 'synthetic.gguf');
    writeFileSync(weights, 'synthetic fixture, not model data');
    assert.throws(() => validateRuntimeTree(root), /external inference/);
    rmSync(weights);
    mkdirSync(join(root, 'nested'));
    symlinkSync('.', join(root, 'nested/loop'));
    assert.throws(() => validateRuntimeTree(root), /cyclic/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
test('public package links are bounded to the exported tree before dereferencing', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'magnus-native-tree-'));
  try {
    const root = join(temporary, 'runtime');
    mkdirSync(root);
    writeFileSync(
      join(root, 'published.js'),
      'export const publicFixture=true;',
    );
    symlinkSync('published.js', join(root, 'internal.js'));
    validateRuntimeTree(root);
    copyRuntimeTree(root, join(temporary, 'copied'));
    assert.equal(
      lstatSync(join(temporary, 'copied/internal.js')).isFile(),
      true,
    );
    writeFileSync(join(temporary, 'private-fixture'), 'never copied');
    symlinkSync('../private-fixture', join(root, 'escape'));
    assert.throws(() => validateRuntimeTree(root), /escapes/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
