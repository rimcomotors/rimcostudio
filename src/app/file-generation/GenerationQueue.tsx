'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatElapsed, formatStageDurations, type StageDurations } from './processing-display';

type Item = { id: string; title?: string; status: string; versionStatus?: string | null; processingStage?: string; stageElapsedSeconds?: number | null; processingDurations?: StageDurations; durationSeconds?: number; createdAt?: string };
const steps = ['queued', 'keyframing', 'generating', 'transferring', 'postprocessing', 'ready'];
const labels = ['En file', 'Images-clés', 'Génération', 'Transfert', 'Habillage', 'Prête'];
const stageLabels: Record<string, string> = { queued: 'En file d’attente', keyframing: 'Création des images-clés', generating: 'Génération vidéo', transferring: 'Transfert du fichier', postprocessing: 'Logo et finalisation' };
export function GenerationQueue() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState('');
  const loading = useRef(false);
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const response = await fetch('/api/versions', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Impossible de charger la file.');
      let versions = (data.versions ?? []) as Item[];
      const pending = versions.filter((item) => ['generating', 'queued'].includes(item.status) || ['queued', 'generating', 'postprocessing'].includes(item.versionStatus ?? ''));
      let refreshFailed = false;
      if (pending.length > 0) {
        const results = await Promise.all(pending.map(async (item) => {
          try { return (await fetch(`/api/versions/${item.id}/refresh`, { cache: 'no-store', signal: AbortSignal.timeout(25_000) })).ok; }
          catch { return false; }
        }));
        refreshFailed = results.some((ok) => !ok);
        const refreshedResponse = await fetch('/api/versions', { cache: 'no-store' });
        const refreshedData = await refreshedResponse.json();
        if (refreshedResponse.ok) versions = refreshedData.versions ?? [];
      }
      setItems(versions.filter((item) => ['generating', 'queued'].includes(item.status) || ['queued', 'generating', 'postprocessing'].includes(item.versionStatus ?? '')));
      setError(refreshFailed ? 'Le suivi de génération est momentanément indisponible. La file réessaiera automatiquement.' : '');
    } finally { loading.current = false; }
  }, []);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Une erreur est survenue.')); const timer = window.setInterval(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Le suivi de génération est momentanément indisponible.')); }, 5000); return () => window.clearInterval(timer); }, [load]);
  async function cancel(item: Item) {
    const response = await fetch(`/api/versions/${item.id}/cancel`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) { setError(data.error ?? 'La génération ne peut pas être annulée.'); return; }
    await load();
  }
  return <section className="space-y-4">{error && <p role="alert" className="border border-[#f0c9c6] bg-[#fae9e7] p-4 text-sm text-[#9d352e]">{error}</p>}{items.length === 0 ? <div className="border border-dashed border-[#d2d2d6] bg-white px-6 py-16 text-center"><h2 className="text-sm font-semibold">La file est vide</h2><p className="mt-2 text-xs text-[#626269]">Les nouvelles générations apparaîtront ici.</p></div> : items.map((item) => { const activeStep = item.processingStage ?? item.versionStatus ?? (item.status === 'generating' ? 'generating' : item.status); const current = Math.max(0, steps.indexOf(activeStep)); return <article key={item.id} className="border border-[#e2e2e5] bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">{item.title ?? 'Vidéo sans titre'}</h2><p className="mt-1 text-xs text-[#626269]">{item.durationSeconds ?? 5} s · {item.createdAt ? new Date(item.createdAt).toLocaleDateString('fr-FR') : 'Aujourd’hui'}</p><p className="mt-1 text-xs text-[#626269]">{stageLabels[activeStep] ?? 'Génération en cours'}{item.stageElapsedSeconds != null ? ` · ${formatElapsed(item.stageElapsedSeconds)}` : ''}.{(item.stageElapsedSeconds ?? 0) >= 600 ? ' Le délai est inhabituel ; vérifiez l’état de la génération avant de la relancer.' : ''}</p><p className="mt-2 text-[11px] leading-5 text-[#77777d]">{formatStageDurations({ ...item, processingStage: activeStep })}</p></div><button type="button" onClick={() => void cancel(item)} className="min-h-10 rounded-full border border-[#e2e2e5] px-4 text-xs font-semibold">Annuler</button></div><ol className="mt-5 grid gap-2 md:grid-cols-5">{labels.map((label, index) => <li key={label} className="flex items-center gap-2 text-xs"><span className={`grid size-5 place-items-center rounded-full border-2 ${index < current ? 'border-[#c51e1c] bg-[#c51e1c]' : index === current ? 'border-[#c51e1c] bg-white' : 'border-[#dfe1e4] bg-white'}`} aria-hidden="true">{index < current ? '✓' : ''}</span><span className={index <= current ? 'font-semibold text-[#242428]' : 'text-[#77777d]'}>{label}</span></li>)}</ol></article>; })}</section>;
}
