export type GenerationTier = 'standard' | 'pro' | 'premium';

export function resolveGenerationTier(storedTier: unknown, modelTier: unknown): GenerationTier | null {
  const tier = storedTier ?? modelTier;
  if (tier === 'standard' || tier === 'pro' || tier === 'premium') return tier;
  return tier === 'test' ? 'premium' : null;
}

export function generationTierLabel(tier: unknown): string {
  if (tier === 'test' || tier === 'premium') return 'Premium';
  if (tier === 'pro') return 'Pro';
  if (tier === 'standard') return 'Standard';
  return 'Niveau indisponible';
}
