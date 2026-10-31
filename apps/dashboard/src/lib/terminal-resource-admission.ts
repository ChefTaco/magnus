/** Server-side admission only. Browser input never selects a Control API origin. */
import { controlApiFetch } from '@/lib/control-api-fetch';
export async function assertTerminalResourceAdmission(host: string): Promise<void> {
  const base = process.env['CONTROL_API_URL'];
  const secret = process.env['API_SECRET'];
  if (!base || !secret) throw new Error('Terminal resource admission is unavailable');
  const response = await controlApiFetch(`${base.replace(/\/+$/, '')}/api/v1/resource-leases/ssh-admission?host=${encodeURIComponent(host)}`, {
    headers: { 'x-api-secret': secret }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Managed terminal is unavailable for this enrolled or unresolved resource');
  const value = await response.json() as { success?: boolean; data?: { allowed?: boolean; enrolled?: boolean } };
  if (value.success !== true || value.data?.allowed !== true || value.data.enrolled !== false)
    throw new Error('Terminal resource admission could not be verified');
}
