'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { buildComparisonCsv, type ComparisonCsvRow } from '@/core/comparisons/csv';

type Model = { id: string; name: string; tier: string; adapterFamily: string; falEndpointId: string; isActive: boolean; allowedDurations: number[]; allowedFormats: string[]; priceUsdPerSecond: number };
type Asset = { id: string; make?: string; model?: string; color?: string };
type Ratings = { fidelity: number; realism: number; brandFit: number };
type Result = { modelId: string; modelName: string; versionId?: string; status: string; error?: string; videoUrl?: string; ratings?: Ratings; comment?: string; elapsedSeconds?: number; costUsd?: number; costEur?: number; costRealFcfa?: number; priceFcfa?: number; costStatus?: string };
type Comparison = { id: string; created_at: string; brief_json: { status?: string; notes?: string; brief?: { description?: string; format?: string }; results?: Result[] } };
type Props = { mode: 'mock' | 'live'; usdToEurRate: number; llmMaxCostUsd: number };
const formats = ['16:9', '9:16', '1:1'] as const;

export function ComparisonWorkspace({ mode, usdToEurRate, llmMaxCostUsd }: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [assetId, setAssetId] = useState('');
  const [description, setDescription] = useState('');
  const [format, setFormat] = useState<(typeof formats)[number]>('16:9');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  async function loadComparisons() {
    const response = await fetch('/api/comparisons');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Impossible de charger les comparaisons.');
    setComparisons(data.comparisons ?? []);
  }

  useEffect(() => {
    let current = true;
    Promise.all([
      fetch('/api/admin/models').then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Chargement des modèles impossible.'); return data.models ?? []; }),
      fetch('/api/assets?kind=vehicle&status=valid%C3%A9e').then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Chargement des véhicules impossible.'); return data.assets ?? []; }),
      fetch('/api/comparisons').then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Chargement des comparaisons impossible.'); return data.comparisons ?? []; }),
    ]).then((loaded) => {
      if (!current) return;
      const [modelRows, assetRows, comparisonRows] = loaded as [Model[], Asset[], Comparison[]];
      setModels(modelRows); setAssets(assetRows); setComparisons(comparisonRows);
      if (assetRows.length) setAssetId(assetRows[0].id);
    }).catch((caught) => { if (current) setError(caught instanceof Error ? caught.message : 'Une erreur est survenue.'); });
    return () => { current = false; };
  }, [mode]);

  useEffect(() => {
    if (!comparisons.some((comparison) => comparison.brief_json.status === 'running')) return;
    const timer = window.setInterval(() => {
      fetch('/api/comparisons').then(async (response) => { const data = await response.json(); if (response.ok) setComparisons(data.comparisons ?? []); }).catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [comparisons]);

  const compatibleModels = useMemo(() => models.filter((model) => model.isActive && (model.adapterFamily === 'veo' ? model.allowedDurations.includes(6) : model.allowedDurations.includes(5)) && model.allowedFormats.includes(format)
    && ((model.adapterFamily === 'kling' && model.falEndpointId === 'fal-ai/kling-video/o3/pro/image-to-video')
      || (model.adapterFamily === 'seedance' && model.falEndpointId === 'bytedance/seedance-2.5/image-to-video')
      || (model.adapterFamily === 'wan' && model.falEndpointId === 'alibaba/wan-3.0/image-to-video')
      || (model.adapterFamily === 'veo' && model.falEndpointId === 'fal-ai/veo3.1/fast/image-to-video' && model.allowedDurations.includes(6)))), [models, format]);
  const selectedModels = compatibleModels.filter((model) => selected.includes(model.id));
  const estimatedEur = selectedModels.reduce((sum, model) => sum + (model.adapterFamily === 'veo' ? 6 : 5) * model.priceUsdPerSecond * usdToEurRate, 0) + (selectedModels.length ? 2 * llmMaxCostUsd * usdToEurRate : 0);

  function toggle(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length < 3 ? [...current, id] : current);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      const response = await fetch('/api/comparisons', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        brief: { description, format, location, lighting: 'Lumière douce de fin de journée' }, assetId, modelIds: selected, notes,
      }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'La comparaison n’a pas pu démarrer.');
      if (mode === 'mock' && !data.comparison.brief_json.results?.length) setComparisons((current) => [data.comparison, ...current]);
      else await loadComparisons();
      setNotice(mode === 'live' ? 'Les générations ont été soumises. Retrouvez chaque résultat dans la bibliothèque.' : 'Comparaison simulée enregistrée. Aucun appel fournisseur n’a été effectué.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Une erreur est survenue.'); }
    finally { setBusy(false); }
  }

  async function saveEvaluation(comparisonId: string, result: Result, ratings: Ratings, comment: string) {
    setError('');
    const response = await fetch(`/api/comparisons/${comparisonId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: result.modelId, ratings, comment }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'La notation n’a pas pu être enregistrée.');
    if (mode === 'mock' && !data.comparison.brief_json.results?.length) return;
    await loadComparisons();
  }

  function exportCsv() {
    const rows: ComparisonCsvRow[] = comparisons.flatMap((comparison) => (comparison.brief_json.results ?? []).map((result) => ({
      comparisonId: comparison.id,
      createdAt: comparison.created_at,
      brief: comparison.brief_json.brief?.description ?? '',
      format: comparison.brief_json.brief?.format ?? '',
      model: result.modelName,
      status: result.status,
      fidelity: result.ratings?.fidelity,
      realism: result.ratings?.realism,
      brandFit: result.ratings?.brandFit,
      comment: result.comment,
      elapsedSeconds: result.elapsedSeconds,
      costUsd: result.costUsd,
      costEur: result.costEur,
      costRealFcfa: result.costRealFcfa,
      priceFcfa: result.priceFcfa,
    })));
    const csv = buildComparisonCsv(rows);
    const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'rimco-comparaisons.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  return <div className="space-y-8">
    <form onSubmit={submit} className="max-w-4xl space-y-6 border-y border-[#e4e1db] py-6">
      <div className="grid gap-5 md:grid-cols-2">
        <label className="grid content-start gap-2 text-sm font-semibold">Photo validée du véhicule
          <select value={assetId} onChange={(event) => setAssetId(event.target.value)} required className="rounded-md border border-[#d2cec6] bg-white px-3 py-3 text-sm font-normal" disabled={!assets.length}>
            {assets.map((asset) => <option key={asset.id} value={asset.id}>{[asset.make, asset.model, asset.color].filter(Boolean).join(' ') || 'Véhicule'}</option>)}
          </select>
          {!assets.length && <span className="text-xs font-normal text-[#716d66]">Ajoutez puis faites valider une photo de véhicule dans la médiathèque.</span>}
        </label>
        <fieldset><legend className="mb-2 text-sm font-semibold">Format de sortie</legend><div className="flex gap-2">{formats.map((value) => <button key={value} type="button" onClick={() => { setFormat(value); setSelected([]); }} aria-pressed={format === value} className={`rounded-md border px-3 py-2 text-sm ${format === value ? 'border-[#c51e1c] bg-[#fff5f4] text-[#831810]' : 'border-[#d2cec6]'}`}>{value}</button>)}</div></fieldset>
      </div>
      <label className="grid gap-2 text-sm font-semibold">Brief commun
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} required minLength={8} maxLength={500} rows={4} placeholder="Décrivez une scène simple pour comparer le rendu des modèles…" className="rounded-md border border-[#d2cec6] bg-[#fbfbfa] p-3 text-sm font-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c51e1c]" />
      </label>
      <label className="grid max-w-sm gap-2 text-sm font-semibold">Lieu<input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={160} placeholder="Abidjan, Plateau" className="rounded-md border border-[#d2cec6] px-3 py-3 text-sm font-normal" /></label>
      <fieldset><legend className="mb-2 text-sm font-semibold">Modèles actifs compatibles <span className="font-normal text-[#716d66]">(2 à 3)</span></legend>
        <div className="divide-y divide-[#e4e1db] border-y border-[#e4e1db]">{compatibleModels.map((model) => <label key={model.id} className="flex cursor-pointer items-center gap-3 py-3 text-sm">
          <input type="checkbox" checked={selected.includes(model.id)} onChange={() => toggle(model.id)} disabled={!selected.includes(model.id) && selected.length >= 3} className="size-4 accent-[#c51e1c]" />
          <span className="flex-1">{model.name}</span><span className="text-xs text-[#716d66]">{model.tier === 'test' ? 'Test' : model.tier} · {model.priceUsdPerSecond.toFixed(2)} USD/s</span>
        </label>)}</div>
        {compatibleModels.length < 2 && <p className="mt-3 text-xs leading-5 text-[#716d66]">Activez un second adaptateur compatible dans l’espace Admin. Wan 3.0 Test est disponible pour les ratios 16:9, 9:16 et 1:1. Veo Premium génère une source de 6 s, ensuite coupée à 5 s.</p>}
      </fieldset>
      <label className="grid gap-2 text-sm font-semibold">Notes de comparaison<textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} rows={2} className="rounded-md border border-[#d2cec6] bg-[#fbfbfa] p-3 text-sm font-normal" /></label>
      {mode === 'live' && <p className="max-w-3xl border-y border-[#e4e1db] py-3 text-xs leading-5 text-[#716d66]">Coût estimé de cette comparaison, brief LLM inclus : <strong className="text-[#253b4e]">{estimatedEur.toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})} EUR</strong>. Le coût réel sera suivi après génération; le plafond de dépense est géré par fal.ai.</p>}
      {error && <p role="alert" className="text-sm text-[#831810]">{error}</p>}{notice && <p role="status" className="text-sm text-[#35556c]">{notice}</p>}
      <button disabled={busy || selected.length < 2 || !assetId || !description.trim()} className="min-h-11 rounded-md bg-[#c51e1c] px-5 py-3 text-sm font-semibold text-white hover:bg-[#a71715] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c51e1c] disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Préparation des générations…' : mode === 'live' ? 'Lancer la comparaison' : 'Simuler la comparaison'}</button>
    </form>

    <section className="max-w-5xl"><div className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-[#e4e1db] pb-3"><h2 className="text-base font-semibold">Comparaisons récentes</h2><div className="flex items-center gap-4"><button type="button" onClick={exportCsv} disabled={!comparisons.length} className="rounded-md border border-[#d2cec6] px-3 py-2 text-xs font-semibold hover:bg-[#f4f2ee] disabled:cursor-not-allowed disabled:opacity-50">Exporter CSV</button><Link href="/bibliotheque" className="text-xs font-semibold text-[#831810] underline underline-offset-4">Ouvrir la bibliothèque</Link></div></div>
      {comparisons.length === 0 ? <p className="py-8 text-sm text-[#716d66]">Les résultats apparaîtront ici après le premier lancement.</p> : <div className="divide-y divide-[#e4e1db]">{comparisons.map((comparison) => <article key={comparison.id} className="py-4">
        <div className="flex flex-wrap justify-between gap-2"><div><h3 className="text-sm font-semibold">{comparison.brief_json.brief?.description ?? 'Comparaison de modèles'}</h3><p className="mt-1 text-xs text-[#716d66]">{comparison.brief_json.brief?.format} · {new Date(comparison.created_at).toLocaleString('fr-FR')} · {comparison.brief_json.status ?? 'Brouillon'}</p></div></div>
        <ul className="mt-3 grid gap-3 md:grid-cols-2">{(comparison.brief_json.results ?? []).map((result) => <li key={result.modelId} className="border-b border-[#e4e1db] py-4 text-xs"><div className="flex flex-wrap justify-between gap-2"><span className="font-semibold">{result.modelName}</span><span className={result.status === 'failed' ? 'text-[#831810]' : 'text-[#716d66]'}>{result.error ?? result.status}</span></div>{result.videoUrl && <video controls preload="metadata" src={result.videoUrl} className="mt-3 aspect-video w-full bg-black" aria-label={`Résultat ${result.modelName}`} />}
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[#716d66]">{result.elapsedSeconds !== undefined && <><dt>Délai</dt><dd>{result.elapsedSeconds} s</dd></>}{result.costUsd !== undefined && <><dt>Coût réel</dt><dd>{result.costUsd.toFixed(3)} USD · {result.costEur?.toFixed(2)} EUR</dd></>}{result.costRealFcfa !== undefined && <><dt>Coût réel FCFA</dt><dd>{new Intl.NumberFormat('fr-FR',{maximumFractionDigits:0}).format(result.costRealFcfa)} FCFA</dd></>}{result.priceFcfa !== undefined && <><dt>Prix facturé</dt><dd>{new Intl.NumberFormat('fr-FR',{maximumFractionDigits:0}).format(result.priceFcfa)} FCFA</dd></>}</dl>
          <ComparisonEvaluation key={`${comparison.id}-${result.modelId}-${JSON.stringify(result.ratings ?? {})}-${result.comment ?? ''}`} comparisonId={comparison.id} result={result} onSave={saveEvaluation} />
        </li>)}</ul>
      </article>)}</div>}
    </section>
  </div>;
}

function ComparisonEvaluation({ comparisonId, result, onSave }: {
  comparisonId: string;
  result: Result;
  onSave: (comparisonId: string, result: Result, ratings: Ratings, comment: string) => Promise<void>;
}) {
  const [ratings, setRatings] = useState<Ratings>(result.ratings ?? { fidelity: 0, realism: 0, brandFit: 0 });
  const [comment, setComment] = useState(result.comment ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function save() {
    if (Object.values(ratings).some((rating) => rating < 1 || rating > 5)) {
      setMessage('Attribuez une note de 1 à 5 pour chaque critère.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      await onSave(comparisonId, result, ratings, comment);
      setMessage('Évaluation enregistrée.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'La notation n’a pas pu être enregistrée.');
    } finally {
      setBusy(false);
    }
  }

  return <fieldset className="mt-4 grid gap-3 border-t border-[#e4e1db] pt-3">
    <legend className="font-semibold text-[#253b4e]">Évaluer ce résultat</legend>
    <div className="grid gap-3 sm:grid-cols-3">
      {([['fidelity', 'Fidélité véhicule'], ['realism', 'Réalisme'], ['brandFit', 'Charte RIMCO']] as const).map(([key, label]) => <label key={key} className="grid gap-1 text-[#716d66]">{label}
        <select aria-label={`${label} pour ${result.modelName}`} value={ratings[key] || ''} onChange={(event) => setRatings((current) => ({ ...current, [key]: Number(event.target.value) }))} className="min-h-10 rounded-md border border-[#d2cec6] bg-white px-2 text-[#253b4e]">
          <option value="">À noter</option>{[1, 2, 3, 4, 5].map((score) => <option key={score} value={score}>{score} / 5</option>)}
        </select>
      </label>)}
    </div>
    <label className="grid gap-1 text-[#716d66]">Commentaire<textarea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1000} rows={2} className="rounded-md border border-[#d2cec6] bg-white p-2 text-[#253b4e]" /></label>
    <div className="flex flex-wrap items-center gap-3"><button type="button" onClick={() => void save()} disabled={busy} className="min-h-10 rounded-md border border-[#d2cec6] px-3 py-2 font-semibold text-[#253b4e] hover:bg-[#f4f2ee] disabled:opacity-50">{busy ? 'Enregistrement…' : 'Enregistrer la note'}</button>{message && <p role="status" className="text-[#716d66]">{message}</p>}</div>
  </fieldset>;
}
