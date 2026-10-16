export type GenerationTier = 'standard' | 'pro' | 'premium';
export type AdapterFamily = 'wan' | 'kling' | 'veo' | 'seedance';

export const MODEL_ENDPOINTS = {
  wan: 'alibaba/wan-3.0/image-to-video',
  kling: 'fal-ai/kling-video/o3/pro/image-to-video',
  veo: 'fal-ai/veo3.1/fast/image-to-video',
  seedance: 'bytedance/seedance-2.5/image-to-video',
} as const;

export const REFERENCE_MODEL_ENDPOINTS = {
  standard: 'fal-ai/wan/v2.7/reference-to-video',
  pro: 'fal-ai/kling-video/o3/pro/reference-to-video',
  premium: 'bytedance/seedance-2.5/reference-to-video',
} as const;

/** Matrice métier verrouillée : l’interface et l’API doivent suivre cette table. */
export const LOCKED_MODEL_POLICY = [
  { tier: 'standard', duration: 5, model: 'Wan 3.0' },
  { tier: 'pro', duration: 5, model: 'Kling O3 Pro' },
  { tier: 'pro', duration: 10, model: 'Kling O3 Pro' },
  { tier: 'pro', duration: 15, model: 'Kling O3 Pro' },
  { tier: 'premium', duration: 5, model: 'Veo 3.1 Fast' },
  { tier: 'premium', duration: 10, model: 'Seedance 2.5' },
  { tier: 'premium', duration: 15, model: 'Seedance 2.5' },
  { tier: 'premium', duration: 20, model: 'Seedance 2.5' },
  { tier: 'premium', duration: 30, model: 'Seedance 2.5' },
] as const;

type Route = {
  tier: GenerationTier;
  adapterFamily: AdapterFamily;
  endpoint: string;
  outputDuration: number;
  sourceDuration: number;
};

const ROUTES: Record<GenerationTier, Record<number, Route>> = {
  standard: {
    5: { tier: 'standard', adapterFamily: 'wan', endpoint: MODEL_ENDPOINTS.wan, outputDuration: 5, sourceDuration: 5 },
  },
  pro: {
    5: { tier: 'pro', adapterFamily: 'kling', endpoint: MODEL_ENDPOINTS.kling, outputDuration: 5, sourceDuration: 5 },
    10: { tier: 'pro', adapterFamily: 'kling', endpoint: MODEL_ENDPOINTS.kling, outputDuration: 10, sourceDuration: 10 },
    15: { tier: 'pro', adapterFamily: 'kling', endpoint: MODEL_ENDPOINTS.kling, outputDuration: 15, sourceDuration: 15 },
  },
  premium: {
    5: { tier: 'premium', adapterFamily: 'veo', endpoint: MODEL_ENDPOINTS.veo, outputDuration: 5, sourceDuration: 6 },
    10: { tier: 'premium', adapterFamily: 'seedance', endpoint: MODEL_ENDPOINTS.seedance, outputDuration: 10, sourceDuration: 10 },
    15: { tier: 'premium', adapterFamily: 'seedance', endpoint: MODEL_ENDPOINTS.seedance, outputDuration: 15, sourceDuration: 15 },
    20: { tier: 'premium', adapterFamily: 'seedance', endpoint: MODEL_ENDPOINTS.seedance, outputDuration: 20, sourceDuration: 20 },
    30: { tier: 'premium', adapterFamily: 'seedance', endpoint: MODEL_ENDPOINTS.seedance, outputDuration: 30, sourceDuration: 30 },
  },
};

export function getRouteForGeneration(tier: GenerationTier, duration: number): Route | null {
  return ROUTES[tier][duration] ?? null;
}

export function getRoutedDurations(tier: GenerationTier): number[] {
  return Object.keys(ROUTES[tier]).map(Number);
}

export function isModelOnRoute(
  model: { tier: string; adapterFamily: string; endpoint: string; allowedDurations: number[] },
  tier: GenerationTier,
  duration: number,
): boolean {
  const route = getRouteForGeneration(tier, duration);
  const durationSupported = Boolean(route && (model.allowedDurations.includes(duration) || route.adapterFamily === 'veo' && model.allowedDurations.includes(route.sourceDuration)));
  return Boolean(route && model.tier === tier && model.adapterFamily === route.adapterFamily && model.endpoint === route.endpoint && durationSupported);
}
