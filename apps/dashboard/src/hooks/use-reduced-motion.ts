'use client';

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** True when the viewer asked for reduced motion or switched visual effects to low. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(QUERY).matches || document.documentElement.dataset.fx === 'low';
}

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-fx'] });
  return () => {
    mql.removeEventListener('change', onChange);
    observer.disconnect();
  };
}

/** Reactive version of `prefersReducedMotion()`. The server snapshot is `false`; CSS does the real gating. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}

const FX_STORAGE_KEY = 'magnus:fx';

/** Apply the persisted visual-effects level to <html data-fx>. */
export function applyStoredFxLevel(): void {
  try {
    const level = window.localStorage.getItem(FX_STORAGE_KEY);
    if (level === 'low') document.documentElement.dataset.fx = 'low';
    else delete document.documentElement.dataset.fx;
  } catch {
    // Storage blocked: keep the default.
  }
}

/** Toggle between normal and low visual effects; returns the new level. */
export function toggleFxLevel(): 'low' | 'normal' {
  const next = document.documentElement.dataset.fx === 'low' ? 'normal' : 'low';
  if (next === 'low') document.documentElement.dataset.fx = 'low';
  else delete document.documentElement.dataset.fx;
  try {
    window.localStorage.setItem(FX_STORAGE_KEY, next);
  } catch {
    // Storage blocked: the change still applies to this page view.
  }
  return next;
}
