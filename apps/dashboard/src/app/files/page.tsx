'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { NodeSelector } from '@/components/ui/node-selector';
import { FileBrowserModal } from '@/components/files/file-browser-modal';
import { LibraryPickerModal, SaveToLibraryModal } from '@/components/library/library-picker';
import { api } from '@/lib/api-client';
import { FileText, Save, Download, Loader2, FolderOpen, Library, BookOpen, ShieldCheck } from 'lucide-react';
import { PageTransition, PageItem } from '@/components/ui/page-transition';

export default function FilesPage(): React.ReactElement {
  const [nodeId, setNodeId] = useState('');
  const [filePath, setFilePath] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const [saveToLibraryOpen, setSaveToLibraryOpen] = useState(false);
  const [libraryFileId, setLibraryFileId] = useState<string | null>(null);
  const [backup, setBackup] = useState(true);
  const [preview, setPreview] = useState<{ policy: string; targetCount: number; backupPlanned: boolean; contentBytes: number } | null>(null);

  /** Extract a human-readable message from ky / API errors. */
  const extractErrorMessage = async (err: unknown, fallback: string): Promise<string> => {
    if (err && typeof err === 'object' && 'response' in err) {
      try {
        const body = await (err as { response: Response }).response.json();
        // Try body.error.message (API error shape)
        const apiMsg: string | undefined =
          (body as Record<string, unknown>)?.['error'] &&
          typeof (body as Record<string, unknown>)['error'] === 'object'
            ? ((body as Record<string, Record<string, string>>)['error']?.['message'])
            : undefined;
        if (apiMsg) return apiMsg;
        // Try body.data[].error for per-task errors
        const tasks = (body as Record<string, unknown>)?.['data'];
        if (Array.isArray(tasks)) {
          const failed = tasks.filter((t: Record<string, unknown>) => t.status === 'failed');
          if (failed.length > 0) {
            return failed.map((t: Record<string, unknown>) => t.error || 'Unknown error').join('; ');
          }
        }
      } catch { /* ignore parse errors */ }
    }
    if (err instanceof Error) {
      return err.message === 'Failed to fetch' ? 'Control node unreachable' : err.message;
    }
    return fallback;
  };

  const handleRead = async (pathOverride?: string): Promise<void> => {
    const targetPath = pathOverride ?? filePath;
    if (!nodeId || !targetPath) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.files.read(nodeId, targetPath);
      const data = res.data as { content: string };
      setContent(data.content);
    } catch (err: unknown) {
      const msg = await extractErrorMessage(err, 'Could not read file from node');
      setError(`Read failed: ${msg}`);
      setContent('');
    } finally {
      setLoading(false);
    }
  };

  const handleWrite = async (): Promise<void> => {
    if (!nodeId || !filePath) return;
    setLoading(true);
    setSaved(false);
    setError(null);
    try {
      const res = await api.files.update({
        nodeIds: [nodeId],
        filePath,
        content,
        createIfMissing: true,
        backup,
      });
      // Check per-task results — the API returns tasks with status
      const tasks = (res as { data: Array<{ status: string; error?: string }> }).data;
      const failed = tasks?.filter((t) => t.status === 'failed') ?? [];
      if (failed.length > 0) {
        const reasons = failed.map((t) => t.error || 'Unknown error').join('; ');
        setError(`Push failed: ${reasons}`);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (err: unknown) {
      const msg = await extractErrorMessage(err, 'Could not push file to node');
      setError(`Push failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async (): Promise<void> => {
    if (!nodeId || !filePath) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const res = await api.files.update({
        nodeIds: [nodeId],
        filePath,
        content,
        createIfMissing: true,
        backup,
        previewOnly: true,
      });
      setPreview(res.data as unknown as { policy: string; targetCount: number; backupPlanned: boolean; contentBytes: number });
    } catch (err: unknown) {
      const msg = await extractErrorMessage(err, 'Could not preview file update');
      setError(`Preview failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleLibrarySelect = (file: { id: string; name: string; fileName: string; content: string }): void => {
    setContent(file.content);
    setLibraryFileId(file.id);
    if (!filePath) {
      setFilePath(file.fileName);
    }
  };

  const handleSaveToLibrary = async (): Promise<void> => {
    if (libraryFileId && content) {
      // Update existing library file
      try {
        await api.library.files.update(libraryFileId, { content });
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      } catch {
        // Fallback to create new
        setSaveToLibraryOpen(true);
      }
    } else {
      setSaveToLibraryOpen(true);
    }
  };

  return (
    <PageTransition className="space-y-6">
      <PageItem>
      <div>
        <h1 className="text-lg font-bold uppercase tracking-wider">File Manager</h1>
        <p className="mt-1 text-[11px] text-text-muted uppercase tracking-wider">
          Read and update Magnus workspace files across nodes
        </p>
      </div>
      </PageItem>

      {/* Target Selection */}
      <PageItem>
      <Card title="Target">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NodeSelector
            value={nodeId}
            onChange={(v) => setNodeId(Array.isArray(v) ? v[0] ?? '' : v)}
            label="Node"
            placeholder="Select a node…"
          />
          <div>
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-text-muted">File Path</label>
            <div className="flex gap-2">
              <div
                onClick={() => nodeId && setBrowserOpen(true)}
                className={`flex-1 flex items-center gap-2 rounded border border-border bg-bg px-3 py-2 text-xs cursor-pointer hover:border-primary/40 hover:shadow-[0_0_8px_var(--color-glow)] transition-all ${
                  !nodeId ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                <FileText className="h-3.5 w-3.5 text-text-muted shrink-0" />
                <span className={filePath ? '' : 'text-text-muted'}>
                  {filePath || 'Browse to select a file…'}
                </span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setBrowserOpen(true)}
                disabled={!nodeId}
                title="Browse files on node"
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <Button variant="secondary" onClick={() => void handleRead()} disabled={loading || !nodeId || !filePath}>
              <Download className="h-4 w-4" />
              Pull
            </Button>
          </div>
        </div>
        <label className="mt-4 inline-flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-muted">
          <input type="checkbox" checked={backup} onChange={(event) => setBackup(event.target.checked)} />
          Create remote backup before write
        </label>
      </Card>
      </PageItem>
      <FileBrowserModal
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        nodeId={nodeId}
        currentPath="~"
        onSelect={(path) => {
          setFilePath(path);
          void handleRead(path);
        }}
        runAsUser={null}
      />

      {/* Error banner */}
      {error && (
        <PageItem>
        <div className="rounded border border-danger/40 bg-danger/5 px-4 py-3 text-[11px] text-danger flex items-center justify-between shadow-[0_0_8px_rgba(255,23,68,0.15)]">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-4 text-danger hover:text-danger/80 text-[10px] uppercase tracking-wider">
            Dismiss
          </button>
        </div>
        </PageItem>
      )}

      {preview && (
        <PageItem>
        <div className="rounded border border-primary/30 bg-primary/5 px-4 py-3 text-[11px] uppercase tracking-wider text-primary">
          Policy: {preview.policy} · targets: {preview.targetCount} · backup: {preview.backupPlanned ? 'planned' : 'off'} · bytes: {preview.contentBytes}
        </div>
        </PageItem>
      )}

      {/* Editor */}
      <PageItem>
      <Card
        title="File Editor"
        action={
          <div className="flex items-center gap-2">
            {saved && <span className="text-xs text-success">Saved!</span>}
            <Button variant="secondary" size="sm" onClick={() => setLibraryPickerOpen(true)}>
              <BookOpen className="h-3.5 w-3.5" />
              Load from Library
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void handleSaveToLibrary()} disabled={!content}>
              <Library className="h-3.5 w-3.5" />
              {libraryFileId ? 'Save to Library' : 'Save as Library File'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void handlePreview()} disabled={loading || !nodeId || !filePath}>
              <ShieldCheck className="h-3.5 w-3.5" />
              Preview
            </Button>
            <Button size="sm" onClick={() => void handleWrite()} disabled={loading || !nodeId}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Push to Node
            </Button>
          </div>
        }
      >
        <div className="flex items-center gap-2 border-b border-border/50 pb-3 mb-3">
          <FileText className="h-4 w-4 text-primary" />
          <span className="text-[11px] text-primary">{filePath || 'No file selected'}</span>
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="File content will appear here after pulling from a node…"
          rows={20}
          className="w-full rounded border border-border bg-bg p-4 text-xs leading-relaxed outline-none focus:border-primary focus:shadow-[0_0_12px_var(--color-glow)] transition-all text-text"
        />
      </Card>
      </PageItem>

      {/* Library Modals */}
      <LibraryPickerModal
        open={libraryPickerOpen}
        onClose={() => setLibraryPickerOpen(false)}
        onSelect={handleLibrarySelect}
      />

      <SaveToLibraryModal
        open={saveToLibraryOpen}
        onClose={() => setSaveToLibraryOpen(false)}
        fileName={filePath.split('/').pop() ?? (filePath || 'untitled.md')}
        content={content}
        onSaved={() => {
          setSaved(true);
          setTimeout(() => setSaved(false), 3000);
        }}
      />
    </PageTransition>
  );
}
