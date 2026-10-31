'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Modal, FormField, inputClass, textareaClass, selectClass } from '@/components/ui/modal';
import { api } from '@/lib/api-client';
import { FolderPlus, FileUp, Loader2, Palette } from 'lucide-react';

// ════════════════════════════════════════════════
//  Category Modal (Create / Edit)
// ════════════════════════════════════════════════

const CATEGORY_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f59e0b', '#22c55e', '#3b82f6', '#06b6d4',
];

interface CategoryData {
  id: string;
  name: string;
  description: string;
  color: string;
  sortOrder: number;
}

interface CategoryModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  category: CategoryData | null;
  onClose: () => void;
  onSaved: () => void;
}

export function CategoryModal({ open, mode, category, onClose, onSaved }: CategoryModalProps): React.ReactElement | null {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#6366f1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (mode === 'edit' && category) {
      setName(category.name);
      setDescription(category.description);
      setColor(category.color);
    } else {
      setName('');
      setDescription('');
      setColor('#6366f1');
    }
    setError('');
  }, [mode, category, open]);

  const handleSave = async (): Promise<void> => {
    if (!name.trim()) return;
    setSaving(true);
    setError('');

    try {
      if (mode === 'create') {
        await api.library.categories.create({
          name: name.trim(),
          description: description.trim(),
          color,
        });
      } else if (category) {
        await api.library.categories.update(category.id, {
          name: name.trim(),
          description: description.trim(),
          color,
        });
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save category');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? 'Create Category' : 'Edit Category'}
      description={mode === 'create' ? 'Add a new organizational category' : `Editing "${category?.name ?? ''}"`}
      icon={<FolderPlus className="h-5 w-5 text-primary" />}
    >
      <div className="space-y-4">
        <FormField label="Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Personality, Templates, Config…"
            className={inputClass}
            autoFocus
          />
        </FormField>

        <FormField label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What kind of files belong here?"
            rows={2}
            className={textareaClass}
          />
        </FormField>

        <FormField label="Color">
          <div className="flex items-center gap-2">
            {CATEGORY_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`h-7 w-7 rounded-full border-2 transition-all ${
                  color === c ? 'border-white scale-110' : 'border-transparent'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
            <div className="ml-2 flex items-center gap-1.5">
              <Palette className="h-3.5 w-3.5 text-text-muted" />
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className={`${inputClass} !w-24`}
              />
            </div>
          </div>
        </FormField>

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
            icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {saving ? 'Saving…' : mode === 'create' ? 'Create Category' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════
//  File Modal (Create / Edit)
// ════════════════════════════════════════════════

interface FileData {
  id: string;
  name: string;
  fileName: string;
  mimeType: string;
  content: string;
  categoryId: string | null;
  tags: string[];
}

interface FileModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  file: FileData | null;
  categories: CategoryData[];
  onClose: () => void;
  onSaved: () => void;
}

export function FileModal({ open, mode, file, categories, onClose, onSaved }: FileModalProps): React.ReactElement | null {
  const [name, setName] = useState('');
  const [fileName, setFileName] = useState('');
  const [mimeType, setMimeType] = useState('text/markdown');
  const [content, setContent] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (mode === 'edit' && file) {
      setName(file.name);
      setFileName(file.fileName);
      setMimeType(file.mimeType);
      setContent(file.content);
      setCategoryId(file.categoryId ?? '');
      setTags(file.tags.join(', '));
    } else {
      setName('');
      setFileName('');
      setMimeType('text/markdown');
      setContent('');
      setCategoryId('');
      setTags('');
    }
    setError('');
  }, [mode, file, open]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0];
    if (!f) return;

    setFileName(f.name);
    if (!name) setName(f.name.replace(/\.[^/.]+$/, ''));
    setMimeType(f.type || 'application/octet-stream');

    const reader = new FileReader();
    if (f.type.startsWith('text/') || f.name.endsWith('.md') || f.name.endsWith('.json') || f.name.endsWith('.yaml') || f.name.endsWith('.yml') || f.name.endsWith('.txt')) {
      reader.onload = () => setContent(reader.result as string);
      reader.readAsText(f);
    } else {
      // Binary files: base64 encode
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1] ?? '';
        setContent(base64);
      };
      reader.readAsDataURL(f);
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!name.trim() || !fileName.trim()) return;
    setSaving(true);
    setError('');

    try {
      const tagArray = tags.split(',').map((t) => t.trim()).filter(Boolean);

      if (mode === 'create') {
        await api.library.files.create({
          name: name.trim(),
          fileName: fileName.trim(),
          mimeType,
          content,
          categoryId: categoryId || null,
          tags: tagArray,
        });
      } else if (file) {
        await api.library.files.update(file.id, {
          name: name.trim(),
          fileName: fileName.trim(),
          mimeType,
          content,
          categoryId: categoryId || null,
          tags: tagArray,
        });
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save file');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'create' ? 'Upload File' : 'Edit File'}
      description={mode === 'create' ? 'Add a new file to the library' : `Editing "${file?.name ?? ''}"`}
      icon={<FileUp className="h-5 w-5 text-primary" />}
      className="max-w-2xl"
    >
      <div className="space-y-4">
        {mode === 'create' && (
          <FormField label="Upload File">
            <input
              type="file"
              onChange={handleFileUpload}
              accept=".md,.txt,.json,.yaml,.yml,.pdf,.png,.jpg,.jpeg,.gif,.svg,.webp"
              className="block w-full text-xs text-text-muted file:mr-4 file:rounded file:border-0 file:bg-primary/10 file:px-4 file:py-2 file:text-xs file:font-bold file:text-primary hover:file:bg-primary/20 file:cursor-pointer"
            />
            <p className="mt-1 text-xs text-text-muted">Or fill in the fields manually below</p>
          </FormField>
        )}

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Display Name" required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="SOUL"
              className={inputClass}
            />
          </FormField>
          <FormField label="File Name" required>
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="SOUL.md"
              className={inputClass}
            />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Category">
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className={selectClass}
            >
              <option value="">Uncategorized</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
            </select>
          </FormField>
          <FormField label="MIME Type">
            <select
              value={mimeType}
              onChange={(e) => setMimeType(e.target.value)}
              className={selectClass}
            >
              <option value="text/markdown">Markdown (.md)</option>
              <option value="text/plain">Plain Text (.txt)</option>
              <option value="application/json">JSON (.json)</option>
              <option value="application/pdf">PDF (.pdf)</option>
              <option value="image/png">PNG Image</option>
              <option value="image/jpeg">JPEG Image</option>
              <option value="image/svg+xml">SVG Image</option>
            </select>
          </FormField>
        </div>

        <FormField label="Tags">
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="personality, config, template"
            className={inputClass}
          />
          <p className="mt-1 text-xs text-text-muted">Comma-separated</p>
        </FormField>

        {(mimeType.startsWith('text/') || mimeType === 'application/json') && (
          <FormField label="Content">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="File content…"
              rows={8}
              className={`${textareaClass} text-xs`}
            />
          </FormField>
        )}

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
            disabled={saving || !name.trim() || !fileName.trim()}
            icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined}
          >
            {saving ? 'Saving…' : mode === 'create' ? 'Upload File' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════
//  File Viewer Modal
// ════════════════════════════════════════════════

interface FileViewerProps {
  open: boolean;
  file: FileData | null;
  onClose: () => void;
}

export function FileViewerModal({ open, file, onClose }: FileViewerProps): React.ReactElement | null {
  if (!file) return null;

  const isMarkdown = file.mimeType === 'text/markdown' || file.fileName.endsWith('.md');
  const isText = file.mimeType.startsWith('text/') || file.mimeType === 'application/json';
  const isImage = file.mimeType.startsWith('image/');
  const isPdf = file.mimeType === 'application/pdf';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={file.name}
      description={file.fileName}
      className="max-w-4xl max-h-[80vh]"
    >
      <div className="overflow-auto max-h-[60vh]">
        {isMarkdown && (
          <div className="prose prose-invert prose-sm max-w-none rounded border border-border bg-bg p-4 text-xs whitespace-pre-wrap leading-relaxed">
            {file.content}
          </div>
        )}
        {isText && !isMarkdown && (
          <pre className="rounded border border-border bg-bg p-4 text-xs overflow-auto">
            {file.content}
          </pre>
        )}
        {isImage && (
          <div className="flex items-center justify-center p-4">
            <img
              src={file.content.startsWith('data:') ? file.content : `data:${file.mimeType};base64,${file.content}`}
              alt={file.name}
              className="max-w-full rounded"
            />
          </div>
        )}
        {isPdf && (
          <div className="flex items-center justify-center p-8 text-text-muted">
            <p className="text-xs">PDF preview not available. Use the download button instead.</p>
          </div>
        )}
        {!isText && !isImage && !isPdf && (
          <div className="flex items-center justify-center p-8 text-text-muted">
            <p className="text-xs">Preview not available for this file type.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
