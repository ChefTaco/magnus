'use client';

import { type ReactNode, useEffect } from 'react';
import { ControlNodeProvider } from '@/lib/control-node-context';
import { initErrorReporter } from '@/lib/error-reporter';
import { ToastProvider } from '@/components/ui/toast-provider';
import { MotionConfig } from 'motion/react';
import { applyStoredFxLevel } from '@/hooks/use-reduced-motion';

/** Client-side providers wrapper for the root layout. */
export function Providers({ children }: { children: ReactNode }): React.ReactElement {
  useEffect(() => {
    applyStoredFxLevel();
    const cleanup = initErrorReporter();
    return cleanup;
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <ControlNodeProvider>{children}</ControlNodeProvider>
      </ToastProvider>
    </MotionConfig>
  );
}
