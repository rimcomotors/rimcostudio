import { describe, expect, it } from 'vitest';
import { areStoryboardClipDurationsValid, getStoryboardClipBudget, getStoryboardModeRoute, getReferenceClipDurations, getSupportedReferenceDurations } from './storyboard-routing';

describe('routage des modes storyboard multi-clips', () => {
  it('associe Standard à Wan 3 image-to-video et les autres modes à leurs adaptateurs', () => {
    expect(getStoryboardModeRoute('standard')).toMatchObject({ adapterFamily: 'wan', endpoint: 'alibaba/wan-3.0/image-to-video', minClipDurationS: 5, maxClipDurationS: 5 });
    expect(getStoryboardModeRoute('pro')).toMatchObject({ adapterFamily: 'kling', endpoint: 'fal-ai/kling-video/o3/pro/reference-to-video' });
    expect(getStoryboardModeRoute('premium')).toMatchObject({ adapterFamily: 'seedance', endpoint: 'bytedance/seedance-2.5/reference-to-video' });
  });

  it('treats the choice as generated footage and adds the logo afterward', () => {
    expect(getStoryboardClipBudget(15)).toBe(15);
    expect(getStoryboardClipBudget(20)).toBe(20);
    expect(areStoryboardClipDurationsValid('standard', 20, [5, 5, 5, 5])).toBe(true);
    expect(areStoryboardClipDurationsValid('standard', 20, [10, 10])).toBe(false);
    expect(areStoryboardClipDurationsValid('pro', 15, [15])).toBe(true);
    expect(areStoryboardClipDurationsValid('pro', 15, [16])).toBe(false);
    expect(areStoryboardClipDurationsValid('premium', 20, [20])).toBe(true);
    expect(areStoryboardClipDurationsValid('premium', 21, [18])).toBe(false);
  });

  it('splits only when required by the selected endpoint and respects its supported durations', () => {
    expect(getReferenceClipDurations('standard', 20, [5])).toEqual([5, 5, 5, 5]);
    expect(getReferenceClipDurations('standard', 15, [5])).toEqual([5, 5, 5]);
    expect(getReferenceClipDurations('standard', 10, [5])).toEqual([5, 5]);
    expect(getReferenceClipDurations('standard', 5, [5])).toEqual([5]);
    expect(getReferenceClipDurations('pro', 20, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).toEqual([10, 10]);
    expect(getReferenceClipDurations('premium', 20, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])).toEqual([20]);
    expect(getReferenceClipDurations('standard', 15, [2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([5, 5, 5]);
  });

  it('offers only total runtimes that can be made from endpoint-supported clip lengths', () => {
    expect(getSupportedReferenceDurations('standard', [5])).toEqual([5, 10, 15, 20]);
    expect(getSupportedReferenceDurations('pro', [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).toEqual([5, 10, 15, 20]);
    expect(getSupportedReferenceDurations('premium', [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])).toEqual([5, 10, 15, 20]);
    expect(getSupportedReferenceDurations('standard', [2, 4])).toEqual([]);
  });
});
