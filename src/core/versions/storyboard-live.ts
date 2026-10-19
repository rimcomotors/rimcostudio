import type { Actor } from '@/core/auth/guards';
import { HttpError } from '@/core/auth/guards';
import { buildBrief } from '@/core/brief';
import { getStoryboardModeRoute } from '@/core/providers/storyboard-routing';
import { wanReferenceVideoProvider, klingReferenceVideoProvider, seedanceReferenceVideoProvider, safeProviderError, type ReferenceVideoProvider } from '@/core/providers/fal-reference-video';
import { buildKeyframeAnimationPrompt, buildKeyframePrompt, canAnimateKeyframes, keyframeQualityAction, KEYFRAME_IMAGE_COST_USD, KEYFRAME_QUALITY_RESERVE_USD, KEYFRAME_VIDEO_ENDPOINTS, keyframeVideoProviders, readKeyframe, readKeyframeQuality, shouldGenerateKeyframes, submitKeyframe, submitKeyframeQuality } from '@/core/providers/fal-keyframes';
import { logFalStatusFailure } from '@/core/providers/fal-observability';
import { klingVideoProvider } from '@/core/providers/fal-kling';
import { createStorageAdminClient } from '@/core/storage/supabase';
import { keyframeImageUploadTarget } from '@/core/storage/keyframe-image';
import { createSupabaseServerClient } from '@/core/supabase/server';
import { env } from '@/env';
import { calculateClientPriceFcfa } from '@/core/pricing';
import { firstObservedAt, type ProcessingMetrics } from './processing-metrics';
import { expandSingleShotStoryboard, finalVideoSeconds, shotToPrompt, type ClipDurationSeconds, type StoryboardShot, validateSingleShotStoryboard, validateStoryboard } from '@/core/storyboard';
import { assembleShotMontage } from '@/core/postproduction/pipeline';
import type { CreateVersionInput } from './live';
import { reserveGenerationCost, reserveKeyframeCost, settleUsageCost } from '@/core/billing/ledger';
import { findCuratedLocation, locationCatalog } from '@/core/assets/location-catalog';
import { createFalClient } from '@fal-ai/client';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getActiveFalCredential, getFalCredentialById, pruneRetiredFalCredentials } from '@/core/providers/fal-credential-vault';

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const providers: Record<'wan' | 'kling' | 'seedance', ReferenceVideoProvider> = {
  wan: wanReferenceVideoProvider, kling: klingReferenceVideoProvider, seedance: seedanceReferenceVideoProvider,
};

async function resolveFalAssetUrl(path: string, admin: ReturnType<typeof createStorageAdminClient>, falStorage: ReturnType<typeof createFalClient>['storage'], uploads: Map<string, Promise<string>>) {
  if (path.startsWith('/places/')) {
    const curated = locationCatalog.find((entry) => entry.path === path);
    if (!curated || !falStorage) throw new HttpError(422, 'La photo du lieu n’est pas une référence de la médiathèque.');
    if (!uploads.has(path)) {
      uploads.set(path, readFile(join(process.cwd(), 'public', path.slice(1))).then((bytes) => {
        const extension = path.split('.').at(-1)?.toLowerCase();
        const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
        return falStorage.upload(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mimeType }), { lifecycle: { expiresIn: '1d' } });
      }));
    }
    return uploads.get(path)!;
  }
  const { data: signed, error } = await admin.storage.from('assets').createSignedUrl(path, 3600);
  if (error || !signed?.signedUrl) throw new HttpError(422, 'Impossible de préparer une image de référence.');
  return signed.signedUrl;
}

