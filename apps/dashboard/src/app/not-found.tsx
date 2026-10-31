import { FileQuestion, Home, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { buttonClass } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="grid-bg flex min-h-[60vh] flex-col items-center justify-center gap-6 rounded-panel text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full border border-accent/40 bg-bg shadow-[0_0_24px_var(--color-glow-accent)]">
        <FileQuestion className="h-8 w-8 text-accent" />
      </div>

      <div className="space-y-2">
        <h1 className="glitch text-6xl font-bold tracking-[0.2em] text-accent glow-text-accent">404</h1>
        <h2 className="text-lg font-bold uppercase tracking-wider text-text">Page not found</h2>
        <p className="max-w-md text-xs text-text-muted">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
      </div>

      <div className="flex gap-3">
        <Link href="/" className={buttonClass('primary')}>
          <Home className="h-4 w-4" />
          Dashboard
        </Link>
        <Link href="/nodes" className={buttonClass('secondary')}>
          <ArrowLeft className="h-4 w-4" />
          Nodes
        </Link>
      </div>
    </div>
  );
}
