import type { NextConfig } from 'next';

const API_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@maxcloud/shared'],
  poweredByHeader: false,
  // Same-origin API: /api/* is proxied to the Nest API so auth cookies are first-party.
  // Only small JSON goes through here; file bytes go browser <-> S3 directly.
  // On Vercel the project's top-level rewrite (vercel.json) sends /api/* to the `api` service
  // before Next.js sees it, so no proxy is needed (and next.config rewrites are build-time,
  // where service bindings aren't available anyway).
  async rewrites() {
    if (process.env.VERCEL) return [];
    return [{ source: '/api/:path*', destination: `${API_URL}/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ];
  },
};

export default config;
