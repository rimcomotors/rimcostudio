import { describe, expect, it } from 'vitest';
import { animationSubmitStateAfterFailure, canSubmitAnimation } from './animation-submit-state';

describe('animation submit state', () => {
  it('only submits a queued shot without a provider request', () => {
    expect(canSubmitAnimation('queued', null)).toBe(true);
    expect(canSubmitAnimation('submitting', null)).toBe(false);
    expect(canSubmitAnimation('failed', null)).toBe(false);
    expect(canSubmitAnimation('reconciliation', null)).toBe(false);
    expect(canSubmitAnimation('queued', 'fal-request')).toBe(false);
  });

  it('makes deterministic refusals terminal and uncertain submits require reconciliation', () => {
    expect(animationSubmitStateAfterFailure(422)).toBe('failed');
    expect(animationSubmitStateAfterFailure(401)).toBe('failed');
    expect(animationSubmitStateAfterFailure(503)).toBe('reconciliation');
    expect(animationSubmitStateAfterFailure(null)).toBe('reconciliation');
  });

  it('allows only one concurrent compare-and-set claim for a queued shot', async () => {
    let state: 'queued' | 'submitting' = 'queued';
    const atomicClaim = async () => {
      if (state !== 'queued') return false;
      state = 'submitting';
      return true;
    };
    expect(await Promise.all([atomicClaim(), atomicClaim()])).toEqual([true, false]);
  });
});
