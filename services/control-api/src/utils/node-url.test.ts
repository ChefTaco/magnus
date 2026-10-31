import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveAgentCertificateHostname,
  getNodeBaseUrl,
  selectAgentEndpointHostname,
  verifyAgentCertificateHostname,
} from './node-url.js';

const originalTlsCert = process.env['TLS_CERT_PATH'];
const originalTlsKey = process.env['TLS_KEY_PATH'];

afterEach(() => {
  if (originalTlsCert === undefined) delete process.env['TLS_CERT_PATH'];
  else process.env['TLS_CERT_PATH'] = originalTlsCert;
  if (originalTlsKey === undefined) delete process.env['TLS_KEY_PATH'];
  else process.env['TLS_KEY_PATH'] = originalTlsKey;
});

describe('node agent endpoint identity', () => {
  it('derives the certificate hostname from short and legacy OS hostnames', () => {
    expect(deriveAgentCertificateHostname('magnus', 'example.com')).toBe('magnus.example.com');
    expect(deriveAgentCertificateHostname('chatgpt-mcp.fleet.local', 'example.com')).toBe('chatgpt-mcp.example.com');
  });

  it('preserves an already matching certificate hostname', () => {
    expect(deriveAgentCertificateHostname('Node-B.Example.Com.', '.example.com.')).toBe('node-b.example.com');
  });

  it('refuses absent or malformed endpoint identity configuration', () => {
    expect(deriveAgentCertificateHostname('magnus', undefined)).toBeNull();
    expect(deriveAgentCertificateHostname('../magnus', 'example.com')).toBeNull();
    expect(deriveAgentCertificateHostname('magnus', 'bad_suffix')).toBeNull();
  });

  it('accepts the certificate hostname only when DNS matches heartbeat evidence', () => {
    expect(verifyAgentCertificateHostname('magnus.example.com', '100.64.0.74', ['10.20.30.40', '100.64.0.74'])).toBe('magnus.example.com');
    expect(verifyAgentCertificateHostname('magnus.example.com', '127.0.0.1', ['127.0.0.1', '10.20.30.40'])).toBe('magnus.example.com');
    expect(verifyAgentCertificateHostname('magnus.example.com', '100.64.0.99', ['10.20.30.40', '100.64.0.74'])).toBeNull();
  });

  it('persists the verified certificate identity instead of a mutable OS hostname', () => {
    expect(
      selectAgentEndpointHostname(
        'Magnus.Example.Com',
        'magnus.fleet.local',
      ),
    ).toBe('magnus.example.com');
    expect(
      selectAgentEndpointHostname(
        null,
        'Magnus.Fleet.Local',
        'magnus.example.com',
        'magnus.example.com',
      ),
    ).toBe('magnus.example.com');
    expect(
      selectAgentEndpointHostname(
        null,
        'Magnus.Fleet.Local',
        'stale.attacker.invalid',
        'magnus.example.com',
      ),
    ).toBe('magnus.fleet.local');
  });

  it('selects HTTPS only with complete Control API TLS configuration', () => {
    process.env['TLS_CERT_PATH'] = '/cert.pem';
    process.env['TLS_KEY_PATH'] = '/key.pem';
    expect(getNodeBaseUrl('magnus.example.com', 4100)).toBe('https://magnus.example.com:4100');
    delete process.env['TLS_KEY_PATH'];
    expect(getNodeBaseUrl('127.0.0.1', 4100)).toBe('http://127.0.0.1:4100');
  });
});
