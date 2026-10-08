'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { StatusPill } from '@/components/shell';

type Video = { id: string; videoId?: string; title?: string; make?: string; model?: string; status: string; retryablePostproduction?: boolean; createdAt?: string; created_at?: string; estimatedPriceFcfa?: number; price_fcfa?: number; priceFcfa?: number; videoUrl?: string | null; previewUrl?: string | null; finalUrl?: string };

export function VideoLibrary() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState('');

  const loadVideos = useCallback(async () => {
    const response = await fetch('/api/versions');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Impossible de charger la bibliothèque.');
    setVideos(data.versions ?? []);
  }, []);

  async function retryPostproduction(video: Video) {
    setRetrying(video.id);
    setError('');
    try {
      const response = await fetch(`/api/versions/${video.id}/refresh`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Impossible de reprendre la finalisation.');
      await loadVideos();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Une erreur est survenue.');
    } finally {
      setRetrying('');
    }
  }

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
  const tabs = [['all', 'Toutes'], ['ready', 'Prêtes'], ['generating', 'En cours'], ['failed', 'Échec']];
  const labels: Record<string, string> = { ready: 'Prête', review: 'Prête', generating: 'Génération', queued: 'Génération', failed: 'Échec', rejected: 'Échec', draft: 'Brouillon' };

  return <>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex gap-1 overflow-x-auto border border-[#e2e2e5] bg-white p-1">{tabs.map(([value, label]) => <button key={value} onClick={() => setFilter(value)} className={`whitespace-nowrap px-3 py-2 text-xs font-semibold ${filter === value ? 'bg-[#fae9e8] text-[#9c2822]' : 'text-[#626269] hover:bg-[#f4f4f5]'}`}>{label}</button>)}</div>
      <input aria-label="Rechercher une vidéo" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher…" className="w-full border border-[#e2e2e5] bg-white px-4 py-2.5 text-xs outline-none focus:border-[#c51e1c] sm:w-64" />
    </div>
    {error && <p role="alert" className="mb-5 border border-[#f0c9c6] bg-[#fae9e7] p-4 text-sm text-[#9d352e]">{error}</p>}
    {filtered.length === 0 ? <div className="border border-dashed border-[#d2d2d6] bg-white px-6 py-16 text-center"><svg aria-hidden="true" viewBox="0 0 24 24" className="mx-auto size-8 fill-none stroke-[#c51e1c]" strokeWidth="1.5"><path d="M4 5h16v14H4zM10 9l5 3-5 3z" /></svg><h2 className="mt-4 text-sm font-semibold">Aucune vidéo dans cette vue</h2><p className="mx-auto mt-2 max-w-md text-xs leading-5 text-[#626269]">Les vidéos générées apparaîtront ici avec leur aperçu, leur statut et leur prix.</p><Link href="/studio" className="mt-5 inline-flex rounded-sm bg-[#c51e1c] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#a71715]">Créer une vidéo</Link></div> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {filtered.map((video) => <article key={video.videoId ?? video.id} className="overflow-hidden border border-[#e2e2e5] bg-white">
        {video.previewUrl ? <video controls preload="metadata" src={video.previewUrl} className="aspect-video w-full bg-[#232326]" aria-label={`Aperçu de ${video.title ?? 'la vidéo'}`} /> : <div className="grid aspect-video place-items-center bg-[#eeeeef] text-[#8b8b91"><svg aria-hidden="true" viewBox="0 0 24 24" className="size-9 fill-none stroke-current" strokeWidth="1.5"><path d="M4 5h16v14H4zM10 9l5 3-5 3z" /></svg></div>}
        <div className="p-4"><div className="flex items-center justify-between gap-3"><StatusPill status={labels[video.status] ?? video.status} /><span className="text-xs font-semibold tabular-nums">{new Intl.NumberFormat('fr-FR').format(video.priceFcfa ?? video.estimatedPriceFcfa ?? video.price_fcfa ?? 0)} FCFA</span></div><h3 className="mt-3 truncate text-sm font-semibold">{video.title ?? `${video.make ?? 'Nouvelle'} ${video.model ?? 'vidéo'}`}</h3><p className="mt-1 text-[11px] text-[#77777d]">{video.createdAt ?? video.created_at ?? 'Aujourd’hui'} · 5 s</p>
          {video.status === 'ready' && video.videoUrl ? <a href={video.videoUrl} download className="mt-4 inline-flex rounded-sm bg-[#c51e1c] px-3.5 py-2.5 text-xs font-semibold text-white hover:bg-[#a71715]">Télécharger le MP4</a> : video.status === 'generating' ? <p className="mt-4 text-xs text-[#626269]">Génération en cours. Mise à jour automatique.</p> : video.retryablePostproduction ? <div className="mt-4 space-y-2"><p className="text-[11px] leading-5 text-[#626269]">La vidéo brute est conservée. Vous pouvez reprendre sa finalisation sans relancer la génération.</p><button type="button" onClick={() => void retryPostproduction(video)} disabled={retrying === video.id} className="rounded-sm bg-[#c51e1c] px-3.5 py-2.5 text-xs font-semibold text-white hover:bg-[#a71715] disabled:opacity-60">{retrying === video.id ? 'Finalisation…' : 'Reprendre la finalisation'}</button></div> : null}
        </div>
      </article>)}
    </div>}
  </>;
}
