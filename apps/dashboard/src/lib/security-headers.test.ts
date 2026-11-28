import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('console security headers', () => {
  it('sends a restrictive Content Security Policy on every console page', async () => {
    const rules = await nextConfig.headers!();
    const pages = rules.find((rule) => rule.source.startsWith('/((?!'))!;
    const csp = pages.headers.find((header) => header.key === 'Content-Security-Policy')?.value ?? '';
    for (const directive of ["default-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"])
      expect(csp).toContain(directive);
    expect(csp).not.toMatch(/\*|https?:/);
  });

  it('keeps the embedded dashboards frameable only by the console itself', async () => {
    const rules = await nextConfig.headers!();
    for (const source of ['/api/hermes/dashboard', '/api/hermes/dashboard/:path+']) {
      const rule = rules.find((entry) => entry.source === source)!;
      expect(rule.headers.find((header) => header.key === 'Content-Security-Policy')?.value).toContain("frame-ancestors 'self'");
    }
  });

  it('no longer exempts the removed router admin proxy from the page policy', async () => {
    const rules = await nextConfig.headers!();
    expect(rules.some((entry) => entry.source.includes('hive-router'))).toBe(false);
  });
});
