'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';
import Link from 'next/link';
import { Button, buttonClass } from '@/components/ui/button';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Magnus Error]', error);
  }, [error]);

  return (
    <div className="grid-bg flex min-h-[60vh] flex-col items-center justify-center gap-6 rounded-panel text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full border border-danger/40 bg-bg shadow-[0_0_24px_var(--color-glow-danger)]">
        <AlertTriangle className="h-8 w-8 text-danger" />
      </div>

      <div className="space-y-2">
        <p aria-hidden="true" className="glitch text-5xl font-bold tracking-[0.3em] text-danger glow-text-danger">ERR</p>
        <h1 className="text-xl font-bold uppercase tracking-wider text-text">Something went wrong</h1>
        <p className="max-w-md text-xs text-text-muted">
          An unexpected error occurred. This has been logged for investigation.
        </p>
        {error.digest && (
          <p className="num text-[11px] text-text-muted/70">Error ID: {error.digest}</p>
        )}
      </div>

      <div className="flex gap-3">
        <Button onClick={reset} icon={<RotateCcw className="h-4 w-4" />}>
          Try Again
        </Button>
        <Link href="/" className={buttonClass('secondary')}>
          <Home className="h-4 w-4" />
          Dashboard
        </Link>
      </div>
    </div>
  );
}
