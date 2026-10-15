'use client';

import { useCallback, useEffect, useState } from 'react';

type Item = { id: string; title?: string; status: string; durationSeconds?: number; tier?: 'standard' | 'pro' | 'premium' | 'test'; modelName?: string; workflow?: 'multi_clip' | 'single'; previewUrl?: string | null; createdAt?: string; validationId?: string; version?: number; department?: string; userId?: string };

export function ValidationQueue() {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Item | null>(null);
  const load = useCallback(async () => {
    const response = await fetch('/api/versions?status=review');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Impossible de charger les vidéos à valider.');
    setItems(data.versions ?? []);
  }, []);
  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Une erreur est survenue.')); }, [load]);
  async function review(item: Item, status: 'approved' | 'rejected') {
    const validationId = item.validationId;
    if (!validationId) { setError('Cette demande ne contient pas de référence de validation.'); return; }
    const reason = status === 'rejected' ? window.prompt('Motif du refus')?.trim() : undefined;
    if (status === 'rejected' && !reason) return;
    setBusy(item.id);
    try {
      const response = await fetch(`/api/validations/${validationId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status, reason }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'La décision n’a pas pu être enregistrée.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Une erreur est survenue.'); } finally { setBusy(''); }
  }
  return <section className="space-y-3" aria-live="polite">
    {error && <p role="alert" className="border border-[#f0c9c6] bg-[#fae9e7] p-4 text-sm text-[#9d352e]">{error}</p>}
    {items.length === 0 ? <div className="border border-dashed border-[#d2d2d6] bg-white px-6 py-16 text-center"><h2 className="text-sm font-semibold">Aucune vidéo à valider</h2><p className="mt-2 text-xs text-[#626269]">Les nouvelles demandes de votre périmètre apparaîtront ici.</p></div> : items.map((item) => <article key={item.id} className="flex flex-wrap items-center gap-4 border border-[#e2e2e5] bg-white p-4 md:flex-nowrap">
      {item.previewUrl ? <video src={item.previewUrl} muted preload="metadata" className="h-20 w-32 rounded-sm object-cover" aria-label={`Aperçu de ${item.title ?? 'la vidéo'}`} /> : <div className="grid h-20 w-32 place-items-center bg-[#eeeeef] text-xs text-[#77777d]">Aperçu indisponible</div>}
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{item.title ?? 'Vidéo sans titre'}</h2><p className="mt-1 text-xs text-[#626269]">{item.workflow === 'multi_clip' ? `Multi-plans · ${item.tier === 'pro' ? 'Pro' : item.tier === 'premium' ? 'Premium' : 'Standard'}` : item.tier ? `${item.tier === 'pro' ? 'Pro' : item.tier === 'premium' ? 'Premium' : item.tier === 'test' ? 'Test' : 'Standard'}` : 'Standard'}{item.modelName ? ` · ${item.modelName}` : ''} · {item.durationSeconds ?? 5} s · {item.createdAt ? new Date(item.createdAt).toLocaleDateString('fr-FR') : 'Date inconnue'}</p></div>
      <div className="flex items-center gap-2"><button type="button" onClick={() => setSelected(item)} className="min-h-10 rounded-full border border-[#e2e2e5] px-4 text-xs font-semibold">Voir</button><button type="button" disabled={Boolean(busy)} onClick={() => void review(item, 'approved')} className="min-h-10 rounded-full bg-[#247a4d] px-4 text-xs font-semibold text-white disabled:opacity-50">{busy === item.id ? '…' : 'Approuver'}</button><button type="button" disabled={Boolean(busy)} onClick={() => void review(item, 'rejected')} className="min-h-10 rounded-full border border-[#e2e2e5] px-4 text-xs font-semibold disabled:opacity-50">Refuser</button></div>
    </article>)}
    {selected && <div role="dialog" aria-modal="true" aria-labelledby="validation-preview-title" className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setSelected(null)}><section className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#c51e1c]">Aperçu de validation</p><h2 id="validation-preview-title" className="mt-1 text-lg font-semibold">{selected.title ?? 'Vidéo sans titre'}</h2><p className="mt-1 text-xs text-[#626269]">{selected.workflow === 'multi_clip' ? `Multi-plans · ${selected.tier === 'pro' ? 'Pro' : selected.tier === 'premium' ? 'Premium' : 'Standard'}` : selected.tier === 'pro' ? 'Pro' : selected.tier === 'premium' ? 'Premium' : selected.tier === 'test' ? 'Test' : 'Standard'}{selected.modelName ? ` · ${selected.modelName}` : ''} · V{selected.version ?? 1} · {selected.durationSeconds ?? 5} s · {selected.createdAt ? new Date(selected.createdAt).toLocaleDateString('fr-FR') : 'Date inconnue'}</p></div><button type="button" onClick={() => setSelected(null)} aria-label="Fermer l’aperçu" className="rounded-full border border-[#e2e2e5] px-3 py-1.5 text-xs font-semibold">Fermer</button></div>{selected.previewUrl ? <video src={selected.previewUrl} controls autoPlay className="mt-5 max-h-[60vh] w-full rounded-lg bg-[#232326]" /> : <p className="mt-5 rounded-lg bg-[#f5f5f3] p-8 text-center text-sm text-[#77777d]">Aperçu indisponible.</p>}</section></div>}
  </section>;
}
