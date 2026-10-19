import { describe, expect, it } from 'vitest';
import { aggregateGenerationCost } from './aggregate';

describe('aggregateGenerationCost', () => {
  it('combines the LLM and Fal reservations and applies the margin once', () => {
    const result = aggregateGenerationCost([
      { kind: 'generation', ai_model_id: 'fal-model', seconds: 10, cost_usd: 2, price_fcfa: 3711, status: 'charged' },
      { kind: 'generation', ai_model_id: null, seconds: 1, cost_usd: 0.5, price_fcfa: 0, status: 'charged' },
    ], 0.9, 655.957);

    expect(result).toEqual({ costUsd: 2.5, priceFcfa: 1919, seconds: 10, status: 'charged' });
  });

  it('does not expose released reservations', () => {
    expect(aggregateGenerationCost([
      { kind: 'generation', ai_model_id: 'fal-model', seconds: 5, cost_usd: 1, price_fcfa: 800, status: 'released' },
    ], 0.9, 655.957)).toBeNull();
  });

  it('prices the requested runtime while keeping overgenerated duration in the real cost total', () => {
    const result = aggregateGenerationCost([
      { kind: 'generation', ai_model_id: 'seedance', seconds: 32, cost_usd: 6.4, billable_cost_usd: 2, price_fcfa: 1535, status: 'charged' },
    ], 0.9, 655.957);
    expect(result).toEqual({ costUsd: 6.4, priceFcfa: 1535, seconds: 32, status: 'charged' });
  });
});
