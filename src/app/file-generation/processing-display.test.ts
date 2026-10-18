import { describe, expect, it } from 'vitest';
import { formatElapsed, formatStageDurations } from './processing-display';

describe('generation progress display', () => {
  it('formats elapsed stage durations', () => {
    expect(formatElapsed(125)).toBe('2 min 5 s');
  });

  it('shows measured, active, and upcoming stage durations distinctly', () => {
    expect(formatStageDurations({
      processingStage: 'generating',
      processingDurations: { queueSeconds: 12, generationSeconds: 65, transferSeconds: null, billingSeconds: null, postproductionSeconds: null },
    })).toBe('File d’attente : 12 s · Images-clés : En attente de mesure · Génération : 1 min 5 s · Transfert : À venir · Clôture des coûts : À venir · Post-production : À venir');
  });

  it('shows keyframing time before animation begins', () => {
    expect(formatStageDurations({
      processingStage: 'keyframing',
      processingDurations: { queueSeconds: 12, keyframingSeconds: 31, generationSeconds: null, transferSeconds: null, billingSeconds: null, postproductionSeconds: null },
    })).toContain('Images-clés : 31 s');
  });
});
