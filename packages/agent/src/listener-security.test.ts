import { describe, expect, it } from 'vitest';
import { resolveListenerSecurity } from './listener-security.js';

const exists = () => true;

describe('agent listener security', () => {
  it('fails closed when production TLS is absent', () => {
    expect(() => resolveListenerSecurity({
      nodeEnv: 'production',
      allowInsecureHttp: true,
      pathExists: exists,
    })).toThrow(/required in production/);
  });

  it('requires explicit loopback-only HTTP in development', () => {
    expect(() => resolveListenerSecurity({
      nodeEnv: 'development',
      allowInsecureHttp: false,
      pathExists: exists,
    })).toThrow(/explicit ALLOW_INSECURE_HTTP/);
    expect(() => resolveListenerSecurity({
      nodeEnv: 'development',
      allowInsecureHttp: true,
      bindHost: '192.0.2.10',
      pathExists: exists,
    })).toThrow(/only to a loopback/);
    expect(resolveListenerSecurity({
      nodeEnv: 'development',
      allowInsecureHttp: true,
      bindHost: '::1',
      pathExists: exists,
    })).toEqual({ hostname: '::1', useTls: false });
  });

  it('rejects partial and missing configured TLS material', () => {
    expect(() => resolveListenerSecurity({
      nodeEnv: 'development',
      allowInsecureHttp: false,
      keyPath: '/key.pem',
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

  it('uses the configured TLS bind host', () => {
    expect(resolveListenerSecurity({
      nodeEnv: 'production',
      allowInsecureHttp: false,
      bindHost: '100.64.0.10',
      certPath: '/cert.pem',
      keyPath: '/key.pem',
      pathExists: exists,
    })).toEqual({ hostname: '100.64.0.10', useTls: true });
  });
});
