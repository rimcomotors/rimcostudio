import { describe, expect, it } from 'vitest';
import { buildBrief } from '@/core/brief';
import { shotDraftSchema, shotToPrompt, storyboardSchema } from './storyboard';

const shots = [
  { title: 'Découverte', scene: 'Plan large', location: 'Abidjan', action: 'Le véhicule est immobile', camera: 'Travelling lent' },
  { title: 'Action', scene: 'Plan héro', location: 'Boulevard côtier', action: 'Le véhicule avance', camera: 'Trois-quarts avant' },
];

describe('storyboard input', () => {
  it('requires exactly two complete shot descriptions', () => {
    expect(storyboardSchema.parse(shots)).toHaveLength(2);
    expect(() => storyboardSchema.parse(shots.slice(0, 1))).toThrow();
    expect(() => shotDraftSchema.parse({ ...shots[0], unknown: 'ignored' })).toThrow();
  });

  it('creates separate short prompts grounded in the same vehicle reference', () => {
    const brief = buildBrief('Une Haval bleue pour un film élégant.', {
      vehicle_asset_id: 'vehicle-1', vehicle_description: 'Haval H6 bleue', duration_s: 6,
      lighting: 'Lumière douce de fin de journée', mood: 'Élégant', character: 'Aucun personnage',
    });
    const firstPrompt = shotToPrompt(brief, shots[0], 0);
    const secondPrompt = shotToPrompt(brief, shots[1], 1);

    expect(firstPrompt).toContain('3-second');
    expect(firstPrompt).toContain('shot 1 of 2');
    expect(secondPrompt).toContain('shot 2 of 2');
    expect(firstPrompt).toContain('Haval H6 bleue');
    expect(secondPrompt).toContain('Haval H6 bleue');
    expect(firstPrompt).toContain('do not add people');
    expect(firstPrompt).toContain('do not add transitions, cuts');
    expect(secondPrompt).toContain('Action: Le véhicule avance');
  });
});
