/**
 * Every refusal is a fixed code and a fixed sentence. Upstream and SSH error text never reaches a
 * client or a log, because it can carry hostnames, addresses or key material.
 */
export const REFUSALS = {
  UNAUTHORIZED: [401, 'A valid bearer token is required.'],
  FORBIDDEN: [403, 'The web terminal requires an administrator link and the magnus:terminal permission.'],
  STEP_UP_REQUIRED: [403, 'Verify your identity again to open a terminal.'],
  CROSS_ORIGIN_REJECTED: [403, 'Cross-origin requests are not accepted.'],
  INVALID_REQUEST: [400, 'The request is not valid.'],
  CREDENTIAL_IN_URL: [400, 'Credentials and options are not accepted in the URL.'],
  PAYLOAD_TOO_LARGE: [413, 'The request body is too large.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'The request body must be application/json.'],
  NOT_FOUND: [404, 'Not found.'],
  SESSION_NOT_FOUND: [404, 'Terminal session not found.'],
  NODE_NOT_FOUND: [404, 'Node not found.'],
  NODE_TARGET_REFUSED: [409, 'This node cannot be reached by the web terminal.'],
  NODE_TARGET_CHANGED: [409, 'The node address no longer matches its trusted host record.'],
  HOST_KEY_UNTRUSTED: [409, 'No SSH host key has been approved for this node.'],
  HOST_KEY_CHANGED: [409, 'The node presented an SSH host key that has not been approved.'],
  RESOURCE_ADMISSION_REFUSED: [409, 'Resource coordination does not currently allow a terminal on this node.'],
  SESSION_LIMIT_REACHED: [429, 'Too many terminal sessions are open.'],
  RATE_LIMITED: [429, 'Too many terminal sessions were opened recently.'],
  INPUT_BUSY: [429, 'The terminal is not accepting input yet. Retry shortly.'],
  SSH_CONNECT_FAILED: [502, 'The SSH connection to the node failed.'],
  CONTROL_API_UNAVAILABLE: [503, 'The Magnus API could not be reached.'],
  GATEWAY_STOPPING: [503, 'The gateway is shutting down.'],
  TRUST_STORE_UNAVAILABLE: [503, 'The SSH host key store could not be read.'],
  AUDIT_UNAVAILABLE: [503, 'The session could not be recorded, so it was not opened.'],
  INTERNAL: [500, 'The request failed.'],
} as const satisfies Record<string, readonly [number, string]>;

export type RefusalCode = keyof typeof REFUSALS;

/** Metadata for the refusal's audit record. Never reaches the client. */
export interface RefusalAudit {
  subject: string;
  actorId: string;
  nodeId?: string | null;
  fingerprint?: string | null;
}

export class GatewayError extends Error {
  readonly status: number;
  audit?: RefusalAudit;
  /** Set when a verified token from this identity session no longer grants the terminal. */
  ownerKey?: string;
  /** The unapproved key a node presented, for the audit record that an operator compares against. */
  observedFingerprint?: string;
  constructor(readonly code: RefusalCode, readonly reason?: string) {
    super(code);
    this.status = REFUSALS[code][0];
  }
}
