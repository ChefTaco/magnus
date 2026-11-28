import type { NextConfig } from 'next';
import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';

// Read agent version from the monorepo agent package at build time
let AGENT_VERSION = '0.0.0';
try {
  const agentPkg = JSON.parse(readFileSync(resolve(__dirname, '../../packages/agent/package.json'), 'utf-8')) as { version: string };
  AGENT_VERSION = agentPkg.version;
} catch {
  // Fallback when the agent package isn't available (CI, standalone deploy)
}

// The console's own release (server, console and agent are released in lockstep)
const MAGNUS_VERSION = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }).version;

// Load .env so NEXT_PUBLIC_* vars are available to the client bundle
config({ path: resolve(__dirname, '.env') });

// Console-wide Content Security Policy. Next.js inlines its bootstrap scripts, so scripts need
// 'unsafe-inline' (and React's development build needs eval); everything else is locked to this
// origin: no plugins, no foreign connections, forms or frames, and no framing by other sites.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env['NODE_ENV'] === 'production' ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const EMBEDDED_DASHBOARD_POLICY = [
  'sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals',
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');
const EMBEDDED_DASHBOARD_SOURCES = [
  '/api/hermes/dashboard',
  '/api/hermes/dashboard/:path+',
];

const nextConfig: NextConfig = {
  // Standalone output bundles everything for deployment — no npm install needed on target
  output: 'standalone',
  reactStrictMode: true,
  serverExternalPackages: ['ssh2'],
  turbopack: {
    root: resolve(__dirname, '../..'),
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env['NEXT_PUBLIC_API_URL'] ?? 'https://localhost:4000',
    NEXT_PUBLIC_AGENT_VERSION: AGENT_VERSION,
    NEXT_PUBLIC_MAGNUS_VERSION: MAGNUS_VERSION,
  },
  async headers() {
    return [
      // Proxied third-party dashboards: sandboxed into an opaque origin (no allow-same-origin), so
      // their script has no console authority, and frameable by the console only. Same policy as
      // the route handlers send (EMBED_CONTENT_SECURITY_POLICY in runtime-embed-isolation.mjs).
      ...EMBEDDED_DASHBOARD_SOURCES.map((source) => ({
        source,
        headers: [
          { key: 'Content-Security-Policy', value: EMBEDDED_DASHBOARD_POLICY },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      })),
      {
        source: '/((?!api/hermes/dashboard).*)',
        headers: [
          { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: '/hermes', destination: '/orchestra/installations', permanent: true },
      { source: '/hermes/installations', destination: '/orchestra/installations', permanent: true },
      { source: '/hermes/profiles', destination: '/orchestra/profiles', permanent: true },
      { source: '/orchestra/agents', destination: '/orchestra/installations', permanent: true },
    ];
  },
};

export default nextConfig;
