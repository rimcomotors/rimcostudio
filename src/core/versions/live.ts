import type { Actor } from '@/core/auth/guards';
import { briefToPrompt, buildBrief } from '@/core/brief';
import type { Brief } from '@/core/brief';
import { klingVideoProvider, KLING_ENDPOINT } from '@/core/providers/fal-kling';
import { wanVideoProvider, WAN_ENDPOINT } from '@/core/providers/fal-wan';
import { veoVideoProvider, VEO_ENDPOINT } from '@/core/providers/fal-veo';
import { seedanceVideoProvider, SEEDANCE_ENDPOINT } from '@/core/providers/fal-seedance';
import { buildFalBriefWithCost, FalLlmBriefError } from '@/core/providers/fal-llm';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { env } from '@/env';
import { HttpError } from '@/core/auth/guards';
import type { z } from 'zod';
import { requestSchema } from './request-schema';
import { beginPostproduction, retryPostproduction } from '@/core/postproduction/pipeline';
import { approveCompletedAdminVideo } from '@/core/versions/approval';
import { refreshLivePhotoFidelity } from '@/core/versions/photo-fidelity';
import { getScenePreset, inferVehicleCategory } from '@/core/scenes/catalog';
import { calculateClientPriceFcfa } from '@/core/pricing';
import { refreshLiveStoryboard } from './storyboard-live';
import { getSceneConceptDirection } from '@/core/scenes/concepts';
import { reserveGenerationCost, reserveLlmCost, settleUsageCost } from '@/core/billing/ledger';
import { llmReservationUsd } from '@/core/providers/fal-llm';
import { getRouteForGeneration, REFERENCE_MODEL_ENDPOINTS } from '@/core/providers/model-routing';
import { wanReferenceVideoProvider, klingReferenceVideoProvider, seedanceReferenceVideoProvider } from '@/core/providers/fal-reference-video';
import { logFalStatusFailure } from '@/core/providers/fal-observability';
import { findCuratedLocation, locationCatalog } from '@/core/assets/location-catalog';
import { createFalClient } from '@fal-ai/client';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getActiveFalCredential, getFalCredentialById, pruneRetiredFalCredentials } from '@/core/providers/fal-credential-vault';
import { firstObservedAt, type ProcessingMetrics } from './processing-metrics';

export type CreateVersionInput = z.infer<typeof requestSchema>;

