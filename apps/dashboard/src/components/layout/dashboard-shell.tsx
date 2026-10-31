'use client';

import { type ReactNode, useEffect, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { CommandPalette } from '@/components/command-palette';
import { useEventStream } from '@/hooks/use-event-stream';
import type { IntegrationFlags } from '@/lib/routes';

/**
 * Client-side shell that conditionally renders the Sidebar + Header chrome.
 * Extracted from AppShell so AppShell itself can remain a server component.
 * The /login page renders its children directly with no navigation chrome.
 */
export function DashboardShell({ children, integrations }: { children: ReactNode; integrations: IntegrationFlags }): React.ReactElement {
  const pathname = usePathname();
  const isAuthPage = pathname === '/login' || pathname.startsWith('/governor/share/');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Connect to fleet event bus SSE for real-time toast notifications
  useEventStream({ enabled: !isAuthPage });

  // Close sidebar on navigation (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const toggleSidebar = useCallback(() => setSidebarOpen((p) => !p), []);

  if (isAuthPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-[2px] md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — hidden on mobile, visible on md+ */}
      <div className={`
        fixed inset-y-0 left-0 z-50 transform transition-transform duration-200 ease-in-out md:relative md:h-full md:translate-x-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <Sidebar integrations={integrations} />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onMenuToggle={toggleSidebar} />
        <main className="app-backdrop relative flex-1 overflow-y-auto p-3 md:p-6">
          {children}
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
