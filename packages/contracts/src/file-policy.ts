/**
 * Path policy for file writes pushed to nodes, shared by the Control API (judging the requested
 * path) and the node agent (judging the real destination after symlink resolution). A write to a
 * sensitive system path needs an ADMIN's authority: the server forwards it as `adminWrite: true`
 * in the signed `/files/write` request, and an agent refuses a sensitive destination without it.
 */
export const BLOCKED_FILE_PREFIXES = ['/proc/', '/sys/', '/dev/'] as const;
export const SENSITIVE_FILE_PREFIXES = ['/etc/', '/root/', '/var/lib/', '/var/spool/', '/boot/', '/usr/', '/bin/', '/sbin/', '/lib/', '/lib64/'] as const;

export type FilePathPolicy = 'safe-app-path' | 'sensitive-system-path' | 'blocked-path';

/** Policy of an absolute, normalized path. */
export function filePathPolicy(filePath: string): FilePathPolicy {
  if (filePath === '/' || BLOCKED_FILE_PREFIXES.some((prefix) => filePath === prefix.slice(0, -1) || filePath.startsWith(prefix))) {
    return 'blocked-path';
  }
  if (SENSITIVE_FILE_PREFIXES.some((prefix) => filePath === prefix.replace(/\/$/, '') || filePath.startsWith(prefix))
    || filePath.split('/').includes('.ssh')) {
    return 'sensitive-system-path';
  }
  return 'safe-app-path';
}
