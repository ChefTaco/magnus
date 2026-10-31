export const DEFAULT_ARDENT_PACKAGE = '@hivemagnus/ardent';
const scopedPackageName = /^@[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/;
/**
 * npm package names the agent accepts as the Ardent runtime, in preference
 * order. `MAGNUS_AGENT_ARDENT_PACKAGES` (comma-separated scoped names) lets a
 * node keep managing an Ardent build published under another scope.
 */
export function ardentPackageNames(value = process.env['MAGNUS_AGENT_ARDENT_PACKAGES']): string[] {
  if (value === undefined || value.trim() === '') return [DEFAULT_ARDENT_PACKAGE];
  const names = value.split(',').map(item => item.trim()).filter(Boolean);
  if (!names.length || names.some(name => !scopedPackageName.test(name)))
    throw new Error('MAGNUS_AGENT_ARDENT_PACKAGES must list scoped npm package names such as @scope/ardent');
  return [...new Set(names)];
}
