export const STORYBOARD_COMPARISON_BUDGET_USD = 10;

export function estimateStoryboardComparisonUsd(pricesUsdPerSecond: number[], generatedSeconds: number): number {
  if (!pricesUsdPerSecond.length || !Number.isInteger(generatedSeconds) || generatedSeconds <= 0) throw new Error('Durée ou tarif de comparaison invalide.');
  if (pricesUsdPerSecond.some((price) => !Number.isFinite(price) || price <= 0)) throw new Error('Tarif fournisseur de comparaison invalide.');
  return pricesUsdPerSecond.reduce((sum, price) => sum + price * generatedSeconds, 0);
}

export function reserveStoryboardComparisonBudget(currentReservedUsd: number, newEstimateUsd: number, budgetUsd = STORYBOARD_COMPARISON_BUDGET_USD): number | null {
  if (![currentReservedUsd, newEstimateUsd, budgetUsd].every(Number.isFinite) || currentReservedUsd < 0 || newEstimateUsd <= 0 || budgetUsd <= 0) return null;
  const next = currentReservedUsd + newEstimateUsd;
  return next <= budgetUsd + 0.000001 ? next : null;
}
