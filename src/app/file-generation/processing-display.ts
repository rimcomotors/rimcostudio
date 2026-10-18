export type StageDurations = { queueSeconds: number | null; keyframingSeconds?: number | null; generationSeconds: number | null; transferSeconds: number | null; postproductionSeconds: number | null; billingSeconds: number | null };
export type ProcessingDisplayItem = { processingStage?: string | null; processingDurations?: StageDurations };

const steps = ['queued', 'keyframing', 'generating', 'transferring', 'postprocessing', 'ready'];
const stageRows: Array<[string, keyof StageDurations, number]> = [
  ['File d’attente', 'queueSeconds', 0], ['Images-clés', 'keyframingSeconds', 1], ['Génération', 'generationSeconds', 2], ['Transfert', 'transferSeconds', 3],
  ['Clôture des coûts', 'billingSeconds', 3], ['Post-production', 'postproductionSeconds', 4],
];

export function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

export function formatStageDurations(item: ProcessingDisplayItem) {
  const current = steps.indexOf(item.processingStage ?? 'queued');
  return stageRows.map(([label, key, startsAt]) => {
    const seconds = item.processingDurations?.[key];
    const value = seconds == null ? (startsAt > current ? 'À venir' : 'En attente de mesure') : formatElapsed(seconds);
    return `${label} : ${value}`;
  }).join(' · ');
}
