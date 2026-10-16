import { describe, expect, it } from 'vitest';
import { generationTierLabel, resolveGenerationTier } from './generation-tier';

describe('generation tier history', () => {
  it('uses the tier snapshot before current model metadata', () => {
    expect(resolveGenerationTier('pro', 'standard')).toBe('pro');
  });

  it('falls back to the associated model for older video records', () => {
    expect(resolveGenerationTier(undefined, 'standard')).toBe('standard');
  });

  it('maps the legacy test tier to Premium', () => {
    expect(resolveGenerationTier(undefined, 'test')).toBe('premium');
  });

  it('leaves unknown history explicit instead of guessing', () => {
    expect(resolveGenerationTier(undefined, null)).toBeNull();
    expect(generationTierLabel(null)).toBe('Niveau indisponible');
  });

  it('formats the three levels for the library', () => {
    expect(['standard', 'pro', 'premium'].map(generationTierLabel)).toEqual(['Standard', 'Pro', 'Premium']);
  });
});
