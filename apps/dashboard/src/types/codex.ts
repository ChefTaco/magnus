export type CodexAuthStatus =
  | 'authenticated'
  | 'not_authenticated'
  | 'wrong_auth_mode'
  | 'expired_logged_out'
  | 'error';

export interface CodexInstallation {
  nodeId: string;
  nodeName: string;
  hostname: string;
  nodeStatus: string;
  lastHeartbeatAt: string | null;
  reachable: boolean;
  installed: boolean;
  user: string;
  userHome: string;
  codexHome: string;
  codexBin: string | null;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  provenance: 'standalone' | 'npm' | 'nvm' | 'fnm' | 'asdf' | 'mise' | 'volta' | 'pnpm' | 'bun' | 'nix' | 'snap' | 'unknown';
  updateSupported: boolean;
  auth: {
    status: CodexAuthStatus;
    mode: 'chatgpt' | 'apiKey' | 'other' | null;
    oauth: boolean;
    tokenExpiresAt: string | null;
    tokenExpired: boolean | null;
    refreshTokenPresent: boolean;
    lastRefreshAt: string | null;
    planType: string | null;
    autoLoggedOut: boolean;
    message: string;
  };
  checkedAt: string;
  error: string | null;
}

export interface CodexDeviceAuthSession {
  id: string;
  status: 'pending' | 'completed' | 'failed' | 'expired' | 'cancelled';
  verificationUrl: string;
  userCode: string;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  error: string | null;
}
