export interface HermesInstallationSelection<T> { installation: T | null; error: string | null }
export function controlApiTlsOptions(env?: Record<string, string | undefined>): { rejectUnauthorized: true; ca?: Buffer };
export function controlApiResponseLimit(env?: Record<string, string | undefined>): number;
export function normalizeHermesInstallations<T>(value: unknown): T[];
export function chooseHermesInstallation<T>(installations: T[], installationId: string | null, nodeId: string | null, cookieInstallationId: string | null): HermesInstallationSelection<T>;
export function websocketOriginAllowed(origin: string | undefined, configuredOrigins: string): boolean;
export function cookieHeaderAllowed(header: string | undefined, maxBytes?: number): boolean;
export function hermesSshAllowedCidrs(env?: Record<string, string | undefined>): string[];
export function hermesSshAddressAllowed(address: string, cidrs?: string[]): boolean;
export interface HermesSshAuthorization { installationId: string; nodeId: string; addresses: string[]; hostKeySha256: string[] }
export function hermesSshAuthorizationPath(env?: Record<string, string | undefined>): string;
export function loadHermesSshAuthorization(installation: { id: string; nodeId: string | null }, options?: { file?: string; env?: Record<string, string | undefined>; now?: Date | string | number }): HermesSshAuthorization;
export interface HermesSshTrustInventoryEntry { installationId: string; nodeId: string; hostname: string | null; addresses: string[]; expectedFingerprints: string[]; firstSeenAt: string | null; rotationState: string; overlapExpiresAt: string | null; expiredFingerprints: string[] }
export function readHermesSshTrustInventory(options?: { file?: string; env?: Record<string, string | undefined>; now?: Date | string | number }): HermesSshTrustInventoryEntry[];
export function resolveApprovedHermesSshTarget(installation: { id: string; nodeId: string | null; hostname: string }, options?: { resolver?: (hostname: string) => Promise<Array<string | { address: string }>>; authorization?: HermesSshAuthorization; file?: string; env?: Record<string, string | undefined> }): Promise<{ address: string; addresses: string[]; authorization: HermesSshAuthorization }>;
export function resolveHermesDashboardForwardTarget(installation: { id: string; nodeId: string | null; dashboardHost?: string | null; dashboardPort?: number }, approvedTarget: { address: string; authorization: HermesSshAuthorization }): { address: string; port: number };
export function hermesWebsocketPathAllowed(pathname: string): boolean;
export function rawWebSocketDataByteLength(data: unknown): number | null;
export function createBoundedMessageQueue(maxBytes?: number): { push(data: unknown, isBinary: boolean): boolean; flush(send: (data: unknown, isBinary: boolean) => void): void; drain(send: (data: unknown, isBinary: boolean) => void, canSend: () => boolean): boolean; readonly bytes: number };
export function createWebSocketBackpressureController(options?: { highWaterMark?: number; maxQueueBytes?: number; maxPressureMs?: number; now?: () => number }): { push(data: unknown, isBinary: boolean): boolean; drain(send: (data: unknown, isBinary: boolean) => void, getBufferedAmount: () => number): { pending: boolean; close: boolean; durationMs: number; peakBytes: number }; snapshot(): { queuedBytes: number; durationMs: number; peakBytes: number } };
