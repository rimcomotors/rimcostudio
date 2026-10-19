export type ProcessingMetrics = {
  requestedAt?: string;
  keyframingStartedAt?: string;
  keyframingCompletedAt?: string;
  providerSubmittedAt?: string;
  providerQueuedAt?: string;
  generationStartedAt?: string;
  providerCompletedAt?: string;
  rawStoredAt?: string;
  costsSettlementStartedAt?: string;
  postproductionStartedAt?: string;
  postproductionCompletedAt?: string;
  costsSettledAt?: string;
  failedAt?: string;
};

export type ProcessingStage = 'queued' | 'keyframing' | 'generating' | 'quality_checking' | 'transferring' | 'postprocessing' | 'ready' | 'failed';

export function firstObservedAt(metrics: ProcessingMetrics, key: keyof ProcessingMetrics, observedAt: string) {
  return metrics[key] ? metrics : { ...metrics, [key]: observedAt };
}

export function processingStage(status: string, metrics: ProcessingMetrics): ProcessingStage {
  if (status === 'ready') return 'ready';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'postprocessing') return 'postprocessing';
  if (status === 'generating' && metrics.keyframingStartedAt && !metrics.keyframingCompletedAt) return 'keyframing';
  // Provider completion includes fetching the result and finalizing accounting;
  // keep showing transfer until post-production explicitly starts.
  if (metrics.providerCompletedAt && status === 'generating') return 'transferring';
  if (status === 'generating' && metrics.generationStartedAt) return 'generating';
  return 'queued';
}

export function elapsedSeconds(start?: string, end?: string, now = Date.now()) {
  if (!start) return null;
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : now;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.floor((endMs - startMs) / 1000);
}

export function processingDurations(metrics: ProcessingMetrics, status: string, now = Date.now()) {
  const failedAt = metrics.failedAt;
  const terminalAt = status === 'failed' || status === 'cancelled' ? failedAt : undefined;
  return {
    queueSeconds: elapsedSeconds(metrics.providerSubmittedAt, metrics.generationStartedAt ?? terminalAt, now),
    keyframingSeconds: elapsedSeconds(metrics.keyframingStartedAt, metrics.keyframingCompletedAt ?? terminalAt, now),
    generationSeconds: elapsedSeconds(metrics.generationStartedAt, metrics.providerCompletedAt ?? terminalAt, now),
    transferSeconds: elapsedSeconds(metrics.providerCompletedAt, metrics.rawStoredAt ?? terminalAt, now),
    postproductionSeconds: elapsedSeconds(metrics.postproductionStartedAt, metrics.postproductionCompletedAt ?? terminalAt, now),
    billingSeconds: elapsedSeconds(metrics.costsSettlementStartedAt, metrics.costsSettledAt ?? terminalAt, now),
  };
}
