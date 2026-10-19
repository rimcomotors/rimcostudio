import { describe, expect, it } from 'vitest';
import { getRouteForGeneration, getRoutedDurations, isModelOnRoute } from './model-routing';

describe('règles de routage vidéo', () => {
  it('route Standard selon la durée', () => {
    expect(getRouteForGeneration('standard', 5)).toMatchObject({ adapterFamily: 'wan', endpoint: 'alibaba/wan-3.0/image-to-video' });
    expect(getRouteForGeneration('standard', 10)).toBeNull();
    expect(getRouteForGeneration('standard', 15)).toBeNull();
  });

  it('route Pro vers Kling aux durées documentées', () => {
    expect(getRouteForGeneration('pro', 5)).toMatchObject({ adapterFamily: 'kling', endpoint: 'fal-ai/kling-video/o3/pro/image-to-video' });
    expect(getRouteForGeneration('pro', 10)).toMatchObject({ adapterFamily: 'kling', endpoint: 'fal-ai/kling-video/o3/pro/image-to-video' });
    expect(getRouteForGeneration('pro', 15)).toMatchObject({ adapterFamily: 'kling', endpoint: 'fal-ai/kling-video/o3/pro/image-to-video' });
    expect(getRouteForGeneration('pro', 20)).toBeNull();
  });

  it('réserve Premium à Seedance en 20 secondes', () => {
    expect(getRouteForGeneration('premium', 20)).toMatchObject({ adapterFamily: 'seedance', endpoint: 'bytedance/seedance-2.5/image-to-video', sourceDuration: 20 });
    expect(getRouteForGeneration('premium', 5)).toBeNull();
    expect(getRouteForGeneration('premium', 10)).toBeNull();
    expect(getRouteForGeneration('premium', 30)).toBeNull();
  });

  it('expose uniquement les durées prévues pour chaque niveau', () => {
    expect(getRoutedDurations('standard')).toEqual([5]);
    expect(getRoutedDurations('pro')).toEqual([5, 10, 15]);
    expect(getRoutedDurations('premium')).toEqual([20]);
  });

  it('rejette un modèle hors route même si son endpoint est actif', () => {
    expect(isModelOnRoute({ tier: 'pro', adapterFamily: 'kling', endpoint: 'fal-ai/kling-video/o3/pro/image-to-video', allowedDurations: [5, 10, 15] }, 'pro', 5)).toBe(true);
    expect(isModelOnRoute({ tier: 'standard', adapterFamily: 'kling', endpoint: 'fal-ai/kling-video/o3/pro/image-to-video', allowedDurations: [5, 10, 15] }, 'standard', 5)).toBe(false);
    expect(isModelOnRoute({ tier: 'premium', adapterFamily: 'seedance', endpoint: 'bytedance/seedance-2.5/image-to-video', allowedDurations: [5, 10, 15, 20, 30] }, 'premium', 20)).toBe(true);
  });
});
