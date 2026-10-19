export const FAL_POLL_RETRY_DELAYS_MS = [15_000, 60_000, 180_000] as const;
export const FAL_POLL_MAX_FAILURES = FAL_POLL_RETRY_DELAYS_MS.length + 1;

export type FalPollFailurePlan =
  | { action: 'retry'; failureCount: number; nextPollAt: string; retryAfterSeconds: number }
  | { action: 'manual'; failureCount: number; nextPollAt: null; retryAfterSeconds: null }
  | { action: 'fail'; failureCount: number; nextPollAt: null; retryAfterSeconds: null };

export function falErrorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const value = [record.status, record.statusCode, record.status_code].find(
    (candidate) => typeof candidate === 'number' && Number.isInteger(candidate),
  );
  return typeof value === 'number' ? value : null;
}

export function isTransientFalPollFailure(error: unknown): boolean {
  const status = falErrorStatusCode(error);
  return status === null || status === 429 || status >= 500 && status <= 599;
}

export function planFalPollFailure(error: unknown, previousFailures: number, now = new Date()): FalPollFailurePlan {
  const failureCount = Math.max(0, Math.floor(previousFailures)) + 1;
  if (!isTransientFalPollFailure(error)) return { action: 'fail', failureCount, nextPollAt: null, retryAfterSeconds: null };
  const delay = FAL_POLL_RETRY_DELAYS_MS[failureCount - 1];
  if (delay === undefined) return { action: 'manual', failureCount, nextPollAt: null, retryAfterSeconds: null };
  return {
    action: 'retry', failureCount,
    nextPollAt: new Date(now.getTime() + delay).toISOString(),
    retryAfterSeconds: Math.ceil(delay / 1000),
  };
}

export function isFalPollDue(nextPollAt: unknown, now = Date.now()): boolean {
  if (typeof nextPollAt !== 'string') return true;
  const dueAt = Date.parse(nextPollAt);
  return !Number.isFinite(dueAt) || dueAt <= now;
}
