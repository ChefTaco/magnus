'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CategoryModal, FileModal, FileViewerModal } from '@/components/library/library-modals';
import { LibraryDeployModal } from '@/components/library/library-deploy-modal';
import { api } from '@/lib/api-client';
import { useControlNode } from '@/lib/control-node-context';
import { formatDate, formatBytes, cn } from '@/lib/utils';
import { PageTransition, PageItem } from '@/components/ui/page-transition';
import {
  Library,
  FolderPlus,
  FileUp,
  Search,
  RefreshCw,
  Pencil,
  Trash2,
  Eye,
  Download,
  Copy,
  Check,
  GripVertical,
  FileText,
  Image,
  FileJson,
  File,
  FolderOpen,
  Filter,
  LayoutGrid,
  List,
  X,
  Rocket,
  Package,
  Clock,
} from 'lucide-react';

// ─── Types ───

export interface CategoryRow {
  id: string;
  name: string;
  description: string;
  color: string;
  sortOrder: number;
  fileCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileRow {
  id: string;
  name: string;
  fileName: string;
  mimeType: string;
  content?: string;
  sizeBytes: number;
  categoryId: string | null;
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  category?: { id: string; name: string; color: string } | null;
}

// ─── Helpers ───

function fileIcon(mimeType: string): React.ReactElement {
  if (mimeType === 'application/x-magnus-skill') return <Package className="h-4 w-4" />;
  if (mimeType === 'application/x-magnus-cronjob') return <Clock className="h-4 w-4" />;
  if (mimeType.startsWith('image/')) return <Image className="h-4 w-4" />;
  if (mimeType === 'application/json') return <FileJson className="h-4 w-4" />;
  if (mimeType === 'text/markdown' || mimeType === 'text/plain') return <FileText className="h-4 w-4" />;
  return <File className="h-4 w-4" />;
}

function isDeployable(mimeType: string): boolean {
  return mimeType === 'application/x-magnus-skill' || mimeType === 'application/x-magnus-cronjob';
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
    'image/gif': 'GIF',
    'image/webp': 'WebP',
    'application/x-magnus-skill': 'Skill',
    'application/x-magnus-cronjob': 'Cron Job',
  };
  return map[mimeType] ?? mimeType.split('/')[1]?.toUpperCase() ?? 'File';
}

// ─── Page ───

interface LibraryPageClientProps {
  initialCategories: CategoryRow[];
  initialFiles: FileRow[];
  initialTotalFiles: number;
}

