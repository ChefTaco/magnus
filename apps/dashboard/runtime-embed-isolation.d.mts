export type EmbeddedDashboard = 'hermes' | 'router';
export const EMBEDDED_DASHBOARDS: Readonly<Record<EmbeddedDashboard, string>>;
export const FRAME_SEGMENT: string;
export const EMBED_IFRAME_SANDBOX: string;
export const EMBED_CONTENT_SECURITY_POLICY: string;
export const FRAME_COMPAT_SCRIPT: string;
export interface FrameGrant {
  app: EmbeddedDashboard;
  username: string;
  sessionId: string;
  installationId: string | null;
}
export function mintFrameGrant(input: {
  app: EmbeddedDashboard;
  installationId?: string | null;
  session: { username: string; sessionId?: string; provider?: string; exp: number };
}): Promise<string>;
export function verifyFrameGrant(token: string, app: EmbeddedDashboard): Promise<FrameGrant | null>;
export function parseFramePath(pathname: string): {
  app: EmbeddedDashboard;
  base: string;
  grant: string;
  frameBase: string;
  upstreamPath: string;
} | null;
export function splitFrameSegments(segments: string[] | undefined): { grant: string; rest: string[] } | null;
export function frameEntryAllowed(headers: { get(name: string): string | null }): boolean;
export function applyFrameHeaders(headers: Headers, requestOrigin: string | null): Headers;
export function framePreflightHeaders(requestHeaders: { get(name: string): string | null }): Headers;
export function injectFrameCompat(html: string): string;
