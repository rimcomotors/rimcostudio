import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    '/api/versions/\\[id\\]/refresh': ['./.generated/ffmpeg'],
    '/api/cron/reconcile': ['./.generated/ffmpeg'],
  },
};
export default nextConfig;
