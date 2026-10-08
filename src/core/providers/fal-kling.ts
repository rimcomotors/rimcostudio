import { createFalClient } from '@fal-ai/client';
import { env } from '@/env';
import type { ProviderStatus, VideoProvider } from './contracts';

export const KLING_ENDPOINT = 'fal-ai/kling-video/v2.6/pro/image-to-video';
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

/** Adapter for the documented Kling 2.6 Pro image-to-video endpoint. */
export const klingVideoProvider: VideoProvider = {
  async submit(input) {
    const result = await client().queue.submit(KLING_ENDPOINT, { input: {
      prompt: input.prompt,
      start_image_url: input.imageUrl,
      duration: '5',
      generate_audio: false,
    } });
    return { requestId: result.request_id };
  },
  async status(requestId) {
    const fal = client();
    const result = await fal.queue.status(KLING_ENDPOINT, { requestId, logs: false });
    const status = normalizeStatus(result.status);
    if (status !== 'ready') return { status, ...(status === 'failed' ? { error: 'La génération fal.ai a échoué.' } : {}) };
    const completed = await fal.queue.result(KLING_ENDPOINT, { requestId });
    // @fal-ai/client wraps queue results as { data, requestId }.
    const video = (completed as { data?: { video?: { url?: string } } }).data?.video;
    if (!video?.url) return { status: 'failed', error: 'La réponse fal.ai ne contient pas de vidéo.' };
    return { status: 'ready', videoUrl: video.url };
  },
};
