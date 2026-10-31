'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { shortcuts, formatKeys, getModifierKey, type ShortcutDef } from '@/lib/keyboard-shortcuts';
import {
  searchEntities,
  filterAndRank,
  type PaletteEntity,
  type PaletteEntityKind,
} from '@/lib/command-palette-search';
import {
  Search, ArrowRight, LayoutDashboard, Server, Terminal, Clock, FileText,
  Puzzle, ScrollText, Shield, Library, Keyboard, X,
  Bot, Key as KeyIcon, Compass, Loader2, Sparkles,
} from 'lucide-react';
import { toggleFxLevel } from '@/hooks/use-reduced-motion';

const iconMap: Record<string, React.ElementType> = {
  '/': LayoutDashboard, '/mission-control': Compass,
  '/nodes': Server, '/commands': Terminal, '/cron': Clock,
  '/files': FileText, '/skills': Puzzle, '/logs': ScrollText, '/audit': Shield,
  '/library': Library,
};

const entityIconMap: Record<PaletteEntityKind, React.ElementType> = {
  node: Server,
  installation: Bot,
  skill: Puzzle,
  action: ArrowRight,
};

type PaletteItem =
  | { kind: 'shortcut'; key: string; shortcut: ShortcutDef }
  | { kind: 'entity'; key: string; entity: PaletteEntity };

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [entities, setEntities] = useState<PaletteEntity[]>([]);
  const [searching, setSearching] = useState(false);
  const [fxLevel, setFxLevel] = useState<'low' | 'normal'>('normal');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const sequenceRef = useRef<string[]>([]);
  const sequenceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  // Filter shortcuts by query (lightweight fuzzy)
  const shortcutEntries: PaletteItem[] = (
    query.trim()
      ? shortcuts.filter(
          (s) =>
            s.label.toLowerCase().includes(query.toLowerCase()) ||
            s.description.toLowerCase().includes(query.toLowerCase()),
        )
      : shortcuts
  ).map((s) => ({ kind: 'shortcut' as const, key: `s:${s.keys.join('-')}`, shortcut: s }));

  const entityEntries: PaletteItem[] = filterAndRank(query, entities).map((e) => ({
    kind: 'entity' as const,
    key: `e:${e.kind}:${e.id}`,
    entity: e,
  }));

  // Show entity hits first when searching; shortcuts always visible
  const items: PaletteItem[] = query.trim()
    ? [...entityEntries, ...shortcutEntries]
    : shortcutEntries;

  // Debounced async entity search
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setEntities([]);
      setSearching(false);
      return;
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      const results = await searchEntities(q, { signal: ctrl.signal, limit: 12 });
      if (!ctrl.signal.aborted) {
        setEntities(results);
        setSearching(false);
      }
    }, 180);
    return () => {
      ctrl.abort();
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query, open]);

  const executeShortcut = useCallback(
    (shortcut: ShortcutDef) => {
      if (shortcut.action === 'navigate' && shortcut.target) {
        router.push(shortcut.target);
        setOpen(false);
        setQuery('');
      } else if (shortcut.target === 'show-shortcuts') {
        setShowShortcuts(true);
        setOpen(false);
        setQuery('');
      }
    },
    [router],
  );

  const executeItem = useCallback(
    (item: PaletteItem) => {
      if (item.kind === 'shortcut') {
        executeShortcut(item.shortcut);
      } else {
        router.push(item.entity.href);
        setOpen(false);
        setQuery('');
      }
    },
    [executeShortcut, router],
  );

  // Global keyboard listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // Cmd/Ctrl+K (with or without Shift) opens the palette.
      // Registered in the capture phase so it wins against the AI-chat
      // ⌘K binding on the dashboard shell.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setOpen((prev) => !prev);
        return;
      }

      // Escape closes palette or shortcut reference
      if (e.key === 'Escape') {
        if (open) { setOpen(false); setQuery(''); return; }
        if (showShortcuts) { setShowShortcuts(false); return; }
        return;
      }

      // Don't capture keystrokes in inputs (except palette)
      if (isInput) return;

      // ? shows shortcut reference
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
        return;
      }

      // Two-key sequences (g then n, etc.)
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        clearTimeout(sequenceTimerRef.current);
        sequenceRef.current.push(e.key.toLowerCase());

        // Check if sequence matches any shortcut
        for (const s of shortcuts) {
          if (
            s.keys.length === sequenceRef.current.length &&
            s.keys.every((k, i) => k === sequenceRef.current[i])
          ) {
            e.preventDefault();
            sequenceRef.current = [];
            executeShortcut(s);
            return;
          }
        }

        // Wait for next key in sequence
        sequenceTimerRef.current = setTimeout(() => {
          sequenceRef.current = [];
        }, 800);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, showShortcuts, executeShortcut]);

  // Focus input when palette opens
  useEffect(() => {
    if (open) {
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Clamp selected when item list shrinks
  useEffect(() => {
    if (selected >= items.length) setSelected(Math.max(0, items.length - 1));
  }, [items.length, selected]);

  // Palette keyboard navigation
  const handlePaletteKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((prev) => Math.min(prev + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && items[selected]) {
      e.preventDefault();
      executeItem(items[selected]);
    }
  };

  useEffect(() => {
    if (open) setFxLevel(document.documentElement.dataset.fx === 'low' ? 'low' : 'normal');
  }, [open]);

  if (!open && !showShortcuts) return null;

  return (
    <>
      {/* Command Palette */}
      {open && (
        <div className="fixed inset-0 z-(--z-modal) flex items-start justify-center pt-[15vh]" data-testid="command-palette">
          <div className="fixed inset-0 bg-black/70 backdrop-blur-[2px]" onClick={() => { setOpen(false); setQuery(''); }} />
          <div className="relative z-10 w-full max-w-lg panel-corners rounded-panel border border-primary/30 bg-surface/95 shadow-[0_0_40px_var(--color-glow)]">
            {/* Search Input */}
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <Search className="h-5 w-5 text-primary" />
              <input
                ref={inputRef}
                type="text"
                placeholder="Search nodes, agents, runs, users, commands..."
                className="flex-1 bg-transparent text-sm text-text placeholder:text-text-muted/70 caret-primary outline-none"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
                onKeyDown={handlePaletteKeys}
                data-testid="command-palette-input"
              />
              {searching ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : (
                <kbd className="rounded-chip border border-border bg-bg px-1.5 py-0.5 text-[10px] text-text-muted">ESC</kbd>
              )}
            </div>

            {/* Results */}
            <div className="max-h-96 overflow-y-auto py-2">
              {items.length === 0 && !searching && (
                <p className="px-4 py-6 text-center text-xs uppercase tracking-wider text-text-muted">No results found</p>
              )}
              {items.length === 0 && searching && (
                <p className="px-4 py-6 text-center text-xs uppercase tracking-wider text-text-muted">Searching…</p>
              )}
              {items.map((item, i) => {
                const isSel = i === selected;
                if (item.kind === 'shortcut') {
                  const Icon = iconMap[item.shortcut.target ?? ''] ?? ArrowRight;
                  return (
                    <button
                      key={item.key}
                      className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                        isSel ? 'bg-primary/10 text-primary shadow-[inset_2px_0_0_var(--color-primary)]' : 'text-text hover:bg-surface-hover'
                      }`}
                      onClick={() => executeItem(item)}
                      onMouseEnter={() => setSelected(i)}
                      data-testid="command-palette-item"
                      data-item-kind="shortcut"
                    >
                      <Icon className="h-4 w-4 shrink-0 opacity-70" />
                      <span className="flex-1">{item.shortcut.label}</span>
                      <span className="text-xs text-text-muted">{formatKeys(item.shortcut.keys)}</span>
                    </button>
                  );
                }
                const Icon = entityIconMap[item.entity.kind] ?? ArrowRight;
                return (
                  <button
                    key={item.key}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                      isSel ? 'bg-accent/10 text-accent shadow-[inset_2px_0_0_var(--color-accent)]' : 'text-text hover:bg-surface-hover'
                    }`}
                    onClick={() => executeItem(item)}
                    onMouseEnter={() => setSelected(i)}
                    data-testid="command-palette-item"
                    data-item-kind="entity"
                    data-entity-kind={item.entity.kind}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-accent/80" />
                    <span className="flex-1 truncate">
                      <span className="font-medium">{item.entity.label}</span>
                      {item.entity.sublabel && (
                        <span className="ml-2 text-xs text-text-muted">{item.entity.sublabel}</span>
                      )}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-text-muted">
                      {item.entity.kind}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[10px] uppercase tracking-wider text-text-muted">
              <span>↑↓ navigate</span>
              <span>↵ select</span>
              <span>esc close</span>
              <button
                type="button"
                onClick={() => setFxLevel(toggleFxLevel())}
                className="ml-auto flex items-center gap-1 rounded-chip px-1 text-text-muted transition-colors hover:text-primary"
                title="Toggle visual effects (scanlines, glow pulses, animated map)"
                data-testid="command-palette-fx-toggle"
              >
                <Sparkles className="h-3 w-3" /> fx: {fxLevel}
              </button>
              <span className="flex items-center gap-1">
                <KeyIcon className="h-3 w-3" /> {getModifierKey()}+K
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Shortcut Reference */}
      {showShortcuts && (
        <div className="fixed inset-0 z-(--z-modal) flex items-center justify-center">
          <div className="fixed inset-0 bg-black/70 backdrop-blur-[2px]" onClick={() => setShowShortcuts(false)} />
          <div className="relative z-10 w-full max-w-md panel-corners rounded-panel border border-primary/30 bg-surface/95 p-6 shadow-[0_0_40px_var(--color-glow)]">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Keyboard className="h-5 w-5 text-primary" />
                <h2 className="text-sm font-bold uppercase tracking-wider text-primary glow-text-primary">Keyboard Shortcuts</h2>
              </div>
              <button onClick={() => setShowShortcuts(false)} className="text-text-muted hover:text-text">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <h3 className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-text-muted">General</h3>
                <div className="space-y-1">
                  <ShortcutRow keys={[`${getModifierKey()}+K`]} label="Open command palette" />
                  <ShortcutRow keys={['?']} label="Show this reference" />
                  <ShortcutRow keys={['Esc']} label="Close modal / palette" />
                </div>
              </div>
              <div>
                <h3 className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-text-muted">Fleet Navigation</h3>
                <div className="space-y-1">
                  {shortcuts.filter((s) => s.category === 'navigation').map((s) => (
                    <ShortcutRow key={s.target} keys={s.keys.map((k) => k.toUpperCase())} label={s.label} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-text">{label}</span>
      <div className="flex gap-1">
        {keys.map((k, i) => (
          <span key={i}>
            <kbd className="rounded-chip border border-border bg-bg px-1.5 py-0.5 text-[11px] text-primary">{k}</kbd>
            {i < keys.length - 1 && <span className="mx-0.5 text-[10px] text-text-muted/60">then</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
