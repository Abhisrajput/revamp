import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `standalone` emits a self-contained server into `.next/standalone/` so
  // the production Docker image doesn't need to carry node_modules. Used by
  // infra/docker/Dockerfile.web.
  output: 'standalone',
  // Next 15+ needs to know the repo root so standalone traces workspace deps
  // correctly; without it, the build misses files from packages/*.
  outputFileTracingRoot: require('path').join(__dirname, '../..'),
  transpilePackages: ['@revamp/shared', '@revamp/core', '@revamp/views'],
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
};

export default nextConfig;
