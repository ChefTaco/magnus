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
      {
        // Hive Router dashboard proxy — allow same-origin iframe embedding
        source: '/api/hive-router/dashboard',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        source: '/api/hive-router/dashboard/:path+',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },

      {
        // Hermes dashboard proxy — allow same-origin iframe embedding
        source: '/api/hermes/dashboard',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        source: '/api/hermes/dashboard/:path+',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        source: '/((?!api/hive-router/dashboard|api/hermes/dashboard).*)',
        headers: [
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
  async rewrites() {
    return [
      { source: '/dashboard-plugins/:path*', destination: '/api/hermes/dashboard/dashboard-plugins/:path*' },
      { source: '/kanban', destination: '/api/hermes/dashboard/kanban' },
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
