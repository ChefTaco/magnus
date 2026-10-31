export const WEBHOOK_FORMATS = ['generic', 'slack', 'discord', 'mattermost'] as const;
/**
 * Legacy webhook type names mapped to current formats, from
 * `MAGNUS_WEBHOOK_TYPE_ALIASES` (comma-separated `legacy=format` pairs). Lets
 * endpoints stored or submitted under an older type name keep their format.
 */
export function webhookTypeAliases(raw = process.env['MAGNUS_WEBHOOK_TYPE_ALIASES']): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {};
  const aliases: Record<string, string> = {};
  for (const pair of raw.split(',').map(item => item.trim()).filter(Boolean)) {
    const [from, to, extra] = pair.split('=').map(item => item.trim());
    if (extra !== undefined || !from || !to || !/^[a-z][a-z0-9_-]{0,31}$/.test(from)
      || (WEBHOOK_FORMATS as readonly string[]).includes(from) || !(WEBHOOK_FORMATS as readonly string[]).includes(to))
      throw new Error('MAGNUS_WEBHOOK_TYPE_ALIASES must list legacy=format pairs, where format is generic, slack, discord or mattermost');
    aliases[from] = to;
  }
  return aliases;
}
/** The current delivery format for a stored or submitted webhook type. */
export function webhookFormat(type: string): string {
  let aliases: Record<string, string> = {};
  try { aliases = webhookTypeAliases(); } catch { /* Startup validation reports a malformed list. */ }
  return Object.hasOwn(aliases, type) ? aliases[type]! : type;
}
