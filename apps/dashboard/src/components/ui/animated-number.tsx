'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { prefersReducedMotion } from '@/hooks/use-reduced-motion';

export interface AnimatedNumberProps {
  value: number | null | undefined;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Custom formatter (client callers only; functions can't cross the server boundary). */
  format?: (n: number) => string;
  duration?: number;
  className?: string;
}

const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * Number that tweens when its value changes. The first render (including the
 * server render) shows the final value, so text assertions and SSR stay exact.
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
  format,
  duration = 600,
  className,
}: AnimatedNumberProps): React.ReactElement {
  const known = typeof value === 'number' && Number.isFinite(value);
  const [shown, setShown] = useState<number | null>(known ? value : null);
  const fromRef = useRef<number | null>(known ? value : null);

  useEffect(() => {
    if (!known) {
      fromRef.current = null;
      setShown(null);
      return;
    }
    const from = fromRef.current;
    fromRef.current = value;
    if (from === null || from === value || prefersReducedMotion()) {
      setShown(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / duration);
      setShown(from + (value - from) * easeOutExpo(t));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [known, value, duration]);

  const text = shown === null ? '—' : `${prefix}${format ? format(shown) : shown.toFixed(decimals)}${suffix}`;
  return <span className={cn('num', className)}>{text}</span>;
}
