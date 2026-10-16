'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { formatFcfa } from '@/core/pricing';
import { getScenePresets, getScenePreset, inferVehicleCategory } from '@/core/scenes/catalog';
import { getRouteForGeneration } from '@/core/providers/model-routing';

type Format = '16:9' | '9:16';
type Job = { id: string; status: string; error?: string; prompt?: string; completedShots?: number; totalShots?: number };
type Model = { id: string; name: string; tier: string; adapterFamily: string; formats: Format[]; durations: number[]; estimatedPricesFcfa: Record<string, number>; isDefault: boolean; isReference: boolean };
type VehicleDossier = { id: string | null; key: string; dossierIds?: string[]; make: string; model: string; color?: string | null; variant?: string | null; photos: Array<{ id: string; photoRole: string; title: string; angle?: string | null; previewUrl?: string | null }> };
type PlaceAsset = { id: string; title?: string; category?: string; previewUrl?: string | null; isCurated?: boolean };
type StoryShot = { title: string; scene: string; framing: string; location: string; action: string; camera: string; durationSeconds: number; vehiclePhotoId: string; locationPhotoId?: string | null };
type ComparisonJob = { mode: 'standard' | 'pro'; id?: string; status: string; completedShots?: number; totalShots?: number; error?: string };
const durationOptions = [5, 10, 15, 20];
const lightOptions = ['Lumière naturelle claire du matin'];

function getLightingLabel(lighting: string): string {
  const normalized = lighting.toLocaleLowerCase('fr');
  if (normalized.includes('lever du jour')) return 'Lever du jour';
  if (normalized.includes('fin de journée')) return 'Fin de journée';
  if (normalized.includes('nuit')) return 'Nuit';
  if (normalized.includes('soirée')) return 'Soirée';
  if (normalized.includes('intérieur')) return 'Intérieur';
  if (normalized.includes('matin')) return 'Matin';
  return lighting;
}

const characterOptions = [
  { value: '', label: 'Sans personnage · recommandé pour le premier test' },
  { value: 'Une conductrice ou un conducteur naturel, visible à travers la vitre', label: 'Conductrice ou conducteur' },
  { value: 'Une personne en tenue professionnelle, discrète et naturelle, à proximité du véhicule', label: 'Personne en arrière-plan' },
];

function buildAutomaticShots(input: {
  vehicle: VehicleDossier;
  places: PlaceAsset[];
  placeIds: string[];
  durationSeconds: number;
  multiClip: boolean;
  tier: 'standard' | 'pro' | 'premium';
  selectedPhotoId?: string;
}): StoryShot[] {
  const minClipSeconds = input.tier === 'standard' ? 2 : input.tier === 'pro' ? 3 : 4;
  const chosenPlaces = input.placeIds.map((id) => input.places.find((place) => place.id === id)).filter((place): place is PlaceAsset => Boolean(place));
  const requestedCount = input.multiClip ? Math.max(2, input.vehicle.photos.length, chosenPlaces.length) : 1;
  const maxCount = input.multiClip ? Math.min(6, Math.floor(input.durationSeconds / minClipSeconds)) : 1;
  if (input.multiClip && chosenPlaces.length > maxCount) {
    throw new Error(`Cette durée et ce modèle permettent au maximum ${maxCount} lieux. Réduisez votre sélection ou choisissez une durée plus longue.`);
  }
  const shotCount = Math.min(requestedCount, maxCount);
  if (input.multiClip && shotCount < 2) {
    throw new Error('La durée choisie ne peut pas être répartie en plusieurs clips compatibles. Choisissez une durée plus longue ou un autre niveau.');
  }
  const baseDuration = Math.floor(input.durationSeconds / shotCount);
  const remainder = input.durationSeconds % shotCount;
  const shots = Array.from({ length: shotCount }, (_, index) => {
    const photo = input.multiClip
      ? input.vehicle.photos[index % input.vehicle.photos.length]
      : input.vehicle.photos.find((item) => item.id === input.selectedPhotoId) ?? input.vehicle.photos[0];
    const place = chosenPlaces[index % Math.max(1, chosenPlaces.length)];
    return {
      title: shotCount === 1 ? 'Présentation du véhicule' : index === shotCount - 1 ? 'Signature du véhicule' : `Vue ${index + 1} du véhicule`,
      scene: photo.angle ?? photo.title ?? 'Présentation fidèle du véhicule',
      framing: photo.angle ?? 'Cadrage adapté à la photo de référence',
      location: place?.title ?? 'Lieu réel en Côte d’Ivoire',
      action: 'Mouvement lent et naturel, sans modifier la forme, la couleur ni les équipements visibles du véhicule.',
      camera: index === 0 ? 'Travelling lent et stable' : 'Mouvement doux, raccord visuel avec le plan précédent',
      durationSeconds: baseDuration + (index < remainder ? 1 : 0),
      vehiclePhotoId: photo.id,
      locationPhotoId: place?.id ?? null,
    };
  });
  const maxClipSeconds = input.tier === 'standard' ? 10 : input.tier === 'pro' ? 15 : 30;
  if (input.multiClip && shots.some((shot) => shot.durationSeconds < minClipSeconds || shot.durationSeconds > maxClipSeconds)) {
    throw new Error('La durée ne peut pas être répartie en clips compatibles avec ce modèle. Choisissez une autre durée ou un autre niveau.');
  }
  return shots;
}

