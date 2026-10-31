import type { Metadata } from 'next';
import './globals.css';
import { jetbrainsMono } from './fonts';
import { Providers } from './providers';
import { connection } from 'next/server';
import { AppShell } from '@/components/layout/app-shell';
import { readIntegrations } from '../../runtime-integrations.mjs';

export const metadata: Metadata = {
  title: 'Magnus',
  description: 'Fleet management dashboard for Magnus agents',
};

export default async function RootLayout({ children }: { children: React.ReactNode }): Promise<React.ReactElement> {
  // Integrations are configured at runtime, not build time: render per request.
  await connection();
  const integrations = readIntegrations();
  return (
    <html lang="en" className={`dark ${jetbrainsMono.variable}`}>
      <body className="min-h-screen antialiased">
        <Providers>
          <AppShell integrations={integrations}>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
