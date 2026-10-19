import { describe, expect, it } from 'vitest';
import { buildBrief } from '@/core/brief';
import { buildStoryboardInstruction, compactStoryboardText, expandSingleShotStoryboard, finalVideoSeconds, fitStoryboardDurations, getSingleShotClipDurations, shotDraftSchema, shotToPrompt, storyboardSchema, validateStoryboard } from './storyboard';

const shots = [
  { title: 'Découverte', scene: 'Plan large', framing: 'Plan large', location: 'Plateau', action: 'Le véhicule avance lentement', camera: 'Travelling latéral', durationSeconds: 8, vehiclePhotoId: 'vehicle-front', locationPhotoId: 'place-plateau' },
  { title: 'Habitacle', scene: 'Détail intérieur', framing: 'Gros plan', location: 'Habitacle du véhicule', action: 'La caméra révèle les finitions', camera: 'Travelling rapproché', durationSeconds: 7, vehiclePhotoId: 'vehicle-interior' },
];

describe('storyboard', () => {
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
      purpose: 'advertising',
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
