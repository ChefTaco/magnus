/**
 * Theme tones shared by the UI primitives, plus helpers for canvas and chart
 * code that needs the resolved colour values instead of Tailwind classes.
 *
 * Class strings are spelled out in full so Tailwind can find them.
 */

export type Tone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'muted';

export const TONE_TEXT: Record<Tone, string> = {
  primary: 'text-primary',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
  muted: 'text-text-muted',
};

export const TONE_BG: Record<Tone, string> = {
  primary: 'bg-primary',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  muted: 'bg-text-muted',
};

export const TONE_BORDER: Record<Tone, string> = {
  primary: 'border-primary/40',
  accent: 'border-accent/40',
  success: 'border-success/40',
  warning: 'border-warning/40',
  danger: 'border-danger/40',
  info: 'border-info/40',
  muted: 'border-border',
};

export const TONE_GLOW_TEXT: Record<Tone, string> = {
  primary: 'glow-text-primary',
  accent: 'glow-text-accent',
  success: 'glow-text-success',
  warning: 'glow-text-warning',
  danger: 'glow-text-danger',
  info: 'glow-text-primary',
  muted: '',
};

/** CSS custom property for each tone, usable in inline SVG `stroke`/`fill` and `style`. */
export const TONE_VAR: Record<Tone, string> = {
  primary: 'var(--color-primary)',
  accent: 'var(--color-accent)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  info: 'var(--color-info)',
  muted: 'var(--color-text-muted)',
};

export interface Thresholds {
  warn: number;
  crit: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { warn: 70, crit: 90 };

/** Map a utilisation value onto success / warning / danger. */
export function thresholdTone(value: number, thresholds: Thresholds = DEFAULT_THRESHOLDS): Tone {
  if (value >= thresholds.crit) return 'danger';
  if (value >= thresholds.warn) return 'warning';
  return 'success';
}

/** Map a latency in ms onto a tone (fast, ok, slow). */
export function latencyTone(ms: number): Tone {
  if (ms >= 100) return 'danger';
  if (ms >= 20) return 'warning';
  return 'success';
}

export type ThemeColors = Record<
  'bg' | 'surface' | 'border' | 'text' | 'textMuted' | 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info',
  string
>;

const FALLBACK_COLORS: ThemeColors = {
  bg: '#000000',
  surface: '#06060d',
  border: '#1a1a2e',
  text: '#e0e0ec',
  textMuted: '#8a8aab',
  primary: '#00e5ff',
  accent: '#ff006e',
  success: '#00ff41',
  warning: '#ffb300',
  danger: '#ff1744',
  info: '#00b0ff',
};

/** Resolve the theme colours from CSS custom properties (browser only; falls back on the server). */
export function readThemeColors(): ThemeColors {
  if (typeof window === 'undefined' || typeof document === 'undefined') return FALLBACK_COLORS;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    bg: read('--color-bg', FALLBACK_COLORS.bg),
    surface: read('--color-surface', FALLBACK_COLORS.surface),
    border: read('--color-border', FALLBACK_COLORS.border),
    text: read('--color-text', FALLBACK_COLORS.text),
    textMuted: read('--color-text-muted', FALLBACK_COLORS.textMuted),
    primary: read('--color-primary', FALLBACK_COLORS.primary),
    accent: read('--color-accent', FALLBACK_COLORS.accent),
    success: read('--color-success', FALLBACK_COLORS.success),
    warning: read('--color-warning', FALLBACK_COLORS.warning),
    danger: read('--color-danger', FALLBACK_COLORS.danger),
    info: read('--color-info', FALLBACK_COLORS.info),
  };
}

/** Parse `#rrggbb` into an `rgba()` string with the given alpha. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${alpha})`;
}
