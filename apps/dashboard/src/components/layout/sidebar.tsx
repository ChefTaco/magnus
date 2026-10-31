'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { ControlNodeSelector } from '@/components/control-nodes/control-node-selector';
import { motion } from 'motion/react';
import { activeNavHref, visibleNavGroups, type IntegrationFlags, type NavGroup as NavGroupDef } from '@/lib/routes';
import { eventFeed } from '@/lib/event-feed';

const DIVIDER: Record<string, string> = {
  security: 'from-primary/60 via-accent/20',
  hermes: 'from-accent/50 via-accent/20',
  ardent: 'from-primary/50 via-accent/20',
  codex: 'from-primary/50 via-primary/20',
};

function NavGroup({ group, activeHref }: { group: NavGroupDef; activeHref: string | null }): React.ReactElement {
  const accent = group.tone === 'accent';
  return (
    <>
      {group.id !== 'fleet' && (
        <>
          <div className="mx-3 my-1">
            <div className={cn('h-px bg-gradient-to-r to-transparent', DIVIDER[group.id])} />
          </div>
          <div className="px-4 pb-0.5 pt-2">
            <span className={cn('text-[9px] font-bold uppercase tracking-[0.25em]', accent ? 'text-accent/60' : 'text-primary/60')}>
              {group.label}
            </span>
          </div>
        </>
      )}
      <nav className={cn('space-y-0.5 p-3', group.id !== 'fleet' && 'pt-1')} aria-label={group.label}>
        {group.items.map((item) => {
          const isActive = item.href === activeHref;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              target={item.external ? '_blank' : undefined}
              rel={item.external ? 'noopener noreferrer' : undefined}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'group relative flex items-center gap-3 overflow-hidden rounded-chip px-3 py-2 text-xs uppercase tracking-wider transition-colors duration-200',
                // Hover sheen: a light band that slides across the row.
                'before:pointer-events-none before:absolute before:inset-y-0 before:-left-1/2 before:w-1/2 before:-skew-x-12 before:bg-gradient-to-r before:from-transparent before:to-transparent before:opacity-0 before:transition-[left,opacity] before:duration-500 hover:before:left-full hover:before:opacity-100',
                accent ? 'before:via-accent/10' : 'before:via-primary/10',
                isActive
                  ? cn(accent ? 'text-accent' : 'text-primary', accent ? 'bg-accent/5' : 'bg-primary/5')
                  : cn('text-text-muted', accent ? 'hover:text-accent' : 'hover:text-primary'),
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="sidebar-indicator"
                  className={cn('absolute bottom-1 left-0 top-1 w-0.5 rounded-full', accent ? 'bg-accent' : 'bg-primary')}
                  style={{
                    boxShadow: accent
                      ? '0 0 8px var(--color-accent), 0 0 16px var(--color-glow-accent)'
                      : '0 0 8px var(--color-primary), 0 0 16px var(--color-glow)',
                  }}
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                />
              )}
              <Icon className="relative h-4 w-4 shrink-0" />
              <span className="relative truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function LogoMark(): React.ReactElement {
  return (
    <div className="relative flex h-8 w-8 items-center justify-center animate-flicker">
      <svg viewBox="0 0 32 32" className="h-8 w-8 overflow-visible" aria-hidden="true">
        <rect x="1" y="1" width="30" height="30" rx="4" fill="none" stroke="var(--color-primary)" strokeOpacity="0.35" />
        <path
          d="M8 23 V9 L16 18 L24 9 V23"
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={100}
          style={{ ['--stroke-length' as string]: 100, strokeDasharray: 100, animation: 'draw-stroke 1.4s var(--ease-out-expo) both' }}
          className="drop-shadow-[0_0_4px_var(--color-primary)]"
        />
      </svg>
      <div className="absolute inset-0 rounded shadow-[0_0_12px_var(--color-glow)]" />
    </div>
  );
}

function LiveLed(): React.ReactElement {
  const { connected } = useSyncExternalStore(eventFeed.subscribe, eventFeed.getSnapshot, eventFeed.getServerSnapshot);
  return (
    <span className="flex items-center gap-1.5" title={connected ? 'Live event stream connected' : 'Live event stream reconnecting'}>
      <span className="relative inline-flex h-1.5 w-1.5">
        {connected && <span className="absolute inset-0 rounded-full bg-success animate-halo" />}
        <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', connected ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-warning')} />
      </span>
      <span className={connected ? 'text-success/70' : 'text-warning/70'}>{connected ? 'Live' : 'Offline'}</span>
    </span>
  );
}

export function Sidebar({ integrations }: { integrations: IntegrationFlags }): React.ReactElement {
  const pathname = usePathname();
  const activeHref = activeNavHref(pathname);
  const groups = useMemo(() => visibleNavGroups(integrations), [integrations]);

  return (
    <aside className="relative flex h-full w-56 flex-col border-r border-border/50 bg-bg">
      {/* Cyan accent line on right edge */}
      <div className="absolute bottom-0 right-0 top-0 w-px bg-gradient-to-b from-primary/60 via-primary/20 to-transparent" />

      {/* Logo */}
      <div className="flex h-14 items-center gap-3 border-b border-border/30 px-4">
        <LogoMark />
        <span className="text-sm font-bold uppercase tracking-[0.2em] text-text">Magnus</span>
      </div>

      {/* Control Node Selector */}
      <ControlNodeSelector />

      {/* Scrollable navigation area */}
      <div className="flex-1 overflow-y-auto">
        {groups.map((group) => (
          <NavGroup key={group.id} group={group} activeHref={activeHref} />
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border/30 p-4 text-[10px] uppercase tracking-widest text-primary/40">
        <span>Magnus v{process.env['NEXT_PUBLIC_AGENT_VERSION'] ?? '0.0.0'}</span>
        <LiveLed />
      </div>
    </aside>
  );
}
