import { describe, expect, it } from 'vitest';
import { buildBrief } from '@/core/brief';
import { expandSingleShotStoryboard, finalVideoSeconds, getSingleShotClipDurations, shotDraftSchema, shotToPrompt, storyboardSchema, validateStoryboard } from './storyboard';

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
    expect(validateStoryboard(shots, 15, 'wan')).toBe(true);
    expect(() => validateStoryboard(shots, 20, 'wan')).toThrow(/durée/i);
    expect(() => validateStoryboard([{ ...shots[0], durationSeconds: 11 }, { ...shots[1], durationSeconds: 9 }], 20, 'wan')).toThrow(/maximum/i);
    expect(validateStoryboard([{ ...shots[0], durationSeconds: 12 }, { ...shots[1], durationSeconds: 8 }], 20, 'kling')).toBe(true);
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
    expect(getSingleShotClipDurations(20, 'wan')).toEqual([10, 10]);
    expect(getSingleShotClipDurations(20, 'kling')).toEqual([10, 10]);
    expect(getSingleShotClipDurations(20, 'seedance')).toEqual([20]);
    expect(finalVideoSeconds(20)).toBe(22);
    expect(finalVideoSeconds(5)).toBe(7);
    expect(expandSingleShotStoryboard(shots[0], 20, 'wan').map((shot) => shot.durationSeconds)).toEqual([10, 10]);
  });
});
