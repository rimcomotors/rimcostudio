import { describe, expect, it } from 'vitest';
import { estimateStoryboardComparisonUsd, reserveStoryboardComparisonBudget } from './storyboard-budget';

describe('budget de comparatif du storyboard', () => {
  it('estime les rendus Wan et Kling à la durée de clips, logo exclu', () => {
    expect(estimateStoryboardComparisonUsd([0.10, 0.112], 13)).toBeCloseTo(2.756);
    expect(estimateStoryboardComparisonUsd([0.10, 0.112], 18)).toBeCloseTo(3.816);
  });

  it('cumule les paliers 15/20 s sous 10 USD et bloque tout dépassement', () => {
    const firstRun = estimateStoryboardComparisonUsd([0.10, 0.112], 13);
    const secondRun = estimateStoryboardComparisonUsd([0.10, 0.112], 18);
    expect(reserveStoryboardComparisonBudget(0, firstRun)).toBeCloseTo(firstRun);
    expect(reserveStoryboardComparisonBudget(firstRun, secondRun)).toBeCloseTo(6.572);
    expect(reserveStoryboardComparisonBudget(8.5, secondRun)).toBeNull();
  });
});
