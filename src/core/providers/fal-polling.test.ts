import { describe, expect, it } from 'vitest';
import { isFalPollDue, isTransientFalPollFailure, planFalPollFailure } from './fal-polling';

describe('fal polling retry policy', () => {
  it.each([400, 401, 403, 404, 422])('fails immediately on provider status %s', (status) => {
    expect(isTransientFalPollFailure({ status })).toBe(false);
    expect(planFalPollFailure({ status }, 0).action).toBe('fail');
  });

  it.each([429, 500, 503])('retries provider status %s with bounded delays', (status) => {
    const plan = planFalPollFailure({ status }, 0, new Date('2026-10-19T00:00:00.000Z'));
    expect(plan).toMatchObject({ action: 'retry', failureCount: 1, nextPollAt: '2026-10-19T00:00:15.000Z', retryAfterSeconds: 15 });
  });

  it('treats network errors as transient and allows three retries before manual recovery', () => {
    expect(planFalPollFailure(new TypeError('fetch failed'), 0).action).toBe('retry');
    expect(planFalPollFailure({ status: 503 }, 1).retryAfterSeconds).toBe(60);
    expect(planFalPollFailure({ status: 503 }, 2).retryAfterSeconds).toBe(180);
    expect(planFalPollFailure({ status: 503 }, 3)).toMatchObject({ action: 'manual', failureCount: 4, nextPollAt: null });
  });

  it('polls only when the persisted next time is due', () => {
    const now = Date.parse('2026-10-19T00:00:00.000Z');
    expect(isFalPollDue('2026-10-19T00:00:15.000Z', now)).toBe(false);
    expect(isFalPollDue('2026-10-19T00:00:15.000Z', now + 15_000)).toBe(true);
    expect(isFalPollDue(null, now)).toBe(true);
  });
});