export async function createLiveStoryboard(actor: Actor, input: CreateVersionInput & { storyboard: StoryboardShot[]; workflow?: 'single' | 'multi_clip'; storyMode: 'standard' | 'pro' | 'premium'; clipDurationSeconds: ClipDurationSeconds; vehicleDossierId: string; vehicleDossierIds: string[]; placeIds: string[]; purpose: 'presentation' | 'advertising'; storyboardLedgerIds?: string[]; comparisonCampaignId?: string }) {
  if (!actor.brandId) throw new HttpError(403, 'Aucune marque n’est associée à votre profil.');

  const authenticated = await createSupabaseServerClient();
  const admin = createStorageAdminClient();
  const route = getStoryboardModeRoute(input.storyMode);
  const provider = providers[route.adapterFamily];
  const keyframeMode = shouldGenerateKeyframes(input.storyMode);
  const animationEndpoint = KEYFRAME_VIDEO_ENDPOINTS[route.adapterFamily];
  const isSingleShot = input.workflow === 'single';
  if (isSingleShot) validateSingleShotStoryboard(input.storyboard, input.clipDurationSeconds, route.adapterFamily);
  else {
    validateStoryboard(input.storyboard, input.clipDurationSeconds, route.adapterFamily);
  }
  const generationShots = isSingleShot
    ? expandSingleShotStoryboard(input.storyboard[0], input.clipDurationSeconds, route.adapterFamily)
    : input.storyboard;
  const dossierIds = [...new Set([input.vehicleDossierId, ...input.vehicleDossierIds])];
  const [{ data: dossiers, error: dossierError }, { data: model, error: modelError }, { data: animationModel, error: animationModelError }] = await Promise.all([
    authenticated.from('vehicle_dossiers').select('id,make,model,color,variant,brand_id,assets(id,kind,path,title,angle,photo_role,status)').in('id', dossierIds).eq('brand_id', actor.brandId),
    admin.from('ai_models').select('id,name,tier,fal_endpoint_id,adapter_family,price_usd_per_second,pricing_verified_at,allowed_formats,allowed_durations,is_active').eq('fal_endpoint_id', route.endpoint).eq('is_active', true).single(),
    keyframeMode ? admin.from('ai_models').select('id,name,tier,fal_endpoint_id,adapter_family,price_usd_per_second,pricing_verified_at,allowed_formats,allowed_durations,is_active').eq('fal_endpoint_id', animationEndpoint).eq('is_active', true).single() : Promise.resolve({ data: null, error: null }),
  ]);
  const dossier = dossiers?.find((entry) => entry.id === input.vehicleDossierId);
  if (dossierError || !dossiers || !dossier || dossiers.length !== dossierIds.length) throw new HttpError(422, 'Choisissez des dossiers véhicule de votre marque.');
  const normalize = (value: string | null) => (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('fr');
  const identity = (entry: typeof dossier) => [entry.make, entry.model, entry.color, entry.variant].map(normalize).join('|');
  if (new Set(dossiers.map(identity)).size !== 1) throw new HttpError(422, 'Les dossiers regroupés doivent décrire exactement le même véhicule.');
  const vehiclePhotos = dossiers.flatMap((entry) => entry.assets ?? []).filter((asset) => asset.kind === 'vehicle' && asset.status === 'validée');
  const asset = vehiclePhotos.find((photo) => photo.id === input.assetId) ?? vehiclePhotos[0];
  if (!asset) throw new HttpError(422, 'Le dossier ne contient aucune photo validée.');
  if (modelError || !model || model.adapter_family !== route.adapterFamily) throw new HttpError(503, `Le modèle ${route.label} n’est pas activé dans la configuration fal.`);
  if (!model.pricing_verified_at || Date.now() - new Date(model.pricing_verified_at).getTime() > 7 * 24 * 60 * 60 * 1000) throw new HttpError(503, `Le tarif de ${route.label} doit être vérifié et daté avant tout lancement.`);
  if (keyframeMode && (animationModelError || !animationModel || animationModel.adapter_family !== route.adapterFamily || animationModel.tier !== input.storyMode)) throw new HttpError(503, `Le modèle image-clé ${route.label} n’est pas activé dans la configuration fal.`);
  const videoModel = keyframeMode ? animationModel : model;
  if (!videoModel) throw new HttpError(503, `Le modèle vidéo ${route.label} n’est pas configuré.`);
  if (keyframeMode && (!videoModel.pricing_verified_at || Date.now() - new Date(videoModel.pricing_verified_at).getTime() > 7 * 24 * 60 * 60 * 1000)) throw new HttpError(503, `Le tarif du modèle vidéo ${route.label} doit être vérifié et daté avant tout lancement.`);
  if (!videoModel.allowed_formats?.includes(input.format)) throw new HttpError(422, `${route.label} ne prend pas en charge le format ${input.format}.`);
  if (generationShots.some((shot) => !videoModel.allowed_durations?.includes(shot.durationSeconds))) throw new HttpError(422, `La durée d’un clip n’est pas prise en charge par ${route.label}. Réduisez le nombre de plans ou choisissez une autre durée totale.`);
  if (input.audioAssetId) throw new HttpError(422, 'Les vidéos multi-plans sont sans audio pour le moment.');

  const curatedPlaces = input.placeIds.map(findCuratedLocation).filter((place) => place !== undefined);
  const curatedIds = new Set<string>(curatedPlaces.map((place) => place.id));
  const uploadedPlaceIds = input.placeIds.filter((id) => !curatedIds.has(id));
  const locationsQuery = uploadedPlaceIds.length ? await authenticated.from('assets').select('id,path,title,kind,status,brand_id').in('id', uploadedPlaceIds).eq('kind', 'place').eq('status', 'validée').eq('brand_id', actor.brandId) : { data: [], error: null };
  if (locationsQuery.error || (locationsQuery.data ?? []).length !== uploadedPlaceIds.length) throw new HttpError(422, 'Un lieu sélectionné n’est plus disponible.');
  const placeAssets = [...curatedPlaces.map((place) => ({ id: place.id, path: place.path, title: place.title, kind: 'place' as const, status: 'validée' as const, brand_id: actor.brandId })), ...(locationsQuery.data ?? [])];
  const validVehiclePhotoIds = new Set(vehiclePhotos.map((photo) => photo.id));
  const validPlaceIds = new Set(placeAssets.map((photo) => photo.id));
  if (generationShots.some((shot) => !validVehiclePhotoIds.has(shot.vehiclePhotoId) || shot.locationPhotoId != null && !validPlaceIds.has(shot.locationPhotoId))) {
    throw new HttpError(422, 'Le storyboard référence une photo ou un lieu qui n’est pas validé dans votre sélection.');
  }

  const vehicleDescription = [dossier.make, dossier.model, dossier.variant, dossier.color].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ');
  const brief = buildBrief(input.description || 'Vidéo automobile élégante à Abidjan.', {
    vehicle_asset_id: asset.id,
    vehicle_description: vehicleDescription || 'Véhicule strictement identique à la photo de référence',
    vehicle_category: input.vehicleCategory,
    user_direction: input.description,
    location: input.location,
    setting: input.setting,
    character: input.character || 'as explicitly requested in the user direction; otherwise none',
    lighting: input.lighting,
    camera_movement: input.cameraMovement,
    mood: input.mood,
    format: input.format,
    duration_s: input.clipDurationSeconds,
    complexity: input.complexity,
  });
  const prompts = generationShots.map((shot, index) => {
    const reference = vehiclePhotos.find((photo) => photo.id === shot.vehiclePhotoId);
    return shotToPrompt(brief, shot, index, generationShots.length, '@', {
      role: reference?.photo_role,
      angle: reference?.angle,
    });
  });
  const generatedSeconds = generationShots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  const costUsd = generatedSeconds * Number(videoModel.price_usd_per_second);
  const priceFcfa = calculateClientPriceFcfa(costUsd, env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);

  const falCredential = await getActiveFalCredential(admin);
  const { data: video, error: videoError } = await admin.from('videos').insert({
    user_id: actor.id, brand_id: actor.brandId,
    title: input.title || `${dossier.make ?? ''} ${dossier.model ?? 'Véhicule'} · storyboard ${route.label}`.trim(),
    department: actor.department, status: 'generating',
  }).select('id').single();
  if (videoError || !video) throw new HttpError(500, 'Impossible de créer la vidéo. Réessayez.');
  const storedBrief = { ...brief, storyboard: generationShots, approvedStoryboard: input.storyboard, generationTier: input.storyMode, overlayLogo: input.overlayLogo, multiClipMode: !isSingleShot, singleStoryboardMode: isSingleShot, storyMode: input.storyMode, clipDurationSeconds: input.clipDurationSeconds, finalDurationSeconds: finalVideoSeconds(input.clipDurationSeconds), purpose: input.purpose, vehicleDossierId: input.vehicleDossierId, placeIds: input.placeIds, processingMetrics: { requestedAt: new Date().toISOString() }, shotProcessingMetrics: {}, ...(input.comparisonCampaignId ? { comparisonCampaignId: input.comparisonCampaignId } : {}) };
  const { data: version, error: versionError } = await admin.from('video_versions').insert({
    video_id: video.id, number: 1, brief_json: storedBrief, generated_prompt: prompts.join('\n\n--- Plan suivant ---\n\n'),
    ai_model_id: videoModel.id, fal_credential_id: falCredential.id, status: 'queued', generation_seconds: finalVideoSeconds(input.clipDurationSeconds),
  }).select('id,number').single();
  if (versionError || !version) {
    await admin.from('videos').delete().eq('id', video.id);
    throw new HttpError(500, 'Impossible de créer la version de la vidéo. Réessayez.');
  }

  let storyboardCostUsd = 0;
  const storyboardLedgerIds = input.storyboardLedgerIds ?? [];
  if (storyboardLedgerIds.length) {
    const { data: storyboardLedgers, error: storyboardLedgerError } = await admin.from('usage_ledger')
      .select('id,cost_usd,status,version_id,user_id,ai_model_id')
      .in('id', storyboardLedgerIds).eq('user_id', actor.id).eq('status', 'charged')
      .is('version_id', null).is('ai_model_id', null);
    if (storyboardLedgerError || !storyboardLedgers || storyboardLedgers.length !== storyboardLedgerIds.length) {
      await Promise.all([admin.from('video_versions').delete().eq('id', version.id), admin.from('videos').delete().eq('id', video.id)]);
      throw new HttpError(422, 'Le coût du storyboard ne peut pas être associé à cette vidéo. Régénérez le storyboard.');
    }
    const { data: linkedLedger, error: linkError } = await admin.from('usage_ledger')
      .update({ version_id: version.id }).in('id', storyboardLedgerIds).is('version_id', null).select('id');
    if (linkError || !linkedLedger || linkedLedger.length !== storyboardLedgerIds.length) {
      await Promise.all([admin.from('video_versions').delete().eq('id', version.id), admin.from('videos').delete().eq('id', video.id)]);
      throw new HttpError(409, 'Ce coût de storyboard est déjà associé à une autre vidéo. Régénérez le storyboard.');
    }
    storyboardCostUsd = storyboardLedgers.reduce((sum, row) => sum + Number(row.cost_usd), 0);
  }

  const { data: ledgerId, error: reserveError } = await reserveGenerationCost(admin, {
    userId: actor.id, versionId: version.id, modelId: videoModel.id, seconds: generatedSeconds,
    priceUsdPerSecond: Number(videoModel.price_usd_per_second), usdToEur: env.USD_TO_EUR_RATE,
    eurToFcfa: env.EUR_TO_FCFA, priceFcfa, department: actor.department,
  });
  if (reserveError || !ledgerId) {
    await Promise.all([admin.from('usage_ledger').update({ version_id: null }).eq('version_id', version.id).eq('status', 'charged'), admin.from('video_versions').delete().eq('id', version.id), admin.from('videos').delete().eq('id', video.id)]);
    throw new HttpError(503, 'Impossible d’enregistrer le suivi de coûts du montage.');
  }

  const shotRows = generationShots.map((shot, index) => ({
    version_id: version.id, shot_number: index + 1, duration_seconds: shot.durationSeconds,
    title: shot.title, generated_prompt: prompts[index], usage_ledger_id: ledgerId, status: 'queued', keyframe_status: keyframeMode ? 'queued' : 'skipped',
    price_usd_per_second: Number(videoModel.price_usd_per_second), estimated_cost_usd: shot.durationSeconds * Number(videoModel.price_usd_per_second),
  }));
  const { error: shotsInsertError } = await admin.from('video_shots').insert(shotRows);
  if (shotsInsertError) {
    await Promise.all([
      settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
      admin.from('video_versions').update({ status: 'failed', error_message: 'Impossible d’enregistrer les plans.' }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(503, 'Impossible d’enregistrer les plans du montage.');
  }

  if (keyframeMode) {
    const keyframeLedgers = new Map<number, { imageIds: string[]; qualityIds: string[] }>();
    const reservations: string[] = [];
    try {
      for (let index = 0; index < generationShots.length; index += 1) {
        const imageIds: string[] = [];
        const qualityIds: string[] = [];
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const imageReservation = await reserveKeyframeCost(admin, {
            userId: actor.id, versionId: version.id, department: actor.department,
            estimatedCostUsd: KEYFRAME_IMAGE_COST_USD, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA,
          });
          if (imageReservation.error || !imageReservation.data) throw new HttpError(503, 'Impossible de réserver le coût de création des images-clés.');
          reservations.push(imageReservation.data); imageIds.push(imageReservation.data);
          const qualityReservation = await reserveKeyframeCost(admin, {
            userId: actor.id, versionId: version.id, department: actor.department,
            estimatedCostUsd: KEYFRAME_QUALITY_RESERVE_USD, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA,
          });
          if (qualityReservation.error || !qualityReservation.data) throw new HttpError(503, 'Impossible de réserver le coût de contrôle des images-clés.');
          reservations.push(qualityReservation.data); qualityIds.push(qualityReservation.data);
        }
        keyframeLedgers.set(index + 1, { imageIds, qualityIds });
      }
    } catch (cause) {
      await Promise.all(reservations.map((entryId) => settleUsageCost(admin, { entryId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false })));
      await Promise.all([
        settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
        admin.from('video_versions').update({ status: 'failed', error_message: cause instanceof Error ? cause.message : 'Impossible de réserver les images-clés.' }).eq('id', version.id),
        admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
      ]);
      throw cause;
    }
    for (const [shotNumber, ledgers] of keyframeLedgers) {
      const { error } = await admin.from('video_shots').update({ keyframe_image_ledger_ids: ledgers.imageIds, keyframe_quality_ledger_ids: ledgers.qualityIds }).eq('version_id', version.id).eq('shot_number', shotNumber);
      if (error) {
        await Promise.all([
          ...reservations.map((entryId) => settleUsageCost(admin, { entryId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false })),
          settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
          admin.from('video_versions').update({ status: 'failed', error_message: 'Impossible d’enregistrer les réservations des images-clés.' }).eq('id', version.id),
          admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
        ]);
        throw new HttpError(503, 'Impossible d’enregistrer les réservations des images-clés. Aucun fournisseur n’a été appelé.');
      }
    }

    const falStorage = createFalClient({ credentials: falCredential.apiKey }).storage;
    const uploads = new Map<string, Promise<string>>();
    const keyframeSubmissions = await Promise.allSettled(generationShots.map(async (shot) => {
      const vehiclePhoto = vehiclePhotos.find((photo) => photo.id === shot.vehiclePhotoId);
      const place = placeAssets.find((photo) => photo.id === shot.locationPhotoId);
      if (!vehiclePhoto) throw new HttpError(422, 'Le storyboard utilise une photo de véhicule non validée.');
      const imageUrls = await Promise.all([vehiclePhoto.path, ...(place ? [place.path] : [])].map((path) => resolveFalAssetUrl(path, admin, falStorage, uploads)));
      const prompt = buildKeyframePrompt({ shot, vehicle: vehicleDescription, lighting: brief.lighting, format: input.format, retryReason: null });
      return submitKeyframe({ prompt, imageUrls, aspectRatio: input.format }, falCredential.apiKey);
    }));
    let submittedKeyframes = 0;
    for (let index = 0; index < keyframeSubmissions.length; index += 1) {
      const result = keyframeSubmissions[index];
      if (result.status === 'fulfilled') {
        submittedKeyframes += 1;
        const { error: updateError } = await admin.from('video_shots').update({ keyframe_request_id: result.value.requestId, keyframe_status: 'generating', updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
        if (updateError) {
          await Promise.all([
            ...((keyframeLedgers.get(index + 1)?.imageIds ?? []).map((entryId) => settleUsageCost(admin, { entryId, outcome: 'charged', actualCostUsd: KEYFRAME_IMAGE_COST_USD, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }))),
            ...((keyframeLedgers.get(index + 1)?.qualityIds ?? []).map((entryId) => settleUsageCost(admin, { entryId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }))),
          ]);
          await admin.from('video_shots').update({ keyframe_status: 'failed', error_message: 'Le suivi de l’image-clé n’a pas pu être enregistré.' }).eq('version_id', version.id).eq('shot_number', index + 1);
        }
      } else {
        const ids = keyframeLedgers.get(index + 1);
        await Promise.all((ids ? [...ids.imageIds, ...ids.qualityIds] : []).map((entryId) => settleUsageCost(admin, { entryId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false })));
        await admin.from('video_shots').update({ keyframe_status: 'failed', error_message: 'L’image-clé de ce plan n’a pas pu démarrer.', updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
      }
    }
    if (!submittedKeyframes) {
      await Promise.all([
        settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
        admin.from('video_versions').update({ status: 'failed', error_message: 'Aucune image-clé n’a pu démarrer. Aucun plan vidéo n’a été envoyé.' }).eq('id', version.id),
        admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
      ]);
      throw new HttpError(503, 'Aucune image-clé n’a pu démarrer. Réessayez plus tard.');
    }
    const keyframingStartedAt = new Date().toISOString();
    await admin.from('video_versions').update({ status: 'generating', brief_json: { ...storedBrief, keyframeMode: true, processingMetrics: { ...storedBrief.processingMetrics, keyframingStartedAt } }, updated_at: keyframingStartedAt }).eq('id', version.id);
    return { id: version.id, status: 'generating' as const, prompt: prompts.join('\n\n--- Plan suivant ---\n\n'), estimatedPriceFcfa: calculateClientPriceFcfa(costUsd + storyboardCostUsd, env.USD_TO_EUR_RATE, env.EUR_TO_FCFA), storyboardCostUsd, version: version.number, completedShots: 0, totalShots: generationShots.length, completedKeyframes: 0, totalKeyframes: generationShots.length, processingStage: 'keyframing' as const };
  }

  const falStorage = createFalClient({ credentials: falCredential.apiKey }).storage;
  const curatedUploads = new Map<string, Promise<string>>();
  const submissions = await Promise.allSettled(generationShots.map(async (shot, index) => {
    const vehiclePhoto = vehiclePhotos.find((photo) => photo.id === shot.vehiclePhotoId);
    const place = placeAssets.find((photo) => photo.id === shot.locationPhotoId);
    if (!vehiclePhoto) throw new HttpError(422, 'Le storyboard utilise une photo de véhicule non validée.');
    const refs = await Promise.all([vehiclePhoto.path, ...(place ? [place.path] : [])].map(async (path) => {
      if (path.startsWith('/places/')) {
        const curated = locationCatalog.find((entry) => entry.path === path);
        if (!curated || !falStorage) throw new HttpError(422, 'La photo du lieu n’est pas une référence de la médiathèque.');
        if (!curatedUploads.has(path)) {
          curatedUploads.set(path, readFile(join(process.cwd(), 'public', path.slice(1))).then((bytes) => {
            const extension = path.split('.').at(-1)?.toLowerCase();
            const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
            return falStorage.upload(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mimeType }), { lifecycle: { expiresIn: '1d' } });
          }));
        }
        return curatedUploads.get(path)!;
      }
      const { data: signed, error } = await admin.storage.from('assets').createSignedUrl(path, 3600);
      if (error || !signed?.signedUrl) throw new HttpError(422, 'Impossible de préparer une image de référence.');
      return signed.signedUrl;
    }));
    return provider.submit({ prompt: prompts[index], referenceImageUrls: refs, durationS: shot.durationSeconds, aspectRatio: input.format, endUserId: actor.id }, falCredential.apiKey);
  }));
  let submitted = 0;
  for (let index = 0; index < submissions.length; index += 1) {
    const submission = submissions[index];
    if (submission.status === 'fulfilled') {
      submitted += 1;
      await admin.from('video_shots').update({ provider_request_id: submission.value.requestId, status: 'generating', updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
    } else {
      const providerError = safeProviderError(submission.reason, falCredential.apiKey);
      console.error('[video-generation] Séquence non démarrée.', { versionId: version.id, shotNumber: index + 1, detail: providerError });
      await admin.from('video_shots').update({ status: 'failed', error_message: 'Cette séquence n’a pas pu démarrer.', updated_at: new Date().toISOString() }).eq('version_id', version.id).eq('shot_number', index + 1);
    }
  }
  if (!submitted) {
    await Promise.all([
      settleUsageCost(admin, { entryId: ledgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA }),
      admin.from('video_versions').update({ status: 'failed', error_message: 'Aucun plan n’a pu démarrer. La réservation a été libérée.' }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed' }).eq('id', video.id),
    ]);
    throw new HttpError(503, 'Aucun plan n’a pu démarrer. La réservation a été libérée. Réessayez plus tard.');
  }
  const providerSubmittedAt = new Date().toISOString();
  const submittedBrief = { ...storedBrief, processingMetrics: { ...storedBrief.processingMetrics, providerSubmittedAt } };
  await admin.from('video_versions').update({ status: 'generating', brief_json: submittedBrief, updated_at: providerSubmittedAt }).eq('id', version.id);
  const totalEstimatedPriceFcfa = calculateClientPriceFcfa(costUsd + storyboardCostUsd, env.USD_TO_EUR_RATE, env.EUR_TO_FCFA);
  return { id: version.id, status: 'generating' as const, prompt: prompts.join('\n\n--- Plan suivant ---\n\n'), estimatedPriceFcfa: totalEstimatedPriceFcfa, storyboardCostUsd, version: version.number, completedShots: 0, totalShots: generationShots.length };
}

async function refreshKeyframes(input: {
  admin: ReturnType<typeof createStorageAdminClient>;
  version: { id: string; video_id: string; ai_model_id: string | null };
  video: { id: string; user_id: string; brand_id: string | null };
  shots: Array<Record<string, unknown>>;
  actor: Actor;
  brief: Record<string, unknown>;
  apiKey: string;
  adapterFamily: 'wan' | 'kling' | 'seedance';
}) {
  const { admin, version, video, shots, brief, apiKey, adapterFamily } = input;
  const shotDrafts = Array.isArray(brief.storyboard) ? brief.storyboard as StoryboardShot[] : [];
  const draftsByNumber = new Map(shotDrafts.map((shot, index) => [index + 1, shot]));
  const anyKeyframes = shots.some((shot) => shot.keyframe_status !== 'skipped');
  if (!anyKeyframes) return null;
  if (canAnimateKeyframes(shots.map((shot) => String(shot.keyframe_status))) && shots.some((shot) => typeof shot.provider_request_id === 'string')) return null;

  const vehicleIds = [...new Set(shotDrafts.map((shot) => shot.vehiclePhotoId))];
  const selectedPlaceIds = shotDrafts.map((shot) => shot.locationPhotoId).filter((id): id is string => Boolean(id));
  const curatedLocations = selectedPlaceIds.map(findCuratedLocation).filter((place) => place !== undefined);
  const curatedIds = new Set<string>(curatedLocations.map((place) => place.id));
  const uploadedPlaceIds = [...new Set(selectedPlaceIds.filter((id) => !curatedIds.has(id)))];
  const { data: vehicleAssets, error: vehicleError } = await admin.from('assets').select('id,path,kind,status,brand_id').in('id', vehicleIds).eq('kind', 'vehicle').eq('status', 'validée').eq('brand_id', video.brand_id);
  const { data: placeAssets, error: placeError } = uploadedPlaceIds.length
    ? await admin.from('assets').select('id,path,kind,status,brand_id').in('id', uploadedPlaceIds).eq('kind', 'place').eq('status', 'validée').eq('brand_id', video.brand_id)
    : { data: [], error: null };
  if (vehicleError || placeError || (vehicleAssets ?? []).length !== vehicleIds.length || (placeAssets ?? []).length !== uploadedPlaceIds.length) throw new HttpError(422, 'Une référence validée n’est plus accessible pour contrôler les images-clés.');
  const assetsById = new Map([...(vehicleAssets ?? []), ...(placeAssets ?? [])].map((asset) => [asset.id, asset]));
  const locationPaths = new Map<string, string>(curatedLocations.map((place) => [place.id, place.path]));
  const falStorage = createFalClient({ credentials: apiKey }).storage;
  const uploads = new Map<string, Promise<string>>();
  const now = new Date().toISOString();
  const outcomes = await Promise.allSettled(shots.map(async (shot) => {
    const shotNumber = Number(shot.shot_number);
    const draft = draftsByNumber.get(shotNumber);
    const imageLedgerIds = Array.isArray(shot.keyframe_image_ledger_ids) ? shot.keyframe_image_ledger_ids as string[] : [];
    const qualityLedgerIds = Array.isArray(shot.keyframe_quality_ledger_ids) ? shot.keyframe_quality_ledger_ids as string[] : [];
    const attempt = Number(shot.keyframe_retry_count ?? 0);
    if (!draft || imageLedgerIds.length !== 2 || qualityLedgerIds.length !== 2) throw new HttpError(503, `Le suivi de l’image-clé ${shotNumber} est incomplet.`);
    const vehicle = assetsById.get(draft.vehiclePhotoId);
    const placePath = draft.locationPhotoId ? locationPaths.get(draft.locationPhotoId) ?? assetsById.get(draft.locationPhotoId)?.path : undefined;
    if (!vehicle || !placePath && draft.locationPhotoId) throw new HttpError(422, `Une référence du plan ${shotNumber} n’est plus disponible.`);
    const referenceUrls = await Promise.all([vehicle.path, ...(placePath ? [placePath] : [])].map((path) => resolveFalAssetUrl(path, admin, falStorage, uploads)));
    const imageLedgerId = imageLedgerIds[attempt];
    const qualityLedgerId = qualityLedgerIds[attempt];
    if (shot.keyframe_status === 'generating' && typeof shot.keyframe_request_id === 'string') {
      const state = await readKeyframe(shot.keyframe_request_id, apiKey);
      if (state.status === 'failed') {
        await settleUsageCost(admin, { entryId: imageLedgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
        await settleUsageCost(admin, { entryId: qualityLedgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
        await admin.from('video_shots').update({ keyframe_status: 'failed', error_message: 'Le fournisseur n’a pas pu créer cette image-clé.', updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
        return;
      }
      if (state.status === 'generating') return;
      const parsed = acceptedFalUrl(state.imageUrl);
      if (!parsed) throw new HttpError(502, `L’URL de l’image-clé ${shotNumber} n’est pas autorisée.`);
      await settleUsageCost(admin, { entryId: imageLedgerId, outcome: 'charged', actualCostUsd: KEYFRAME_IMAGE_COST_USD, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
      const response = await fetch(parsed, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw new HttpError(502, `Impossible de récupérer l’image-clé ${shotNumber}.`);
      const bytes = await readBoundedImage(response, MAX_IMAGE_BYTES);
      const contentType = state.contentType;
      const target = keyframeImageUploadTarget({ videoId: version.video_id, versionId: version.id, shotNumber, contentType });
      const { error: uploadError } = await admin.storage.from(target.bucket).upload(target.path, bytes, target.options);
      if (uploadError) {
        console.error('keyframe_storage_upload_failed', JSON.stringify({
          versionId: version.id,
          shotNumber,
          code: uploadError.name,
          message: uploadError.message,
        }));
        await Promise.all([
          settleUsageCost(admin, { entryId: qualityLedgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }),
          admin.from('video_shots').update({ keyframe_status: 'failed', error_message: `Impossible d’enregistrer l’image-clé ${shotNumber}.`, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber),
        ]);
        return;
      }
      const { data: signed, error: signedError } = await admin.storage.from(target.bucket).createSignedUrl(target.path, 3600);
      if (signedError || !signed?.signedUrl) throw new HttpError(503, 'Impossible de créer le lien de contrôle temporaire.');
      const visionPrompt = `Compare les images reçues dans cet ordre : image 1 = candidat image-clé, image 2 = véhicule approuvé, image 3 éventuelle = lieu sélectionné. Le candidat doit conserver strictement le véhicule et sa couleur visibles dans la référence; respecter le lieu et la composition demandés; ne contenir aucun texte ajouté, logo inventé ni plaque lisible. Vérifie aussi une lumière et une échelle plausibles. Réponds avec approved=true seulement si aucun défaut manifeste. Sinon liste précisément les défauts. Plan: ${draft.title}; scène: ${draft.scene}; cadrage: ${draft.framing}; lieu: ${draft.location}.`;
      const qualityJob = await submitKeyframeQuality({ prompt: visionPrompt, imageUrls: [signed.signedUrl, ...referenceUrls] }, apiKey);
      const { error: updateError } = await admin.from('video_shots').update({ keyframe_status: 'checking', keyframe_path: target.path, keyframe_quality_request_id: qualityJob.requestId, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
      if (updateError) {
        await settleUsageCost(admin, { entryId: qualityLedgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
        throw new HttpError(503, `Impossible d’enregistrer le contrôle de l’image-clé ${shotNumber}.`);
      }
      return;
    }
    if (shot.keyframe_status !== 'checking' || typeof shot.keyframe_quality_request_id !== 'string') return;
    const state = await readKeyframeQuality(shot.keyframe_quality_request_id, apiKey);
    if (state.status === 'checking') return;
    if (state.status === 'failed' || !state.quality) {
      await settleUsageCost(admin, { entryId: qualityLedgerId, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
      await admin.from('video_shots').update({ keyframe_status: 'failed', error_message: 'Le contrôle automatique de cette image-clé n’a pas abouti.', updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
      return;
    }
    const quality = state.quality;
    const qualityCostUsd = state.costUsd ?? KEYFRAME_QUALITY_RESERVE_USD;
    await settleUsageCost(admin, { entryId: qualityLedgerId, outcome: 'charged', actualCostUsd: qualityCostUsd, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false });
    const qualityAction = keyframeQualityAction(quality.approved, attempt);
    if (qualityAction === 'accept') {
      if (attempt === 0) {
        await Promise.all([
          settleUsageCost(admin, { entryId: imageLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }),
          settleUsageCost(admin, { entryId: qualityLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }),
        ]);
      }
      await admin.from('video_shots').update({ keyframe_status: 'ready', keyframe_quality: quality, error_message: null, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
      return;
    }
    if (qualityAction === 'retry') {
      const vehicleDescription = String(brief.vehicle_description ?? 'Véhicule fidèle à la photo validée');
      const prompt = buildKeyframePrompt({ shot: draft, vehicle: vehicleDescription, lighting: String(brief.lighting ?? ''), format: String(brief.format ?? '16:9'), retryReason: quality.issues.join('; ') || quality.reason });
      try {
        const retryJob = await submitKeyframe({ prompt, imageUrls: referenceUrls, aspectRatio: String(brief.format ?? '16:9') }, apiKey);
        const { error: updateError } = await admin.from('video_shots').update({ keyframe_status: 'generating', keyframe_request_id: retryJob.requestId, keyframe_quality_request_id: null, keyframe_path: null, keyframe_quality: quality, keyframe_retry_count: 1, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
        if (updateError) throw new HttpError(503, 'Impossible d’enregistrer la reprise de l’image-clé.');
      } catch {
        await Promise.all([
          settleUsageCost(admin, { entryId: imageLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }),
          settleUsageCost(admin, { entryId: qualityLedgerIds[1], outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA, billable: false }),
          admin.from('video_shots').update({ keyframe_status: 'failed', keyframe_quality: quality, error_message: 'La reprise de cette image-clé n’a pas pu démarrer.' }).eq('version_id', version.id).eq('shot_number', shotNumber),
        ]);
      }
      return;
    }
    await admin.from('video_shots').update({ keyframe_status: 'failed', keyframe_quality: quality, error_message: `Image-clé refusée après une reprise : ${quality.issues.join('; ') || quality.reason}`, updated_at: now }).eq('version_id', version.id).eq('shot_number', shotNumber);
  }));
  const failure = outcomes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;

  const { data: refreshedShots, error: refreshedError } = await admin.from('video_shots')
    .select('shot_number,duration_seconds,title,generated_prompt,provider_request_id,status,raw_path,error_message,keyframe_status,keyframe_request_id,keyframe_quality_request_id,keyframe_path,keyframe_retry_count,keyframe_quality,keyframe_image_ledger_ids,keyframe_quality_ledger_ids')
    .eq('version_id', version.id).order('shot_number');
  if (refreshedError || !refreshedShots) throw new HttpError(503, 'Impossible de relire la progression des images-clés.');
  const completedKeyframes = refreshedShots.filter((shot) => shot.keyframe_status === 'ready').length;
  const keyframes = await Promise.all(refreshedShots.filter((shot) => typeof shot.keyframe_path === 'string').map(async (shot) => {
    const { data, error } = await admin.storage.from('videos').createSignedUrl(shot.keyframe_path!, 3600);
    return error || !data?.signedUrl ? null : { number: shot.shot_number, title: shot.title, url: data.signedUrl, quality: shot.keyframe_quality };
  }));
  const keyframePreviews = keyframes.filter((item): item is NonNullable<typeof item> => Boolean(item));
  const pendingKeyframes = refreshedShots.some((shot) => ['queued','generating','checking'].includes(shot.keyframe_status));
  if (pendingKeyframes) return { id: version.id, status: 'generating' as const, processingStage: 'keyframing' as const, completedKeyframes, totalKeyframes: refreshedShots.length, keyframes: keyframePreviews, completedShots: 0, totalShots: refreshedShots.length };
  if (completedKeyframes !== refreshedShots.length) {
    const { data: generationLedger } = await admin.from('usage_ledger').select('id').eq('version_id', version.id).eq('kind', 'generation').eq('ai_model_id', version.ai_model_id).eq('status', 'reserved').maybeSingle();
    if (generationLedger?.id) await settleUsageCost(admin, { entryId: generationLedger.id, outcome: 'released', actualCostUsd: 0, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA });
    const error = refreshedShots.find((shot) => shot.keyframe_status === 'failed')?.error_message ?? 'Une image-clé n’a pas passé le contrôle. Aucun plan vidéo n’a été envoyé.';
    await Promise.all([
      admin.from('usage_ledger').update({ status: 'released' }).eq('version_id', version.id).eq('kind', 'keyframe').eq('status', 'reserved'),
      admin.from('video_versions').update({ status: 'failed', error_message: error, updated_at: now }).eq('id', version.id),
      admin.from('videos').update({ status: 'failed', updated_at: now }).eq('id', version.video_id),
    ]);
    return { id: version.id, status: 'failed' as const, error, completedKeyframes, totalKeyframes: refreshedShots.length, keyframes: keyframePreviews };
  }
  if (canAnimateKeyframes(refreshedShots.map((shot) => shot.keyframe_status)) && refreshedShots.some((shot) => typeof shot.provider_request_id === 'string')) return null;

  const provider = keyframeVideoProviders[adapterFamily];
  const animationJobs = await Promise.allSettled(refreshedShots.map(async (shot) => {
    const draft = draftsByNumber.get(Number(shot.shot_number));
    if (!draft || !shot.keyframe_path) throw new HttpError(422, 'Une image-clé validée est introuvable.');
    const { data: signed, error } = await admin.storage.from('videos').createSignedUrl(shot.keyframe_path, 3600);
    if (error || !signed?.signedUrl) throw new HttpError(503, 'Impossible de préparer une image-clé pour son animation.');
    const prompt = buildKeyframeAnimationPrompt({
      shot: draft, vehicle: String(brief.vehicle_description ?? 'Véhicule de référence'),
      durationS: Number(shot.duration_seconds), mood: String(brief.mood ?? ''), lighting: String(brief.lighting ?? ''),
    });
    const job = await provider.submit({ prompt, referenceImageUrls: [signed.signedUrl], durationS: Number(shot.duration_seconds), aspectRatio: String(brief.format ?? '16:9'), endUserId: String(video.user_id) }, apiKey);
    const { error: updateError } = await admin.from('video_shots').update({ provider_request_id: job.requestId, status: 'generating', generated_prompt: prompt, updated_at: now }).eq('version_id', version.id).eq('shot_number', shot.shot_number);
    if (updateError) throw new HttpError(503, 'Impossible d’enregistrer le lancement de l’animation.');
  }));
  for (let index = 0; index < animationJobs.length; index += 1) {
    const result = animationJobs[index];
    if (result.status === 'rejected') await admin.from('video_shots').update({ status: 'failed', error_message: 'L’animation de ce plan n’a pas pu démarrer.', updated_at: now }).eq('version_id', version.id).eq('shot_number', Number(refreshedShots[index].shot_number));
  }
  const metrics = brief.processingMetrics && typeof brief.processingMetrics === 'object' ? brief.processingMetrics as ProcessingMetrics : {};
  const keyframeCompletedAt = new Date().toISOString();
  const updatedBrief = { ...brief, processingMetrics: { ...metrics, keyframingCompletedAt: keyframeCompletedAt, providerSubmittedAt: keyframeCompletedAt } };
  await admin.from('video_versions').update({ brief_json: updatedBrief, updated_at: keyframeCompletedAt }).eq('id', version.id);
  return { id: version.id, status: 'generating' as const, processingStage: 'generating' as const, completedKeyframes, totalKeyframes: refreshedShots.length, keyframes: keyframePreviews, completedShots: 0, totalShots: refreshedShots.length };
}

export async function refreshLiveStoryboard(versionId: string, actor: Actor) {
  const admin = createStorageAdminClient();
  const { data: version, error } = await admin.from('video_versions')
    .select('id,video_id,status,final_path,error_message,updated_at,ai_model_id,fal_credential_id,brief_json,model:ai_models!inner(adapter_family,fal_endpoint_id,price_usd_per_second),video:videos!inner(id,user_id,brand_id,status)')
    .eq('id', versionId).single();
  if (error || !version) throw new HttpError(404, 'Cette version est introuvable.');
  const video = Array.isArray(version.video) ? version.video[0] : version.video;
  if (!video || video.user_id !== actor.id && actor.role !== 'admin') throw new HttpError(404, 'Cette version est introuvable.');
  if (version.status === 'ready' && version.final_path) return { id: versionId, status: 'ready' as const, videoUrl: await signedUrl(admin, version.final_path) };
  if (version.status === 'cancelled') return { id: versionId, status: 'cancelled' as const, error: 'La génération a été annulée.' };
  if (version.status === 'failed') { await pruneRetiredFalCredentials(admin); return { id: versionId, status: 'failed' as const, error: version.error_message ?? 'Un plan n’a pas pu être généré.' }; }
  if (version.status === 'postprocessing' && actor.id !== 'cron-reconcile' && Date.now() - new Date(version.updated_at).getTime() < 60_000) {
    return { id: versionId, status: 'postprocessing' as const };
  }
  if (version.status === 'postprocessing') {
    const { data: claimed, error: claimError } = await admin.from('video_versions').update({ updated_at: new Date().toISOString() }).eq('id', versionId).eq('status', 'postprocessing').eq('updated_at', version.updated_at).select('id').maybeSingle();
    if (claimError) throw new HttpError(503, 'Impossible de réclamer la finalisation du montage.');
    if (!claimed) return { id: versionId, status: 'postprocessing' as const };
  }

  const { data: shots, error: shotsError } = await admin.from('video_shots')
    .select('shot_number,duration_seconds,title,generated_prompt,provider_request_id,status,raw_path,error_message,updated_at,keyframe_status,keyframe_request_id,keyframe_quality_request_id,keyframe_path,keyframe_retry_count,keyframe_quality,keyframe_image_ledger_ids,keyframe_quality_ledger_ids')
    .eq('version_id', versionId).order('shot_number');
  const briefData = version.brief_json && typeof version.brief_json === 'object' ? version.brief_json as Record<string, unknown> : {};
  const singleStoryboardMode = briefData.singleStoryboardMode === true;
  if (shotsError || !shots || (singleStoryboardMode ? shots.length < 1 || shots.length > 6 : shots.length < 2 || shots.length > 6)) throw new HttpError(503, 'Les plans de cette vidéo sont introuvables.');
  if (version.status === 'generating') {
    const { data: claimed, error: claimError } = await admin.from('video_versions').update({ updated_at: new Date().toISOString() }).eq('id', versionId).eq('status', 'generating').eq('updated_at', version.updated_at).select('id').maybeSingle();
    if (claimError) throw new HttpError(503, 'Impossible de réclamer le suivi des plans.');
    if (!claimed) return { id: versionId, status: 'generating' as const, completedShots: shots.filter((shot) => shot.status === 'ready').length, totalShots: shots.length };
  }
  const currentMetrics = briefData.processingMetrics && typeof briefData.processingMetrics === 'object' ? briefData.processingMetrics as ProcessingMetrics : {};
  const shotMetrics = briefData.shotProcessingMetrics && typeof briefData.shotProcessingMetrics === 'object' ? briefData.shotProcessingMetrics as Record<string, ProcessingMetrics> : {};
  const observedAt = new Date().toISOString();
  const nextShotMetrics = { ...shotMetrics };
  const model = Array.isArray(version.model) ? version.model[0] : version.model;
  const adapterFamily: 'wan' | 'kling' | 'seedance' = model?.adapter_family === 'wan' ? 'wan' : model?.adapter_family === 'seedance' ? 'seedance' : 'kling';
  const multiClip = version.brief_json && typeof version.brief_json === 'object' && (version.brief_json as { multiClipMode?: unknown }).multiClipMode === true;
  const keyframeMode = briefData.keyframeMode === true;
  const falCredential = await getFalCredentialById(version.fal_credential_id, admin);
  if (keyframeMode) {
    const keyframeResult = await refreshKeyframes({ admin, version, video, shots, actor, brief: briefData, apiKey: falCredential.apiKey, adapterFamily });
    if (keyframeResult) return keyframeResult;
  }
  const statusProvider = keyframeMode ? keyframeVideoProviders[adapterFamily] : multiClip || singleStoryboardMode ? providers[adapterFamily] : klingVideoProvider;

  const shotRefreshResults = await Promise.allSettled(shots.filter((shot) => shot.status === 'generating' && shot.provider_request_id).map(async (shot) => {
    let state;
    try {
      state = await statusProvider.status(shot.provider_request_id, falCredential.apiKey);
    } catch (cause) {
      logFalStatusFailure({ stage: 'storyboard_shot_status', versionId, shotNumber: shot.shot_number, providerRequestId: shot.provider_request_id, endpoint: model?.fal_endpoint_id ?? 'unknown', adapterFamily, cause, apiKey: falCredential.apiKey });
      throw new HttpError(502, `Le suivi du plan ${shot.shot_number} a échoué. Réessayez dans un instant.`);
    }
    if (state.status === 'failed') {
      nextShotMetrics[String(shot.shot_number)] = firstObservedAt(nextShotMetrics[String(shot.shot_number)] ?? {}, 'failedAt', observedAt);
      await admin.from('video_shots').update({ status: 'failed', error_message: state.error ?? 'La génération fal a échoué.', updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shot.shot_number).eq('status', 'generating');
      return;
    }
    if (state.status === 'queued') nextShotMetrics[String(shot.shot_number)] = firstObservedAt(nextShotMetrics[String(shot.shot_number)] ?? {}, 'providerQueuedAt', observedAt);
    if (state.status === 'generating') nextShotMetrics[String(shot.shot_number)] = firstObservedAt(nextShotMetrics[String(shot.shot_number)] ?? {}, 'generationStartedAt', observedAt);
    if (state.status !== 'ready' || !state.videoUrl) return;
    nextShotMetrics[String(shot.shot_number)] = firstObservedAt(nextShotMetrics[String(shot.shot_number)] ?? {}, 'providerCompletedAt', observedAt);
    const parsed = acceptedFalUrl(state.videoUrl);
    if (!parsed) throw new HttpError(502, 'Le fournisseur a retourné une URL vidéo non autorisée.');
    const response = await fetch(parsed, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new HttpError(502, `Impossible de récupérer le plan ${shot.shot_number}.`);
    const bytes = await readBoundedVideo(response, MAX_VIDEO_BYTES);
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new HttpError(502, `Le plan ${shot.shot_number} n’est pas un MP4 valide.`);
    const rawPath = `${version.video_id}/${versionId}/shot-${shot.shot_number}.mp4`;
    const { error: uploadError } = await admin.storage.from('videos').upload(rawPath, bytes, { contentType: 'video/mp4', upsert: true });
    if (uploadError) throw new HttpError(502, `Impossible d’enregistrer le plan ${shot.shot_number}.`);
    await admin.from('video_shots').update({ status: 'ready', raw_path: rawPath, actual_cost_usd: Number(shot.duration_seconds) * Number(model?.price_usd_per_second ?? 0), error_message: null, updated_at: new Date().toISOString() }).eq('version_id', versionId).eq('shot_number', shot.shot_number).eq('status', 'generating');
    nextShotMetrics[String(shot.shot_number)] = firstObservedAt(nextShotMetrics[String(shot.shot_number)] ?? {}, 'rawStoredAt', new Date().toISOString());
  }));

  const observedShots = latestMetricsForShots(shots, nextShotMetrics, observedAt);
  let metrics = { ...currentMetrics };
  const firstGeneration = observedShots.map((entry) => entry.generationStartedAt).filter((value): value is string => Boolean(value)).sort()[0];
  if (firstGeneration) metrics.generationStartedAt = metrics.generationStartedAt ?? firstGeneration;
  const allSettled = observedShots.length > 0 && observedShots.every((entry) => entry.providerCompletedAt || entry.failedAt);
  const lastCompleted = observedShots.map((entry) => entry.providerCompletedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  if (allSettled && lastCompleted) metrics.providerCompletedAt = metrics.providerCompletedAt ?? lastCompleted;
  const lastStored = observedShots.map((entry) => entry.rawStoredAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  if (allSettled && lastStored) metrics.rawStoredAt = metrics.rawStoredAt ?? lastStored;
  const lastFailed = observedShots.map((entry) => entry.failedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  if (allSettled && lastFailed) metrics.failedAt = metrics.failedAt ?? lastFailed;
  const mergedBrief = { ...briefData, processingMetrics: metrics, shotProcessingMetrics: nextShotMetrics };
  const { error: metricsSaveError } = await admin.from('video_versions').update({ brief_json: mergedBrief }).eq('id', versionId);
  if (metricsSaveError) console.error('Impossible d’enregistrer les durées des plans:', metricsSaveError.message);
  const refreshFailure = shotRefreshResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (refreshFailure) throw refreshFailure.reason;

  const { data: latestShots, error: latestError } = await admin.from('video_shots').select('status,raw_path,duration_seconds').eq('version_id', versionId).order('shot_number');
  if (latestError || !latestShots) throw new HttpError(503, 'Impossible de relire l’état des plans.');
  const completedShots = latestShots.filter((shot) => shot.status === 'ready' && shot.raw_path).length;
  const pendingShots = latestShots.some((shot) => ['queued','generating','postprocessing'].includes(shot.status));
  if (pendingShots) return { id: versionId, status: 'generating' as const, completedShots, totalShots: latestShots.length };

  const { data: ledger, error: ledgerError } = await admin.from('usage_ledger').select('id,status').eq('version_id', versionId).eq('kind', 'generation').eq('ai_model_id', version.ai_model_id).maybeSingle();
  if (ledgerError) throw new HttpError(503, 'Impossible de clôturer le budget des plans.');
  const priceUsdPerSecond = Number(model.price_usd_per_second);
  if (ledger?.status === 'reserved') {
    metrics = firstObservedAt(metrics, 'costsSettlementStartedAt', new Date().toISOString());
    const { error: billingStartError } = await admin.from('video_versions').update({ brief_json: { ...mergedBrief, processingMetrics: metrics } }).eq('id', versionId);
    if (billingStartError) console.error('Impossible d’enregistrer le début de clôture des coûts:', billingStartError.message);
    const outcome = completedShots > 0 ? 'charged' : 'released';
    const actualCostUsd = latestShots.filter((shot) => shot.status === 'ready').reduce((sum, shot) => sum + Number(shot.duration_seconds) * priceUsdPerSecond, 0);
    const { error: settleError } = await settleUsageCost(admin, {
      entryId: ledger.id, outcome, actualCostUsd, usdToEur: env.USD_TO_EUR_RATE, eurToFcfa: env.EUR_TO_FCFA,
    });
    if (settleError) throw new HttpError(503, 'La consommation fal doit être réconciliée avant de terminer le montage.');
  }
  metrics.costsSettledAt = metrics.costsSettledAt ?? new Date().toISOString();
  metrics.postproductionStartedAt = metrics.postproductionStartedAt ?? new Date().toISOString();
  await admin.from('video_versions').update({ brief_json: { ...mergedBrief, processingMetrics: metrics } }).eq('id', versionId);
  if (completedShots !== latestShots.length) {
    const errorMessage = 'Un plan a échoué. Relancez la vidéo pour obtenir le montage complet.';
    await Promise.all([
      admin.from('video_versions').update({ status: 'failed', error_message: errorMessage, updated_at: new Date().toISOString() }).eq('id', versionId),
      admin.from('videos').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', version.video_id),
    ]);
    await pruneRetiredFalCredentials(admin);
    return { id: versionId, status: 'failed' as const, error: errorMessage, completedShots, totalShots: latestShots.length };
  }

  if (version.status !== 'postprocessing') {
    await admin.from('video_versions').update({ status: 'postprocessing', updated_at: new Date().toISOString() }).eq('id', versionId);
  }
  try {
    const { finalPath } = await assembleShotMontage(versionId);
    await pruneRetiredFalCredentials(admin);
    return { id: versionId, status: 'ready' as const, videoUrl: await signedUrl(admin, finalPath), completedShots: latestShots.length, totalShots: latestShots.length };
  } catch (cause) {
    return { id: versionId, status: 'postprocessing' as const, error: cause instanceof Error ? cause.message : 'Le montage sera repris automatiquement.', completedShots: latestShots.length, totalShots: latestShots.length };
  }
}

async function signedUrl(admin: ReturnType<typeof createStorageAdminClient>, path: string) {
  const { data, error } = await admin.storage.from('videos').createSignedUrl(path, 3600);
  if (error || !data) throw new HttpError(503, 'Impossible de créer le lien temporaire du montage.');
  return data.signedUrl;
}

function latestMetricsForShots(shots: Array<{ shot_number: number }>, byShot: Record<string, ProcessingMetrics>, fallbackAt: string) {
  return shots.map((shot) => byShot[String(shot.shot_number)] ?? { requestedAt: fallbackAt });
}

function acceptedFalUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'fal.media' || host.endsWith('.fal.media') || host === 'storage.googleapis.com') ? url : null;
  } catch { return null; }
}

async function readBoundedImage(response: Response, limit: number) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'L’image-clé dépasse la taille autorisée.');
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(502, 'Le fournisseur n’a pas retourné de fichier image.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'L’image-clé dépasse la taille autorisée.'); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const isPng = bytes.toString('hex', 0, 4) === '89504e47';
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (bytes.length < 12 || !(isPng || isJpeg || isWebp)) {
    throw new HttpError(502, 'Le fichier image retourné par le fournisseur est invalide.');
  }
  return bytes;
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
