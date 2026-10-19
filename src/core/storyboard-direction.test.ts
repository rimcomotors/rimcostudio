import { describe, expect, it } from 'vitest';
import { storyboardDirectionSchema } from './storyboard-direction';

describe('storyboardDirectionSchema', () => {
  it('accepts a detailed 576-character automotive brief', () => {
    const prompt = 'Crée un spot publicitaire automobile premium de 10 secondes pour la GWM Tank 300 grise sélectionnée, sans personnage visible. Le véhicule traverse Abidjan, dans une ambiance chaleureuse et élégante. Fais ressentir le confort, la confiance et l\'envie de partir. Mets en valeur la voiture avec un mouvement fluide et réaliste, une lumière de fin de journée et un cadrage cinématographique. Termine sur une belle vue du véhicule au pont HKB. Garde strictement le modèle, la couleur, les proportions et les détails de la photo de référence. Aucun texte ni slogan ajouté à l’image.';

    expect(prompt).toHaveLength(576);
    expect(storyboardDirectionSchema.safeParse(prompt).success).toBe(true);
  });

  it('rejects directions beyond the shared limit', () => {
    expect(storyboardDirectionSchema.safeParse('a'.repeat(1001)).success).toBe(false);
  });
});
