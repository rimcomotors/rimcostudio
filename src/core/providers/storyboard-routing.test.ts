import { describe, expect, it } from 'vitest';
import { areStoryboardClipDurationsValid, getStoryboardClipBudget, getStoryboardModeRoute } from './storyboard-routing';

describe('routage des modes storyboard multi-clips', () => {
  it('associe les modes aux adaptateurs de référence Wan, Kling et Seedance', () => {
    expect(getStoryboardModeRoute('standard')).toMatchObject({ adapterFamily: 'wan', endpoint: 'fal-ai/wan/v2.7/reference-to-video' });
    expect(getStoryboardModeRoute('pro')).toMatchObject({ adapterFamily: 'kling', endpoint: 'fal-ai/kling-video/o3/pro/reference-to-video' });
    expect(getStoryboardModeRoute('premium')).toMatchObject({ adapterFamily: 'seedance', endpoint: 'bytedance/seedance-2.5/reference-to-video' });
  });

  it('treats the choice as generated footage and adds the logo afterward', () => {
    expect(getStoryboardClipBudget(15)).toBe(15);
    expect(getStoryboardClipBudget(20)).toBe(20);
    expect(areStoryboardClipDurationsValid('standard', 20, [10, 10])).toBe(true);
    expect(areStoryboardClipDurationsValid('standard', 20, [10, 9])).toBe(false);
    expect(areStoryboardClipDurationsValid('pro', 15, [15])).toBe(true);
    expect(areStoryboardClipDurationsValid('pro', 15, [16])).toBe(false);
    expect(areStoryboardClipDurationsValid('premium', 20, [20])).toBe(true);
    expect(areStoryboardClipDurationsValid('premium', 21, [18])).toBe(false);
  });
});