export function StudioComposer({ mode }: { mode: 'mock' | 'live' }) {
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetsError, setAssetsError] = useState('');
  const [assetsRetry, setAssetsRetry] = useState(0);
  const [assetId, setAssetId] = useState('');
  const [title, setTitle] = useState('');
  const [overlayLogo] = useState(true);
  const [scenePresetId, setScenePresetId] = useState('');
  const conceptId = 'signature';
  const complexity = 'balanced';
  const [tier, setTier] = useState<'standard' | 'pro' | 'premium'>('standard');
  const [durationS, setDurationS] = useState(5);
  const [additionalDirection, setAdditionalDirection] = useState('');
  const [character, setCharacter] = useState('');
  const [format, setFormat] = useState<Format>('16:9');
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [purpose, setPurpose] = useState<'presentation' | 'advertising'>('presentation');
  const [vehicleDossiers, setVehicleDossiers] = useState<VehicleDossier[]>([]);
  const [places, setPlaces] = useState<PlaceAsset[]>([]);
  const [vehicleDossierId, setVehicleDossierId] = useState('');
  const [placeIds, setPlaceIds] = useState<string[]>([]);
  const [locationAssetId, setLocationAssetId] = useState('');
  const [comparisonCampaignId, setComparisonCampaignId] = useState('');
  const [comparisonJobs, setComparisonJobs] = useState<ComparisonJob[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  const selectedDossier = vehicleDossiers.find((vehicle) => vehicle.key === vehicleDossierId);
  const effectivePlaceIds = durationS >= 10 ? placeIds : (locationAssetId ? [locationAssetId] : placeIds.slice(0, 1));
  const tierMaxClipSeconds = tier === 'standard' ? 10 : tier === 'pro' ? 15 : 30;
  const multiClip = Boolean(selectedDossier && (selectedDossier.photos.length > 1 || durationS >= 10 && effectivePlaceIds.length > 1 || durationS > tierMaxClipSeconds));
  const selectedPhoto = selectedDossier?.photos.find((photo) => photo.id === assetId) ?? selectedDossier?.photos[0];
  const selectedAsset = selectedPhoto ? { ...selectedPhoto, make: selectedDossier?.make, model: selectedDossier?.model, color: selectedDossier?.color } : undefined;
  const vehicleCategory = inferVehicleCategory(selectedAsset?.make, selectedAsset?.model);
  const relevantScenes = getScenePresets(vehicleCategory);
  const allScenes = getScenePresets();
  const universalScenes = allScenes.filter((scene) => scene.category === 'autre' && !relevantScenes.some((recommended) => recommended.id === scene.id));
  const sceneChoices = [...relevantScenes, ...universalScenes].slice(0, 8);
  const selectedScene = getScenePreset(scenePresetId) ?? relevantScenes[0];
  const compatibleModels = availableModels.filter((model) => model.tier === tier && !model.isReference);
  const route = getRouteForGeneration(tier, durationS);
  const routedModel = compatibleModels.find((model) => model.adapterFamily === route?.adapterFamily && model.durations.includes(durationS) && model.formats.includes(format));
  const singleReferenceMode = !multiClip;
  const selectedModel = singleReferenceMode
    ? availableModels.find((model) => model.tier === tier && model.isReference && model.formats.includes(format))
    : routedModel;
  const storyboardModel = multiClip
    ? availableModels.find((model) => model.tier === tier && model.isReference && model.formats.includes(format))
    : selectedModel;
  const estimatedPriceFcfa = storyboardModel?.estimatedPricesFcfa[String(durationS)];
  const generationActive = Boolean(job && !['ready', 'failed'].includes(job.status));
  const lightingChoices = Array.from(new Map(sceneChoices.map((scene) => [getLightingLabel(scene.lighting), scene])).entries())
    .map(([label, scene]) => ({ label, scene }));

  function clearFormError() {
    setError('');
  }

  useEffect(() => {
    const allowed = durationOptions;
    if (!allowed.includes(durationS)) setDurationS(allowed[0]);
  }, [durationS, mode, selectedModel, tier]);

  useEffect(() => {
    if (mode !== 'live') return;
    let active = true;
    setModelsLoading(true);
    setModelsError('');
    fetch('/api/models/available')
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Impossible de charger les modèles.');
        return data;
      })
      .then((data) => {
        if (!active) return;
        const models: Model[] = data.models ?? [];
        setAvailableModels(models);
      })
      .catch((loadError) => {
        if (!active) return;
        setModelsError(loadError instanceof Error ? loadError.message : 'Impossible de charger les modèles.');
      })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [mode]);

  useEffect(() => {
    void fetch('/api/me').then((response) => response.ok ? response.json() : null).then((data) => setIsAdmin(data?.actor?.role === 'admin')).catch(() => setIsAdmin(false));
  }, []);

  useEffect(() => {
    let active = true;
    setAssetsLoading(true);
    setAssetsError('');
    Promise.all([fetch('/api/vehicles'), fetch('/api/assets?kind=place&status=valid%C3%A9e')])
      .then(async ([vehiclesResponse, placesResponse]) => {
        const [vehiclesData, placesData] = await Promise.all([vehiclesResponse.json(), placesResponse.json()]);
        if (!vehiclesResponse.ok) throw new Error(vehiclesData.error ?? 'Impossible de charger les véhicules.');
        if (!placesResponse.ok) throw new Error(placesData.error ?? 'Impossible de charger les lieux.');
        if (!active) return;
        const vehicleList: VehicleDossier[] = vehiclesData.vehicles ?? [];
        setVehicleDossiers(vehicleList);
        setPlaces(placesData.assets ?? []);
        if (placesData.assets?.[0]) {
          setLocationAssetId(placesData.assets[0].id);
          setPlaceIds([placesData.assets[0].id]);
        }
        if (vehicleList[0]) {
          setVehicleDossierId(vehicleList[0].key);
          setAssetId(vehicleList[0].photos[0]?.id ?? '');
          setScenePresetId(getScenePresets(inferVehicleCategory(vehicleList[0].make, vehicleList[0].model))[0]?.id ?? '');
        }
      })
      .catch((loadError) => {
        if (!active) return;
        setAssetsError(loadError instanceof Error ? loadError.message : 'Impossible de charger les véhicules.');
      })
      .finally(() => { if (active) setAssetsLoading(false); });
    return () => { active = false; };
  }, [assetsRetry]);

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

  useEffect(() => {
    if (!comparisonJobs.length || comparisonJobs.every((item) => !item.id || ['ready', 'failed'].includes(item.status))) return;
    const timer = window.setInterval(async () => {
      const updated = await Promise.all(comparisonJobs.map(async (item) => {
        if (!item.id || ['ready', 'failed'].includes(item.status)) return item;
        try {
          const response = await fetch(`/api/versions/${item.id}/refresh`);
          const data = await response.json();
          return response.ok ? { ...item, ...data } : item;
        } catch { return item; }
      }));
      setComparisonJobs(updated);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [comparisonJobs]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (!selectedDossier?.id || !selectedDossier.photos.length) throw new Error('Choisissez un véhicule avec au moins une photo validée.');
      const shots = buildAutomaticShots({ vehicle: selectedDossier, places, placeIds: effectivePlaceIds, durationSeconds: durationS, multiClip, tier, selectedPhotoId: assetId });
      const firstPhoto = selectedDossier.photos.find((photo) => photo.id === shots[0].vehiclePhotoId) ?? selectedDossier.photos[0];
      const workflow = multiClip ? 'multi_clip' : 'single_storyboard';
      const payload = multiClip
        ? { workflow, description: additionalDirection, title, assetId: firstPhoto.id, vehicleDossierId: selectedDossier.id, vehicleDossierIds: selectedDossier.dossierIds ?? [selectedDossier.id], vehiclePhotoIds: selectedDossier.photos.map((photo) => photo.id), placeIds: effectivePlaceIds, storyMode: tier, clipDurationSeconds: durationS, purpose, storyboard: shots, storyboardLedgerIds: [], format, tier: 'standard', durationS: 5, overlayLogo: true, complexity: 'balanced' }
        : { workflow, storyMode: tier, clipDurationSeconds: durationS, purpose, storyboard: shots, storyboardLedgerIds: [], description: additionalDirection, conceptId, title, assetId: firstPhoto.id, vehicleDossierId: selectedDossier.id, vehicleDossierIds: selectedDossier.dossierIds ?? [selectedDossier.id], vehiclePhotoIds: selectedDossier.photos.map((photo) => photo.id), locationAssetId: effectivePlaceIds[0] ?? null, character, format, tier, durationS, overlayLogo, complexity, placeIds: effectivePlaceIds.slice(0, 1), scenePresetId: selectedScene?.id ?? '', vehicleCategory, location: selectedScene?.location ?? '', setting: selectedScene?.setting ?? '', lighting: selectedScene?.lighting ?? lightOptions[0], vehicleAction: selectedScene?.vehicleAction ?? 'Le véhicule avance lentement et régulièrement', cameraMovement: selectedScene?.cameraMovement ?? '', mood: selectedScene?.mood ?? '', ...(mode === 'live' && storyboardModel ? { modelId: storyboardModel.id } : {}) };
      const response = await fetch('/api/versions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'La génération n’a pas pu démarrer.');
      setJob({ id: data.id, status: data.status, prompt: data.prompt, completedShots: data.completedShots, totalShots: data.totalShots });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Une erreur est survenue.');
    } finally {
      setBusy(false);
    }
  }

  async function compareWanAndKling() {
    setError(''); setBusy(true);
    try {
      if (!selectedDossier?.id || durationS < 15) throw new Error('Le comparatif nécessite un véhicule et une durée de 15 ou 20 secondes.');
      const shots = buildAutomaticShots({ vehicle: selectedDossier, places, placeIds: effectivePlaceIds, durationSeconds: durationS, multiClip: true, tier: 'standard', selectedPhotoId: assetId });
      const firstPhoto = selectedDossier.photos.find((photo) => photo.id === shots[0].vehiclePhotoId) ?? selectedDossier.photos[0];
      if (!firstPhoto) throw new Error('Ajoutez une photo validée au dossier véhicule.');
      const response = await fetch('/api/storyboard/compare', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ campaignId: comparisonCampaignId || undefined, vehicleDossierId: selectedDossier.id, vehicleDossierIds: selectedDossier.dossierIds ?? [selectedDossier.id], placeIds: effectivePlaceIds, clipDurationSeconds: durationS as 15 | 20, purpose, storyboard: shots, description: additionalDirection, title, assetId: firstPhoto.id, format, tier: 'standard', durationS: 5, overlayLogo: true, complexity: 'balanced' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Le comparatif n’a pas pu démarrer.');
      setComparisonCampaignId(data.campaignId);
      setComparisonJobs(data.jobs ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Le comparatif n’a pas pu démarrer.');  }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-5">
        <section className="overflow-hidden rounded-md border border-black/[.055] bg-white">
          <div className="min-h-[250px] p-5 md:min-h-[320px] md:p-7">
            <div className="flex items-center justify-between gap-3">
              <span className="rounded-full bg-[#f2f1ef] px-3 py-1 text-[11px] text-[#77736d]">Décrivez la vidéo que vous voulez, je m’occupe du reste.</span>
              <span className="hidden text-[10px] font-semibold uppercase tracking-[.12em] text-[#aaa59d] md:inline">Brief de création</span>
            </div>
            {additionalDirection.trim() && <p className="mt-6 max-w-2xl whitespace-pre-wrap text-sm leading-6 text-[#4d4a45]">{additionalDirection.trim()}</p>}
          </div>
          <div className="border-t border-[#eeeae4] p-4 md:p-5">
            <textarea value={additionalDirection} onChange={(event) => { setAdditionalDirection(event.target.value); clearFormError(); }} maxLength={240} rows={3} placeholder="Décrivez votre vidéo…" aria-label="Description de la vidéo" className="w-full resize-y rounded-md border border-[#e9e7e2] bg-[#fcfcfb] p-3 text-sm leading-6 outline-none focus:border-[#c51e1c]" />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <button type="button" onClick={() => { setAdditionalDirection('Une vidéo publicitaire automobile élégante, avec une mise en valeur progressive du véhicule.'); clearFormError(); }} className="text-xs font-semibold text-[#c51e1c] underline underline-offset-4">Insérer un exemple</button>
              <button type="button" onClick={() => document.getElementById('generation-options')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="rounded-md bg-[#c51e1c] px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-[#a71715]">Envoyer la description ↑</button>
            </div>
          </div>
        </section>

        {job && <section className="rounded-md border border-black/[.055] bg-white p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">État de la vidéo</h2><span className="text-[10px] font-semibold uppercase text-[#a47731]">{job.status === 'ready' ? 'Prête' : job.status === 'failed' ? 'Échec' : 'En cours'}</span></div><p className="mt-2 text-xs leading-5 text-[#88847d]">{job.status === 'ready' ? 'Votre vidéo est prête à consulter.' : job.status === 'failed' ? job.error ?? 'La génération a échoué. Vous pouvez relancer une nouvelle vidéo.' : 'Actualisation automatique toutes les 10 secondes.'}</p>{job.prompt && <details className="mt-4 border-t border-[#eeeae4] pt-3"><summary className="cursor-pointer text-xs font-semibold text-[#716d66]">Voir le prompt généré</summary><p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[#77736d]">{job.prompt}</p></details>}{job.status === 'ready' && <Link href="/bibliotheque" className="mt-4 block rounded-lg bg-[#c51e1c] px-3 py-2.5 text-center text-xs font-semibold text-white">Voir ma vidéo →</Link>}</section>}
      </div>

      <aside id="generation-options" className="min-w-0 space-y-3 xl:sticky xl:top-5">
        <section className="rounded-md border border-[#e2e2e5] bg-white p-4">
          <fieldset><legend className="mb-2 text-[11px] font-semibold">Durée de la vidéo</legend><div className="flex flex-wrap gap-1.5">{durationOptions.map((seconds) => <button type="button" key={seconds} onClick={() => { setDurationS(seconds); clearFormError(); if (seconds < 10 && placeIds.length > 1) setPlaceIds((current) => current.slice(0, 1)); }} aria-pressed={durationS === seconds} className={`rounded-full border px-2.5 py-1.5 text-[10px] ${durationS === seconds ? 'border-[#c51e1c] bg-[#fff1ef] font-semibold text-[#b21c1a]' : 'border-[#e5e2dd] text-[#77736d]'}`}>{seconds} s</button>)}</div><p className="mt-2 text-[9px] text-[#88847d]">La durée choisie correspond aux clips. L’animation du logo est ajoutée à la fin.</p></fieldset>
          <fieldset className="mt-4"><legend className="mb-2 text-[11px] font-semibold">Intention</legend><div className="flex gap-1.5">{([{ value: 'presentation', label: 'Présentation fidèle' }, { value: 'advertising', label: 'Publicité premium' }] as const).map((option) => <button type="button" key={option.value} onClick={() => { setPurpose(option.value); clearFormError(); }} aria-pressed={purpose === option.value} className={`flex-1 rounded-full border px-2 py-1.5 text-[10px] ${purpose === option.value ? 'border-[#c51e1c] bg-[#fff1ef] font-semibold text-[#b21c1a]' : 'border-[#e5e2dd] text-[#77736d]'}`}>{option.label}</button>)}</div></fieldset>
        </section>

        <section className="rounded-md border border-[#e2e2e5] bg-white p-4 text-[#161619]">
          <div className="flex items-center justify-between gap-2"><h2 className="font-display text-sm font-semibold uppercase tracking-[.04em]">Votre vidéo</h2><span className="rounded-full bg-[#f2f1ef] px-2 py-1 text-[9px] text-[#88847d]">{title.trim() ? 'Prête à lancer' : 'Description à saisir'}</span></div>
          <label className="mt-4 grid gap-1.5 text-[11px] font-semibold">Titre de la vidéo<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="Ex. Starlight EV · lancement Abidjan" className="min-h-10 rounded-md border border-[#e9e7e2] bg-white px-3 py-2 text-xs font-normal outline-none focus:border-[#c51e1c]" /></label>
          <label className="mt-4 grid gap-1.5 text-[11px] font-semibold">Véhicule<select value={vehicleDossierId} onChange={(event) => { const nextVehicle = vehicleDossiers.find((vehicle) => vehicle.key === event.target.value); setVehicleDossierId(event.target.value); setAssetId(nextVehicle?.photos[0]?.id ?? ''); clearFormError(); setScenePresetId(getScenePresets(inferVehicleCategory(nextVehicle?.make, nextVehicle?.model))[0]?.id ?? ''); }} disabled={assetsLoading || !vehicleDossiers.length} className="min-h-10 rounded-md border border-[#e9e7e2] bg-white px-3 py-2 text-xs font-normal outline-none focus:border-[#c51e1c]"><option value="">{assetsLoading ? 'Chargement…' : 'Choisissez un véhicule'}</option>{vehicleDossiers.filter((vehicle) => vehicle.photos.length > 0 && vehicle.id).map((vehicle) => <option key={vehicle.key} value={vehicle.key}>{vehicle.make} {vehicle.model}{vehicle.color ? ` · ${vehicle.color}` : ''}</option>)}</select></label>
          {selectedAsset && <div className="mt-3 rounded-md bg-[#f8f7f4] p-2"><div className="flex items-center gap-3"><span className="grid size-12 shrink-0 place-items-center overflow-hidden bg-[#ededeb]">{selectedAsset.previewUrl ? <Image src={selectedAsset.previewUrl} alt={`${selectedAsset.make ?? 'Véhicule'} ${selectedAsset.model ?? ''}`} width={48} height={48} unoptimized className="size-full object-cover" /> : <span className="text-xl text-[#831810]" aria-hidden="true">◈</span>}</span><span className="min-w-0"><b className="block truncate text-xs">{selectedAsset.make} {selectedAsset.model}</b><small className="mt-1 block truncate text-[10px] text-[#99958e]">{selectedAsset.color ?? 'Photos validées'} · {selectedDossier?.photos.length ?? 0} vue(s) rattachée(s)</small></span></div><div className="mt-2 flex gap-2 overflow-x-auto">{selectedDossier?.photos.map((photo, index) => <button type="button" key={photo.id} onClick={() => setAssetId(photo.id)} aria-pressed={photo.id === (selectedPhoto?.id ?? assetId)} className={`relative h-14 w-20 shrink-0 overflow-hidden rounded border ${photo.id === (selectedPhoto?.id ?? assetId) ? 'border-[#c51e1c] ring-1 ring-[#c51e1c]' : 'border-[#e5e2dd]'}`}>{photo.previewUrl && <Image src={photo.previewUrl} alt={photo.angle ?? photo.title ?? `Vue ${index + 1}`} fill sizes="80px" unoptimized className="object-cover" />}<span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-left text-[8px] text-white">{photo.angle ?? photo.title ?? `Vue ${index + 1}`}</span></button>)}</div></div>}
          {assetsError && <div role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-xs text-red-700">{assetsError}<button type="button" onClick={() => setAssetsRetry((value) => value + 1)} className="ml-2 font-semibold underline">Réessayer</button></div>}
          {!assetsLoading && !assetsError && !vehicleDossiers.length && <Link href="/mediatheque" className="mt-3 block rounded-md border border-dashed border-[#dad7d1] p-3 text-center text-xs text-[#817d76]">＋ Ajouter une photo validée</Link>}
        </section>

        <section className="rounded-md border border-[#e2e2e5] bg-white p-4">
          <fieldset><legend className="mb-1 text-[11px] font-semibold">Lieu réel · Côte d’Ivoire</legend><p className="mb-3 text-[9px] leading-4 text-[#88847d]">{durationS >= 10 ? 'À partir de 10 secondes, vous pouvez sélectionner plusieurs lieux.' : 'Pour les clips de moins de 10 secondes, un seul lieu est utilisé.'}</p>{places.length ? <div className="grid max-h-64 grid-cols-2 gap-2 overflow-auto">{places.map((place) => { const selected = durationS >= 10 ? placeIds.includes(place.id) : locationAssetId === place.id; return <button type="button" key={place.id} onClick={() => { if (durationS >= 10) { setPlaceIds((current) => selected ? current.length > 1 ? current.filter((id) => id !== place.id) : current : [...current, place.id]); setLocationAssetId(selected ? placeIds.find((id) => id !== place.id) ?? place.id : place.id); } else { setLocationAssetId(selected ? locationAssetId : place.id); setPlaceIds([place.id]); } clearFormError(); }} aria-pressed={selected} className={`overflow-hidden rounded-md border text-left ${selected ? 'border-[#c51e1c] ring-1 ring-[#c51e1c]' : 'border-[#e5e2dd]'}`}><span className="relative block h-16 bg-[#f4f2ef]">{place.previewUrl && <Image src={place.previewUrl} alt="" fill sizes="140px" unoptimized className="object-cover" />}</span><span className="block truncate px-2 pt-1.5 text-[9px] font-medium text-[#4d4a45]">{place.title ?? 'Lieu'}</span><span className="block truncate px-2 pb-1.5 text-[8px] text-[#99958e]">{place.category ?? 'Côte d’Ivoire'}</span></button>; })}</div> : <p className="text-[10px] text-[#88847d]">Aucun lieu validé disponible.</p>}</fieldset>
        </section>

        <section className="rounded-md border border-[#e2e2e5] bg-white p-4">
          <div className="space-y-4">
            <fieldset><legend className="mb-2 text-[11px] font-semibold">Personnage</legend><div className="flex flex-wrap gap-1.5">{characterOptions.map((option) => <button type="button" key={option.value || 'none'} onClick={() => setCharacter(option.value)} aria-pressed={character === option.value} className={`rounded-full border px-2.5 py-1.5 text-[10px] transition ${character === option.value ? 'border-[#c51e1c] bg-[#fff1ef] font-semibold text-[#b21c1a]' : 'border-[#e5e2dd] text-[#77736d] hover:border-[#c51e1c]'}`}>{option.value ? option.label.replace('Une ', '') : 'Aucun'}</button>)}</div></fieldset>
            <fieldset><legend className="mb-2 text-[11px] font-semibold">Lumière</legend><div className="flex flex-wrap gap-1.5">{lightingChoices.map(({ label, scene }) => <button type="button" key={label} onClick={() => setScenePresetId(scene.id)} aria-pressed={label === getLightingLabel(selectedScene?.lighting ?? '')} className={`rounded-full border px-2.5 py-1.5 text-[10px] transition ${label === getLightingLabel(selectedScene?.lighting ?? '') ? 'border-[#c51e1c] bg-[#fff1ef] font-semibold text-[#b21c1a]' : 'border-[#e5e2dd] text-[#77736d] hover:border-[#c51e1c]'}`}>{label}</button>)}</div></fieldset>
          </div>
        </section>

        <section className="rounded-md border border-[#e2e2e5] bg-white p-4">
          <fieldset><legend className="mb-2 text-[11px] font-semibold">Format</legend><div className="flex flex-wrap gap-1.5">{(['16:9', '9:16'] as const).map((value) => <button type="button" key={value} onClick={() => { setFormat(value); clearFormError(); }} aria-pressed={format === value} className={`rounded-full border px-2.5 py-1.5 text-[10px] ${format === value ? 'border-[#c51e1c] bg-[#fff1ef] font-semibold text-[#b21c1a]' : 'border-[#e5e2dd] text-[#77736d]'}`}>{value}</button>)}</div></fieldset>
          <fieldset className="mt-4"><legend className="mb-2 text-[11px] font-semibold">Niveau de génération</legend><div className="grid grid-cols-3 gap-1.5">{([{ value: 'standard', label: 'Standard' }, { value: 'pro', label: 'Pro' }, { value: 'premium', label: 'Premium' }] as const).map((option) => <button type="button" key={option.value} onClick={() => { setTier(option.value); clearFormError(); }} aria-pressed={tier === option.value} className={`rounded-full border px-2.5 py-1.5 text-[10px] ${tier === option.value ? 'border-[#c51e1c] bg-[#fff1ef] font-semibold text-[#b21c1a]' : 'border-[#e5e2dd] text-[#77736d]'}`}>{option.label}</button>)}</div><p className="mt-2 text-[9px] text-[#88847d]">Durée des clips : {durationS} s.</p></fieldset>
          {mode === 'live' && modelsError && <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-[10px] text-red-700">{modelsError}</p>}
          {mode === 'live' && !modelsLoading && !modelsError && !storyboardModel && <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-[10px] text-red-700">Aucune option disponible pour cette durée et ce format. Choisissez un autre niveau ou format.</p>}
          {mode === 'mock' && <p className="mt-4 rounded-md bg-[#fbf6ed] p-3 text-[10px] leading-4 text-[#765d39]">Simulation active : aucune vidéo payante ne sera générée.</p>}
          {mode === 'live' && estimatedPriceFcfa != null && <p className="mt-4 border-t border-[#eeeae4] pt-4 text-[10px] text-[#88847d]">Estimation vidéo · environ {formatFcfa(estimatedPriceFcfa)}</p>}
          <p className="mt-4 border-t border-[#eeeae4] pt-4 text-[10px] leading-4 text-[#88847d]">La vidéo sera générée directement. Les plans et les lieux suivront automatiquement vos choix.</p>
        </section>
        <p className="px-1 text-[10px] leading-4 text-[#88847d]">{multiClip ? 'Plusieurs vues ou lieux : clips assemblés automatiquement.' : 'Une seule vue et un seul lieu : génération en un plan.'}</p>
      </aside>
      <div className="space-y-3 xl:col-span-2">
        {error && <div role="alert" className="rounded-md border border-red-100 bg-red-50 p-4 text-xs leading-5 text-red-800"><p>{error}</p><button type="submit" disabled={busy} className="mt-2 font-semibold underline underline-offset-2">Réessayer la génération</button></div>}
        <button type="submit" disabled={busy || generationActive || !selectedDossier?.id || !selectedDossier.photos.length || mode === 'live' && (!storyboardModel || modelsLoading)} aria-describedby={generationActive ? 'generation-lock-message' : undefined} className="w-full rounded-md bg-[#c51e1c] px-4 py-4 text-sm font-semibold text-white transition hover:bg-[#a71715] disabled:cursor-not-allowed disabled:opacity-50">{busy ? 'Lancement de la génération…' : generationActive ? 'Génération en cours…' : `Générer la vidéo · ${durationS} s`}</button>
        {multiClip && durationS >= 15 && isAdmin && mode === 'live' && <button type="button" disabled={busy} onClick={() => void compareWanAndKling()} className="w-full rounded-md bg-[#253b4e] px-4 py-3 text-xs font-semibold text-white disabled:opacity-50">Comparer Wan et Kling</button>}
        <p className="text-center text-[10px] text-[#88847d]">Lancement direct : les vues et lieux sélectionnés déterminent automatiquement les plans.</p>
      </div>
    </form>
  );
}
