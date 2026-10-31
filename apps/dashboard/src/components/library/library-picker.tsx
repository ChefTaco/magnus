'use client';

import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api-client';
import { formatDate, formatBytes } from '@/lib/utils';
import { Library, Search, FileText, Image, FileJson, File, X } from 'lucide-react';

interface LibraryFileRow {
  id: string;
  name: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  categoryId: string | null;
  tags: string[];
  updatedAt: string;
  category?: { id: string; name: string; color: string } | null;
}

interface LibraryPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (file: { id: string; name: string; fileName: string; content: string }) => void;
  title?: string;
}

function fileIcon(mimeType: string): React.ReactElement {
  if (mimeType.startsWith('image/')) return <Image className="h-4 w-4" />;
  if (mimeType === 'application/json') return <FileJson className="h-4 w-4" />;
  if (mimeType === 'text/markdown' || mimeType === 'text/plain') return <FileText className="h-4 w-4" />;
  return <File className="h-4 w-4" />;
}

function mimeLabel(mimeType: string): string {
  const map: Record<string, string> = {
    'text/markdown': 'Markdown',
    'text/plain': 'Text',
    'application/json': 'JSON',
    'application/pdf': 'PDF',
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/svg+xml': 'SVG',
  };
  return map[mimeType] ?? mimeType.split('/')[1]?.toUpperCase() ?? 'File';
}

export function LibraryPickerModal({ open, onClose, onSelect, title }: LibraryPickerProps): React.ReactElement | null {
  const [files, setFiles] = useState<LibraryFileRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchFiles = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const params: Record<string, string> = { pageSize: '100' };
      if (search) params.query = search;
      // Only show text-based files that make sense for the file editor
      const res = await api.library.files.list(params);
      setFiles(res.data as LibraryFileRow[]);
    } catch {
      // handle error
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    if (!open) return;
    void fetchFiles();
  }, [open, fetchFiles]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void fetchFiles();
    }, 300);
    return () => clearTimeout(timer);
  }, [search, open, fetchFiles]);

  const handleSelect = async (file: LibraryFileRow): Promise<void> => {
    try {
      const res = await api.library.files.get(file.id);
      const full = res.data as LibraryFileRow & { content: string };
      onSelect({
        id: full.id,
        name: full.name,
        fileName: full.fileName,
        content: full.content,
      });
      onClose();
    } catch {
      // handle error
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? 'Load from Library'}
      description="Select a library file to load into the editor"
      icon={<Library className="h-5 w-5 text-primary" />}
      className="max-w-2xl"
    >
      <div className="space-y-3">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search library files…"
            className="w-full rounded border border-border bg-bg py-2 pl-10 pr-4 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary focus:shadow-[0_0_8px_var(--color-glow)] transition-all"
            autoFocus
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* File List */}
        <div className="max-h-80 overflow-y-auto rounded border border-border divide-y divide-border">
          {loading ? (
            <div className="py-8 text-center text-xs text-text-muted">Loading…</div>
          ) : files.length === 0 ? (
            <div className="py-8 text-center text-xs text-text-muted">
              {search ? 'No files match your search' : 'No library files yet'}
            </div>
          ) : (
            files.map((file) => (
              <button
                key={file.id}
                onClick={() => void handleSelect(file)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-all hover:bg-surface-hover hover:shadow-[0_0_20px_var(--color-glow)]"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded bg-primary/10 text-primary shrink-0">
                  {fileIcon(file.mimeType)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold truncate">{file.name}</span>
                    <span className="text-xs text-text-muted">{file.fileName}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Badge>{mimeLabel(file.mimeType)}</Badge>
                    <span className="text-xs text-text-muted">{formatBytes(file.sizeBytes)}</span>
                    {file.category && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs"
                        style={{ backgroundColor: `${file.category.color}20`, color: file.category.color }}
                      >
                        {file.category.name}
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-text-muted shrink-0">{formatDate(file.updatedAt)}</span>
              </button>
            ))
          )}
        </div>

        <div className="flex justify-end pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Save to Library Modal ──

interface SaveToLibraryProps {
  open: boolean;
  onClose: () => void;
  fileName: string;
  content: string;
  onSaved: () => void;
}

export function SaveToLibraryModal({ open, onClose, fileName, content, onSaved }: SaveToLibraryProps): React.ReactElement | null {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setName(fileName.replace(/\.[^/.]+$/, '') || '');
      setError('');
    }
  }, [open, fileName]);

  const handleSave = async (): Promise<void> => {
    if (!name.trim()) return;
    setSaving(true);
    setError('');

    try {
      await api.library.files.create({
        name: name.trim(),
        fileName: fileName || `${name.trim()}.md`,
        mimeType: fileName.endsWith('.json') ? 'application/json' : 'text/markdown',
        content,
      });
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save to library');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save to Library"
      description="Save the current editor content as a library file"
      icon={<Library className="h-5 w-5 text-primary" />}
    >
      <div className="space-y-4">
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wider text-text-muted mb-1.5">Display Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. SOUL"
            className="w-full rounded border border-border bg-bg px-3 py-2 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary focus:shadow-[0_0_8px_var(--color-glow)] transition-all"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wider text-text-muted mb-1.5">File Name</label>
          <input
            type="text"
            value={fileName}
            disabled
            className="w-full rounded border border-border bg-bg px-3 py-2 text-xs text-text-muted"
          />
        </div>
        <p className="text-xs text-text-muted">
          Content size: {formatBytes(new TextEncoder().encode(content).length)}
        </p>

        {error && (
          <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
          >
            {saving ? 'Saving…' : 'Save to Library'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
