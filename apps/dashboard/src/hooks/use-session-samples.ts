'use client';

import { useEffect, useState } from 'react';

export interface SessionSample {
  t: number;
  [metric: string]: number | null;
}

const LIMIT = 40;

function read(key: string): SessionSample[] {
  try {
    const raw = window.sessionStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? (parsed as SessionSample[]).slice(-LIMIT) : [];
  } catch {
    return [];
  }
}

/**
 * Keeps the last 40 polled samples for this browser tab (persisted in
 * sessionStorage so trends survive navigation). There is no fleet-wide history
 * endpoint yet, so overview sparklines show "this session" trends.
 */
export function useSessionSamples(key: string, sample: Omit<SessionSample, 't'> | null): SessionSample[] {
  const [samples, setSamples] = useState<SessionSample[]>([]);

  useEffect(() => {
    setSamples(read(key));
  }, [key]);

  const signature = sample ? JSON.stringify(sample) : null;
  useEffect(() => {
    if (!signature) return;
    const next = JSON.parse(signature) as Omit<SessionSample, 't'>;
    setSamples((prev) => {
      const now = Date.now();
      const last = prev[prev.length - 1];
      // Polls every 15s; ignore re-renders that bring no new data within 5s.
      if (last && now - last.t < 5_000 && JSON.stringify({ ...last, t: undefined }) === JSON.stringify({ ...next, t: undefined })) return prev;
      const updated = [...prev, { ...next, t: now }].slice(-LIMIT);
      try {
        window.sessionStorage.setItem(key, JSON.stringify(updated));
      } catch {
        // Storage full or blocked: keep the in-memory trend only.
      }
      return updated;
    });
  }, [key, signature]);

  return samples;
}

/** Pull one metric out of the samples as a number series (nulls dropped). */
export function series(samples: SessionSample[], metric: string): number[] {
  return samples.map((s) => s[metric]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}
