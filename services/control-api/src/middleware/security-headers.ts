import type { MiddlewareHandler } from 'hono';

/**
 * Security headers middleware.
 * Applies OWASP-recommended HTTP response headers to all responses.
 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();

  // Prevent MIME type sniffing
  c.header('X-Content-Type-Options', 'nosniff');

  // Prevent click-jacking
  c.header('X-Frame-Options', 'DENY');

  // XSS protection (legacy browsers)
  c.header('X-XSS-Protection', '1; mode=block');

  // Strict transport security (1 year, include subdomains)
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // No referrer leakage
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Restrict permissions
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Prevent caching of API responses with sensitive data
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
};
