export function sshHostKeyFingerprint(key: Buffer | string): string;
export function createSshHostVerifier(host: string, options: { expectedFingerprints: string[]; onMismatch?: (event: { host: string; observedFingerprint: string }) => void }): (key: Buffer | string) => boolean;
