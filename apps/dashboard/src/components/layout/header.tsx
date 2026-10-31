'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, RefreshCw, Menu, Search, ChevronRight } from 'lucide-react';
import { NotificationDropdown } from '@/components/notifications/notification-dropdown';
import { HeaderTicker } from '@/components/live-ticker';
import { getModifierKey } from '@/lib/keyboard-shortcuts';
import { routeInfo } from '@/lib/routes';

function openCommandPalette(): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, metaKey: true, bubbles: true }));
}

export function Header({ onMenuToggle }: { onMenuToggle?: () => void }): React.ReactElement {
  const pathname = usePathname();
  const router = useRouter();
  const { title: pageName, crumbs } = routeInfo(pathname);
  const [username, setUsername] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modKey, setModKey] = useState('Ctrl');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setModKey(getModifierKey());
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { username?: string } | null) => {
        if (data?.username) setUsername(data.username);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent): void => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen]);

  async function handleLogout(all = false): Promise<void> {
    const response = await fetch(`/api/auth/logout${all ? '?all=true' : ''}`, {
      method: 'POST',
    }).catch(() => null);
    if (!response?.ok) {
      window.alert('Session revocation unavailable; retry sign out.');
      return;
    }
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="relative z-(--z-shell) flex h-14 items-center justify-between gap-3 bg-bg/80 px-3 backdrop-blur-sm sm:px-6">
      {/* Bottom gradient line */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-primary/60 via-accent/40 to-transparent" />

      <div className="flex min-w-0 items-center gap-2 text-xs uppercase tracking-[0.15em] text-text-muted">
        {onMenuToggle && (
          <button
            className="mr-1 rounded p-1.5 text-text-muted hover:text-primary md:hidden"
            onClick={onMenuToggle}
            type="button"
            title="Toggle menu"
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <span className="text-primary/60">&gt;_</span>
        <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 sm:flex">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1">
                {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-primary/30" aria-hidden="true" />}
                {crumb.href && !last ? (
                  <Link href={crumb.href} prefetch={false} className="truncate transition-colors hover:text-primary">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className={last ? 'truncate text-text' : i === 0 && crumbs.length > 1 ? 'truncate text-text-muted/60' : 'truncate'} aria-current={last ? 'page' : undefined}>
                    {crumb.label}
                  </span>
                )}
              </span>
            );
          })}
        </nav>
        <span className="sr-only sm:hidden">{pageName}</span>
        <span
          className="ml-1 hidden h-3.5 w-1.5 shrink-0 bg-primary/80 sm:inline-block"
          style={{ animation: 'cursor-blink 1s step-end infinite' }}
        />
      </div>

      <HeaderTicker className="hidden max-w-xl flex-1 lg:block" />

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <button
          type="button"
          onClick={openCommandPalette}
          className="hidden items-center gap-2 rounded-chip border border-border bg-surface px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-text-muted transition-colors hover:border-primary/40 hover:text-primary md:flex"
          title="Search and jump (command palette)"
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search</span>
          <kbd className="rounded-chip border border-border bg-bg px-1 text-[9px] text-primary/70">{modKey}+K</kbd>
        </button>
        <button
          className="rounded p-2 text-text-muted transition-all hover:text-primary hover:drop-shadow-[0_0_6px_var(--color-glow)]"
          title="Refresh"
          onClick={() => window.location.reload()}
          type="button"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <NotificationDropdown />
        <button
          className="rounded p-2 text-text-muted transition-all hover:text-danger hover:drop-shadow-[0_0_6px_rgba(255,23,68,0.3)]"
          title="Sign Out"
          onClick={() => void handleLogout()}
          type="button"
        >
          <LogOut className="h-4 w-4" />
        </button>
        <div ref={menuRef} className="relative ml-1">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={username ? `Signed in as ${username}` : 'Account'}
            className="flex h-8 w-8 items-center justify-center rounded border border-accent/40 text-[10px] font-bold uppercase text-accent shadow-[0_0_8px_var(--color-glow-accent)] transition-colors hover:border-accent hover:bg-accent/10"
          >
            {username?.[0] ?? 'U'}
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="panel-corners absolute right-0 top-full z-(--z-modal) mt-2 w-60 rounded-panel border border-accent/30 bg-surface/95 p-1 shadow-[0_0_24px_var(--color-glow-accent)] backdrop-blur-sm [--panel-corner-color:var(--color-accent)]"
            >
              {username && (
                <div className="border-b border-border px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
                  Signed in as <span className="text-accent">{username}</span>
                </div>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleLogout()}
                className="flex w-full items-center gap-2 rounded-chip px-3 py-2 text-left text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
              >
                <LogOut className="h-3.5 w-3.5" /> Sign out
              </button>
              <button
                type="button"
                role="menuitem"
                aria-label="Sign out all local sessions"
                onClick={() => void handleLogout(true)}
                className="flex w-full items-center gap-2 rounded-chip px-3 py-2 text-left text-xs text-text-muted transition-colors hover:bg-danger/10 hover:text-danger"
              >
                <LogOut className="h-3.5 w-3.5" /> Sign out all local sessions
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
