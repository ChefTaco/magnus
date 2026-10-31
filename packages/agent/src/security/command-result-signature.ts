import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface SignableCommandResult {
  commandId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  coordination?: { version: 1; resourceKey: string; fence: string; expiresAt: number; requestSha256: string };
  completion?: { registryVersion:1; registrySha256:string; descriptorId:string };
}

export function commandResultSigningPayload(result: SignableCommandResult): string {
  return JSON.stringify({
    version: result.completion ? 3 : result.coordination ? 2 : 1,
    commandId: result.commandId,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
    stderrSha256: createHash('sha256').update(result.stderr).digest('hex'),
    truncated: result.truncated,
    ...(result.coordination ? { coordination: {
      version: result.coordination.version, resourceKey: result.coordination.resourceKey,
      fence: result.coordination.fence, expiresAt: result.coordination.expiresAt,
      requestSha256: result.coordination.requestSha256,
    } } : {}),
    ...(result.completion ? { completion: { registryVersion: result.completion.registryVersion,
      registrySha256: result.completion.registrySha256, descriptorId: result.completion.descriptorId } } : {}),
  });
}

export function signCommandResult(result: SignableCommandResult, secret: string): string {
  if (secret.length < 32) {
    throw new Error('RESULT_SIGNING_SECRET must contain at least 32 characters');
  }
  return createHmac('sha256', secret).update(commandResultSigningPayload(result)).digest('hex');
}

export function verifyCommandResult(result: SignableCommandResult & { signature: string }, secret: string): boolean {
  if (secret.length < 32 || !/^[a-f0-9]{64}$/.test(result.signature)) return false;
  return timingSafeEqual(Buffer.from(result.signature, 'hex'), Buffer.from(signCommandResult(result, secret), 'hex'));
}

export interface CommandReconciliationAssertion {
  nodeFqdn: string;
  commandId: string;
  requestSha256: string;
  coordination?: { version: 1; resourceKey: string; fence: string; expiresAt: number };
  disposition: 'effects_verified' | 'no_effect_verified';
  evidenceSha256: string;
  approvalRef: string;
  decisionId: string;
  expiresAt: number;
  signature: string;
}

/** Separate key and domain: a result signer cannot authorize releasing an unknown claim. */
export function commandReconciliationSigningPayload(assertion: Omit<CommandReconciliationAssertion, 'signature'>): string {
  return JSON.stringify({
    domain: 'magnus.command-reconciliation.v1', nodeFqdn: assertion.nodeFqdn,
    commandId: assertion.commandId, requestSha256: assertion.requestSha256,
    coordination: assertion.coordination ? {
      version: assertion.coordination.version, resourceKey: assertion.coordination.resourceKey,
      fence: assertion.coordination.fence, expiresAt: assertion.coordination.expiresAt,
    } : null,
    disposition: assertion.disposition, evidenceSha256: assertion.evidenceSha256,
    approvalRef: assertion.approvalRef, decisionId: assertion.decisionId, expiresAt: assertion.expiresAt,
  });
}

export function verifyCommandReconciliation(assertion: CommandReconciliationAssertion, secret: string): boolean {
  if (secret.length < 32 || !/^[a-f0-9]{64}$/.test(assertion.signature)) return false;
  const expected = createHmac('sha256', secret).update(commandReconciliationSigningPayload(assertion)).digest();
  return timingSafeEqual(expected, Buffer.from(assertion.signature, 'hex'));
}
