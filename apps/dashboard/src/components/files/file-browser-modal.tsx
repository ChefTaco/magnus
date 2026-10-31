'use client';

import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import {
  Folder,
  FileText,
  ArrowUp,
  Loader2,
  Home,
  RefreshCw,
  FileCode,
  File,
  FileImage,
  FileArchive,
} from 'lucide-react';

interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: string;
  permissions: string;
  modified: string;
}

interface FileBrowserModalProps {
  open: boolean;
  onClose: () => void;
  nodeId: string;
  currentPath: string;
  onSelect: (filePath: string) => void;
  /** When set, commands run as this user (via runuser) instead of root. */
  runAsUser?: string | null;
}

/**
 * Wrap a string in POSIX single-quotes, escaping any embedded single-quotes
 * using the '\'' idiom (end quote, escaped literal quote, restart quote).
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function fileIcon(name: string, isDir: boolean): React.ReactNode {
  if (isDir) return <Folder className="h-4 w-4 text-warning shrink-0" />;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'json', 'yaml', 'yml', 'toml'].includes(ext))
    return <FileCode className="h-4 w-4 text-primary shrink-0" />;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext))
    return <FileImage className="h-4 w-4 text-accent shrink-0" />;
  if (['tar', 'gz', 'zip', 'bz2', 'xz', 'deb', 'rpm'].includes(ext))
    return <FileArchive className="h-4 w-4 text-warning shrink-0" />;
  if (['md', 'txt', 'log', 'conf', 'cfg', 'ini', 'env'].includes(ext))
    return <FileText className="h-4 w-4 text-success shrink-0" />;
  return <File className="h-4 w-4 text-text-muted shrink-0" />;
}

/**
 * Remote file browser modal.
 * Lists files on a node using `ls -la` via the quick-command endpoint.
 */
