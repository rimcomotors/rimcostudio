'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  getScenePresets,
  getScenePreset,
  inferVehicleCategory,
  vehicleCategories,
  vehicleCategoryLabels,
  type VehicleCategory,
} from '@/core/scenes/catalog';
import { formatFcfa } from '@/core/pricing';

type Format = '16:9' | '9:16' | '1:1' | '4:5';
type Asset = { id: string; make?: string; model?: string; color?: string; previewUrl?: string | null };
type AudioAsset = { id: string; variant?: string };
type Job = { id: string; status: string; error?: string; prompt?: string };
type Model = { id: string; name: string; tier: string; adapterFamily: string; formats: Format[]; durations: number[]; estimatedPricesFcfa: Record<string, number>; isDefault: boolean };
type Complexity = 'simple' | 'balanced' | 'rich';

const lightOptions = [
  'Lumière naturelle claire du matin',
  'Lumière douce de fin de journée',
  'Nuit urbaine avec éclairage doux et réaliste',
  'Ciel couvert lumineux',
];
const characterOptions = [
  { value: '', label: 'Sans personnage · recommandé pour le premier test' },
  { value: 'Une dirigeante ou un dirigeant en tenue professionnelle, en arrière-plan, à proximité du véhicule', label: 'Dirigeant ou dirigeante' },
  { value: 'Une conductrice ou un conducteur naturel, visible à travers la vitre', label: 'Conductrice ou conducteur' },
  { value: 'Deux personnes en tenue professionnelle, discrètes et naturelles, à proximité du véhicule', label: 'Deux personnes en arrière-plan' },
];

