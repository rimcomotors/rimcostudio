import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    '/api/versions/\\[id\\]/refresh': ['./.generated/ffmpeg', './public/brand/logo-rimco.png'],
    '/api/cron/reconcile': ['./.generated/ffmpeg', './public/brand/logo-rimco.png'],
    '/api/admin/asset-kit': ['./public/vehicle-kit'],
  },
};
export default nextConfig;
