import { describe, expect, it } from 'vitest';
import { buildBrief } from '@/core/brief';
import { buildStoryboardInstruction, compactStoryboardText, expandSingleShotStoryboard, finalVideoSeconds, fitStoryboardDurations, getSingleShotClipDurations, isPremiumTenSecondAd, premiumTenSecondAdDurations, shotDraftSchema, shotToPrompt, storyboardSchema, validatePremiumTenSecondAdStoryboard, validatePremiumTwentySecondStoryboard, validateStoryboard, validateTierDuration } from './storyboard';

const shots = [
  { title: 'Découverte', scene: 'Plan large', framing: 'Plan large', location: 'Plateau', action: 'Le véhicule avance lentement', camera: 'Travelling latéral', durationSeconds: 8, vehiclePhotoId: 'vehicle-front', locationPhotoId: 'place-plateau' },
  { title: 'Habitacle', scene: 'Détail intérieur', framing: 'Gros plan', location: 'Habitacle du véhicule', action: 'La caméra révèle les finitions', camera: 'Travelling rapproché', durationSeconds: 7, vehiclePhotoId: 'vehicle-interior' },
];

describe('storyboard', () => {
  it('allows only 20 seconds for Premium and keeps other tier durations available', () => {
    expect(validateTierDuration('premium', 20)).toBe(true);
    for (const duration of [5, 10, 15] as const) expect(() => validateTierDuration('premium', duration)).toThrow(/20 secondes/i);
    expect(validateTierDuration('standard', 5)).toBe(true);
    expect(validateTierDuration('pro', 15)).toBe(true);
  });

  it('requires exactly four 5-second shots for a Premium 20-second storyboard', () => {
    const premiumShots = Array.from({ length: 4 }, (_, index) => ({ ...shots[index % 2], title: `Premium ${index + 1}`, durationSeconds: 5 }));
    expect(validatePremiumTwentySecondStoryboard(premiumShots)).toBe(true);
    expect(() => validatePremiumTwentySecondStoryboard(premiumShots.slice(0, 3))).toThrow(/quatre plans de 5 secondes/i);
    expect(() => validatePremiumTwentySecondStoryboard(premiumShots.map((shot, index) => ({ ...shot, durationSeconds: index === 0 ? 4 : 5 })))).toThrow(/quatre plans de 5 secondes/i);
  });

  it('asks the Premium director for four full 5-second shots at 20 seconds', () => {
    const instruction = buildStoryboardInstruction({
      durationSeconds: 20, mode: 'premium', vehicle: 'GWM Tank 300 gris', vehiclePhotos: [{ id: 'front', role: 'exterior', title: 'Avant' }],
      places: [{ id: 'hkb', title: 'Pont HKB' }], purpose: 'advertising', format: '16:9',
    });
    expect(instruction).toContain('Use exactly four distinct shots of exactly 5 seconds each');
    expect(instruction).toContain('preserve the full 20-second edit without trimming');
  });

  it('accepts two or more complete shots with explicit reference images and durations', () => {
    expect(storyboardSchema.parse(shots)).toHaveLength(2);
    expect(() => shotDraftSchema.parse({ ...shots[0], durationSeconds: 0 })).toThrow();
    expect(() => shotDraftSchema.parse({ ...shots[0], extra: 'ignored' })).toThrow();
  });

  it('requires generated clips to fill the selected runtime before adding the logo card', () => {
    expect(validateStoryboard([{ ...shots[0], durationSeconds: 5 }, { ...shots[1], durationSeconds: 5 }], 10, 'seedance')).toBe(true);
    expect(validateStoryboard([{ ...shots[0], durationSeconds: 5 }, { ...shots[1], durationSeconds: 5 }, { ...shots[0], durationSeconds: 5 }], 15, 'wan')).toBe(true);
    expect(() => validateStoryboard(shots, 20, 'wan')).toThrow(/durée/i);
    expect(() => validateStoryboard([{ ...shots[0], durationSeconds: 11 }, { ...shots[1], durationSeconds: 9 }], 20, 'wan')).toThrow(/maximum/i);
    expect(validateStoryboard([{ ...shots[0], durationSeconds: 12 }, { ...shots[1], durationSeconds: 8 }], 20, 'kling')).toBe(true);
  });

  it('builds a director brief for the selected runtime, aspect ratio and user story', () => {
    const instruction = buildStoryboardInstruction({
      durationSeconds: 10,
      mode: 'premium',
      vehicle: 'GWM Tank 300 noir',
      vehiclePhotos: [{ id: 'vehicle-front', role: 'exterior', title: 'Avant trois-quarts' }],
      places: [{ id: 'place-plateau', title: 'Abidjan, Plateau' }],
      purpose: 'presentation',
      direction: 'Une famille traverse Abidjan au coucher du soleil.',
      format: '9:16',
      character: 'Une famille à bord du véhicule',
      lighting: 'Fin de journée',
    });

    expect(instruction).toContain('10s of footage in 9:16');
    expect(instruction).toContain('9:16');
    expect(instruction).toContain('Une famille traverse Abidjan au coucher du soleil.');
    expect(instruction).toContain('automotive commercial film director');
    expect(instruction).toContain('Une famille à bord du véhicule');
    expect(instruction).toContain('Fin de journée');
    expect(instruction).toContain('scene 160');
    expect(instruction).toContain('action 180');
    expect(instruction).toContain('Use exactly 2 shots and make every shot exactly 5 seconds.');
  });

  it('plans four distinct four-second generation clips for a 10-second Premium advertisement', () => {
    expect(isPremiumTenSecondAd('premium', 'advertising', 10)).toBe(true);
    expect(isPremiumTenSecondAd('pro', 'advertising', 10)).toBe(false);
    expect(isPremiumTenSecondAd('premium', 'presentation', 10)).toBe(false);
    expect(premiumTenSecondAdDurations()).toEqual({ generated: [4, 4, 4, 4], editorial: [2.5, 2.5, 2.5, 2.5] });
    const fourShots = [2, 3, 2, 3].map((durationSeconds, index) => ({ ...shots[0], title: `Plan ${index + 1}`, durationSeconds }));
    expect(validatePremiumTenSecondAdStoryboard(fourShots)).toBe(true);
    expect(() => validatePremiumTenSecondAdStoryboard(fourShots.slice(0, 2))).toThrow(/quatre/i);
  });

  it('asks the Premium advertising director for four varied short shots only for 10 seconds', () => {
    const instruction = buildStoryboardInstruction({
      durationSeconds: 10, mode: 'premium', vehicle: 'GWM Tank 300 gris', vehiclePhotos: [{ id: 'front', role: 'exterior', title: 'Avant' }],
      places: [{ id: 'hkb', title: 'Pont HKB' }], purpose: 'advertising', format: '16:9',
    });
    expect(instruction).toContain('Use exactly 4 distinct shots');
    expect(instruction).toContain('Each will be generated as a separate 4-second');
    expect(instruction).toContain('Absolutely no people anywhere in any shot');
    expect(instruction).toContain('A macro or close-up detail is allowed only when that exact detail is clearly visible');
    expect(instruction).not.toContain('Use exactly 2 shots and make every shot exactly 5 seconds');
  });

  it('rebalances model shot durations to fit the provider limits and requested runtime', () => {
    const fitted = fitStoryboardDurations([
      { ...shots[0], durationSeconds: 3 },
      { ...shots[1], durationSeconds: 4 },
      { ...shots[0], title: 'Final', durationSeconds: 3 },
    ], 10, 'seedance');

    expect(fitted).toHaveLength(2);
    expect(fitted.map((shot) => shot.durationSeconds)).toEqual([5, 5]);
    expect(fitted.map((shot) => shot.title)).toEqual(['Découverte', 'Final']);
    expect(validateStoryboard(fitted, 10, 'seedance')).toBe(true);
  });

  it('keeps verbose model storyboard fields within the validated limits without cutting a word', () => {
    const text = `${'A precise cinematic scene with the vehicle advancing slowly. '.repeat(5)}`;
    const compact = compactStoryboardText(text, 160);

    expect(compact.length).toBeLessThanOrEqual(160);
    expect(text.startsWith(compact)).toBe(true);
    expect(compact).toMatch(/[.!?]$/);
    expect(shotDraftSchema.parse({ ...shots[0], scene: text }).scene).toBe(compact);
  });

  it('keeps the selected vehicle identity and image references in each shot prompt', () => {
    const brief = buildBrief('Un film automobile premium à Abidjan.', {
      vehicle_asset_id: 'vehicle-folder-1', vehicle_description: 'Haval H6 bleu nuit', duration_s: 15,
      lighting: 'Lumière douce', mood: 'Premium et réaliste', character: 'Aucun personnage',
    });
    const prompt = shotToPrompt(brief, shots[0], 0, shots.length);
    expect(prompt).toContain('Haval H6 bleu nuit');
    expect(prompt).toContain('vehicle-front');
    expect(prompt).toContain('place-plateau');
    expect(prompt).toContain('shot 1 of 2');
    expect(prompt).toContain('no titles, captions, overlays, added logos, or transitions');
    expect(prompt).toContain('natural environmental effects requested by the brief, such as dust from a dirt road');
  });

  it('strictly excludes visible occupants from Premium automotive advertising when none are selected', () => {
    const brief = buildBrief('Film automobile premium à Abidjan.', {
      vehicle_asset_id: 'vehicle-folder-1', vehicle_description: 'GWM Tank 300 gris', character: 'Aucun personnage',
    });
    const prompt = shotToPrompt(brief, shots[0], 0, 4);
    expect(prompt).toMatch(/no visible driver, passenger, face, person, or human silhouette/i);
    expect(prompt).toMatch(/The vehicle is visually unoccupied/i);
  });

  it('does not suppress people explicitly requested in the creative direction', () => {
    const brief = buildBrief('Une famille traverse Abidjan en voiture.', {
      vehicle_asset_id: 'vehicle-folder-1', vehicle_description: 'GWM Tank 300 noir',
      user_direction: 'Une famille traverse Abidjan en voiture.',
      character: 'as explicitly requested in the user direction; otherwise none',
    });
    const prompt = shotToPrompt(brief, shots[0], 0, 2);

    expect(prompt).toContain('Une famille traverse Abidjan en voiture.');
    expect(prompt).toContain('Character: as explicitly requested in the user direction; otherwise none.');
    expect(prompt).not.toContain('none; do not add people');
  });

  it('uses the selected aspect ratio in the master prompt', () => {
    const brief = buildBrief('Film automobile carré.', {
      vehicle_asset_id: 'vehicle-folder-1', vehicle_description: 'Haval H6 bleu nuit', format: '1:1',
    });
    const prompt = shotToPrompt(brief, shots[0], 0, 1);
    expect(prompt).toContain('1:1 image-to-video automotive shot');
    expect(prompt).not.toContain('16:9 image-to-video automotive shot');
  });

  it('splits long endpoint-bound shots and appends two logo seconds to the final runtime', () => {
    expect(getSingleShotClipDurations(5, 'wan')).toEqual([5]);
    expect(getSingleShotClipDurations(10, 'wan')).toEqual([5, 5]);
    expect(getSingleShotClipDurations(15, 'wan')).toEqual([5, 5, 5]);
    expect(getSingleShotClipDurations(20, 'wan')).toEqual([5, 5, 5, 5]);
    expect(getSingleShotClipDurations(20, 'kling')).toEqual([10, 10]);
    expect(getSingleShotClipDurations(20, 'seedance')).toEqual([20]);
    expect(finalVideoSeconds(20)).toBe(22);
    expect(finalVideoSeconds(5)).toBe(7);
    expect(expandSingleShotStoryboard(shots[0], 20, 'wan').map((shot) => shot.durationSeconds)).toEqual([5, 5, 5, 5]);
  });
});
