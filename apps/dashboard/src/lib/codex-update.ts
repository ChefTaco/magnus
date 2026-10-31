import type { CodexInstallation } from '@/types/codex';

export function canRequestCodexUpdate(
  installation: Pick<CodexInstallation, 'installed' | 'latestVersion' | 'updateAvailable' | 'updateSupported'>,
): boolean {
  return installation.installed && installation.updateSupported && (installation.updateAvailable || !installation.latestVersion);
}
