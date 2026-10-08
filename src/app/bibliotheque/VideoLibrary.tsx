'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { StatusPill } from '@/components/shell';

type Video = { id: string; videoId?: string; title?: string; make?: string; model?: string; status: string; durationSeconds?: number; createdAt?: string; created_at?: string; estimatedPriceFcfa?: number; price_fcfa?: number; priceFcfa?: number; videoUrl?: string | null; previewUrl?: string | null; finalUrl?: string };
const isVideoInProgress = (status: string) => ['queued', 'generating', 'postprocessing'].includes(status);

export function VideoLibrary() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);

  const loadVideos = useCallback(async () => {
    const response = await fetch('/api/versions');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Impossible de charger la bibliothèque.');
    setVideos(data.versions ?? []);
    const visibleIds = new Set((data.versions ?? []).map((video: Video) => video.videoId ?? video.id));
    setSelectedIds((current) => current.filter((id) => visibleIds.has(id)));
  }, []);

  useEffect(() => { loadVideos().catch((cause) => setError(cause instanceof Error ? cause.message : 'Une erreur est survenue.')); }, [loadVideos]);
  useEffect(() => {
    if (!videos.some((video) => video.status === 'generating')) return;
    const timer = window.setInterval(async () => {
      const pending = videos.filter((video) => video.status === 'generating');
      await Promise.all(pending.map((video) => fetch(`/api/versions/${video.id}/refresh`).catch(() => undefined)));
      try { await loadVideos(); } catch { /* Keep the last known videos visible during brief network interruptions. */ }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [loadVideos, videos]);

  const filtered = useMemo(() => videos.filter((video) =>
    (filter === 'all' || video.status === filter) && `${video.title ?? ''} ${video.make ?? ''} ${video.model ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  ), [videos, filter, query]);
  const selectedVideos = videos.filter((video) => selectedIds.includes(video.videoId ?? video.id));
  const selectableVisibleIds = filtered.filter((video) => !isVideoInProgress(video.status)).map((video) => video.videoId ?? video.id);
  const allVisibleSelected = selectableVisibleIds.length > 0 && selectableVisibleIds.every((id) => selectedIds.includes(id));
  const tabs = [['all', 'Toutes'], ['ready', 'Prêtes'], ['generating', 'En cours'], ['failed', 'Échec']];
  const labels: Record<string, string> = { ready: 'Prête', review: 'Prête', generating: 'Génération', queued: 'Génération', failed: 'Échec', rejected: 'Échec', draft: 'Brouillon' };

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

  return <>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex gap-1 overflow-x-auto border border-[#e2e2e5] bg-white p-1">{tabs.map(([value, label]) => <button key={value} onClick={() => setFilter(value)} className={`whitespace-nowrap px-3 py-2 text-xs font-semibold ${filter === value ? 'bg-[#fae9e8] text-[#9c2822]' : 'text-[#626269] hover:bg-[#f4f4f5]'}`}>{label}</button>)}</div>
      <input aria-label="Rechercher une vidéo" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher…" className="w-full border border-[#e2e2e5] bg-white px-4 py-2.5 text-xs outline-none focus:border-[#c51e1c] sm:w-64" />
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
    {notice && <p role="status" className="mb-5 border border-[#d7e7da] bg-[#f2f8f3] p-4 text-sm text-[#315c39]">{notice}</p>}
    {filtered.length === 0 ? <div className="border border-dashed border-[#d2d2d6] bg-white px-6 py-16 text-center"><svg aria-hidden="true" viewBox="0 0 24 24" className="mx-auto size-8 fill-none stroke-[#c51e1c]" strokeWidth="1.5"><path d="M4 5h16v14H4zM10 9l5 3-5 3z" /></svg><h2 className="mt-4 text-sm font-semibold">Aucune vidéo dans cette vue</h2><p className="mx-auto mt-2 max-w-md text-xs leading-5 text-[#626269]">Les vidéos générées apparaîtront ici avec leur aperçu, leur statut et leur prix.</p><Link href="/studio" className="mt-5 inline-flex rounded-sm bg-[#c51e1c] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#a71715]">Créer une vidéo</Link></div> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {filtered.map((video) => <article key={video.videoId ?? video.id} className="overflow-hidden border border-[#e2e2e5] bg-white">
        <div className="flex min-h-11 items-center justify-between border-b border-[#e2e2e5] px-4">
          <label className={`inline-flex min-h-11 items-center gap-2 text-xs font-medium ${isVideoInProgress(video.status) ? 'cursor-not-allowed text-[#8b8b91]' : 'cursor-pointer text-[#333338]'}`}>
            <input type="checkbox" checked={selectedIds.includes(video.videoId ?? video.id)} disabled={isVideoInProgress(video.status)} onChange={() => toggleSelected(video.videoId ?? video.id)} aria-label={`Sélectionner ${video.title ?? 'la vidéo'}`} className="size-4 accent-[#c51e1c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c51e1c] disabled:cursor-not-allowed" />
            {isVideoInProgress(video.status) ? 'Génération en cours' : 'Sélectionner'}
          </label>
        </div>
        {video.previewUrl ? <video controls preload="metadata" src={video.previewUrl} className="aspect-video w-full bg-[#232326]" aria-label={`Aperçu de ${video.title ?? 'la vidéo'}`} /> : <div className="grid aspect-video place-items-center bg-[#eeeeef] text-[#8b8b91"><svg aria-hidden="true" viewBox="0 0 24 24" className="size-9 fill-none stroke-current" strokeWidth="1.5"><path d="M4 5h16v14H4zM10 9l5 3-5 3z" /></svg></div>}
        <div className="p-4"><div className="flex items-center justify-between gap-3"><StatusPill status={labels[video.status] ?? video.status} /><span className="text-xs font-semibold tabular-nums">{new Intl.NumberFormat('fr-FR').format(video.priceFcfa ?? video.estimatedPriceFcfa ?? video.price_fcfa ?? 0)} FCFA</span></div><h3 className="mt-3 truncate text-sm font-semibold">{video.title ?? `${video.make ?? 'Nouvelle'} ${video.model ?? 'vidéo'}`}</h3><p className="mt-1 text-[11px] text-[#77777d]">{video.createdAt ?? video.created_at ?? 'Aujourd’hui'} · {video.durationSeconds ?? 5} s</p>
          {video.status === 'ready' && video.videoUrl ? <a href={video.videoUrl} download className="mt-4 inline-flex rounded-sm bg-[#c51e1c] px-3.5 py-2.5 text-xs font-semibold text-white hover:bg-[#a71715]">Télécharger le MP4</a> : video.status === 'generating' ? <p className="mt-4 text-xs text-[#626269]">Génération en cours. Mise à jour automatique.</p> : null}
        </div>
      </article>)}
    </div>}
  </>;
}
