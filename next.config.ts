import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  // Keep the native executable outside Next's server chunk so __dirname resolves
  // to the deployed node_modules package instead of a non-existent chunk copy.
  serverExternalPackages: ['ffmpeg-static'],
  outputFileTracingIncludes: {
    '/api/versions/\\[id\\]/refresh': ['./node_modules/ffmpeg-static/**/*', './node_modules/ffmpeg-static/ffmpeg'],
    '/api/cron/reconcile': ['./node_modules/ffmpeg-static/**/*', './node_modules/ffmpeg-static/ffmpeg'],
  },
};
export default nextConfig;
