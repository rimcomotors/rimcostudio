import { createFalClient } from '@fal-ai/client';
import { env } from '@/env';
import type { ProviderStatus } from './contracts';

/** fal Reference-to-Video endpoints, verified against their published schemas. */
export const WAN_REFERENCE_ENDPOINT = 'fal-ai/wan/v2.7/reference-to-video';
export const KLING_REFERENCE_ENDPOINT = 'fal-ai/kling-video/o3/pro/reference-to-video';
export const SEEDANCE_REFERENCE_ENDPOINT = 'bytedance/seedance-2.5/reference-to-video';

export type ReferenceVideoInput = {
  prompt: string;
  referenceImageUrls: string[];
  durationS: number;
  aspectRatio: string;
  endUserId?: string;
};

export type ReferenceVideoProvider = {
  endpoint: string;
  maxReferenceImages: number;
  minDurationS: number;
  maxDurationS: number;
  submit(input: ReferenceVideoInput): Promise<{ requestId: string }>;
  status(requestId: string): Promise<{ status: ProviderStatus; videoUrl?: string; error?: string }>;
};

/** Keep actionable provider errors while removing URLs and credential-like values. */
export function safeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const safe = raw
    .replace(/https?:\/\/\S+/gi, '[URL masquée]')
    .replace(/\b(key|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[masqué]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return safe || 'Erreur fournisseur sans détail exploitable.';
}

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

function validateReferences(input: ReferenceVideoInput, provider: ReferenceVideoProvider) {
  if (!Number.isInteger(input.durationS) || input.durationS < provider.minDurationS || input.durationS > provider.maxDurationS) {
    throw new Error(`La durée doit être comprise entre ${provider.minDurationS} et ${provider.maxDurationS} secondes pour ce modèle.`);
  }
  if (input.referenceImageUrls.length < 1 || input.referenceImageUrls.length > provider.maxReferenceImages) {
    throw new Error(`Ce modèle accepte de 1 à ${provider.maxReferenceImages} images de référence.`);
  }
}

function promptWithImageReferences(prompt: string, count: number, marker: '@' | '[' = '@') {
  const references = Array.from({ length: count }, (_, index) => marker === '@' ? `@Image${index + 1}` : `[Image${index + 1}]`).join(', ');
  return `${prompt}\n\nUse these supplied visual references faithfully: ${references}.`;
}

function createStatusReader(endpoint: string): ReferenceVideoProvider['status'] {
  return async (requestId) => {
    const fal = client();
    const result = await fal.queue.status(endpoint, { requestId, logs: false });
    const status = normalizeStatus(result.status);
    if (status !== 'ready') return { status, ...(status === 'failed' ? { error: 'La génération fal.ai a échoué.' } : {}) };
    const completed = await fal.queue.result(endpoint, { requestId });
    const video = (completed as { data?: { video?: { url?: string } } }).data?.video;
    if (!video?.url) return { status: 'failed', error: 'La réponse fal.ai ne contient pas de vidéo.' };
    return { status: 'ready', videoUrl: video.url };
  };
}

/** Wan 2.7 Reference-to-Video: 1–20 images and 2–10 second clips. */
export const wanReferenceVideoProvider: ReferenceVideoProvider = {
  endpoint: WAN_REFERENCE_ENDPOINT,
  maxReferenceImages: 20,
  minDurationS: 2,
  maxDurationS: 10,
  async submit(input) {
    validateReferences(input, this);
    if (!['16:9', '9:16', '1:1', '4:3', '3:4'].includes(input.aspectRatio)) throw new Error('Format non pris en charge par Wan 2.7.');
    const result = await client().queue.submit(WAN_REFERENCE_ENDPOINT, { input: {
      prompt: promptWithImageReferences(input.prompt, input.referenceImageUrls.length),
      reference_image_urls: input.referenceImageUrls,
      // The official API example sends a JSON number; the generated SDK schema currently types it as a string enum.
      duration: input.durationS as unknown as '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10',
      aspect_ratio: input.aspectRatio as '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
      resolution: '1080p',
      multi_shots: false,
      enable_safety_checker: true,
    } });
    return { requestId: result.request_id };
  },
  status: createStatusReader(WAN_REFERENCE_ENDPOINT),
};

/** Kling O3 Pro Reference-to-Video: up to four combined elements/references. */
export const klingReferenceVideoProvider: ReferenceVideoProvider = {
  endpoint: KLING_REFERENCE_ENDPOINT,
  maxReferenceImages: 4,
  minDurationS: 3,
  maxDurationS: 15,
  async submit(input) {
    validateReferences(input, this);
    if (!['16:9', '9:16', '1:1'].includes(input.aspectRatio)) throw new Error('Format non pris en charge par Kling O3.');
    const result = await client().queue.submit(KLING_REFERENCE_ENDPOINT, { input: {
      prompt: promptWithImageReferences(input.prompt, input.referenceImageUrls.length),
      image_urls: input.referenceImageUrls,
      duration: String(input.durationS) as '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | '11' | '12' | '13' | '14' | '15',
      aspect_ratio: input.aspectRatio as '16:9' | '9:16' | '1:1',
      generate_audio: false,
    } });
    return { requestId: result.request_id };
  },
  status: createStatusReader(KLING_REFERENCE_ENDPOINT),
};

/** Seedance 2.5 Reference-to-Video: up to 30 images and 4–30 second clips. */
export const seedanceReferenceVideoProvider: ReferenceVideoProvider = {
  endpoint: SEEDANCE_REFERENCE_ENDPOINT,
  maxReferenceImages: 30,
  minDurationS: 4,
  maxDurationS: 30,
  async submit(input) {
    validateReferences(input, this);
    if (!input.endUserId) throw new Error('Seedance 2.5 nécessite l’identifiant de l’utilisateur final.');
    if (!['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(input.aspectRatio)) throw new Error('Format non pris en charge par Seedance 2.5.');
    const result = await client().queue.submit(SEEDANCE_REFERENCE_ENDPOINT, { input: {
      prompt: promptWithImageReferences(input.prompt, input.referenceImageUrls.length),
      image_urls: input.referenceImageUrls,
      duration: String(input.durationS),
      aspect_ratio: input.aspectRatio,
      resolution: '720p',
      generate_audio: false,
      end_user_id: input.endUserId,
    } });
    return { requestId: result.request_id };
  },
  status: createStatusReader(SEEDANCE_REFERENCE_ENDPOINT),
};