export function FileBrowserModal({
  open,
  onClose,
  nodeId,
  currentPath,
  onSelect,
  runAsUser,
}: FileBrowserModalProps): React.ReactElement | null {
  const [cwd, setCwd] = useState(currentPath || '~');
  const [resolvedCwd, setResolvedCwd] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listDir = useCallback(
    async (dir: string): Promise<void> => {
      if (!nodeId) return;
      setLoading(true);
      setError(null);

      try {
        // Build the inner shell command — use -F flag to append / to directories
        const innerCmd = `cd ${JSON.stringify(dir)} 2>/dev/null || cd ~ ; echo "CWD:$(pwd)" ; ls -laF --time-style=long-iso 2>/dev/null || ls -laF 2>/dev/null`;

        // The node-manager executor uses spawn(command, args, { shell: true })
        // which concatenates command + args WITHOUT quoting, so shell
        // metacharacters in args (like ||, ;, >) are interpreted by the outer
        // shell.  To avoid this, send the entire command as a single string
        // with args: [].  For runAsUser, wrap innerCmd in properly-escaped
        // single quotes so runuser -c receives it as one argument.
        const fullCmd = runAsUser
          ? `runuser -l ${runAsUser} -c ${shellQuote(innerCmd)}`
          : innerCmd;

        const res = await api.quickCommand.exec(nodeId, {
          command: fullCmd,
          args: [],
          timeoutSeconds: 10,
        });

        const data = res.data;
        if (!data) { setError('Failed to list directory'); setLoading(false); return; }
        if (data.exitCode !== 0 && !data.stdout) {
          setError(data.stderr || `Failed to list directory (exit ${data.exitCode})`);
          setLoading(false);
          return;
        }

        const lines = data.stdout.split('\n').filter(Boolean);

        // Extract resolved CWD
        const cwdLine = lines.find((l) => l.startsWith('CWD:'));
        const resolved = cwdLine ? cwdLine.replace('CWD:', '').trim() : dir;
        setResolvedCwd(resolved);
        setCwd(resolved);

        // Parse ls -la output (skip "total X" line and CWD line)
        const parsed: FileEntry[] = [];
        for (const line of lines) {
          if (line.startsWith('CWD:') || line.startsWith('total ')) continue;
          // ls -la --time-style=long-iso format:
          // drwxr-xr-x  5 user group 4096 2026-02-13 10:30 dirname
          const parts = line.split(/\s+/);
          if (parts.length < 8) continue;

          const permissions = parts[0] ?? '';
          const size = parts[4] ?? '0';
          // Date may be parts[5] + parts[6], name is the rest
          const dateStr = `${parts[5] ?? ''} ${parts[6] ?? ''}`;
          const name = parts.slice(7).join(' ');

          if (!name || name === '.' || name === '..') continue;

          const isLink = permissions.startsWith('l');
          // For symlinks, strip " -> target"
          const displayName = isLink ? name.split(' -> ')[0] ?? name : name;

          // With -F flag, ls appends type indicators: / for dirs, @ for symlinks, * for exec, etc.
          // A symlink to a directory shows as: linkname@ -> target/  OR  linkname/ -> target/
          // We detect directories by: permission starts with 'd', OR name/target ends with '/'
          const cleanName = displayName.replace(/[/@*|]$/, '');
          const endsWithSlash = displayName.endsWith('/') || (isLink && name.endsWith('/'));
          const isDirectory = permissions.startsWith('d') || endsWithSlash;

          parsed.push({
            name: cleanName,
            isDirectory,
            size,
            permissions,
            modified: dateStr,
          });
        }

        // Sort: directories first, then alphabetical
        parsed.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        setEntries(parsed);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to browse files');
      } finally {
        setLoading(false);
      }
    },
    [nodeId, runAsUser],
  );

  // Reset to initial path and list when modal opens
  useEffect(() => {
    if (open && nodeId) {
      const startPath = currentPath || '~';
      setCwd(startPath);
      void listDir(startPath);
    }
  }, [open, nodeId]);

  const navigateUp = (): void => {
    const parent = resolvedCwd.replace(/\/[^/]+\/?$/, '') || '/';
    void listDir(parent);
  };

  const navigateInto = (dirName: string): void => {
    const next = resolvedCwd === '/' ? `/${dirName}` : `${resolvedCwd}/${dirName}`;
    void listDir(next);
  };

  const selectFile = (fileName: string): void => {
    const fullPath =
      resolvedCwd === '/' ? `/${fileName}` : `${resolvedCwd}/${fileName}`;
    onSelect(fullPath);
    onClose();
  };

  const formatSize = (size: string): string => {
    const n = parseInt(size, 10);
    if (isNaN(n)) return size;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Browse Files"
      description={resolvedCwd || cwd}
      icon={<Folder className="h-5 w-5 text-primary" />}
      className="max-w-2xl"
    >
      <div className="space-y-3">
        {/* Navigation bar */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={navigateUp}
            disabled={loading || resolvedCwd === '/'}
            title="Go up"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void listDir('~')}
            disabled={loading}
            title="Home directory"
          >
            <Home className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void listDir(resolvedCwd || cwd)}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <div className="flex-1 rounded border border-border bg-bg px-3 py-1.5 text-xs text-text-muted truncate">
            {resolvedCwd || cwd}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded bg-danger/10 border border-danger/30 p-3">
            <p className="text-xs text-danger">{error}</p>
          </div>
        )}

        {/* File list */}
        <div className="h-96 overflow-y-auto rounded border border-border">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
            </div>
          ) : entries.length === 0 ? (
            <div className="py-8 text-center text-xs text-text-muted">
              Empty directory
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface z-10">
                <tr className="border-b border-border text-[10px] font-bold uppercase tracking-[0.15em] text-text-muted">
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-right w-24">Size</th>
                  <th className="px-3 py-2 text-right w-40 hidden sm:table-cell">
                    Modified
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.name}
                    className="border-b border-border/50 hover:bg-surface-hover hover:shadow-[0_0_20px_var(--color-glow)] cursor-pointer transition-all"
                    onClick={() =>
                      entry.isDirectory
                        ? navigateInto(entry.name)
                        : selectFile(entry.name)
                    }
                    onDoubleClick={() =>
                      entry.isDirectory
                        ? navigateInto(entry.name)
                        : selectFile(entry.name)
                    }
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {fileIcon(entry.name, entry.isDirectory)}
                        <span
                          className={
                            entry.isDirectory
                              ? 'font-bold text-warning'
                              : ''
                          }
                        >
                          {entry.name}
                          {entry.isDirectory ? '/' : ''}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-text-muted">
                      {entry.isDirectory ? '—' : formatSize(entry.size)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-text-muted hidden sm:table-cell">
                      {entry.modified}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer hint */}
        <p className="text-xs text-text-muted">
          Click a folder to navigate into it. Click a file to select it.
        </p>
      </div>
    </Modal>
  );
}
