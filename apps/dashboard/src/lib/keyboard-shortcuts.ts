/**
 * Keyboard shortcut definitions for the Magnus dashboard.
 * Used by the CommandPalette and shortcut hint system.
 */

export interface ShortcutDef {
  keys: string[];
  label: string;
  description: string;
  action: 'navigate' | 'command';
  target?: string; // URL for navigate, action ID for command
  category: 'navigation' | 'fleet' | 'general';
}

export const shortcuts: ShortcutDef[] = [
  // Navigation — Fleet
  { keys: ['g', 'm'], label: 'Go to Mission Control', description: 'Navigate to unified Mission Control home', action: 'navigate', target: '/mission-control', category: 'navigation' },
  { keys: ['g', 'o'], label: 'Go to Overview', description: 'Navigate to fleet overview', action: 'navigate', target: '/', category: 'navigation' },
  { keys: ['g', 'n'], label: 'Go to Nodes', description: 'Navigate to node list', action: 'navigate', target: '/nodes', category: 'navigation' },
  { keys: ['g', 'c'], label: 'Go to Commands', description: 'Navigate to command console', action: 'navigate', target: '/commands', category: 'navigation' },
  { keys: ['g', 'j'], label: 'Go to Cron Jobs', description: 'Navigate to cron jobs', action: 'navigate', target: '/cron', category: 'navigation' },
  { keys: ['g', 'f'], label: 'Go to Files', description: 'Navigate to file editor', action: 'navigate', target: '/files', category: 'navigation' },
  { keys: ['g', 's'], label: 'Go to Skills', description: 'Navigate to skill marketplace', action: 'navigate', target: '/skills', category: 'navigation' },
  { keys: ['g', 'l'], label: 'Go to Logs', description: 'Navigate to log explorer', action: 'navigate', target: '/logs', category: 'navigation' },
  { keys: ['g', 'a'], label: 'Go to Audit', description: 'Navigate to audit trail', action: 'navigate', target: '/audit', category: 'navigation' },
  // General
  { keys: ['?'], label: 'Show Shortcuts', description: 'Show keyboard shortcut reference', action: 'command', target: 'show-shortcuts', category: 'general' },
];

/**
 * Format shortcut keys for display.
 * Example: ['g', 'n'] → "G then N"
 */
export function formatKeys(keys: string[]): string {
  return keys.map((k) => k.toUpperCase()).join(' then ');
}

/**
 * Detect platform for modifier key display.
 */
export function getModifierKey(): string {
  if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)) {
    return '⌘';
  }
  return 'Ctrl';
}
