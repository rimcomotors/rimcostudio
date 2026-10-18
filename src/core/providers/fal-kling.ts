import { createFalClient } from '@fal-ai/client';
import { env } from '@/env';
import type { ProviderStatus, VideoProvider } from './contracts';

export const KLING_ENDPOINT = 'fal-ai/kling-video/o3/pro/image-to-video';
function client(apiKey?: string) {
  const credentials = apiKey ?? env.FAL_KEY;
  if (!credentials) throw new Error('Aucune clé Fal n’est configurée.');
  return createFalClient({ credentials });
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

/** Adapter for the documented Kling O3 Pro image-to-video endpoint. */
export const klingVideoProvider: VideoProvider = {
  async submit(input, apiKey) {
    const result = await client(apiKey).queue.submit(KLING_ENDPOINT, { input: {
      prompt: input.prompt,
      image_url: input.imageUrl,
      duration: String(input.durationS) as `${3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15}`,
      generate_audio: false,
    } });
    return { requestId: result.request_id };
  },
  async status(requestId, apiKey) {
    const fal = client(apiKey);
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
