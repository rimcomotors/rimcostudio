import { describe, expect, it } from 'vitest';
import { nextGenerationPollDelayMs, shouldPollGenerationQueue } from '@/core/versions/client-polling';

describe('shouldPollGenerationQueue', () => {
  it('does not poll when the tab is hidden', () => {
    expect(shouldPollGenerationQueue([{ status: 'generating' }], false)).toBe(false);
  });

  it('does not poll when there are no active generations', () => {
    expect(shouldPollGenerationQueue([{ status: 'ready' }, { status: 'failed' }], true)).toBe(false);
  });

  it('polls when a visible queue contains a queued or active version', () => {
    expect(shouldPollGenerationQueue([{ status: 'ready' }, { status: 'queued' }], true)).toBe(true);
    expect(shouldPollGenerationQueue([{ status: 'generating' }], true)).toBe(true);
  });

  it('uses the earliest server delay with a 30-second minimum', () => {
    expect(nextGenerationPollDelayMs([180, 60])).toBe(60_000);
    expect(nextGenerationPollDelayMs([5])).toBe(30_000);
    expect(nextGenerationPollDelayMs([null, 'invalid'])).toBe(30_000);
  });
});
