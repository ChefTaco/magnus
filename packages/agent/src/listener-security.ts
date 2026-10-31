export interface ListenerSecurityOptions {
  nodeEnv: string;
  allowInsecureHttp: boolean;
  bindHost?: string;
  certPath?: string;
  keyPath?: string;
  pathExists: (path: string) => boolean;
}

export interface ListenerSecurity {
  hostname: string;
  useTls: boolean;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

/** Fail closed instead of silently downgrading a missing TLS listener. */
export function resolveListenerSecurity(options: ListenerSecurityOptions): ListenerSecurity {
  const certConfigured = Boolean(options.certPath);
  const keyConfigured = Boolean(options.keyPath);
  if (certConfigured !== keyConfigured) {
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be configured together');
  }

  if (certConfigured && keyConfigured) {
    if (!options.pathExists(options.certPath!) || !options.pathExists(options.keyPath!)) {
      throw new Error('Configured TLS certificate or key does not exist');
    }
    return {
      hostname: options.bindHost?.trim() || '0.0.0.0',
      useTls: true,
    };
  }

  if (options.nodeEnv === 'production') {
    throw new Error('TLS_CERT_PATH and TLS_KEY_PATH are required in production');
  }
  if (!options.allowInsecureHttp) {
    throw new Error('Cleartext HTTP requires explicit ALLOW_INSECURE_HTTP=true');
  }

  const hostname = options.bindHost?.trim() || '127.0.0.1';
  if (!isLoopbackHost(hostname)) {
    throw new Error('Cleartext HTTP may bind only to a loopback host');
  }
  return { hostname, useTls: false };
}