export default function LibraryPageClient({ initialCategories, initialFiles, initialTotalFiles }: LibraryPageClientProps): React.ReactElement {
  const { activeNode } = useControlNode();
  // Data state
  const [categories, setCategories] = useState<CategoryRow[]>(initialCategories);
  const [files, setFiles] = useState<FileRow[]>(initialFiles);
  const [totalFiles, setTotalFiles] = useState(initialTotalFiles);
  const [loading, setLoading] = useState(false);
  const [isFirstLoad, setIsFirstLoad] = useState(initialFiles.length > 0 || initialCategories.length > 0);

  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [mimeFilter, setMimeFilter] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // Modal state
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [catModalMode, setCatModalMode] = useState<'create' | 'edit'>('create');
  const [editCategory, setEditCategory] = useState<CategoryRow | null>(null);

  const [fileModalOpen, setFileModalOpen] = useState(false);
  const [fileModalMode, setFileModalMode] = useState<'create' | 'edit'>('create');
  const [editFile, setEditFile] = useState<FileRow | null>(null);

  const [viewerFile, setViewerFile] = useState<FileRow | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deployFile, setDeployFile] = useState<FileRow | null>(null);

  // Drag state
  const [draggedFileId, setDraggedFileId] = useState<string | null>(null);
  const [dragOverCat, setDragOverCat] = useState<string | null>(null);

  // ── Data fetching ──

  const fetchCategories = useCallback(async (): Promise<void> => {
    try {
      const res = await api.library.categories.list();
      setCategories(res.data as CategoryRow[]);
    } catch {
      // API not available
    }
  }, []);

  const fetchFiles = useCallback(async (): Promise<void> => {
    try {
      const params: Record<string, string | number> = {};
      if (searchQuery) params.query = searchQuery;
      if (selectedCategory) params.categoryId = selectedCategory;
      if (mimeFilter) params.mimeType = mimeFilter;
      params.pageSize = 100;

      const res = await api.library.files.list(params as Record<string, string>);
      setFiles(res.data as FileRow[]);
      setTotalFiles(res.pagination?.total ?? (res.data as FileRow[]).length);
    } catch {
      // API not available
    }
  }, [searchQuery, selectedCategory, mimeFilter]);

  const fetchAll = useCallback(async (): Promise<void> => {
    setLoading(true);
    await Promise.all([fetchCategories(), fetchFiles()]);
    setLoading(false);
  }, [fetchCategories, fetchFiles]);

  useEffect(() => {
    if (isFirstLoad) {
      setIsFirstLoad(false);
      return;
    }
    void fetchAll();
  }, [fetchAll, activeNode.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchFiles();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, selectedCategory, mimeFilter, fetchFiles]);

  // ── Category CRUD ──

  const openCreateCategory = (): void => {
    setCatModalMode('create');
    setEditCategory(null);
    setCatModalOpen(true);
  };

  const openEditCategory = (cat: CategoryRow): void => {
    setCatModalMode('edit');
    setEditCategory(cat);
    setCatModalOpen(true);
  };

  const deleteCategory = async (cat: CategoryRow): Promise<void> => {
    if (!confirm(`Delete category "${cat.name}"? Files in this category will become uncategorized.`)) return;
    try {
      await api.library.categories.delete(cat.id);
      if (selectedCategory === cat.id) setSelectedCategory(null);
      void fetchAll();
    } catch {
      // handle error
    }
  };

  // ── File CRUD ──

  const openCreateFile = (): void => {
    setFileModalMode('create');
    setEditFile(null);
    setFileModalOpen(true);
  };

  const openEditFile = async (file: FileRow): Promise<void> => {
    try {
      // Fetch full content for editing
      const res = await api.library.files.get(file.id);
      const full = res.data as FileRow;
      setFileModalMode('edit');
      setEditFile(full);
      setFileModalOpen(true);
    } catch {
      // handle error
    }
  };

  const deleteFile = async (file: FileRow): Promise<void> => {
    if (!confirm(`Delete "${file.name}" (${file.fileName})?`)) return;
    try {
      await api.library.files.delete(file.id);
      void fetchAll();
    } catch {
      // handle error
    }
  };

  const viewFile = async (file: FileRow): Promise<void> => {
    try {
      const res = await api.library.files.get(file.id);
      setViewerFile(res.data as FileRow);
    } catch {
      // handle error
    }
  };

  const copyToClipboard = async (file: FileRow): Promise<void> => {
    try {
      const res = await api.library.files.get(file.id);
      const full = res.data as FileRow;
      await navigator.clipboard.writeText(full.content ?? '');
      setCopiedId(file.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // handle error
    }
  };

  const downloadFile = async (file: FileRow): Promise<void> => {
    try {
      const res = await api.library.files.get(file.id);
      const full = res.data as FileRow;
      const content = full.content ?? '';

      let blob: Blob;
      if (full.mimeType.startsWith('text/') || full.mimeType === 'application/json') {
        blob = new Blob([content], { type: full.mimeType });
      } else {
        // Decode base64
        const byteChars = atob(content);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          byteArray[i] = byteChars.charCodeAt(i);
        }
        blob = new Blob([byteArray], { type: full.mimeType });
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = full.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // handle error
    }
  };

  // ── Drag & Drop ──

  const handleDragStart = (fileId: string): void => {
    setDraggedFileId(fileId);
  };

  const handleDragOver = (e: React.DragEvent, categoryId: string | null): void => {
    e.preventDefault();
    setDragOverCat(categoryId);
  };

  const handleDragLeave = (): void => {
    setDragOverCat(null);
  };

  const handleDrop = async (e: React.DragEvent, categoryId: string | null): Promise<void> => {
    e.preventDefault();
    setDragOverCat(null);
    if (!draggedFileId) return;

    try {
      await api.library.files.move({ fileIds: [draggedFileId], categoryId });
      void fetchAll();
    } catch {
      // handle error
    } finally {
      setDraggedFileId(null);
    }
  };

  // ── File drop zone (upload via drag & drop) ──

  const [isDraggingExternal, setIsDraggingExternal] = useState(false);

  const handleExternalDragOver = (e: React.DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingExternal(true);
    }
  };

  const handleExternalDragLeave = (e: React.DragEvent): void => {
    e.preventDefault();
    setIsDraggingExternal(false);
  };

  const handleExternalDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setIsDraggingExternal(false);

    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles.length === 0) return;

    for (let i = 0; i < droppedFiles.length; i++) {
      const f = droppedFiles[i];
      if (!f) continue;
      const name = f.name.replace(/\.[^/.]+$/, '');
      const mimeType = f.type || 'application/octet-stream';

      const content: string = await new Promise((resolve) => {
        const reader = new FileReader();
        if (f.type.startsWith('text/') || f.name.endsWith('.md') || f.name.endsWith('.json') || f.name.endsWith('.yaml') || f.name.endsWith('.yml') || f.name.endsWith('.txt')) {
          reader.onload = () => resolve(reader.result as string);
          reader.readAsText(f);
        } else {
          reader.onload = () => {
            const base64 = (reader.result as string).split(',')[1] ?? '';
            resolve(base64);
          };
          reader.readAsDataURL(f);
        }
      });

      try {
        await api.library.files.create({
          name,
          fileName: f.name,
          mimeType,
          content,
          categoryId: selectedCategory === 'uncategorized' ? null : selectedCategory,
        });
      } catch {
        // handle error
      }
    }

    void fetchAll();
  };

  // ── Render ──

  return (
    <PageTransition className="space-y-6">
      {/* Header */}
      <PageItem>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold uppercase tracking-wider">Library</h1>
          <p className="mt-1 text-[11px] text-text-muted uppercase tracking-wider">
            Browse, manage, and share Markdown, PDF, and image files
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void fetchAll()}>
            Refresh
          </Button>
          <Button variant="secondary" size="sm" icon={<FolderPlus className="h-3.5 w-3.5" />} onClick={openCreateCategory}>
            Category
          </Button>
          <Button size="sm" icon={<FileUp className="h-3.5 w-3.5" />} onClick={openCreateFile}>
            Upload
          </Button>
        </div>
      </div>
      </PageItem>

      <PageItem>
      <div className="flex gap-6">
        {/* Category Sidebar */}
        <div className="w-56 shrink-0 space-y-2">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-3">Categories</h3>

          {/* All Files */}
          <button
            onClick={() => setSelectedCategory(null)}
            onDragOver={(e) => handleDragOver(e, null)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => void handleDrop(e, null)}
            className={cn(
              'flex w-full items-center gap-2 rounded px-3 py-2 text-xs transition-all',
              selectedCategory === null
                ? 'bg-primary/10 text-primary border border-primary/50'
                : 'border border-transparent text-text-muted hover:bg-surface-hover hover:text-text',
            )}
          >
            <Library className="h-4 w-4" />
            <span className="flex-1 text-left">All Files</span>
            <span className="text-xs opacity-70">{totalFiles}</span>
          </button>

          {/* Uncategorized */}
          <button
            onClick={() => setSelectedCategory('uncategorized')}
            onDragOver={(e) => handleDragOver(e, 'uncategorized')}
            onDragLeave={handleDragLeave}
            onDrop={(e) => void handleDrop(e, null)}
            className={cn(
              'flex w-full items-center gap-2 rounded px-3 py-2 text-xs transition-all',
              dragOverCat === 'uncategorized' && 'ring-2 ring-primary',
              selectedCategory === 'uncategorized'
                ? 'bg-primary/10 text-primary border border-primary/50'
                : 'border border-transparent text-text-muted hover:bg-surface-hover hover:text-text',
            )}
          >
            <FolderOpen className="h-4 w-4" />
            <span className="flex-1 text-left">Uncategorized</span>
          </button>

          {/* Category items */}
          {categories.map((cat) => (
            <div
              key={cat.id}
              onDragOver={(e) => handleDragOver(e, cat.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => void handleDrop(e, cat.id)}
              className={cn(
                'group flex items-center gap-2 rounded px-3 py-2 text-xs transition-all cursor-pointer',
                dragOverCat === cat.id && 'ring-2 ring-primary',
                selectedCategory === cat.id
                  ? 'bg-primary/10 text-primary border border-primary/50'
                  : 'border border-transparent text-text-muted hover:bg-surface-hover hover:text-text',
              )}
              onClick={() => setSelectedCategory(cat.id)}
            >
              <div
                className="h-3 w-3 rounded-full shrink-0"
                style={{ backgroundColor: cat.color }}
              />
              <span className="flex-1 text-left truncate">{cat.name}</span>
              <span className="text-xs opacity-70">{cat.fileCount ?? 0}</span>
              <div className="hidden group-hover:flex gap-0.5">
                <button
                  onClick={(e) => { e.stopPropagation(); openEditCategory(cat); }}
                  className="rounded p-0.5 hover:bg-white/10"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); void deleteCategory(cat); }}
                  className="rounded p-0.5 hover:bg-white/10"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Main Content */}
        <div className="flex-1 space-y-4">
          {/* Search / Filter Bar */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search files by name…"
                className="w-full rounded border border-border bg-bg py-2 pl-10 pr-4 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none focus:shadow-[0_0_8px_var(--color-glow)] transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Filter className="h-4 w-4 text-text-muted" />
              <select
                value={mimeFilter}
                onChange={(e) => setMimeFilter(e.target.value)}
                className="rounded border border-border bg-bg px-3 py-2 text-xs text-text focus:border-primary focus:outline-none focus:shadow-[0_0_8px_var(--color-glow)] transition-all"
              >
                <option value="">All Types</option>
                <option value="text/markdown">Markdown</option>
                <option value="text/plain">Text</option>
                <option value="application/json">JSON</option>
                <option value="application/pdf">PDF</option>
                <option value="image/">Images</option>
              </select>
            </div>
            <div className="flex rounded border border-border">
              <button
                onClick={() => setViewMode('grid')}
                className={cn(
                  'rounded-l p-2 transition-all',
                  viewMode === 'grid' ? 'bg-primary/10 text-primary' : 'text-text-muted hover:bg-surface-hover',
                )}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={cn(
                  'rounded-r p-2 transition-all',
                  viewMode === 'list' ? 'bg-primary/10 text-primary' : 'text-text-muted hover:bg-surface-hover',
                )}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Drop Zone / Content */}
          <div
            onDragOver={handleExternalDragOver}
            onDragLeave={handleExternalDragLeave}
            onDrop={(e) => void handleExternalDrop(e)}
            className={cn(
              'min-h-[400px] rounded border-2 border-dashed transition-all',
              isDraggingExternal
                ? 'border-primary bg-primary/5'
                : 'border-transparent',
            )}
          >
            {loading ? (
              <div className="py-16 text-center text-[11px] text-text-muted">Loading library…</div>
            ) : files.length === 0 ? (
              <Card>
                <div className="py-16 text-center">
                  <Library className="mx-auto h-12 w-12 text-text-muted/30 mb-4" />
                  <p className="text-[11px] text-text-muted mb-2">
                    {searchQuery || mimeFilter || selectedCategory
                      ? 'No files match your filters'
                      : 'Your library is empty'}
                  </p>
                  <p className="text-xs text-text-muted mb-4">
                    Upload files or drag &amp; drop them here
                  </p>
                  <Button size="sm" icon={<FileUp className="h-3.5 w-3.5" />} onClick={openCreateFile}>
                    Upload File
                  </Button>
                </div>
              </Card>
            ) : viewMode === 'grid' ? (
              /* Grid View */
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {files.map((file) => (
                  <div
                    key={file.id}
                    draggable
                    onDragStart={() => handleDragStart(file.id)}
                    onClick={() => void openEditFile(file)}
                    className="group rounded border border-border bg-surface p-4 transition-all hover:border-primary/30 hover:shadow-[0_0_20px_var(--color-glow)] cursor-pointer"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <GripVertical className="h-4 w-4 text-text-muted/40 opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="flex h-8 w-8 items-center justify-center rounded bg-primary/10 text-primary">
                          {fileIcon(file.mimeType)}
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-xs font-bold truncate">{file.name}</h4>
                          <p className="text-xs text-text-muted truncate">{file.fileName}</p>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 mb-3">
                      <Badge>{mimeLabel(file.mimeType)}</Badge>
                      <span className="text-xs text-text-muted">{formatBytes(file.sizeBytes)}</span>
                      {file.category && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
                          style={{ backgroundColor: `${file.category.color}20`, color: file.category.color }}
                        >
                          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: file.category.color }} />
                          {file.category.name}
                        </span>
                      )}
                    </div>

                    {file.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-3">
                        {file.tags.map((tag) => (
                          <span key={tag} className="rounded-full bg-surface-hover px-2 py-0.5 text-xs text-text-muted">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center justify-between text-xs text-text-muted">
                      <span>{formatDate(file.updatedAt)}</span>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={(e) => { e.stopPropagation(); void viewFile(file); }} className="rounded p-1 hover:bg-surface-hover" title="Preview">
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); void copyToClipboard(file); }} className="rounded p-1 hover:bg-surface-hover" title="Copy to clipboard">
                          {copiedId === file.id ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); void downloadFile(file); }} className="rounded p-1 hover:bg-surface-hover" title="Download">
                          <Download className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); void openEditFile(file); }} className="rounded p-1 hover:bg-surface-hover" title="Edit">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); void deleteFile(file); }} className="rounded p-1 hover:bg-surface-hover text-danger" title="Delete">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                        {isDeployable(file.mimeType) && (
                          <button onClick={(e) => { e.stopPropagation(); setDeployFile(file); }} className="rounded p-1 hover:bg-surface-hover text-primary" title="Deploy to nodes">
                            <Rocket className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* List View */
              <div className="rounded border border-border bg-surface divide-y divide-border">
                {files.map((file) => (
                  <div
                    key={file.id}
                    draggable
                    onDragStart={() => handleDragStart(file.id)}
                    onClick={() => void openEditFile(file)}
                    className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-hover cursor-pointer"
                  >
                    <GripVertical className="h-4 w-4 text-text-muted/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
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
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
                            style={{ backgroundColor: `${file.category.color}20`, color: file.category.color }}
                          >
                            {file.category.name}
                          </span>
                        )}
                        {file.tags.map((tag) => (
                          <span key={tag} className="text-xs text-text-muted">#{tag}</span>
                        ))}
                      </div>
                    </div>
                    <span className="text-xs text-text-muted shrink-0">{formatDate(file.updatedAt)}</span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button onClick={(e) => { e.stopPropagation(); void viewFile(file); }} className="rounded p-1.5 hover:bg-border" title="Preview">
                        <Eye className="h-3.5 w-3.5 text-text-muted" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); void copyToClipboard(file); }} className="rounded p-1.5 hover:bg-border" title="Copy">
                        {copiedId === file.id ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5 text-text-muted" />}
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); void downloadFile(file); }} className="rounded p-1.5 hover:bg-border" title="Download">
                        <Download className="h-3.5 w-3.5 text-text-muted" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); void openEditFile(file); }} className="rounded p-1.5 hover:bg-border" title="Edit">
                        <Pencil className="h-3.5 w-3.5 text-text-muted" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); void deleteFile(file); }} className="rounded p-1.5 hover:bg-border text-danger" title="Delete">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      {isDeployable(file.mimeType) && (
                        <button onClick={(e) => { e.stopPropagation(); setDeployFile(file); }} className="rounded p-1.5 hover:bg-border text-primary" title="Deploy to nodes">
                          <Rocket className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      </PageItem>

      {/* Modals */}
      <CategoryModal
        open={catModalOpen}
        mode={catModalMode}
        category={editCategory}
        onClose={() => setCatModalOpen(false)}
        onSaved={() => void fetchAll()}
      />

      <FileModal
        open={fileModalOpen}
        mode={fileModalMode}
        file={editFile as { id: string; name: string; fileName: string; mimeType: string; content: string; categoryId: string | null; tags: string[] } | null}
        categories={categories}
        onClose={() => setFileModalOpen(false)}
        onSaved={() => void fetchAll()}
      />

      <FileViewerModal
        open={!!viewerFile}
        file={viewerFile as { id: string; name: string; fileName: string; mimeType: string; content: string; categoryId: string | null; tags: string[] } | null}
        onClose={() => setViewerFile(null)}
      />

      <LibraryDeployModal
        open={!!deployFile}
        onClose={() => setDeployFile(null)}
        file={deployFile}
      />
    </PageTransition>
  );
}
