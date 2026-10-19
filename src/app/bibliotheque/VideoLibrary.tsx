'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { StatusPill } from '@/components/shell';
import type { Role } from '@/core/auth/guards';
import { generationTierLabel } from '@/core/versions/generation-tier';

type Video = { id: string; videoId?: string; title?: string; make?: string; model?: string; status: string; tier?: string | null; photoFidelity?: boolean; format?: string; durationSeconds?: number; checkedQualityShots?: number; totalQualityShots?: number; createdAt?: string; created_at?: string; estimatedPriceFcfa?: number; price_fcfa?: number; priceFcfa?: number; videoUrl?: string | null; previewUrl?: string | null; previewSource?: 'final' | 'raw' | null; finalUrl?: string; validationId?: string | null; validationStatus?: string | null; version?: number; department?: string; userId?: string; processingStage?: 'queued' | 'keyframing' | 'generating' | 'quality_checking' | 'transferring' | 'postprocessing' | 'ready' | 'failed'; stageElapsedSeconds?: number | null; processingDurations?: { queueSeconds: number | null; keyframingSeconds?: number | null; generationSeconds: number | null; transferSeconds: number | null; postproductionSeconds: number | null; billingSeconds: number | null } };

function formatVideoPrice(video: Video) {
  if (video.photoFidelity) return 'Sans appel vidéo IA';
  const amount = [video.priceFcfa, video.estimatedPriceFcfa, video.price_fcfa].find((value): value is number => typeof value === 'number');
  return amount === undefined ? 'Montant indisponible' : `${new Intl.NumberFormat('fr-FR').format(amount)} FCFA`;
}
function videoMethodLabel(video: Video) {
  return video.photoFidelity ? 'Fidélité photo' : generationTierLabel(video.tier);
}
function formatVideoDate(value?: string) {
  if (!value) return 'Date indisponible';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date indisponible';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Abidjan' }).format(date);
}
const isVideoInProgress = (status: string) => ['queued', 'generating', 'postprocessing'].includes(status);
const videoAspectClass = (format?: string) => format === '9:16' ? 'aspect-[9/16]' : format === '1:1' ? 'aspect-square' : format === '4:5' ? 'aspect-[4/5]' : 'aspect-video';
const stageLabels: Record<string, string> = { queued: 'En file d’attente', keyframing: 'Création des images-clés', generating: 'Génération vidéo', quality_checking: 'Contrôle qualité des clips', transferring: 'Transfert du fichier', postprocessing: 'Logo et finalisation' };
function formatElapsed(seconds?: number | null) {
  if (seconds == null) return '';
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}
function formatStageDurations(durations?: Video['processingDurations']) {
  if (!durations) return '';
  const parts = [
    ['File d’attente', durations.queueSeconds],
    ['Génération', durations.generationSeconds],
    ['Transfert', durations.transferSeconds],
    ['Finalisation', durations.postproductionSeconds],
    ['Comptabilisation', durations.billingSeconds],
  ].filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  return parts.map(([label, seconds]) => `${label} ${formatElapsed(seconds)}`).join(' · ');
}

