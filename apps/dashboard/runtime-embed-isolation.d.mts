export type EmbeddedDashboard = 'hermes';
export const EMBEDDED_DASHBOARDS: Readonly<Record<EmbeddedDashboard, string>>;
export const FRAME_SEGMENT: string;
export const FRAME_GRANT_TTL_SECONDS: number;
export const FRAME_SESSION_RECHECK_MS: number;
export const FRAME_TOKEN_PLACEHOLDER: string;
export const EMBED_IFRAME_SANDBOX: string;
export const EMBED_CONTENT_SECURITY_POLICY: string;
export const FRAME_COMPAT_SCRIPT: string;
export const FRAME_RECONNECT_PAGE: string;
export interface FrameGrant {
  app: EmbeddedDashboard;
  username: string;
  sessionId: string;
  installationId: string | null;
  expired: boolean;
  expiresAt: number;
  sessionExpiresAt: number;
}
export interface FrameSessionState {
  username: string;
  expiresAt: number;
  hermesTokens: Map<string, string>;
}
export function mintFrameGrant(input: {
  app: EmbeddedDashboard;
  installationId?: string | null;
  session: { username: string; sessionId?: string; provider?: string; exp: number };
}): Promise<string>;
export function verifyFrameGrant(token: string, app: EmbeddedDashboard, options?: { allowExpired?: boolean }): Promise<FrameGrant | null>;
export function frameSessionAlive(grant: { username: string; sessionId: string }): Promise<boolean>;
export function parseFramePath(pathname: string): {
  app: EmbeddedDashboard;
  base: string;
  grant: string;
  frameBase: string;
  upstreamPath: string;
} | null;
export function splitFrameSegments(segments: string[] | undefined): { grant: string; rest: string[] } | null;
export function frameStaticAsset(upstreamPath: string): boolean;
export function frameGrantDecision(request: {
  grant: string;
  app: EmbeddedDashboard;
  method: string;
  headers: { get(name: string): string | null };
  upstreamPath: string;
}): Promise<
  | { action: 'allow'; grant: FrameGrant }
  | { action: 'remint'; grant: FrameGrant }
  | { action: 'refuse'; error: 'frame_grant_invalid'; grant: null }
  | { action: 'refuse'; error: 'frame_grant_expired'; grant: FrameGrant }
>;
export function frameEntryAllowed(headers: { get(name: string): string | null }): boolean;
export function applyFrameHeaders(headers: Headers, requestOrigin: string | null): Headers;
export function framePreflightHeaders(requestHeaders: { get(name: string): string | null }): Headers;
export function swapFrameToken(search: string, token: string | null | undefined): string;
export function frameSessionState(grant: { sessionId: string; sessionExpiresAt: number; username: string }): FrameSessionState;
export function peekFrameSessionState(sessionId: string): FrameSessionState | null;
export function clearFrameSessionState(sessionId: string): void;
export function clearFrameUserState(username: string): void;
export function resetFrameState(): void;
export function frameUpstreamPath(segments: string[]): string | null;
export function injectFrameCompat(html: string): string;
