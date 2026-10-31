import { Badge } from '@/components/ui/badge';
import type { HermesRuntimeConfiguration } from '@/types/orchestra';

export function HiveMemTokenStatus({ configuration }: { configuration: HermesRuntimeConfiguration | null | undefined }): React.ReactElement | null {
  if (configuration?.memoryProvider !== 'hivemem') return null;
  const token = configuration.hiveMemToken;
  const status = token?.status ?? 'unknown';
  const variant = status === 'valid' ? 'success'
    : status === 'expiring' || status === 'unreachable' || status === 'unknown' ? 'warning' : 'danger';
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant={variant}>Token {status}</Badge>
      {token?.expiresAt && <time dateTime={token.expiresAt} title="HiveMem token expiration">expires {new Date(token.expiresAt).toLocaleString()}</time>}
      {token?.checkedAt && <time dateTime={token.checkedAt} className="text-text-muted/70" title="Last HiveMem authentication check">checked {new Date(token.checkedAt).toLocaleString()}</time>}
    </span>
  );
}
