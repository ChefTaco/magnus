/**
 * Page transition components — CSS-driven animation (no Framer Motion).
 *
 * Renders children with a fade-in + translateY + blur-in keyframe animation
 * defined in globals.css (.animate-page-in / @keyframes page-item-in).
 *
 * Previously used Framer Motion which added the full ~30-50KB bundle to every
 * page that imported this file. Pure CSS has equivalent visual result with
 * zero additional bundle cost.
 */

import type { ReactNode } from 'react';

interface PageTransitionProps {
  children: ReactNode;
  className?: string;
}

/** Wrapper container — just a passthrough div. Preserved for API compatibility. */
export function PageTransition({ children, className }: PageTransitionProps): React.ReactElement {
  return (
    <div className={className}>
      {children}
    </div>
  );
}

/** Animates the wrapped content in with a fade+lift+blur CSS keyframe. */
export function PageItem({ children, className }: { children: ReactNode; className?: string }): React.ReactElement {
  return (
    <div className={`animate-page-in${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}
