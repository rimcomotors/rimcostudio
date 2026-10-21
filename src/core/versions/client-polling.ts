type QueueStatus = {
  status: string;
  versionStatus?: string | null;
};

const ACTIVE_STATUSES = new Set(['queued', 'generating', 'postprocessing']);
const MIN_CLIENT_POLL_DELAY_MS = 30_000;

export function isGenerationActive(item: QueueStatus) {
  return ACTIVE_STATUSES.has(item.status) || ACTIVE_STATUSES.has(item.versionStatus ?? '');
}

export function shouldPollGenerationQueue(items: QueueStatus[], isVisible: boolean) {
  return isVisible && items.some(isGenerationActive);
}

export function nextGenerationPollDelayMs(serverDelays: unknown[]) {
  const delays = serverDelays
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!delays.length) return MIN_CLIENT_POLL_DELAY_MS;
  return Math.max(MIN_CLIENT_POLL_DELAY_MS, Math.min(...delays) * 1000);
}
