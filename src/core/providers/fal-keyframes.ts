import { createFalClient } from '@fal-ai/client';
import { z } from 'zod';
import { env } from '@/env';
import type { StoryboardShot, StoryMode } from '@/core/storyboard';
import type { ReferenceVideoProvider } from './fal-reference-video';
import { MODEL_ENDPOINTS } from './model-routing';

export const KEYFRAME_IMAGE_ENDPOINT = 'fal-ai/nano-banana-2/edit';
export const KEYFRAME_VISION_ENDPOINT = 'openrouter/router/vision';
export const KEYFRAME_IMAGE_COST_USD = 0.08;
export const KEYFRAME_QUALITY_RESERVE_USD = 0.05;
export const KEYFRAME_VIDEO_ENDPOINTS = {
  wan: MODEL_ENDPOINTS.wan,
  kling: MODEL_ENDPOINTS.kling,
  seedance: MODEL_ENDPOINTS.seedance,
} as const;
export const KEYFRAME_VIDEO_PRICES_USD_PER_SECOND = { wan720p: 0.10, kling: 0.112, seedance: 0.473 } as const;
export type KeyframeQuality = { approved: boolean; issues: string[]; reason: string };

const qualitySchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string().trim().min(1).max(160)).max(5),
  reason: z.string().trim().min(1).max(240),
}).strict();

export function shouldGenerateKeyframes(mode: StoryMode) {
  return mode === 'standard' || mode === 'pro' || mode === 'premium';
}

export function keyframeQualityAction(approved: boolean, retryCount: number): 'accept' | 'retry' | 'reject' {
  if (approved) return 'accept';
  return retryCount < 1 ? 'retry' : 'reject';
}

export function canAnimateKeyframes(statuses: string[]) {
  return statuses.length > 0 && statuses.every((status) => status === 'ready');
}

export function buildKeyframePrompt(input: {
  shot: StoryboardShot;
  vehicle: string;
  lighting: string;
  format: string;
  retryReason: string | null;
}) {
  const retry = input.retryReason ? ` Correct these specific issues from the failed quality check: ${input.retryReason}.` : '';
  return `Create one photorealistic, premium automotive advertising still photograph for a real commercial. Vehicle identity: ${input.vehicle}. The first supplied reference is the exact approved vehicle; preserve its make, model, silhouette, paint color, wheels, visible badges, proportions and equipment. The second supplied reference, when present, is the exact selected location; preserve its recognizable architecture, road layout and landmarks. Scene: ${input.shot.scene}. Location: ${input.shot.location}. Action at this precise instant: ${input.shot.action}. Framing: ${input.shot.framing}. Camera viewpoint: ${input.shot.camera}. Lighting: ${input.lighting}. Compose for ${input.format}. Keep the car naturally grounded in the scene with matching light direction, exposure, reflections, scale, contact shadow and road perspective. Show a plausible instant of real action, with restrained natural motion cues only where appropriate. Match a sophisticated live-action car commercial, elegant composition, realistic materials and subtle color grade. Use only the supplied vehicle and place references; do not invent vehicle details, landmarks, people or signs. No illustration, CGI appearance, extra vehicle, added logo, readable plate, watermark, caption or title; do not add text.${retry}`;
}

export function buildKeyframeAnimationPrompt(input: { shot: StoryboardShot; vehicle: string; durationS: number; mood: string; lighting: string }) {
  return `Animate the supplied approved image as the exact first frame of a ${input.durationS}-second premium live-action automotive commercial. Vehicle identity: ${input.vehicle}; preserve exactly the visible silhouette, paint color, wheels, proportions, badges, equipment and materials in the first frame. Preserve the same location, architecture, road, time of day, lighting direction, exposure, composition and color palette. Scene: ${input.shot.scene}. Location: ${input.shot.location}. Framing: ${input.shot.framing}. Action: ${input.shot.action}. Camera move: ${input.shot.camera}. Mood: ${input.mood}. Light: ${input.lighting}. Make only the smallest physically credible motion needed for this shot: grounded tire contact and rotation, believable suspension, natural reflections and restrained camera movement. Keep the vehicle in the same place and scale unless the requested action requires travel. One continuous shot; no cuts, transitions, added people, objects, logos or text. Avoid morphing, flicker, sliding tires, warped wheels, changing vehicle details, synthetic CGI appearance and impossible reflections.`;
}

export function parseKeyframeQuality(text: string): KeyframeQuality | null {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const candidates = [normalized, ...jsonObjectCandidates(normalized)];
  for (const candidate of candidates) {
    try {
      const result = qualitySchema.safeParse(JSON.parse(candidate) as unknown);
      if (result.success) return result.data;
    } catch { /* Continue past prose or non-JSON objects in model reasoning. */ }
  }
  return null;
}

function jsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function fal(apiKey: string) {
  if (!apiKey) throw new Error('Aucune clé fal active n’est configurée.');
  return createFalClient({ credentials: apiKey });
}

export async function submitKeyframe(input: { prompt: string; imageUrls: string[]; aspectRatio: string }, apiKey: string) {
  if (!input.imageUrls.length || input.imageUrls.length > 14) throw new Error('La création d’une image-clé exige entre 1 et 14 références.');
  const result = await fal(apiKey).queue.submit(KEYFRAME_IMAGE_ENDPOINT, { input: {
    prompt: input.prompt, image_urls: input.imageUrls, aspect_ratio: input.aspectRatio as '16:9' | '9:16' | '1:1' | '4:5',
    output_format: 'png', resolution: '1K', num_images: 1, limit_generations: true,
  } });
  return { requestId: result.request_id };
}

