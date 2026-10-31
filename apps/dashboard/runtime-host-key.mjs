import { createHash } from 'node:crypto';

export function sshHostKeyFingerprint(key) {
  const bytes = Buffer.isBuffer(key) ? key : Buffer.from(key);
  return `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}`;
}

/** Build a strict verifier for fingerprints cryptographically bound to inventory. */
export function createSshHostVerifier(host, options = {}) {
  if (!Array.isArray(options.expectedFingerprints) || options.expectedFingerprints.length === 0) {
    throw new Error(`Expected SSH host-key fingerprints are required for ${host}`);
  }
  const expected = new Set(options.expectedFingerprints);
  return (key) => {
    const fingerprint = sshHostKeyFingerprint(key);
    const matches = expected.has(fingerprint);
    if (!matches) {
      console.error(`[ssh] host key mismatch for ${host}`);
      options.onMismatch?.({ host, observedFingerprint: fingerprint });
    }
    return matches;
  };
}
