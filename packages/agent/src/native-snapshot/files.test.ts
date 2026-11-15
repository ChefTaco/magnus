import { describe, expect, it } from 'vitest';
import { validateTree, type Entry, type Tree } from './files.js';
const runtime = (): Tree => ({ label: 'runtime', entries: [
  { path: '', kind: 'directory', uid: 20001, gid: 20001, mode: 0o700, size: 0 },
  { path: 'package-receipt.json', kind: 'file', uid: 0, gid: 0, mode: 0o600, size: 20, sha256: '0'.repeat(64) },
] });
describe('native archive ownership boundary', () => {
  it('permits only the manager-owned private runtime receipt alongside the non-root runtime owner', () => {
    expect(() => validateTree(runtime(), 20001, 20001)).not.toThrow();
    const arbitrary = runtime(); arbitrary.entries[1]!.path = 'runtime.js';
    expect(() => validateTree(arbitrary, 20001, 20001)).toThrow('ownership');
    const profileReceipt = runtime(); profileReceipt.label = 'root';
    expect(() => validateTree(profileReceipt, 20001, 20001)).toThrow('ownership');
  });
  it('refuses broadened root receipt modes, foreign group, hard-coded alternate owner and symbolic receipt', () => {
    for (const change of [{ mode: 0o644 }, { gid: 20001 }, { uid: 99 }, { kind: 'link' as const, link: 'other.json', sha256: undefined }]) {
      const value = runtime(); Object.assign(value.entries[1]!, change);
      expect(() => validateTree(value, 20001, 20001)).toThrow();
    }
  });
});

const owner = { uid: 20001, gid: 20001 };
const directory = (path: string): Entry => ({ path, kind: 'directory', ...owner, mode: 0o700, size: 0 });
const file = (path: string): Entry => ({ path, kind: 'file', ...owner, mode: 0o600, size: 1, sha256: '0'.repeat(64) });
const link = (path: string, target: string): Entry => ({ path, kind: 'link', ...owner, mode: 0o777, size: 0, link: target });
const graph = (...entries: Entry[]): Tree => ({ label: 'runtime', entries: [directory(''), ...entries] });
describe('declared native snapshot symlink graph', () => {
  it('expands directory links before parent traversal and refuses a lexical-inside/kernel-outside target', () => {
    // `a/../outside` follows a back to the tree root before .. leaves that root.
    const tree = graph(link('a', '.'), link('b', 'a/../outside'), file('outside'));
    expect(() => validateTree(tree, owner.uid, owner.gid)).toThrow('escapes');
    expect(() => validateTree(graph(link('a', '.')), owner.uid, owner.gid)).not.toThrow();
  });
  it('supports safe forward/chained targets and preserves raw parent traversal after expansion', () => {
    const tree = graph(link('a', 'd/sub'), link('b', 'a/../../target'), link('c', 'b'), directory('d'), directory('d/sub'), file('target'));
    expect(() => validateTree(tree, owner.uid, owner.gid)).not.toThrow();
    const binaries = graph(directory('node_modules'), directory('node_modules/.bin'), link('node_modules/.bin/tool', '../tool/bin.js'), directory('node_modules/tool'), file('node_modules/tool/bin.js'));
    expect(() => validateTree(binaries, owner.uid, owner.gid)).not.toThrow();
    expect(() => validateTree(graph(link('a', '.'), link('b', 'a/a')), owner.uid, owner.gid)).not.toThrow();
  });
  it('rejects self/mutual cycles and bounds growing recursive paths', () => {
    for (const tree of [graph(link('a', 'a')), graph(link('a', 'b'), link('b', 'a'))])
      expect(() => validateTree(tree, owner.uid, owner.gid)).toThrow('cycle');
    expect(() => validateTree(graph(link('a', 'a/x')), owner.uid, owner.gid)).toThrow('40-link');
  });
  it('rejects dangling targets, non-directory traversal and undeclared or symbolic actual ancestors', () => {
    expect(() => validateTree(graph(link('a', 'missing')), owner.uid, owner.gid)).toThrow('dangling');
    for (const target of ['target/child', 'target/..', 'target/'])
      expect(() => validateTree(graph(link('a', target), file('target')), owner.uid, owner.gid)).toThrow('non-directory');
    expect(() => validateTree(graph(link('alias', '.'), file('alias/child')), owner.uid, owner.gid)).toThrow('parent');
    expect(() => validateTree(graph(link('a', 'missing/../target'), file('target')), owner.uid, owner.gid)).toThrow('dangling');
  });
  it('allows at most forty total symlink expansions without host filesystem access', () => {
    const chain = (length: number) => graph(...Array.from({ length }, (_, i) => link('link' + i, i === length - 1 ? 'target' : 'link' + (i + 1))), file('target'));
    expect(() => validateTree(chain(40), owner.uid, owner.gid)).not.toThrow();
    expect(() => validateTree(chain(41), owner.uid, owner.gid)).toThrow('40-link');
  });
});