export async function createLiveVersion(actor: Actor, input: CreateVersionInput, options?: { modelId?: string; reuse?: { brief: Brief; prompt: string } }) {
  if (input.tier === 'test' && actor.role !== 'admin') throw new HttpError(403, 'Le niveau Test est réservé à l’administrateur.');
  if (!actor.brandId) throw new HttpError(403, 'Aucune marque n’est associée à votre profil.');

  const authenticated = await createSupabaseServerClient();
  const admin = createStorageAdminClient();
  const expectedTier = input.tier;
  const referenceMode = input.vehiclePhotoIds.length > 1 || Boolean(input.locationAssetId);
  if (referenceMode && input.tier === 'test') throw new HttpError(422, 'Le mode de test ne prend pas en charge plusieurs images de référence.');
  const route = !referenceMode && (input.tier === 'standard' || input.tier === 'pro' || input.tier === 'premium') ? getRouteForGeneration(input.tier, input.durationS) : null;
  if (!referenceMode && !route) throw new HttpError(422, 'Cette combinaison de niveau et de durée n’est pas disponible.');
  const expectedEndpoint = referenceMode ? REFERENCE_MODEL_ENDPOINTS[input.tier as 'standard' | 'pro' | 'premium'] : route!.endpoint;
  const [{ data: asset, error: assetError }, { data: model, error: modelError }] = await Promise.all([
    authenticated.from('assets').select('id,kind,path,make,model,color,status,brand_id').eq('id', input.assetId).single(),
    admin.from('ai_models').select('id,name,tier,fal_endpoint_id,adapter_family,mode,price_usd_per_second,allowed_durations,allowed_formats,is_active,is_default').eq(options?.modelId ? 'id' : 'fal_endpoint_id', options?.modelId ?? expectedEndpoint).eq('is_active', true).single(),
  ]);
  if (assetError || !asset || asset.kind !== 'vehicle' || asset.status !== 'validée' || asset.brand_id !== actor.brandId) throw new HttpError(422, 'Choisissez une photo de véhicule validée pour votre marque.');
  if (input.audioAssetId) {
    const { data: audio, error: audioError } = await authenticated.from('assets').select('id,kind,status,brand_id').eq('id', input.audioAssetId).single();
    if (audioError || !audio || audio.kind !== 'audio' || audio.status !== 'validée' || audio.brand_id !== actor.brandId) throw new HttpError(422, 'Choisissez une piste audio validée pour votre marque.');
  }
  if (modelError || !model || !['kling','wan','veo','seedance'].includes(model.adapter_family)) throw new HttpError(503, 'Le modèle demandé n’est pas activé ou ne dispose pas d’un adaptateur live.');
  const referenceAdapter = model.fal_endpoint_id === REFERENCE_MODEL_ENDPOINTS.standard && model.adapter_family === 'wan'
    ? wanReferenceVideoProvider
    : model.fal_endpoint_id === REFERENCE_MODEL_ENDPOINTS.pro && model.adapter_family === 'kling'
      ? klingReferenceVideoProvider
      : model.fal_endpoint_id === REFERENCE_MODEL_ENDPOINTS.premium && model.adapter_family === 'seedance' ? seedanceReferenceVideoProvider : null;
  if (referenceMode && (!referenceAdapter || input.durationS < referenceAdapter.minDurationS || input.durationS > referenceAdapter.maxDurationS)) throw new HttpError(422, 'Le modèle de référence ne prend pas en charge cette durée.');
  const endpointMatches = Boolean(referenceAdapter) || model.adapter_family === 'kling' && model.fal_endpoint_id === KLING_ENDPOINT
    || model.adapter_family === 'wan' && model.fal_endpoint_id === WAN_ENDPOINT
    || model.adapter_family === 'veo' && model.fal_endpoint_id === VEO_ENDPOINT
    || model.adapter_family === 'seedance' && model.fal_endpoint_id === SEEDANCE_ENDPOINT;
  if (!endpointMatches) throw new HttpError(503, 'L’identifiant d’endpoint ne correspond pas à l’adaptateur vidéo activé.');
  if (model.fal_endpoint_id !== expectedEndpoint) throw new HttpError(422, 'Le modèle ne correspond pas au niveau et à la durée demandés.');
  if (options?.modelId && model.tier !== expectedTier) throw new HttpError(422, 'Le niveau demandé ne correspond pas au modèle sélectionné.');
  const sourceDurationS = referenceMode ? input.durationS : route!.sourceDuration;
  const storedDurations = model.allowed_durations ?? [];
  const durationSupported = storedDurations.includes(input.durationS) || !referenceMode && route!.adapterFamily === 'veo' && storedDurations.includes(sourceDurationS);
  if (!durationSupported) throw new HttpError(422, 'La durée choisie n’est pas disponible pour ce modèle.');
  if (!model.allowed_formats?.includes(input.format)) throw new HttpError(422, `Le modèle ne prend pas en charge le format ${input.format}.`);

  let referenceAssets: Array<{ id: string; path: string; angle?: string | null; photo_role?: string | null }> = [];
  if (referenceMode) {
    const requestedIds = [input.assetId, ...new Set(input.vehiclePhotoIds.filter((id) => id !== input.assetId))];
    if (!requestedIds.includes(input.assetId)) throw new HttpError(422, 'La photo principale doit faire partie des vues du véhicule sélectionné.');
    const dossierIds = [...new Set(input.vehicleDossierIds.length ? input.vehicleDossierIds : input.vehicleDossierId ? [input.vehicleDossierId] : [])];
    if (input.vehicleDossierId && !dossierIds.includes(input.vehicleDossierId)) throw new HttpError(422, 'Le dossier principal doit faire partie des dossiers sélectionnés.');
    if (dossierIds.length) {
      const { data: dossiers, error: dossiersError } = await authenticated.from('vehicle_dossiers').select('id,make,model,color,variant,brand_id').in('id', dossierIds).eq('brand_id', actor.brandId);
      const primary = dossiers?.find((dossier) => dossier.id === input.vehicleDossierId);
      const normalize = (value: string | null) => (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('fr');
      const identity = (dossier: NonNullable<typeof dossiers>[number]) => [dossier.make, dossier.model, dossier.color, dossier.variant].map(normalize).join('|');
      if (dossiersError || !dossiers || dossiers.length !== dossierIds.length || !primary || new Set(dossiers.map(identity)).size !== 1) throw new HttpError(422, 'Les dossiers regroupés ne décrivent pas exactement le même véhicule.');
    }
    const { data: photos, error: photosError } = await authenticated.from('assets').select('id,path,angle,photo_role,kind,status,brand_id,vehicle_dossier_id,make,model,color,variant').in('id', requestedIds).eq('kind', 'vehicle').eq('status', 'validée').eq('brand_id', actor.brandId);
    if (photosError || !photos || photos.length !== requestedIds.length) throw new HttpError(422, 'Une ou plusieurs vues véhicule ne sont plus disponibles.');
    if (dossierIds.length && photos.some((photo) => !dossierIds.includes(photo.vehicle_dossier_id ?? ''))) throw new HttpError(422, 'Les photos sélectionnées ne proviennent pas des dossiers véhicule choisis.');
    if (!dossierIds.length) {
      const identity = (photo: typeof photos[number]) => [photo.make, photo.model, photo.color, photo.variant].map((value) => (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()).join('|');
      if (new Set(photos.map(identity)).size > 1) throw new HttpError(422, 'Les vues sélectionnées doivent appartenir au même véhicule.');
    }
    referenceAssets = requestedIds.map((id) => photos.find((photo) => photo.id === id)!).map((photo) => ({ id: photo.id, path: photo.path, angle: photo.angle, photo_role: photo.photo_role }));
  }
  const { data: image, error: imageError } = await admin.storage.from('assets').createSignedUrl(asset.path, 3600);
  if (imageError || !image?.signedUrl) throw new HttpError(422, 'Impossible de préparer la photo sélectionnée.');
  let dossierMetadata: { make: string | null; model: string | null; color: string | null; variant: string | null } | null = null;
  if (input.vehicleDossierId) {
    const { data: dossier, error: dossierError } = await authenticated.from('vehicle_dossiers').select('make,model,color,variant,brand_id').eq('id', input.vehicleDossierId).single();
    if (dossierError || !dossier || dossier.brand_id !== actor.brandId) throw new HttpError(422, 'Le dossier véhicule sélectionné n’est plus disponible.');
    dossierMetadata = dossier;
  }
  const vehicleMake = dossierMetadata?.make ?? asset.make;
  const vehicleModel = dossierMetadata?.model ?? asset.model;
  const vehicleColor = dossierMetadata?.color ?? asset.color;
  const vehicleDescription = [vehicleMake, vehicleModel, dossierMetadata?.variant, vehicleColor].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ');
  if (input.scenePresetId && !getScenePreset(input.scenePresetId)) throw new HttpError(422, 'La scène sélectionnée est introuvable.');
  const selectedScene = input.scenePresetId ? getScenePreset(input.scenePresetId) : undefined;
  const conceptDirection = getSceneConceptDirection(selectedScene, input.conceptId);
  const userDirection = [conceptDirection, input.description].filter(Boolean).join(' ').slice(0, 500);
  let selectedLocation: { id: string; title: string; path: string; location?: string; setting?: string } | undefined = input.locationAssetId ? findCuratedLocation(input.locationAssetId) : undefined;
  if (input.locationAssetId && !selectedLocation) {
    const { data: uploadedLocation, error: locationError } = await authenticated.from('assets').select('id,title,path,kind,status,brand_id').eq('id', input.locationAssetId).eq('kind', 'place').eq('status', 'validée').eq('brand_id', actor.brandId).single();
    if (locationError || !uploadedLocation) throw new HttpError(422, 'Le lieu sélectionné n’est plus disponible.');
    selectedLocation = { id: uploadedLocation.id, title: uploadedLocation.title ?? 'Lieu réel', path: uploadedLocation.path };
  }
  const briefOptions = { vehicle_asset_id: asset.id, vehicle_description: vehicleDescription || 'Véhicule strictement identique à la photo de référence', vehicle_category: inferVehicleCategory(vehicleMake, vehicleModel), scene_preset_id: input.scenePresetId, vehicle_action: selectedScene?.vehicleAction ?? input.vehicleAction, user_direction: userDirection, location: selectedLocation?.location ?? selectedScene?.location ?? input.location, setting: selectedLocation?.setting ?? selectedScene?.setting ?? input.setting, character: input.character || selectedScene?.character || 'Aucun personnage', lighting: selectedScene?.lighting ?? input.lighting, camera_movement: selectedScene?.cameraMovement ?? input.cameraMovement, mood: selectedScene?.mood ?? input.mood, format: input.format, duration_s: input.durationS, complexity: input.complexity };
  const llmBriefOptions = Object.fromEntries(Object.entries(briefOptions).map(([key, value]) => [key, String(value)]));
  const initialBrief = options?.reuse?.brief ?? buildBrief(input.description || 'Vidéo automobile réaliste et élégante.', briefOptions);
  if (initialBrief.vehicle_asset_id !== asset.id || initialBrief.format !== input.format) throw new HttpError(422, 'Le brief commun ne correspond pas à la photo ou au format sélectionné.');
  const estimatedProviderCostUsd = sourceDurationS * Number(model.price_usd_per_second);
  const priceFcfa = calculateClientPriceFcfa(estimatedProviderCostUsd, env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);
  const videoTitle = input.title || `${vehicleMake ?? ''} ${vehicleModel ?? 'Véhicule'} · Nouvelle création`.trim();
  const falCredential = await getActiveFalCredential(admin);
  const { data: video, error: videoError } = await admin.from('videos').insert({ user_id: actor.id, brand_id: actor.brandId, title: videoTitle, department: actor.department, status: 'generating' }).select('id').single();
  if (videoError || !video) throw new HttpError(500, 'Impossible de créer la vidéo. Réessayez.');
  const generationTier = input.tier === 'test' ? 'premium' : input.tier;
  const { data: version, error: versionError } = await admin.from('video_versions').insert({ video_id: video.id, number: 1, fal_credential_id: falCredential.id, brief_json: { ...initialBrief, generationTier, overlayLogo: input.overlayLogo, ...(referenceMode ? { referenceVideoMode: true, vehicleDossierId: input.vehicleDossierId, vehiclePhotoIds: referenceAssets.map((photo) => photo.id), locationAssetId: selectedLocation?.id ?? null } : {}) }, generated_prompt: '', ai_model_id: model.id, audio_asset_id: input.audioAssetId ?? null, status: 'queued', generation_seconds: input.durationS }).select('id,number').single();
  if (versionError || !version) {
    await admin.from('videos').delete().eq('id', video.id);
    throw new HttpError(500, 'Impossible de créer la version de la vidéo. Réessayez.');
  }
  const { data: ledgerId, error: reserveError } = await reserveGenerationCost(admin, {
    userId: actor.id, versionId: version.id, modelId: model.id, seconds: sourceDurationS,
    priceUsdPerSecond: Number(model.price_usd_per_second), usdToEur: env.USD_TO_EUR_RATE,
    eurToFcfa: env.EUR_TO_FCFA, priceFcfa, department: actor.department,
  });
  if (reserveError || !ledgerId) {
    await Promise.all([admin.from('video_versions').delete().eq('id', version.id), admin.from('videos').delete().eq('id', video.id)]);
    throw new HttpError(503, 'Impossible de réserver le suivi de coûts de la génération.');
  }

  const llmReserveUsd = llmReservationUsd(env.LLM_MAX_COST_USD ?? 0);
  let brief: Brief;
  let prompt: string;
  if (options?.reuse) {
    brief = options.reuse.brief;
    prompt = options.reuse.prompt;
  } else {
  let llmCallCompleted = false;
  let llmReportedCostUsd: number | null = null;
  const { data: llmLedgerId, error: llmReserveError } = await reserveLlmCost(admin, {
    userId: actor.id, versionId: version.id, maxCostUsd: llmReserveUsd,
    usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, department: actor.department,
  });
  if (llmReserveError || !llmLedgerId) {
    await Promise.all([
      settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
      admin.from('video_versions').update({ status: 'failed', error_message: 'Le brief LLM n’a pas pu être réservé.' }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(503, 'Impossible de réserver le suivi de coût du brief LLM.');
  }

  try {
    const generated = await buildFalBriefWithCost(input.description, llmBriefOptions, falCredential.apiKey);
    llmCallCompleted = true;
    llmReportedCostUsd = generated.costUsd;
    brief = generated.brief as Brief;
    if (!model.allowed_formats?.includes(brief.format)) throw new HttpError(422, `Le modèle ne prend pas en charge le format ${brief.format}.`);
    prompt = briefToPrompt(brief, model.adapter_family);
    if (referenceMode) prompt += `\n\nReference fidelity: all vehicle reference images show the same exact vehicle from complementary angles. Preserve its make, model, body shape, color, trim, wheels and visible details; do not redesign, recolor, or substitute it. ${selectedLocation ? `The final reference image is the required real location (${selectedLocation.title}); reproduce its visible architecture, road, vegetation and perspective faithfully as the background.` : ''}`;
    const { error: settleError } = await settleUsageCost(admin, { entryId: llmLedgerId, outcome: 'charged', actualCostUsd: generated.costUsd ?? llmReserveUsd, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
    if (settleError) throw new HttpError(503, 'Le coût du brief LLM doit être réconcilié avant de lancer la vidéo.');
    const { error: briefUpdateError } = await admin.from('video_versions').update({ brief_json: { ...brief, overlayLogo: input.overlayLogo, ...(referenceMode ? { referenceVideoMode: true, vehicleDossierId: input.vehicleDossierId, vehiclePhotoIds: referenceAssets.map((photo) => photo.id), locationAssetId: selectedLocation?.id ?? null } : {}) }, generated_prompt: prompt }).eq('id', version.id);
    if (briefUpdateError) throw new HttpError(503, 'Le brief est facturé mais n’a pas pu être enregistré. Réessayez depuis l’administration.');
  } catch (briefError) {
    const message = briefError instanceof HttpError ? briefError.message : 'Le brief n’a pas pu être préparé. Vérifiez le fournisseur LLM puis réessayez.';
    if (!(briefError instanceof HttpError && message.startsWith('Le coût du brief LLM'))) {
      const completedRequests = briefError instanceof FalLlmBriefError ? briefError.completedRequests : 0;
      const reportedCostUsd = llmReportedCostUsd ?? (briefError instanceof FalLlmBriefError ? briefError.reportedCostUsd : null);
      const completed = llmCallCompleted || completedRequests > 0;
      await settleUsageCost(admin, {
        entryId: llmLedgerId,
        outcome: completed ? 'charged' : 'released',
        actualCostUsd: completed ? reportedCostUsd ?? llmReserveUsd : 0,
        usdToEur: env.USD_TO_EUR_RATE,
        eurToFcfa: env.EUR_TO_FCFA,
        billable: false,
      });
    }
    await Promise.all([
      settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
      admin.from('video_versions').update({ status: 'failed', error_message: message }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(502, message);
  }
  }

  let requestId: string;
  try {
    if (referenceMode && referenceAdapter) {
      const falStorage = createFalClient({ credentials: falCredential.apiKey }).storage;
      const vehicleRefsPromise = Promise.all(referenceAssets.slice(0, Math.max(1, referenceAdapter.maxReferenceImages - (selectedLocation ? 1 : 0))).map(async (photo) => {
        if (photo.id === asset.id && image.signedUrl) return image.signedUrl;
        const { data: signed, error: signedError } = await admin.storage.from('assets').createSignedUrl(photo.path, 3600);
        if (signedError || !signed?.signedUrl) throw new HttpError(422, 'Impossible de préparer toutes les vues du véhicule.');
        return signed.signedUrl;
      }));
      const locationRefPromise = (async () => {
        if (!selectedLocation) return null;
        if (selectedLocation.path.startsWith('/places/')) {
          const curated = locationCatalog.find((item) => item.id === selectedLocation!.id);
          if (!curated || !falStorage) throw new HttpError(422, 'Impossible de préparer la référence du lieu.');
          const bytes = await readFile(join(process.cwd(), 'public', curated.path.slice(1)));
          const extension = curated.path.split('.').at(-1)?.toLowerCase();
          const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
          return falStorage.upload(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mimeType }), { lifecycle: { expiresIn: '1d' } });
        } else {
          const { data: signed, error: signedError } = await admin.storage.from('assets').createSignedUrl(selectedLocation.path, 3600);
          if (signedError || !signed?.signedUrl) throw new HttpError(422, 'Impossible de préparer la référence du lieu.');
          return signed.signedUrl;
        }
      })();
      const [vehicleRefs, locationRef] = await Promise.all([vehicleRefsPromise, locationRefPromise]);
      const refs = locationRef ? [...vehicleRefs, locationRef] : vehicleRefs;
      ({ requestId } = await referenceAdapter.submit({ prompt, referenceImageUrls: refs, durationS: input.durationS, aspectRatio: input.format, endUserId: actor.id }, falCredential.apiKey));
    } else {
      const provider = model.adapter_family === 'wan' ? wanVideoProvider : model.adapter_family === 'veo' ? veoVideoProvider : model.adapter_family === 'seedance' ? seedanceVideoProvider : klingVideoProvider;
      ({ requestId } = await provider.submit({ prompt, imageUrl: image.signedUrl, durationS: sourceDurationS as 5 | 6 | 10 | 15 | 20 | 30, format: input.format, endUserId: actor.id }, falCredential.apiKey));
    }
  } catch {
    await Promise.all([
      settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
      admin.from('video_versions').update({ status: 'failed', error_message: 'Impossible de soumettre la génération au fournisseur.' }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(503, 'Impossible de démarrer la génération vidéo. Le budget réservé a été libéré.');
  }
  const providerSubmittedAt = new Date().toISOString();
  const existingBrief = { ...brief, overlayLogo: input.overlayLogo, generationTier, ...(referenceMode ? { referenceVideoMode: true, vehicleDossierId: input.vehicleDossierId, vehiclePhotoIds: referenceAssets.map((photo) => photo.id), locationAssetId: selectedLocation?.id ?? null } : {}) };
  const persistedBrief = { ...existingBrief, processingMetrics: { providerSubmittedAt } };
  const { error: updateError } = await admin.from('video_versions').update({ provider_request_id: requestId, status: 'generating', brief_json: persistedBrief }).eq('id', version.id);
  if (updateError) throw new HttpError(503, 'La génération a démarré, mais son suivi n’a pas pu être enregistré. Le budget reste réservé.');
  return { id: version.id, status: 'generating' as const, brief, prompt, estimatedPriceFcfa: priceFcfa, version: version.number };
}

function acceptedFalUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'fal.media' || host.endsWith('.fal.media') || host === 'storage.googleapis.com')) return null;
    return url;
  } catch { return null; }
}

export async function refreshLiveVersion(versionId: string, actor: Actor) {
  const admin = createStorageAdminClient();
  const { data: version, error } = await admin.from('video_versions').select('id,video_id,number,provider_request_id,fal_credential_id,status,raw_path,final_path,updated_at,brief_json,model:ai_models(adapter_family,fal_endpoint_id),video:videos!inner(id,user_id,status,brand_id,department)').eq('id', versionId).single();
  if (error || !version) throw new HttpError(404, 'Cette version est introuvable.');
  const video = Array.isArray(version.video) ? version.video[0] : version.video;
  const ownsVideo = video?.user_id === actor.id;
  const canReview = actor.role === 'valideur' && video?.status === 'review' && video.brand_id === actor.brandId && video.department === actor.department;
  if (!video || !ownsVideo && !canReview && actor.role !== 'admin') throw new HttpError(404, 'Cette version est introuvable.');
  if (version.brief_json && typeof version.brief_json === 'object' && (version.brief_json as Record<string, unknown>).photoFidelityMode === true) return refreshLivePhotoFidelity(versionId, actor);
  if (version.brief_json && typeof version.brief_json === 'object' && 'storyboard' in version.brief_json) return refreshLiveStoryboard(versionId, actor);
  if (version.status === 'failed') return { id: versionId, status: version.status };
  if (version.status === 'ready') {
    if (video.status === 'generating' && version.final_path) {
      if (actor.role === 'admin') {
        await approveCompletedAdminVideo(admin, actor, { videoId: version.video_id, versionId });
        video.status = 'approved';
      } else {
        const { error: readyError } = await admin.from('videos').update({ status: 'ready' }).eq('id', version.video_id);
        if (readyError) throw new HttpError(503, 'Le fichier final est prêt; son état doit être réconcilié.');
        video.status = 'ready';
      }
      await notifyVersion(admin, video.user_id, versionId, 'ready', 'Votre vidéo est prête à être consultée.');
    }
    const approvedFinal = (video?.status === 'approved' || video?.status === 'ready' && ownsVideo) && version.final_path;
    const validatorPreview = video?.status === 'review' && (actor.role === 'admin' || actor.role === 'valideur' && video.brand_id === actor.brandId && video.department === actor.department);
    const path = approvedFinal || validatorPreview ? approvedFinal || version.final_path : null;
    return { id: versionId, status: version.status, videoUrl: path ? await signedVideoUrl(admin, path) : undefined };
  }
  if (version.status === 'postprocessing') {
    if (actor.id !== 'cron-reconcile' && Date.now() - new Date(version.updated_at).getTime() < 60_000) return { id: versionId, status: 'postprocessing' as const };
    return retryPostproduction(versionId, admin);
  }
  if (!version.provider_request_id) throw new HttpError(409, 'La demande de génération n’a pas encore été enregistrée.');
  if (Date.now() - new Date(version.updated_at).getTime() < 4_000) return { id: versionId, status: version.status as 'queued' | 'generating' };
  const { data: pollClaim, error: pollClaimError } = await admin.from('video_versions').update({ updated_at: new Date().toISOString() }).eq('id', versionId).eq('updated_at', version.updated_at).in('status', ['queued', 'generating']).select('id').maybeSingle();
  if (pollClaimError) throw new HttpError(503, 'Impossible de réclamer le suivi de génération.');
  if (!pollClaim) return { id: versionId, status: version.status as 'queued' | 'generating' };
  const model = Array.isArray(version.model) ? version.model[0] : version.model;
  const referenceMode = Boolean(version.brief_json && typeof version.brief_json === 'object' && 'referenceVideoMode' in version.brief_json);
  const provider = referenceMode
    ? model?.fal_endpoint_id === REFERENCE_MODEL_ENDPOINTS.standard ? wanReferenceVideoProvider : model?.fal_endpoint_id === REFERENCE_MODEL_ENDPOINTS.pro ? klingReferenceVideoProvider : seedanceReferenceVideoProvider
    : model?.adapter_family === 'wan' ? wanVideoProvider : model?.adapter_family === 'veo' ? veoVideoProvider : model?.adapter_family === 'seedance' ? seedanceVideoProvider : klingVideoProvider;
  const falCredential = await getFalCredentialById(version.fal_credential_id, admin);
  let status;
  try {
    status = await provider.status(version.provider_request_id, falCredential.apiKey);
  } catch (cause) {
    logFalStatusFailure({ stage: 'generation_status', versionId, providerRequestId: version.provider_request_id, endpoint: model?.fal_endpoint_id ?? 'unknown', adapterFamily: model?.adapter_family ?? null, cause, apiKey: falCredential.apiKey });
    throw new HttpError(502, 'Le suivi de génération a échoué. Réessayez dans un instant.');
  }
  const observedAt = new Date().toISOString();
  const briefData = version.brief_json && typeof version.brief_json === 'object' ? version.brief_json as Record<string, unknown> : {};
  const currentMetrics = briefData.processingMetrics && typeof briefData.processingMetrics === 'object' ? briefData.processingMetrics as ProcessingMetrics : {};
  let metrics = currentMetrics;
  if (status.status === 'queued') metrics = firstObservedAt(metrics, 'providerQueuedAt', observedAt);
  if (status.status === 'generating') metrics = firstObservedAt(metrics, 'generationStartedAt', observedAt);
  if (status.status === 'ready') metrics = firstObservedAt(metrics, 'providerCompletedAt', observedAt);
  if (status.status === 'ready') metrics = firstObservedAt(metrics, 'costsSettlementStartedAt', observedAt);
  if (status.status === 'failed') metrics = firstObservedAt(metrics, 'failedAt', observedAt);
  if (metrics !== currentMetrics) {
    const { error: metricsError } = await admin.from('video_versions').update({ brief_json: { ...briefData, processingMetrics: metrics } }).eq('id', versionId);
    if (metricsError) console.error('Impossible d’enregistrer les durées de génération:', metricsError.message);
  }
  let rawPath = version.raw_path as string | null;
  let ledgerSettlementError: unknown;
  const ledgerSettlement = status.status === 'ready' ? settleCompletedGenerationCost(admin, versionId).catch((cause: unknown) => { ledgerSettlementError = cause; }) : Promise.resolve();
  if (status.status === 'ready' && status.videoUrl) {
    const parsed = acceptedFalUrl(status.videoUrl);
    if (!parsed) throw new HttpError(502, 'Le fournisseur a retourné une URL vidéo non autorisée.');
    const response = await fetch(parsed, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new HttpError(502, 'Impossible de récupérer la vidéo générée.');
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 100 * 1024 * 1024) throw new HttpError(502, 'La vidéo générée dépasse la taille autorisée.');
    const bytes = await readBoundedVideo(response, 100 * 1024 * 1024);
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new HttpError(502, 'Le fichier reçu n’est pas une vidéo MP4 valide ou dépasse la taille autorisée.');
    rawPath = `${version.video_id}/${versionId}/raw.mp4`;
    const { error: uploadError } = await admin.storage.from('videos').upload(rawPath, bytes, { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new HttpError(502, 'Impossible de sauvegarder la vidéo dans la médiathèque sécurisée.');
    metrics = firstObservedAt(metrics, 'rawStoredAt', new Date().toISOString());
    const { error: transferMetricsError } = await admin.from('video_versions').update({ brief_json: { ...briefData, processingMetrics: metrics } }).eq('id', versionId);
    if (transferMetricsError) console.error('Impossible d’enregistrer la durée du transfert:', transferMetricsError.message);
  }
  if (status.status === 'ready') {
    await ledgerSettlement;
    if (ledgerSettlementError) throw ledgerSettlementError;
    metrics = firstObservedAt(metrics, 'costsSettledAt', new Date().toISOString());
    const { error: billingMetricsError } = await admin.from('video_versions').update({ brief_json: { ...briefData, processingMetrics: metrics } }).eq('id', versionId);
    if (billingMetricsError) console.error('Impossible d’enregistrer la durée de clôture des coûts:', billingMetricsError.message);
  }
  if (status.status === 'failed') {
    const { data: ledger } = await admin.from('usage_ledger').select('id').eq('version_id', versionId).eq('status', 'reserved').maybeSingle();
    if (ledger) {
      const { error: settleError } = await settleUsageCost(admin, { entryId: ledger.id, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA });
      if (settleError) throw new HttpError(503, 'La réservation de budget doit être réconciliée par l’administrateur.');
    }
  }
  const updates: Record<string, unknown> = { status: status.status, updated_at: new Date().toISOString() };
  if (rawPath) updates.raw_path = rawPath;
  if (status.error) updates.error_message = status.error;
  if (status.status === 'ready') {
    metrics = firstObservedAt(metrics, 'postproductionStartedAt', new Date().toISOString());
    updates.brief_json = { ...briefData, processingMetrics: metrics };
    updates.status = 'postprocessing'; updates.updated_at = new Date().toISOString();
  }
  // A queued version can already have a Fal request ID when the initial
  // submission was only partially persisted. Reconcile either in-flight state
  // so a completed Fal result is not downloaded repeatedly and left unprocessed.
  const { data: claimedVersion, error: updateError } = await admin.from('video_versions').update(updates).eq('id', versionId).in('status', ['queued', 'generating']).select('id').maybeSingle();
  if (updateError) throw new HttpError(503, 'Impossible d’enregistrer le nouvel état de génération.');
  if (status.status === 'ready') {
    if (!claimedVersion) return { id: versionId, status: 'postprocessing' as const };
    try {
      const processed = await beginPostproduction(versionId);
      if (processed.status === 'ready' && actor.role === 'admin') {
        await approveCompletedAdminVideo(admin, actor, { videoId: version.video_id, versionId });
      }
      const canDownload = ownsVideo || actor.role === 'admin';
      if (processed.status === 'ready' || processed.status === 'failed') await pruneRetiredFalCredentials(admin);
      return { id: versionId, status: processed.status, videoUrl: canDownload ? await signedVideoUrl(admin, processed.finalPath) : undefined };
    } catch (postprodError) {
      const message = postprodError instanceof HttpError ? postprodError.message : 'La post-production a échoué.';
      metrics = firstObservedAt(metrics, 'failedAt', new Date().toISOString());
      await Promise.all([
        admin.from('video_versions').update({ status: 'failed', error_message: message, brief_json: { ...briefData, processingMetrics: metrics }, updated_at: metrics.failedAt }).eq('id', versionId),
        admin.from('videos').update({ status: 'failed' }).eq('id', version.video_id),
        notifyVersion(admin, video.user_id, versionId, 'failed', message),
      ]);
      await pruneRetiredFalCredentials(admin);
      return { id: versionId, status: 'failed' as const, error: message };
    }
  }
  if (status.status === 'failed') {
    await Promise.all([admin.from('videos').update({ status: 'failed' }).eq('id', version.video_id), notifyVersion(admin, video.user_id, versionId, 'failed', status.error ?? 'La génération a échoué.')]);
    await pruneRetiredFalCredentials(admin);
  }
  return { id: versionId, status: status.status, error: status.error };
}

async function notifyVersion(admin: ReturnType<typeof createStorageAdminClient>, userId: string, versionId: string, type: 'ready' | 'failed' | 'cancelled', message: string) {
  const { error } = await admin.from('notifications').upsert({ user_id: userId, version_id: versionId, type, message }, { onConflict: 'user_id,version_id,type', ignoreDuplicates: true });
  if (error && !error.message.includes('notifications')) console.error('Notification vidéo non enregistrée:', error.message);
}

async function settleCompletedGenerationCost(admin: ReturnType<typeof createStorageAdminClient>, versionId: string) {
  const { data: ledger, error: ledgerReadError } = await admin.from('usage_ledger').select('id,cost_usd').eq('version_id', versionId).eq('status', 'reserved').maybeSingle();
  if (ledgerReadError) throw new HttpError(503, 'Impossible de lire la réservation de coût de la génération.');
  if (!ledger) return;
  const { error } = await settleUsageCost(admin, { entryId: ledger.id, outcome: 'charged', actualCostUsd: ledger.cost_usd, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA });
  if (error) throw new HttpError(503, 'La vidéo est générée mais la clôture du budget doit être réconciliée par l’administrateur.');
}

async function readBoundedVideo(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new HttpError(502, 'Le fournisseur n’a retourné aucun fichier vidéo.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new HttpError(502, 'La vidéo générée dépasse la taille autorisée.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
async function signedVideoUrl(admin: ReturnType<typeof createStorageAdminClient>, path: string) {
  const { data, error } = await admin.storage.from('videos').createSignedUrl(path, 3600);
  if (error) throw new HttpError(503, 'Impossible de créer le lien temporaire de la vidéo.');
  return data.signedUrl;
}
