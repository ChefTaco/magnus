/**
 * The Hermes Agent bootstrap script that `POST /api/v1/hermes/install` runs.
 *
 * The script is fetched from an exact upstream commit, never from a moving
 * branch, and its SHA-256 must match before anything runs it. The installer is
 * also told to check out that same commit, so the script and the code it
 * installs come from one reviewed revision.
 *
 * To move the pin to a newer Hermes release, run from `packages/agent`:
 *
 *   node scripts/update-hermes-install-pin.mjs            # latest stable release
 *   node scripts/update-hermes-install-pin.mjs v0.23.4    # a specific tag
 *
 * It resolves the tag to its commit, downloads `scripts/install.sh` at that
 * commit, and rewrites `HERMES_INSTALL_PIN` below. Review the script diff
 * upstream before committing the new pin.
 *
 * An operator can override the pin on one node without a Magnus release by
 * setting both `HERMES_INSTALL_COMMIT` and `HERMES_INSTALL_SCRIPT_SHA256`.
 */
import { createHash } from 'node:crypto';

export const HERMES_INSTALL_REPOSITORY = 'NousResearch/hermes-agent';

// update-hermes-install-pin:start
export const HERMES_INSTALL_PIN = {
  tag: 'v0.23.4',
  commit: '8fc0374447313e276f6b9a2764bfc750190c966a',
  scriptSha256: 'c73dad4dcf7c9ecadb98578e28cc763d23d7be3fa1b513545319038795493214',
} as const;
// update-hermes-install-pin:end

/** Upper bound for the bootstrap script download. */
export const HERMES_INSTALL_SCRIPT_MAX_BYTES = 512 * 1024;

export interface HermesInstallPin { commit: string; scriptSha256: string; source: 'release' | 'environment' }

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** The pin in effect: the release pin, or a complete, valid operator override. */
export function hermesInstallPin(env: NodeJS.ProcessEnv = process.env): HermesInstallPin {
  const commit = env['HERMES_INSTALL_COMMIT']?.trim().toLowerCase() || '';
  const scriptSha256 = env['HERMES_INSTALL_SCRIPT_SHA256']?.trim().toLowerCase() || '';
  if (!commit && !scriptSha256) return { commit: HERMES_INSTALL_PIN.commit, scriptSha256: HERMES_INSTALL_PIN.scriptSha256, source: 'release' };
  if (!COMMIT.test(commit) || !SHA256.test(scriptSha256))
    throw new Error('HERMES_INSTALL_COMMIT (40 hex) and HERMES_INSTALL_SCRIPT_SHA256 (64 hex) must be set together');
  return { commit, scriptSha256, source: 'environment' };
}

export function hermesInstallScriptUrl(commit: string): string {
  if (!COMMIT.test(commit)) throw new Error('Hermes install commit must be a full 40-character SHA');
  return `https://raw.githubusercontent.com/${HERMES_INSTALL_REPOSITORY}/${commit}/scripts/install.sh`;
}

/**
 * Download the pinned bootstrap script and return its bytes only when they
 * hash to the pinned SHA-256. Redirects are refused and the size is bounded.
 */
export async function fetchPinnedHermesInstallScript(
  pin: Pick<HermesInstallPin, 'commit' | 'scriptSha256'>,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  const response = await fetcher(hermesInstallScriptUrl(pin.commit), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Pinned Hermes installer download failed (HTTP ${response.status})`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > HERMES_INSTALL_SCRIPT_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Pinned Hermes installer is larger than expected');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > HERMES_INSTALL_SCRIPT_MAX_BYTES) throw new Error('Pinned Hermes installer is larger than expected');
      chunks.push(Buffer.from(chunk));
    }
  }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== pin.scriptSha256)
    throw new Error('Hermes installer digest does not match the pinned SHA-256');
  return bytes;
}
