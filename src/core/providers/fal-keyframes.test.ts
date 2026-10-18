import { describe, expect, it } from 'vitest';
import { buildKeyframeAnimationPrompt, buildKeyframePrompt, canAnimateKeyframes, keyframeQualityAction, parseKeyframeQuality, shouldGenerateKeyframes } from './fal-keyframes';

describe('fal keyframe helpers', () => {
  it('creates a still-image direction from the approved shot without asking for motion', () => {
    const prompt = buildKeyframePrompt({
      shot: { title: 'Départ en famille', scene: 'Boulevard lagunaire', framing: 'Plan large', location: 'Abidjan', action: 'La famille prend place', camera: 'Contre-plongée discrète', durationSeconds: 5, vehiclePhotoId: 'vehicle-1', locationPhotoId: 'place-1' },
      vehicle: 'Haval H9 noir', lighting: 'fin de journée', format: '16:9', retryReason: null,
    });
    expect(prompt).toContain('Haval H9 noir');
    expect(prompt).toContain('Boulevard lagunaire');
    expect(prompt).toContain('Plan large');
    expect(prompt).toContain('still photograph');
    expect(prompt).toContain('do not add text');
  });

  it('accepts only explicit valid JSON quality decisions', () => {
    expect(parseKeyframeQuality('{"approved":true,"issues":[],"reason":"Conforme"}')).toEqual({ approved: true, issues: [], reason: 'Conforme' });
    expect(parseKeyframeQuality('```json\n{"approved":false,"issues":["couleur différente"],"reason":"Véhicule incorrect"}\n```')?.approved).toBe(false);
    expect(parseKeyframeQuality('yes')).toBeNull();
    expect(parseKeyframeQuality('{"approved":"yes","issues":[],"reason":"x"}')).toBeNull();
  });

  it('animates the generated image as the opening frame while preserving motion direction', () => {
    const prompt = buildKeyframeAnimationPrompt({
      shot: { title: 'Départ', scene: 'Boulevard lagunaire', framing: 'Plan large', location: 'Abidjan', action: 'Le véhicule démarre doucement', camera: 'Travelling latéral', durationSeconds: 5, vehiclePhotoId: 'vehicle-1', locationPhotoId: 'place-1' },
      vehicle: 'Haval H9 noir', durationS: 5, mood: 'élégant', lighting: 'fin de journée',
    });
    expect(prompt).toContain('exact first frame');
    expect(prompt).toContain('démarre doucement');
    expect(prompt).toContain('no cuts');
  });

  it('limits automatic keyframes to Pro and Premium', () => {
    expect(shouldGenerateKeyframes('standard')).toBe(false);
    expect(shouldGenerateKeyframes('pro')).toBe(true);
    expect(shouldGenerateKeyframes('premium')).toBe(true);
  });

  it('allows only one automatic quality retry and blocks animation until every keyframe passes', () => {
    expect(keyframeQualityAction(true, 0)).toBe('accept');
    expect(keyframeQualityAction(false, 0)).toBe('retry');
    expect(keyframeQualityAction(false, 1)).toBe('reject');
    expect(canAnimateKeyframes(['ready', 'checking'])).toBe(false);
    expect(canAnimateKeyframes(['ready', 'ready'])).toBe(true);
    expect(canAnimateKeyframes([])).toBe(false);
  });
});