export function VideoLibrary({ role }: { role: Role }) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);
  const [unavailablePreviewIds, setUnavailablePreviewIds] = useState<string[]>([]);
  const renewedPreviewIds = useRef(new Set<string>());
  const refreshing = useRef(false);
  const [refreshIssues, setRefreshIssues] = useState(false);

  const loadVideos = useCallback(async () => {
    const response = await fetch('/api/versions');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Impossible de charger la bibliothèque.');
    setVideos(data.versions ?? []);
    setSelectedVideo((current) => current ? (data.versions ?? []).find((video: Video) => (video.videoId ?? video.id) === (current.videoId ?? current.id)) ?? null : null);
    const visibleIds = new Set((data.versions ?? []).map((video: Video) => video.videoId ?? video.id));
    setSelectedIds((current) => current.filter((id) => visibleIds.has(id)));
  }, []);

  async function renewExpiredPreview(versionId: string) {
    if (renewedPreviewIds.current.has(versionId)) {
      setUnavailablePreviewIds((current) => current.includes(versionId) ? current : [...current, versionId]);
      return;
    }
    renewedPreviewIds.current.add(versionId);
    try {
      await loadVideos();
    } catch (cause) {
      setUnavailablePreviewIds((current) => current.includes(versionId) ? current : [...current, versionId]);
      setError(cause instanceof Error ? cause.message : 'Impossible de renouveler le lien de lecture.');
    }
  }

  function clearPreviewError(versionId: string) {
    setUnavailablePreviewIds((current) => current.filter((id) => id !== versionId));
  }

  useEffect(() => { loadVideos().catch((cause) => setError(cause instanceof Error ? cause.message : 'Une erreur est survenue.')); }, [loadVideos]);
  useEffect(() => {
    if (!videos.some((video) => video.status === 'generating')) return;
    const timer = window.setInterval(async () => {
      if (refreshing.current) return;
      refreshing.current = true;
      const pending = videos.filter((video) => video.status === 'generating');
      try {
        const results = await Promise.all(pending.map(async (video) => {
          const response = await fetch(`/api/versions/${video.id}/refresh`, { cache: 'no-store', signal: AbortSignal.timeout(25_000) });
          return response.ok;
        }));
        setRefreshIssues(results.some((ok) => !ok));
        await loadVideos();
      } catch {
        setRefreshIssues(true);
      } finally { refreshing.current = false; }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadVideos, videos]);

  const filtered = useMemo(() => videos.filter((video) =>
    (filter === 'all' || video.status === filter) && `${video.title ?? ''} ${video.make ?? ''} ${video.model ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  ), [videos, filter, query]);
  const selectedVideos = videos.filter((video) => selectedIds.includes(video.videoId ?? video.id));
  const selectableVisibleIds = filtered.filter((video) => !isVideoInProgress(video.status)).map((video) => video.videoId ?? video.id);
  const allVisibleSelected = selectableVisibleIds.length > 0 && selectableVisibleIds.every((id) => selectedIds.includes(id));
  const tabs = [['all', 'Tous les statuts'], ['ready', 'Prêtes'], ['review', 'En validation'], ['rejected', 'Refusées'], ['generating', 'En cours']];
  const labels: Record<string, string> = { ready: 'Validée', review: 'En validation', generating: 'Génération', queued: 'Génération', failed: 'Échec', rejected: 'Refusée', draft: 'Brouillon', cancelled: 'Annulée' };

  function toggleSelected(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setError('');
    setNotice('');
  }

  function toggleVisibleSelection() {
    setSelectedIds((current) => allVisibleSelected
      ? current.filter((id) => !selectableVisibleIds.includes(id))
      : [...new Set([...current, ...selectableVisibleIds])]);
  }

  function downloadSelected() {
    const downloadable = selectedVideos.filter((video) => video.status === 'ready' && video.videoUrl);
    if (downloadable.length !== selectedVideos.length || downloadable.length === 0) return;
    setError('');
    setNotice(`Téléchargement de ${downloadable.length} vidéo${downloadable.length > 1 ? 's' : ''} lancé.${downloadable.length > 1 ? ' Autorisez les téléchargements multiples dans Chrome si le navigateur le demande.' : ''}`);
    downloadable.forEach((video) => {
      const link = document.createElement('a');
      link.href = video.videoUrl!;
      link.download = `${(video.title ?? 'video-rimco').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'video-rimco'}.mp4`;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
  }

  async function deleteSelected() {
    if (!selectedIds.length || deleting) return;
    const confirmed = window.confirm(`Supprimer définitivement ${selectedIds.length} vidéo${selectedIds.length > 1 ? 's' : ''} et leurs fichiers MP4 ? L’historique des coûts restera conservé.`);
    if (!confirmed) return;
    setDeleting(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/versions', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoIds: selectedIds }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Impossible de supprimer la sélection.');
      setSelectedIds([]);
      await loadVideos();
      setNotice(`${data.deleted} vidéo${data.deleted > 1 ? 's supprimées' : ' supprimée'}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Impossible de supprimer la sélection.');
    } finally {
      setDeleting(false);
    }
  }

  async function submitForValidation(video: Video) {
    setError('');
    const response = await fetch('/api/validations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: video.id }) });
    const data = await response.json();
    if (!response.ok) { setError(data.error ?? 'Impossible d’envoyer la vidéo en validation.'); return; }
    setNotice('Vidéo envoyée en validation.');
    await loadVideos();
  }

  return <>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex gap-1 overflow-x-auto border border-[#e2e2e5] bg-white p-1">{tabs.map(([value, label]) => <button type="button" key={value} onClick={() => setFilter(value)} aria-pressed={filter === value} className={`min-h-11 whitespace-nowrap px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c51e1c] ${filter === value ? 'bg-[#fae9e8] text-[#9c2822]' : 'text-[#626269] hover:bg-[#f4f4f5]'}`}>{label}</button>)}</div>
      <input aria-label="Rechercher une vidéo" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher…" className="min-h-11 w-full border border-[#e2e2e5] bg-white px-4 py-2.5 text-xs outline-none focus:border-[#c51e1c] sm:w-64" />
    </div>
    {filtered.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3 border-y border-[#e2e2e5] bg-white px-4 py-3">
      <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs font-semibold text-[#333338]">
        <input type="checkbox" aria-label="Sélectionner toutes les vidéos visibles" checked={allVisibleSelected} onChange={toggleVisibleSelection} className="size-4 accent-[#c51e1c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c51e1c]" />
        Sélectionner les vidéos visibles
      </label>
      {selectedIds.length > 0 && <>
        <span aria-live="polite" className="text-xs text-[#626269]">{selectedIds.length} sélectionnée{selectedIds.length > 1 ? 's' : ''}</span>
        <button type="button" onClick={downloadSelected} disabled={!selectedVideos.length || selectedVideos.some((video) => video.status !== 'ready' || !video.videoUrl)} className="min-h-11 rounded-sm border border-[#d4d4d8] bg-white px-3.5 text-xs font-semibold text-[#242428] hover:bg-[#f7f7f8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c51e1c] disabled:cursor-not-allowed disabled:opacity-45">Télécharger la sélection</button>
        <button type="button" onClick={deleteSelected} disabled={deleting} className="min-h-11 rounded-sm border border-[#e4b9b6] bg-[#fff8f7] px-3.5 text-xs font-semibold text-[#9c2822] hover:bg-[#fae9e8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c51e1c] disabled:cursor-wait disabled:opacity-60">{deleting ? 'Suppression…' : 'Supprimer la sélection'}</button>
        <button type="button" onClick={() => setSelectedIds([])} className="min-h-11 px-2 text-xs font-medium text-[#626269] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c51e1c]">Effacer la sélection</button>
      </>}
    </div>}
    {error && <p role="alert" className="mb-5 border border-[#f0c9c6] bg-[#fae9e7] p-4 text-sm text-[#9d352e]">{error}</p>}
    {refreshIssues && <p role="status" className="mb-5 border border-[#ead9b4] bg-[#fff9ed] p-4 text-sm text-[#77591f]">Le suivi de génération est momentanément indisponible. La réservation de coût reste inchangée ; le Studio réessaiera automatiquement.</p>}
    {notice && <p role="status" className="mb-5 border border-[#d7e7da] bg-[#f2f8f3] p-4 text-sm text-[#315c39]">{notice}</p>}
    {filtered.length === 0 ? <div className="border border-dashed border-[#d2d2d6] bg-white px-6 py-16 text-center"><svg aria-hidden="true" viewBox="0 0 24 24" className="mx-auto size-8 fill-none stroke-[#c51e1c]" strokeWidth="1.5"><path d="M4 5h16v14H4zM10 9l5 3-5 3z" /></svg><h2 className="mt-4 text-sm font-semibold">Aucune vidéo dans cette vue</h2><p className="mx-auto mt-2 max-w-md text-xs leading-5 text-[#626269]">Les vidéos générées apparaîtront ici avec leur aperçu, leur statut et leur prix.</p><Link href="/studio" className="mt-5 inline-flex min-h-11 items-center rounded-sm bg-[#c51e1c] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#a71715]">Créer une vidéo</Link></div> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {filtered.map((video) => <article key={video.videoId ?? video.id} onClick={() => setSelectedVideo(video)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedVideo(video); } }} tabIndex={0} role="button" className={`cursor-pointer overflow-hidden border bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c51e1c] ${selectedVideo?.id === video.id ? 'border-[#c51e1c]' : 'border-[#e2e2e5]'}`}>
        <div className="flex min-h-11 items-center justify-between border-b border-[#e2e2e5] px-4">
          <label className={`inline-flex min-h-11 items-center gap-2 text-xs font-medium ${isVideoInProgress(video.status) ? 'cursor-not-allowed text-[#8b8b91]' : 'cursor-pointer text-[#333338]'}`}>
            <input type="checkbox" checked={selectedIds.includes(video.videoId ?? video.id)} disabled={isVideoInProgress(video.status)} onChange={() => toggleSelected(video.videoId ?? video.id)} aria-label={`Sélectionner ${video.title ?? 'la vidéo'}`} className="size-4 accent-[#c51e1c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c51e1c] disabled:cursor-not-allowed" />
            {isVideoInProgress(video.status) ? 'Génération en cours' : 'Sélectionner'}
          </label>
        </div>
        {video.previewUrl ? <video controls preload="metadata" src={video.previewUrl} onError={() => { void renewExpiredPreview(video.id); }} onLoadedMetadata={() => clearPreviewError(video.id)} className={`${videoAspectClass(video.format)} w-full bg-[#232326] object-contain`} aria-label={`Aperçu de ${video.title ?? 'la vidéo'}`} /> : <div className={`grid ${videoAspectClass(video.format)} place-items-center bg-[#eeeeef] text-[#8b8b91]`}><svg aria-hidden="true" viewBox="0 0 24 24" className="size-9 fill-none stroke-current" strokeWidth="1.5"><path d="M4 5h16v14H4zM10 9l5 3-5 3z" /></svg></div>}
        {video.previewSource === 'raw' && <p className="border-t border-[#ead9b4] bg-[#fff9ed] px-4 py-2 text-xs text-[#77591f]">Aperçu du fichier brut : l’habillage ou la piste audio finale peuvent manquer.</p>}
        {(!video.previewUrl || unavailablePreviewIds.includes(video.id)) && ['ready', 'review'].includes(video.status) && <p className="border-t border-[#ead9b4] bg-[#fff9ed] px-4 py-2 text-xs text-[#77591f]">Aperçu indisponible après renouvellement : le MP4 est absent ou inaccessible dans le stockage.</p>}
        <div className="p-4"><div className="flex items-center justify-between gap-3"><StatusPill status={labels[video.status] ?? video.status} /><span className="text-xs font-semibold tabular-nums">{formatVideoPrice(video)}</span></div><h3 className="mt-3 truncate text-sm font-semibold">{video.title ?? `${video.make ?? 'Nouvelle'} ${video.model ?? 'vidéo'}`}</h3><p className="mt-1 text-xs text-[#77777d]">{formatVideoDate(video.createdAt ?? video.created_at)} · {video.durationSeconds ?? 5} s · <span className="font-medium text-[#4b4b50]">{videoMethodLabel(video)}</span></p>
          {video.status === 'ready' && video.videoUrl ? <div className="mt-4 flex flex-wrap gap-2"><a href={video.videoUrl} download onClick={(event) => event.stopPropagation()} className="inline-flex min-h-11 items-center rounded-sm bg-[#c51e1c] px-3.5 py-2.5 text-xs font-semibold text-white hover:bg-[#a71715] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c51e1c]">Télécharger le MP4</a>{role === 'collaborateur' && <button type="button" onClick={(event) => { event.stopPropagation(); void submitForValidation(video); }} className="inline-flex min-h-11 items-center rounded-sm border border-[#e2e2e5] px-3.5 py-2.5 text-xs font-semibold">Envoyer en validation</button>}</div> : video.status === 'generating' ? <p className="mt-4 text-xs text-[#626269]">{stageLabels[video.processingStage ?? 'generating'] ?? 'Génération en cours'}{video.stageElapsedSeconds != null ? ` · ${formatElapsed(video.stageElapsedSeconds)}` : ''}{video.totalQualityShots ? ` · Contrôle ${video.checkedQualityShots ?? 0}/${video.totalQualityShots} plans` : ''}. Actualisation toutes les 5 s.{(video.stageElapsedSeconds ?? 0) >= 600 ? ' Le délai est inhabituel ; vérifiez le statut avant de relancer pour éviter un doublon.' : ''}</p> : null}
          {formatStageDurations(video.processingDurations) && <p className="mt-3 text-[11px] text-[#77777e]">{video.status === 'generating' ? 'Étapes' : 'Durées'} : {formatStageDurations(video.processingDurations)}</p>}
        </div>
      </article>)}
    </div>}
    {selectedVideo && <aside className="border border-[#e2e2e5] bg-white p-5" aria-label="Détails de la vidéo sélectionnée"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#c51e1c]">Détail de la vidéo</p><h2 className="mt-1 text-lg font-semibold">{selectedVideo.title ?? 'Vidéo sans titre'}</h2></div><span className="text-xs text-[#626269]">{selectedVideo.format ?? '16:9'} · V{selectedVideo.version ?? 1} · {selectedVideo.durationSeconds ?? 5} s · {videoMethodLabel(selectedVideo)}</span></div>{selectedVideo.previewUrl && <video controls preload="metadata" src={selectedVideo.previewUrl} onError={() => { void renewExpiredPreview(selectedVideo.id); }} onLoadedMetadata={() => clearPreviewError(selectedVideo.id)} className={`mt-4 ${videoAspectClass(selectedVideo.format)} max-h-[420px] w-full bg-[#232326] object-contain`} />}{selectedVideo.previewSource === 'raw' && <p className="mt-3 border border-[#ead9b4] bg-[#fff9ed] px-4 py-2 text-xs text-[#77591f]">Aperçu du fichier brut : l’habillage ou la piste audio finale peuvent manquer.</p>}{(!selectedVideo.previewUrl || unavailablePreviewIds.includes(selectedVideo.id)) && ['ready', 'review'].includes(selectedVideo.status) && <p className="mt-3 border border-[#ead9b4] bg-[#fff9ed] px-4 py-2 text-xs text-[#77591f]">Aperçu indisponible après renouvellement : le MP4 est absent ou inaccessible dans le stockage.</p>}{selectedVideo.videoUrl && <a href={selectedVideo.videoUrl} download className="mt-4 inline-flex min-h-11 items-center rounded-sm bg-[#c51e1c] px-4 py-2.5 text-xs font-semibold text-white">Télécharger MP4</a>}</aside>}
  </>;
}