export async function readKeyframe(requestId: string, apiKey: string) {
  const client = fal(apiKey);
  const status = await client.queue.status(KEYFRAME_IMAGE_ENDPOINT, { requestId, logs: false });
  const statusValue = String(status.status);
  if (statusValue === 'FAILED') return { status: 'failed' as const };
  if (statusValue !== 'COMPLETED') return { status: 'generating' as const };
  const result = await client.queue.result(KEYFRAME_IMAGE_ENDPOINT, { requestId });
  const images = (result as { data?: { images?: Array<{ url?: string; content_type?: string }> } }).data?.images;
  const image = images?.[0];
  if (!image?.url || image.content_type && !['image/png', 'image/jpeg', 'image/webp'].includes(image.content_type)) return { status: 'failed' as const };
  return { status: 'ready' as const, imageUrl: image.url, contentType: image.content_type ?? 'image/png' };
}

export async function submitKeyframeQuality(input: { prompt: string; imageUrls: string[] }, apiKey: string) {
  if (!env.LLM_MODEL) throw new Error('Le modèle de vision n’est pas configuré.');
  const result = await fal(apiKey).queue.submit(KEYFRAME_VISION_ENDPOINT, { input: {
    prompt: input.prompt, system_prompt: 'Tu contrôles les images-clés de publicités automobiles. Réponds uniquement en JSON strict avec approved (booléen), issues (tableau de problèmes visibles) et reason (phrase courte). Sois strict sur le véhicule, sa couleur, le lieu et le texte ajouté. Ne prétends pas identifier des détails invisibles.',
    model: env.LLM_MODEL, image_urls: input.imageUrls, reasoning: true, temperature: 0.1, max_tokens: 300,
  } });
  return { requestId: result.request_id };
}

export async function readKeyframeQuality(requestId: string, apiKey: string) {
  const client = fal(apiKey);
  const status = await client.queue.status(KEYFRAME_VISION_ENDPOINT, { requestId, logs: true });
  const statusValue = String(status.status);
  if (statusValue === 'FAILED') {
    const logs = (status as { logs?: Array<{ message?: unknown }> }).logs;
    const error = logs?.map((entry) => typeof entry.message === 'string' ? entry.message.trim() : '')
      .filter(Boolean).join(' ').slice(0, 500) || 'Le fournisseur de contrôle visuel a échoué sans détail.';
    return { status: 'failed' as const, costUsd: null, quality: null, error };
  }
  if (statusValue !== 'COMPLETED') return { status: 'checking' as const, costUsd: null, quality: null };
  const result = await client.queue.result(KEYFRAME_VISION_ENDPOINT, { requestId });
  const data = (result as { data?: { output?: unknown; usage?: { cost?: unknown } } }).data;
  const output = typeof data?.output === 'string' ? data.output : '';
  const usageCost = data?.usage?.cost;
  const costUsd = typeof usageCost === 'number' && Number.isFinite(usageCost) && usageCost >= 0 ? usageCost : null;
  const quality = parseKeyframeQuality(output);
  return quality
    ? { status: 'ready' as const, costUsd, quality }
    : { status: 'failed' as const, costUsd, quality: null, error: 'La réponse du modèle de contrôle ne contient pas le JSON attendu.' };
}

function createKeyframeVideoProvider(family: 'wan' | 'kling' | 'seedance'): ReferenceVideoProvider {
  const endpoint = KEYFRAME_VIDEO_ENDPOINTS[family];
  return {
    endpoint,
    maxReferenceImages: 1,
    minDurationS: family === 'wan' ? 5 : family === 'kling' ? 3 : 4,
    maxDurationS: family === 'wan' ? 5 : family === 'kling' ? 15 : 30,
    async submit(input, apiKey) {
      const imageUrl = input.referenceImageUrls[0];
      if (!imageUrl) throw new Error('L’image-clé de départ est introuvable.');
      if (family === 'wan' && input.durationS !== 5) throw new Error('Wan 3.0 exige des segments de 5 secondes.');
      if (family === 'wan' && !['16:9', '9:16', '1:1'].includes(input.aspectRatio)) throw new Error('Format vidéo non pris en charge par Wan 3.0.');
      const modelInput = family === 'wan'
        ? { prompt: input.prompt, start_image_url: imageUrl, duration: 5, aspect_ratio: input.aspectRatio, resolution: '720p', audio: false, enable_prompt_expansion: false, enable_safety_checker: true }
        : family === 'kling'
          ? { prompt: input.prompt, start_image_url: imageUrl, duration: String(input.durationS), generate_audio: false, enable_safety_checker: true }
          : { prompt: input.prompt, image_url: imageUrl, duration: String(input.durationS), resolution: '720p', aspect_ratio: 'auto', generate_audio: false };
      const result = await fal(apiKey ?? '').queue.submit(endpoint, { input: modelInput });
      return { requestId: result.request_id };
    },
    async status(requestId, apiKey) {
      const client = fal(apiKey ?? '');
      const state = await client.queue.status(endpoint, { requestId, logs: false });
      const statusValue = String(state.status);
      if (statusValue === 'FAILED') return { status: 'failed', error: 'La génération vidéo à partir de l’image-clé a échoué.' };
      if (statusValue !== 'COMPLETED') return { status: statusValue === 'IN_QUEUE' ? 'queued' : 'generating' };
      const result = await client.queue.result(endpoint, { requestId });
      const videoUrl = (result as { data?: { video?: { url?: string } } }).data?.video?.url;
      return videoUrl ? { status: 'ready', videoUrl } : { status: 'failed', error: 'La réponse ne contient pas de vidéo.' };
    },
  };
}

export const keyframeVideoProviders = {
  wan: createKeyframeVideoProvider('wan'),
  kling: createKeyframeVideoProvider('kling'),
  seedance: createKeyframeVideoProvider('seedance'),
} satisfies Record<'wan' | 'kling' | 'seedance', ReferenceVideoProvider>;
