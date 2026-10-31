import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const pinsSchema = z.record(z.string(), z.array(z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/)).min(1));

/** A trusted pin must exist before SSH can send any authentication credential. */
export function sshHostVerification(hostname: string, port = 22): { hostVerifier: (key: Buffer) => boolean } {
  const file = process.env['SSH_HOST_KEY_PINS_FILE'];
  if (!file) throw new Error('SSH_HOST_KEY_PINS_FILE is required for SSH operations');
  let pins: z.infer<typeof pinsSchema>;
  try { pins = pinsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { throw new Error('SSH host-key pin configuration is unreadable or invalid'); }
  const accepted = pins[`${hostname.toLowerCase()}:${port}`];
  if (!accepted?.length) throw new Error('No trusted SSH host-key pin for this destination');
  return {
    hostVerifier: (key) => {
      const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
      return accepted.includes(fingerprint);
    },
  };
}
