import { createHmac, timingSafeEqual } from 'node:crypto';
export function bridgeSignature(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  if (secret.length < 32) throw new Error('Dedicated bridge secret is required');
  return createHmac('sha256', secret)
    .update(`cindertrace.magnus-response.v1\n${method}\n${path}\n${timestamp}\n${nonce}\n${body}`)
    .digest('hex');
}
export function equalSignature(a: string, b: string): boolean {
  return (
    /^[a-f0-9]{64}$/.test(a) &&
    /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  );
}
