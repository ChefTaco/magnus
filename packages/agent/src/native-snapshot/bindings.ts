/** Configured TLS may be owned by the installation operator; manager authority stays root-owned. */
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { plainPath } from './files.js';

export type BindingStat = { uid: number; gid: number; mode: number; nlink: number; regular: boolean };
export function bindingRecord(label: string, path: string, stat: BindingStat, sha256: string, rootUid = 0) {
  const tls = ['TLS_CERT_PATH', 'TLS_KEY_PATH', 'CONTROL_API_CA_PATH'].includes(label);
  const mode = stat.mode & 0o777;
  if (!stat.regular || stat.nlink !== 1 || stat.mode & 0o7022 || (!tls && stat.uid !== rootUid)
    || (label === 'TLS_KEY_PATH' && mode !== 0o600)) throw new Error('Native manager binding file is unsafe');
  // Storage roles, paths and original metadata are part of the same retained binding as content.
  return { label, path, uid: stat.uid, gid: stat.gid, mode, sha256 };
}
export async function tlsAncestry(path: string, ownerUid: number, rootUid = 0): Promise<void> {
  await plainPath(path);
  let parent = dirname(path); const immediate = parent;
  for (;;) {
    const info = await lstat(parent);
    const rootOwned = info.uid === 0 || info.uid === rootUid;
    // A root-owned sticky ancestor can protect a private child (for example temporary staging).
    // The certificate's immediate parent itself must never be shared-writable.
    const protectedStickyAncestor = parent !== immediate && rootOwned && (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || info.isSymbolicLink() || (!rootOwned && info.uid !== ownerUid)
      || ((info.mode & 0o022) !== 0 && !protectedStickyAncestor)) throw new Error('Configured TLS binding ancestry is unsafe');
    if (parent === '/') break;
    parent = dirname(parent);
  }
}
