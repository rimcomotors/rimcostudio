import { createFalClient } from '@fal-ai/client';
import { env } from '@/env';
import type { ProviderStatus, VideoProvider } from './contracts';

export const WAN_ENDPOINT = 'alibaba/wan-3.0/image-to-video';

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

/** Verified Wan 3.0 image-to-video adapter; produces a 5s, silent clip. */
export const wanVideoProvider: VideoProvider = {
  async submit(input, apiKey) {
    const result = await client(apiKey).queue.submit(WAN_ENDPOINT, { input: {
      prompt: input.prompt,
      start_image_url: input.imageUrl,
      duration: 5,
      aspect_ratio: input.format,
      resolution: '720p',
      audio: false,
      enable_prompt_expansion: false,
      enable_safety_checker: true,
    } });
    return { requestId: result.request_id };
  },
  async status(requestId, apiKey) {
    const fal = client(apiKey);
    const result = await fal.queue.status(WAN_ENDPOINT, { requestId, logs: false });
    const status = normalizeStatus(result.status);
    if (status !== 'ready') return { status, ...(status === 'failed' ? { error: 'La génération fal.ai a échoué.' } : {}) };
    const completed = await fal.queue.result(WAN_ENDPOINT, { requestId });
    // @fal-ai/client wraps queue results as { data, requestId }.
    const video = (completed as { data?: { video?: { url?: string } } }).data?.video;
    if (!video?.url) return { status: 'failed', error: 'La réponse fal.ai ne contient pas de vidéo.' };
    return { status: 'ready', videoUrl: video.url };
  },
};
