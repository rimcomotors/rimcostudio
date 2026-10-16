import { REFERENCE_MODEL_ENDPOINTS } from './model-routing';

/** New multi-clip storyboard modes; intentionally separate from legacy tiers. */
export type StoryboardMode = 'standard' | 'pro' | 'premium';
export type StoryboardClipDuration = 5 | 10 | 15 | 20;

export const STORYBOARD_MODE_ROUTES = {
  standard: { label: 'Standard', adapterFamily: 'wan', endpoint: REFERENCE_MODEL_ENDPOINTS.standard, minClipDurationS: 2, maxClipDurationS: 10, maxReferenceImages: 20 },
  pro: { label: 'Pro', adapterFamily: 'kling', endpoint: REFERENCE_MODEL_ENDPOINTS.pro, minClipDurationS: 3, maxClipDurationS: 15, maxReferenceImages: 4 },
  premium: { label: 'Premium', adapterFamily: 'seedance', endpoint: REFERENCE_MODEL_ENDPOINTS.premium, minClipDurationS: 4, maxClipDurationS: 30, maxReferenceImages: 30 },
} as const;

export function getStoryboardModeRoute(mode: StoryboardMode) {
  return STORYBOARD_MODE_ROUTES[mode];
}

/** Multi-clip choices describe generated footage; the end card adds two seconds. */
export function getStoryboardClipBudget(clipDurationS: number): number | null {
  if (clipDurationS !== 5 && clipDurationS !== 10 && clipDurationS !== 15 && clipDurationS !== 20) return null;
  return clipDurationS;
}

/** Returns provider-safe segment lengths for a selected total footage duration. */
export function getReferenceClipDurations(mode: StoryboardMode, totalDurationS: number, allowedDurations?: number[] | null): number[] {
  const route = getStoryboardModeRoute(mode);
  const allowed = allowedDurations ? new Set(allowedDurations) : null;
  if (getStoryboardClipBudget(totalDurationS) === null) return [];
  const minCount = Math.ceil(totalDurationS / route.maxClipDurationS);
  const maxCount = Math.floor(totalDurationS / route.minClipDurationS);
  for (let count = minCount; count <= maxCount; count += 1) {
    const base = Math.floor(totalDurationS / count);
    const remainder = totalDurationS % count;
    const segments = Array.from({ length: count }, (_, index) => base + Number(index < remainder));
    if (segments.every((seconds) => seconds >= route.minClipDurationS && seconds <= route.maxClipDurationS && (!allowed || allowed.has(seconds)))) return segments;
  }
  return [];
}

/** UI durations are total footage; endpoints may receive several shorter clips. */
export function getSupportedReferenceDurations(mode: StoryboardMode, allowedDurations: number[] | null | undefined): number[] {
  if (!allowedDurations?.length) return [];
  return ([5, 10, 15, 20] as const).filter((total) => getReferenceClipDurations(mode, total, allowedDurations).length > 0);
}

export function areStoryboardClipDurationsValid(mode: StoryboardMode, clipDurationS: number, clipDurationsS: number[]): boolean {
  const route = getStoryboardModeRoute(mode);
  const clipBudget = getStoryboardClipBudget(clipDurationS);
  if (clipBudget === null || clipDurationsS.length === 0) return false;
  return clipDurationsS.every((duration) => Number.isInteger(duration) && duration >= route.minClipDurationS && duration <= route.maxClipDurationS)
    && clipDurationsS.reduce((total, duration) => total + duration, 0) === clipBudget;
}