export function StudioComposer({ mode, isAdmin: _isAdmin }: { mode: 'mock' | 'live'; isAdmin: boolean }) {
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [audioAssets, setAudioAssets] = useState<AudioAsset[]>([]);
  const [audioAssetId, setAudioAssetId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [description, setDescription] = useState('');
  const [title, setTitle] = useState('');
  const [vehicleCategory, setVehicleCategory] = useState<VehicleCategory>('autre');
  const [scenePresetId, setScenePresetId] = useState('other-urban-day');
  const [location, setLocation] = useState('Abidjan, rue calme et contemporaine');
  const [setting, setSetting] = useState('Architecture sobre, voie dégagée et arrière-plan peu chargé');
  const [character, setCharacter] = useState('');
  const [lighting, setLighting] = useState(lightOptions[0]);
  const [cameraMovement, setCameraMovement] = useState('Travelling trois-quarts avant, stable et sans coupe');
  const [vehicleAction, setVehicleAction] = useState('Le véhicule avance lentement et régulièrement');
  const [mood, setMood] = useState('Moderne, naturel et rassurant');
  const [format, setFormat] = useState<Format>('16:9');
  const [tier, setTier] = useState('standard');
  const [durationS, setDurationS] = useState(5);
  const [complexity, setComplexity] = useState<Complexity>('simple');
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedAsset = assets.find((asset) => asset.id === assetId);
  const allScenes = useMemo(() => getScenePresets(), []);
  const categoryScenes = useMemo(() => getScenePresets(vehicleCategory), [vehicleCategory]);
  const selectedScene = allScenes.find((scene) => scene.id === scenePresetId) ?? categoryScenes[0];
  const compatibleModels = availableModels.filter((model) => model.tier === tier);
  const targetFamily = tier === 'standard' ? durationS === 5 ? 'wan' : 'kling' : durationS === 5 ? 'veo' : 'seedance';
  const routedModel = compatibleModels.find((model) => model.adapterFamily === targetFamily);
  const selectedModel = routedModel;
  const estimatedPrice = selectedModel?.estimatedPricesFcfa?.[String(durationS)];
  const priceLabel = mode === 'live' && estimatedPrice ? `≈ ${formatFcfa(estimatedPrice)}` : mode === 'mock' ? 'Simulation' : '—';

  useEffect(() => {
    if (selectedModel && !selectedModel.formats.includes(format)) setFormat(selectedModel.formats[0] ?? '16:9');
  }, [selectedModel, format]);

  function applyScene(sceneId: string) {
    const scene = getScenePreset(sceneId);
    if (!scene) return;
    setScenePresetId(scene.id);
    setLocation(scene.location);
    setSetting(scene.setting);
    setLighting(scene.lighting);
    setVehicleAction(scene.vehicleAction);
    setCameraMovement(scene.cameraMovement);
    setMood(scene.mood);
    setCharacter(scene.character ?? '');
  }

  function chooseCategory(value: VehicleCategory) {
    setVehicleCategory(value);
    const firstScene = getScenePresets(value)[0];
    if (firstScene) applyScene(firstScene.id);
  }

  function chooseAsset(asset: Asset) {
    setAssetId(asset.id);
    const category = inferVehicleCategory(asset.make, asset.model);
    setVehicleCategory(category);
    const firstScene = getScenePresets(category)[0];
    if (firstScene) applyScene(firstScene.id);
  }

  useEffect(() => {
    if (mode !== 'live') return;
    let active = true;
    fetch('/api/models/available')
      .then(async (response) => response.ok ? response.json() : { models: [] })
      .then((data) => {
        if (!active) return;
        const models: Model[] = data.models ?? [];
        setAvailableModels(models);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [mode]);

  useEffect(() => {
    let active = true;
    fetch('/api/assets?kind=vehicle&status=valid%C3%A9e')
      .then(async (response) => response.ok ? response.json() : { assets: [] })
      .then((data) => {
        if (!active) return;
        const list: Asset[] = data.assets ?? [];
        setAssets(list);
        const firstAsset = list[0];
        if (firstAsset) {
          const category = inferVehicleCategory(firstAsset.make, firstAsset.model);
          const firstScene = getScenePresets(category)[0];
          setAssetId(firstAsset.id);
          setVehicleCategory(category);
          if (firstScene) {
            setScenePresetId(firstScene.id);
            setLocation(firstScene.location);
            setSetting(firstScene.setting);
            setLighting(firstScene.lighting);
            setVehicleAction(firstScene.vehicleAction);
            setCameraMovement(firstScene.cameraMovement);
            setMood(firstScene.mood);
            setCharacter(firstScene.character ?? '');
          }
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/assets?kind=audio&status=valid%C3%A9e')
      .then(async (response) => response.ok ? response.json() : { assets: [] })
      .then((data) => { if (active) setAudioAssets(data.assets ?? []); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const jobId = job?.id;
  useEffect(() => {
    if (!jobId || !job || ['ready', 'failed'].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/versions/${jobId}/refresh`);
        const data = await response.json();
        if (response.ok) setJob((previous) => previous ? { ...previous, ...data } : previous);
      } catch { /* The next polling tick retries transient network errors. */ }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [job, jobId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const response = await fetch('/api/versions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          description, title, assetId, audioAssetId: audioAssetId || null, location, setting, character, lighting,
          cameraMovement, vehicleAction, mood, vehicleCategory, scenePresetId, format, tier, durationS, complexity,
          ...(mode === 'live' && routedModel ? { modelId: routedModel.id } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'La génération n’a pas pu démarrer.');
      setJob({ id: data.id, status: data.status, prompt: data.prompt });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  const tierOptions = [
    { value: 'standard', label: 'Standard', description: 'Modèles et tarifs adaptés à la durée' },
    ...(mode === 'live' ? (availableModels.some((model) => model.tier === 'premium') ? [{ value: 'premium', label: 'Premium', description: 'Veo en 5 s · Seedance en 10 à 30 s' }] : []) : [{ value: 'premium', label: 'Premium', description: 'Simulation' }]),
  ];

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_350px]">
      <form onSubmit={submit} className="space-y-6 rounded-md border border-black/[.055] bg-white p-6 md:p-8">
        <section>
          <h2 className="text-sm font-semibold">1. Véhicule de référence</h2>
          <p className="mt-1 text-xs text-[#99958e]">La scène est suggérée selon le véhicule choisi. Vous pouvez la modifier.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {assets.map((asset) => (
              <button type="button" key={asset.id} onClick={() => chooseAsset(asset)} className={`flex items-center gap-3 rounded-md border p-3 text-left ${asset.id === assetId ? 'border-[#c51e1c] bg-[#fcf6f4]' : 'border-[#eceae6]'}`}>
                <span className="grid size-12 shrink-0 place-items-center overflow-hidden bg-[#f1f1f2]">
                  {asset.previewUrl ? <Image src={asset.previewUrl} alt={`${asset.make ?? 'Véhicule'} ${asset.model ?? ''}`} width={48} height={48} unoptimized className="size-full object-cover" /> : <span aria-hidden="true" className="text-xl text-[#831810]">◈</span>}
                </span>
                <span><b className="block text-xs">{asset.make} {asset.model}</b><small className="mt-1 block text-[10px] text-[#99958e]">{asset.color ?? 'Photo validée'}</small></span>
              </button>
            ))}
          </div>
          {!assets.length && <Link href="/mediatheque" className="mt-3 flex justify-center rounded-md border border-dashed border-[#dad7d1] bg-[#fcfcfb] px-4 py-6 text-sm text-[#817d76]">＋ Ajoutez et faites valider votre première photo</Link>}
          {assets.length > 0 && <Link href="/mediatheque" className="mt-2 inline-block text-xs font-semibold text-[#ae332b]">Ajouter un autre véhicule ↗</Link>}
        </section>

        <section className="space-y-4 border-t border-[#eeeae4] pt-5">
          <label className="grid gap-2 text-xs font-semibold">Titre de la vidéo<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="Ex. Starlight EV · lancement Abidjan" className="rounded-md border border-[#e9e7e2] bg-white px-3 py-3 text-sm font-normal outline-none focus:border-[#c51e1c]" /><span className="font-normal text-[#88847d]">Ce titre apparaîtra dans la Bibliothèque et le suivi de facturation.</span></label>
          <div>
            <h2 className="text-sm font-semibold">2. Choisir une scène</h2>
            <p className="mt-1 text-xs text-[#99958e]">Toutes les scènes restent disponibles pour chaque véhicule. Le type sert seulement à mettre en avant les suggestions.</p>
          </div>
          <label className="grid gap-2 text-xs font-semibold">Type de véhicule
            <select value={vehicleCategory} onChange={(event) => chooseCategory(event.target.value as VehicleCategory)} className="rounded-md border border-[#e9e7e2] bg-white px-3 py-3 text-sm font-normal">
              {vehicleCategories.map((category) => <option key={category} value={category}>{vehicleCategoryLabels[category]}</option>)}
            </select>
          </label>
          <label className="grid gap-2 text-xs font-semibold">Scène recommandée
            <select value={selectedScene?.id ?? ''} onChange={(event) => applyScene(event.target.value)} className="rounded-md border border-[#e9e7e2] bg-white px-3 py-3 text-sm font-normal">
              <optgroup label="Recommandées pour ce véhicule">
                {categoryScenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.label}</option>)}
              </optgroup>
              <optgroup label="Autres scènes">
                {allScenes.filter((scene) => scene.category !== vehicleCategory).map((scene) => <option key={scene.id} value={scene.id}>{scene.label}</option>)}
              </optgroup>
            </select>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-semibold">Lieu<input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={160} className="mt-2 w-full rounded-md border border-[#e9e7e2] px-3 py-3 text-sm font-normal outline-none focus:border-[#c51e1c]" /></label>
            <label className="text-xs font-semibold">Décor<input value={setting} onChange={(event) => setSetting(event.target.value)} maxLength={160} className="mt-2 w-full rounded-md border border-[#e9e7e2] px-3 py-3 text-sm font-normal outline-none focus:border-[#c51e1c]" /></label>
            <label className="text-xs font-semibold">Moment et lumière<select value={lighting} onChange={(event) => setLighting(event.target.value)} className="mt-2 w-full rounded-md border border-[#e9e7e2] bg-white px-3 py-3 text-sm font-normal">{lightOptions.map((option) => <option key={option}>{option}</option>)}</select></label>
            <label className="text-xs font-semibold">Personnage<select value={character} onChange={(event) => setCharacter(event.target.value)} className="mt-2 w-full rounded-md border border-[#e9e7e2] bg-white px-3 py-3 text-sm font-normal">{characterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label className="text-xs font-semibold">Mouvement caméra<input value={cameraMovement} onChange={(event) => setCameraMovement(event.target.value)} maxLength={160} className="mt-2 w-full rounded-md border border-[#e9e7e2] px-3 py-3 text-sm font-normal outline-none focus:border-[#c51e1c]" /></label>
            <label className="text-xs font-semibold">Action du véhicule<input value={vehicleAction} onChange={(event) => setVehicleAction(event.target.value)} maxLength={160} className="mt-2 w-full rounded-md border border-[#e9e7e2] px-3 py-3 text-sm font-normal outline-none focus:border-[#c51e1c]" /></label>
          </div>
          <label className="grid gap-2 text-xs font-semibold">Précision complémentaire <span className="font-normal text-[#88847d]">Facultative · le lieu, l’action et la caméra sont déjà renseignés</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} rows={2} placeholder="Ex. La voiture s’arrête doucement devant l’entrée." className="w-full resize-y rounded-md border border-[#e9e7e2] bg-[#fcfcfb] p-3 text-sm font-normal leading-6 outline-none focus:border-[#c51e1c]" />
          </label>
        </section>

        <section className="space-y-4 border-t border-[#eeeae4] pt-5">
          <fieldset><legend className="mb-2 text-xs font-semibold">Niveau de génération</legend><div className="grid gap-2 sm:grid-cols-2">{tierOptions.map(({ value, label, description: tierDescription }) => <button type="button" key={value} onClick={() => { setTier(value); if (value === 'standard' && durationS > 15) setDurationS(15); }} className={`rounded-lg border px-3 py-3 text-left ${tier === value ? 'border-[#c51e1c] bg-[#fcf4f2]' : 'border-[#e9e7e2]'}`}><b className="block text-xs">{label}</b><small className="mt-1 block text-[10px] leading-4 text-[#938f89]">{tierDescription}</small></button>)}</div></fieldset>
          {mode === 'live' && <p className="rounded-md bg-[#f8f7f4] px-3 py-2.5 text-xs text-[#716d66]">Modèle sélectionné automatiquement : <b>{routedModel?.name ?? 'Indisponible'}</b> selon le niveau et la durée.</p>}
          <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="sm:col-span-2"><legend className="mb-2 text-xs font-semibold">Durée et montant probable</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(tier === 'standard' ? [5,10,15] : [5,10,15,20,30]).filter((seconds) => mode === 'mock' || availableModels.some((model) => model.tier === tier && model.adapterFamily === (tier === 'standard' ? seconds === 5 ? 'wan' : 'kling' : seconds === 5 ? 'veo' : 'seedance') && model.durations.includes(seconds))).map((seconds) => { const family = tier === 'standard' ? seconds === 5 ? 'wan' : 'kling' : seconds === 5 ? 'veo' : 'seedance'; const durationModel = compatibleModels.find((model) => model.adapterFamily === family); const price = durationModel?.estimatedPricesFcfa[String(seconds)]; return <button type="button" key={seconds} onClick={() => setDurationS(seconds)} className={`rounded-lg border px-3 py-3 text-left ${durationS === seconds ? 'border-[#c51e1c] bg-[#fcf4f2]' : 'border-[#e9e7e2]'}`}><b className="block text-xs">{seconds} secondes</b><small className="mt-1 block text-[10px] text-[#79756f]">{price ? `≈ ${formatFcfa(price)}` : mode === 'mock' ? 'Simulation' : 'Estimation indisponible'}</small></button>; })}</div><span className="mt-2 block text-[10px] font-normal leading-4 text-[#88847d]">Estimation FCFA calculée selon le modèle et sa durée. Le montant final peut varier.</span></fieldset>
            <label className="grid gap-2 text-xs font-semibold">Complexité de la scène<select value={complexity} onChange={(event) => setComplexity(event.target.value as Complexity)} className="rounded-md border border-[#e9e7e2] bg-white px-3 py-3 text-sm font-normal"><option value="simple">Simple · une action, un mouvement caméra</option><option value="balanced">Équilibrée · deux temps visuels liés</option><option value="rich">Riche · jusqu’à trois temps coordonnés</option></select><span className="font-normal text-[#88847d]">Le prompt adapte le rythme à la durée, sans changer de plan.</span></label>
          </div>
          <fieldset><legend className="mb-2 text-xs font-semibold">Format</legend><div className="flex flex-wrap gap-2">{(mode === 'live' ? selectedModel?.formats ?? ['16:9', '9:16'] : ['16:9', '9:16', '1:1', '4:5']).map((value) => <button type="button" key={value} onClick={() => setFormat(value as Format)} className={`rounded-lg border px-3 py-2 text-xs ${format === value ? 'border-[#c51e1c] bg-[#fcf4f2] text-[#a62b24]' : 'border-[#e9e7e2] text-[#79756f]'}`}>{value}</button>)}</div></fieldset>
          <label className="grid gap-2 text-xs font-semibold">Piste audio <span className="font-normal text-[#88847d]">Optionnelle · ajoutée après la génération</span>
            <select value={audioAssetId} onChange={(event) => setAudioAssetId(event.target.value)} className="rounded-md border border-[#e9e7e2] bg-white px-3 py-3 text-sm font-normal"><option value="">Sans musique</option>{audioAssets.map((audio, index) => <option key={audio.id} value={audio.id}>{audio.variant || `Piste audio ${index + 1}`}</option>)}</select>
            {!audioAssets.length && <span className="font-normal text-[#88847d]">Aucune piste validée disponible. Ajoutez-en une dans la médiathèque.</span>}
          </label>
          <p className="text-xs text-[#716d66]">Le prompt conserve l’identité du véhicule et ajuste le déroulé à la durée et à la complexité choisies.</p>
          {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          <button disabled={busy || !assetId || mode === 'live' && (!routedModel || !estimatedPrice)} className="w-full rounded-md bg-[#c51e1c] py-3.5 text-sm font-semibold text-white transition hover:bg-[#a71715] disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Préparation…' : `Générer ma vidéo · ${priceLabel}`}</button>
        </section>
      </form>

      <aside className="space-y-4">
        <section className="rounded-md border border-[#e2e2e5] bg-white p-6 text-[#161619]">
          <p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#c51e1c]">Résumé de la scène</p>
          <div className="mt-5 grid aspect-video place-items-center overflow-hidden border border-[#e2e2e5] bg-[#f1f1f2]">{selectedAsset?.previewUrl ? <Image src={selectedAsset.previewUrl} alt={`Aperçu de ${selectedAsset.make ?? ''} ${selectedAsset.model ?? ''}`} width={640} height={360} unoptimized className="size-full object-cover" /> : <span className="text-4xl text-[#c51e1c]" aria-hidden="true">▷</span>}</div>
          <h3 className="mt-4 text-sm font-semibold">{selectedAsset ? `${selectedAsset.make ?? 'Véhicule'} ${selectedAsset.model ?? ''}` : 'Choisissez un véhicule'}</h3>
          <div className="mt-4 space-y-2 border-t border-[#e2e2e5] pt-4 text-xs">
            <p><span className="text-[#77736d]">Scène</span><br /><b>{selectedScene?.label ?? 'Scène personnalisée'}</b></p>
            <p><span className="text-[#77736d]">Lieu</span><br />{location || 'À préciser'}</p>
            <p><span className="text-[#77736d]">Action / caméra</span><br />{vehicleAction} · {cameraMovement}</p>
            <p><span className="text-[#77736d]">Personnage</span><br />{characterOptions.find((option) => option.value === character)?.label ?? 'Sans personnage'}</p>
            <div className="flex justify-between border-t border-[#eeeae4] pt-3"><span className="text-[#77736d]">Durée</span><b>{durationS} secondes · plan continu</b></div>
            <div className="flex justify-between"><span className="text-[#77736d]">Complexité</span><b>{complexity === 'simple' ? 'Simple' : complexity === 'balanced' ? 'Équilibrée' : 'Riche'}</b></div>
            <div className="flex justify-between"><span className="text-[#77736d]">Montant probable</span><b>{priceLabel}</b></div>
            {mode === 'live' && <p className="text-[10px] leading-4 text-[#88847d]">Estimation indicative, selon le modèle et sa durée. Le montant final peut varier.</p>}
          </div>
        </section>
        {job && <section className="rounded-md border border-black/[.055] bg-white p-5"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">État de la vidéo</h3><span className="text-[10px] font-semibold uppercase text-[#a47731]">{job.status === 'ready' ? 'Prête' : job.status === 'failed' ? 'Échec' : 'En cours'}</span></div><p className="mt-2 text-xs text-[#88847d]">{job.status === 'ready' ? 'Votre vidéo est prête à consulter.' : job.error ?? 'Actualisation automatique toutes les 10 secondes.'}</p>{job.prompt && <details className="mt-4 border-t border-[#eeeae4] pt-3"><summary className="cursor-pointer text-xs font-semibold text-[#716d66]">Voir le prompt généré</summary><p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[#77736d]">{job.prompt}</p></details>}{job.status === 'ready' && <Link href="/bibliotheque" className="mt-4 block rounded-lg bg-[#c51e1c] px-3 py-2.5 text-center text-xs font-semibold text-white">Voir ma vidéo →</Link>}</section>}
        <section className="rounded-md border border-[#eee3d2] bg-[#fbf6ed] p-5"><p className="text-xs font-semibold text-[#765d39]">Fidélité au véhicule</p><p className="mt-2 text-xs leading-5 text-[#8d806b]">La photo fixe le modèle, la couleur et les proportions. Pour un premier essai, gardez une scène simple et sans figurant.</p></section>
      </aside>
    </div>
  );
}
