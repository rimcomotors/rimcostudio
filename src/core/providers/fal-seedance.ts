import { createFalClient } from '@fal-ai/client';
import { env } from '@/env';
import type { ProviderStatus, VideoProvider } from './contracts';

export const SEEDANCE_ENDPOINT = 'bytedance/seedance-2.5/image-to-video';

function client() {
  if (!env.FAL_KEY) throw new Error('FAL_KEY manque : configurez la clé fal.ai dans Vercel.');
  return createFalClient({ credentials: env.FAL_KEY });
}

function normalizeStatus(status: string): ProviderStatus {
  switch (status.toUpperCase()) {
    case 'IN_QUEUE': case 'QUEUED': return 'queued';
    case 'IN_PROGRESS': case 'PROCESSING': return 'generating';
    case 'COMPLETED': case 'SUCCEEDED': return 'ready';
    case 'FAILED': case 'CANCELLED': return 'failed';
    default: return 'generating';
  }
}

/** Adapter for Seedance 2.5 image-to-video (5s, 720p, generated audio disabled). */
export const seedanceVideoProvider: VideoProvider = {
  async submit(input) {
    if (!input.endUserId) throw new Error('Seedance 2.5 nécessite l’identifiant de l’utilisateur final.');
    const result = await client().queue.submit(SEEDANCE_ENDPOINT, { input: {
      prompt: input.prompt,
      image_url: input.imageUrl,
      duration: '5',
      resolution: '720p',
      aspect_ratio: input.format,
      generate_audio: false,
      end_user_id: input.endUserId,
    } });
    return { requestId: result.request_id };
  },
  async status(requestId) {
    const fal = client();
    const result = await fal.queue.status(SEEDANCE_ENDPOINT, { requestId, logs: false });
    const status = normalizeStatus(result.status);
    if (status !== 'ready') return { status, ...(status === 'failed' ? { error: 'La génération fal.ai a échoué.' } : {}) };
    const completed = await fal.queue.result(SEEDANCE_ENDPOINT, { requestId });
    const video = (completed as { data?: { video?: { url?: string } } }).data?.video;
    if (!video?.url) return { status: 'failed', error: 'La réponse fal.ai ne contient pas de vidéo.' };
    return { status: 'ready', videoUrl: video.url };
  },
};
