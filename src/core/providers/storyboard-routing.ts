import { REFERENCE_MODEL_ENDPOINTS } from './model-routing';

/** New multi-clip storyboard modes; intentionally separate from legacy tiers. */
export type StoryboardMode = 'standard' | 'pro' | 'premium';
export type StoryboardFinalDuration = 15 | 20;

export const STORYBOARD_MODE_ROUTES = {
  standard: { label: 'Standard', adapterFamily: 'wan', endpoint: REFERENCE_MODEL_ENDPOINTS.standard, minClipDurationS: 2, maxClipDurationS: 10, maxReferenceImages: 20 },
  pro: { label: 'Pro', adapterFamily: 'kling', endpoint: REFERENCE_MODEL_ENDPOINTS.pro, minClipDurationS: 3, maxClipDurationS: 15, maxReferenceImages: 4 },
  premium: { label: 'Premium', adapterFamily: 'seedance', endpoint: REFERENCE_MODEL_ENDPOINTS.premium, minClipDurationS: 4, maxClipDurationS: 30, maxReferenceImages: 30 },
} as const;

export function getStoryboardModeRoute(mode: StoryboardMode) {
  return STORYBOARD_MODE_ROUTES[mode];
}

/** Reserves two seconds for the RIMCO end card within the final duration. */
export function getStoryboardClipBudget(finalDurationS: number): number | null {
  if (finalDurationS !== 15 && finalDurationS !== 20) return null;
  return finalDurationS - 2;
}

export function areStoryboardClipDurationsValid(mode: StoryboardMode, finalDurationS: number, clipDurationsS: number[]): boolean {
  const route = getStoryboardModeRoute(mode);
  const clipBudget = getStoryboardClipBudget(finalDurationS);
  if (clipBudget === null || clipDurationsS.length === 0) return false;
  return clipDurationsS.every((duration) => Number.isInteger(duration) && duration >= route.minClipDurationS && duration <= route.maxClipDurationS)
    && clipDurationsS.reduce((total, duration) => total + duration, 0) <= clipBudget;
}
