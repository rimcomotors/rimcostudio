import 'server-only';
import { env } from '@/env';
import { createStorageAdminClient } from './supabase';
import { r2VideoClient } from './r2-video-client';
import { createVideoObjectGateway } from './video-objects';

type AdminClient = ReturnType<typeof createStorageAdminClient>;

export function serverVideoObjects(admin: AdminClient) {
  const bucket = admin.storage.from('videos');
  return createVideoObjectGateway({
    provider: env.VIDEO_STORAGE_PROVIDER,
    bucket: env.R2_BUCKET ?? '',
    supabase: {
      upload: (path, body, options) => bucket.upload(path, body, options),
      createSignedUrl: (path, expiresIn, options) => bucket.createSignedUrl(path, expiresIn, options),
      download: (path) => bucket.download(path),
      remove: (paths) => bucket.remove(paths),
    },
    r2: env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET ? r2VideoClient : undefined,
  });
}
