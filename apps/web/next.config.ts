import bundleAnalyzer from '@next/bundle-analyzer';
import type { NextConfig } from 'next';

// Proxy same-origin: o cookie httpOnly de refresh funciona sem CORS.
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const dev = process.env.NODE_ENV !== 'production';

// shortcut: 'unsafe-inline' em script-src (hidratacao inline do Next + script do tema); trocar por nonce via middleware
// quando aceitarmos renderizacao dinamica de todas as paginas.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${process.env.NEXT_PUBLIC_API_URL ?? ''}${dev ? ' ws:' : ''}`.trim(),
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

// ANALYZE=true gera relatorios JSON em <distDir>/analyze (lidos por `pnpm --filter @docmind/web analyze`)
const withAnalyzer = bundleAnalyzer({ enabled: process.env.ANALYZE === 'true', openAnalyzer: false, analyzerMode: 'json' });

const config: NextConfig = {
  // standalone copia node_modules com symlinks (EPERM no Windows): so ligado no build do Docker.
  ...(process.env.NEXT_STANDALONE === '1' && { output: 'standalone' as const }),
  distDir: process.env.NEXT_DIST_DIR || '.next', // E2E/builds paralelos sem colidir
  poweredByHeader: false,
  transpilePackages: ['@docmind/shared'],
  experimental: { optimizePackageImports: ['antd', '@ant-design/icons'] },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_URL}/api/v1/:path*` }];
  },
};
export default withAnalyzer(config);
