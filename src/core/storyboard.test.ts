import { describe, expect, it } from 'vitest';
import { buildBrief } from '@/core/brief';
import { shotDraftSchema, shotToPrompt, storyboardSchema, validateStoryboard } from './storyboard';

const shots = [
  { title: 'Découverte', scene: 'Plan large', location: 'Plateau', action: 'Le véhicule avance lentement', camera: 'Travelling latéral', durationSeconds: 7, vehiclePhotoId: 'vehicle-front', locationPhotoId: 'place-plateau' },
  { title: 'Habitacle', scene: 'Détail intérieur', location: 'Habitacle du véhicule', action: 'La caméra révèle les finitions', camera: 'Travelling rapproché', durationSeconds: 6, vehiclePhotoId: 'vehicle-interior' },
];

describe('storyboard', () => {
  it('accepts two or more complete shots with explicit reference images and durations', () => {
    expect(storyboardSchema.parse(shots)).toHaveLength(2);
    expect(() => shotDraftSchema.parse({ ...shots[0], durationSeconds: 0 })).toThrow();
    expect(() => shotDraftSchema.parse({ ...shots[0], extra: 'ignored' })).toThrow();
  });

  it('requires the generated clips to fill the final runtime before its two-second logo card', () => {
    expect(validateStoryboard(shots, 15, 'wan')).toBe(true);
    expect(() => validateStoryboard(shots, 20, 'wan')).toThrow(/durée/i);
    expect(() => validateStoryboard([{ ...shots[0], durationSeconds: 11 }, { ...shots[1], durationSeconds: 7 }], 20, 'wan')).toThrow(/maximum/i);
    expect(validateStoryboard([{ ...shots[0], durationSeconds: 12 }, { ...shots[1], durationSeconds: 6 }], 20, 'kling')).toBe(true);
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
    expect(prompt).toContain('Do not add titles, logos, captions, text, or transitions');
  });
});
