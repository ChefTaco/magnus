import { describe, expect, it } from 'vitest';
import { resolveListenerSecurity } from './listener-security.js';

const exists = () => true;

describe('Control API listener security', () => {
  it('fails closed when production TLS is absent', () => {
    expect(() => resolveListenerSecurity({
      nodeEnv: 'production',
      allowInsecureHttp: true,
      pathExists: exists,
    })).toThrow(/required in production/);
  });

  it('requires an explicit loopback-only development opt-in for HTTP', () => {
    expect(() => resolveListenerSecurity({
      nodeEnv: 'development',
      allowInsecureHttp: false,
      pathExists: exists,
    })).toThrow(/explicit ALLOW_INSECURE_HTTP/);
    expect(() => resolveListenerSecurity({
      nodeEnv: 'development',
      allowInsecureHttp: true,
      bindHost: '0.0.0.0',
      pathExists: exists,
    })).toThrow(/only to a loopback/);
    expect(resolveListenerSecurity({
      nodeEnv: 'development',
      allowInsecureHttp: true,
      pathExists: exists,
    })).toEqual({ hostname: '127.0.0.1', useTls: false });
  });

  it('rejects partial or missing configured TLS material', () => {
    expect(() => resolveListenerSecurity({
      nodeEnv: 'development',
      allowInsecureHttp: false,
      certPath: '/cert.pem',
      pathExists: exists,
    })).toThrow(/configured together/);
    expect(() => resolveListenerSecurity({
      nodeEnv: 'production',
      allowInsecureHttp: false,
      certPath: '/cert.pem',
      keyPath: '/key.pem',
      pathExists: () => false,
    })).toThrow(/does not exist/);
  });

  it('retains an all-interface default only for a verified TLS listener', () => {
    expect(resolveListenerSecurity({
      nodeEnv: 'production',
      allowInsecureHttp: false,
      certPath: '/cert.pem',
      keyPath: '/key.pem',
      pathExists: exists,
    })).toEqual({ hostname: '0.0.0.0', useTls: true });
  });
});
