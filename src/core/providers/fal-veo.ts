import { createFalClient } from '@fal-ai/client';
import { env } from '@/env';
import type { ProviderStatus, VideoProvider } from './contracts';

export const VEO_ENDPOINT = 'fal-ai/veo3.1/fast/image-to-video';
const VEO_SOURCE_DURATION = 6;

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

/** Veo 3.1 Fast generates six seconds; post-production trims the delivered MP4 to five. */
export const veoVideoProvider: VideoProvider = {
  async submit(input) {
    if (input.durationS !== VEO_SOURCE_DURATION) throw new Error('Veo 3.1 Fast nécessite une réservation pour six secondes source.');
    if (input.format !== '16:9' && input.format !== '9:16') throw new Error('Veo 3.1 Fast prend uniquement en charge 16:9 ou 9:16.');
    const result = await client().queue.submit(VEO_ENDPOINT, { input: {
      prompt: input.prompt,
      image_url: input.imageUrl,
      aspect_ratio: input.format,
      duration: '6s',
      resolution: '720p',
      generate_audio: false,
    } });
    return { requestId: result.request_id };
  },
  async status(requestId) {
    const fal = client();
    const result = await fal.queue.status(VEO_ENDPOINT, { requestId, logs: false });
    const status = normalizeStatus(result.status);
    if (status !== 'ready') return { status, ...(status === 'failed' ? { error: 'La génération fal.ai a échoué.' } : {}) };
    const completed = await fal.queue.result(VEO_ENDPOINT, { requestId });
    // @fal-ai/client wraps queue results as { data, requestId }.
    const video = (completed as { data?: { video?: { url?: string } } }).data?.video;
    if (!video?.url) return { status: 'failed', error: 'La réponse fal.ai ne contient pas de vidéo.' };
    return { status: 'ready', videoUrl: video.url };
  },
};
