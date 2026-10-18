import { createFalClient } from '@fal-ai/client';
import { env } from '@/env';
import type { ProviderStatus, VideoProvider } from './contracts';

export const SEEDANCE_ENDPOINT = 'bytedance/seedance-2.5/image-to-video';

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

/** Adapter for Seedance 2.5 image-to-video (5-30s, 720p, generated audio disabled). */
export const seedanceVideoProvider: VideoProvider = {
  async submit(input, apiKey) {
    if (!input.endUserId) throw new Error('Seedance 2.5 nécessite l’identifiant de l’utilisateur final.');
    if (![5, 10, 15, 20, 30].includes(input.durationS)) throw new Error('Seedance 2.5 accepte les durées 5, 10, 15, 20 et 30 secondes dans RIMCO Studio.');
    const result = await client(apiKey).queue.submit(SEEDANCE_ENDPOINT, { input: {
      prompt: input.prompt,
      image_url: input.imageUrl,
      duration: String(input.durationS),
      resolution: '720p',
      aspect_ratio: input.format,
      generate_audio: false,
      end_user_id: input.endUserId,
    } });
    return { requestId: result.request_id };
  },
  async status(requestId, apiKey) {
    const fal = client(apiKey);
    const result = await fal.queue.status(SEEDANCE_ENDPOINT, { requestId, logs: false });
    const status = normalizeStatus(result.status);
    if (status !== 'ready') return { status, ...(status === 'failed' ? { error: 'La génération fal.ai a échoué.' } : {}) };
    const completed = await fal.queue.result(SEEDANCE_ENDPOINT, { requestId });
    const video = (completed as { data?: { video?: { url?: string } } }).data?.video;
    if (!video?.url) return { status: 'failed', error: 'La réponse fal.ai ne contient pas de vidéo.' };
    return { status: 'ready', videoUrl: video.url };
  },
};
